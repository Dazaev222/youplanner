/* Синхронизация локального дневника с RTDB (ТЗ §5, §9).
   Outbox отправляет только новые create; обычные онлайн-правки сюда не попадают.
   Повторный create проверяет тот же путь и семантический payload. */

import { equivalentDomainRecord, hashSnapshot } from './canonical.js';
import { fail, ok } from './errors.js';
import { replayJournal } from './projection.js';
import { normalizeRecord } from './schema.js';

const SENDABLE = new Set(['pending', 'unknown']);

function statusCount(outbox, status) {
  return outbox.filter((entry) => entry.status === status).length;
}

function recordKey(kind, id) {
  return { kind, id };
}

function mergeList(kind, remoteList, localList, recordsToAdd, anomalies) {
  for (const [id, payload] of Object.entries(remoteList || {})) {
    if (!payload || typeof payload !== 'object') continue;
    const local = localList[id];
    if (!local) {
      const key = recordKey(kind, id);
      recordsToAdd.push({ ...key, payload: normalizeRecord(payload) });
      continue;
    }
    if (!equivalentDomainRecord(kind, local, payload)) {
      anomalies.push({ code: 'ID_CONFLICT', kind, id, reason: 'payload отличается' });
    }
  }
}

function mergeMutations(remoteMutations, localMutations, recordsToAdd, anomalies) {
  for (const [entityKey, slots] of Object.entries(remoteMutations || {})) {
    if (!slots || typeof slots !== 'object') continue;
    for (const [slot, payload] of Object.entries(slots)) {
      if (!payload || typeof payload !== 'object') continue;
      const local = localMutations[entityKey] ? localMutations[entityKey][slot] : undefined;
      if (local) {
        if (!equivalentDomainRecord('mutation', local, payload)) {
          anomalies.push({
            code: 'ID_CONFLICT', kind: 'mutation', entityKey, slot,
            reason: 'payload отличается',
          });
        }
        continue;
      }
      recordsToAdd.push({
        kind: 'mutation',
        id: payload.operationId || `${entityKey}:${slot}`,
        entityKey,
        slot,
        payload: normalizeRecord(payload),
      });
    }
  }
}

export function createSyncQueue({ store, repository, clock = { now: () => Date.now() } } = {}) {
  if (!store || !repository) throw new TypeError('createSyncQueue: нужны store и repository');

  function project(snapshot) {
    return replayJournal(snapshot);
  }

  async function getSyncState({ uid, journalId } = {}) {
    const snapshot = await store.readSnapshot({ uid, journalId });
    return ok({
      pending: statusCount(snapshot.outbox, 'pending'),
      sending: statusCount(snapshot.outbox, 'sending'),
      unknown: statusCount(snapshot.outbox, 'unknown'),
      acknowledged: statusCount(snapshot.outbox, 'acknowledged'),
      blocked: statusCount(snapshot.outbox, 'blocked'),
      lastSyncAtMs: clock.now(),
    });
  }

  async function mergeServerSnapshot(uid, journalId, server, local) {
    const records = [];
    const anomalies = [];

    if (server.initialization && !local.initialization) {
      records.push({ kind: 'initialization', id: journalId, payload: normalizeRecord(server.initialization) });
    } else if (server.initialization && local.initialization
      && !equivalentDomainRecord('initialization', local.initialization, server.initialization)) {
      anomalies.push({ code: 'ID_CONFLICT', kind: 'initialization', id: journalId });
    }

    mergeList('event', server.events, local.events, records, anomalies);
    mergeList('trigger', server.triggerCreations, local.triggerCreations, records, anomalies);
    mergeList('analysis', server.analyses, local.analyses, records, anomalies);
    mergeMutations(server.mutations, local.mutations, records, anomalies);

    if (records.length > 0) {
      const committed = await store.commitLocalCreate({
        uid, journalId, records, outbox: [],
      });
      if (!committed.ok) return committed;
    }
    return ok(anomalies);
  }

  async function markAllBlocked(uid, journalId, outbox, reason) {
    for (const entry of outbox) {
      if (entry.status === 'pending' || entry.status === 'unknown' || entry.status === 'sending') {
        await store.updateOutbox({
          uid, journalId, operationId: entry.operationId, status: 'blocked', error: reason,
        });
      }
    }
  }

  async function reconcileEntry(uid, journalId, entry) {
    const read = await repository.readServerPath({
      uid, journalId, relativePath: entry.path,
    });
    if (!read.ok) return read;
    if (!read.value.exists) return ok({ status: 'absent' });
    const existing = read.value.value;
    const kind = entry.kind || 'event';
    if (equivalentDomainRecord(kind, existing, entry.payload)) {
      await store.updateOutbox({
        uid, journalId, operationId: entry.operationId, status: 'acknowledged',
      });
      await store.saveReceipt({
        uid, journalId, path: entry.path, status: 'acknowledged',
        operationId: entry.operationId,
      });
      return ok({ status: 'acknowledged' });
    }
    await store.updateOutbox({
      uid, journalId, operationId: entry.operationId, status: 'blocked',
      error: 'CONFLICT_ID',
    });
    await store.saveReceipt({
      uid, journalId, path: entry.path, status: 'blocked',
      operationId: entry.operationId, error: 'CONFLICT_ID',
    });
    return ok({ status: 'blocked', reason: 'CONFLICT_ID' });
  }

  async function sendEntry(uid, journalId, entry, statuses) {
    if (entry.status === 'unknown') {
      const reconciled = await reconcileEntry(uid, journalId, entry);
      if (!reconciled.ok) return reconciled;
      if (reconciled.value.status === 'acknowledged') return ok({ status: 'acknowledged' });
      if (reconciled.value.status === 'blocked') return ok({ status: 'blocked' });
    }

    await store.updateOutbox({
      uid, journalId, operationId: entry.operationId, status: 'sending',
    });
    statuses.set(entry.operationId, 'sending');

    const created = await repository.createAtPath({
      uid, journalId, relativePath: entry.path, payload: entry.payload,
    });

    if (created.ok) {
      await store.updateOutbox({
        uid, journalId, operationId: entry.operationId, status: 'acknowledged',
        attempts: entry.attempts + 1,
      });
      await store.saveReceipt({
        uid, journalId, path: entry.path, status: 'acknowledged',
        operationId: entry.operationId,
      });
      return ok({ status: 'sent' });
    }

    if (created.error.code === 'CONFLICT_RECONFIRM') {
      const reconciled = await reconcileEntry(uid, journalId, entry);
      if (!reconciled.ok) return reconciled;
      return ok({ status: reconciled.value.status === 'acknowledged' ? 'acknowledged' : 'blocked' });
    }
    if (created.error.code === 'UNKNOWN_COMMIT') {
      await store.updateOutbox({
        uid, journalId, operationId: entry.operationId, status: 'unknown',
        attempts: entry.attempts + 1,
      });
      return ok({ status: 'unknown' });
    }
    if (created.error.code === 'ONLINE_REQUIRED') {
      await store.updateOutbox({
        uid, journalId, operationId: entry.operationId, status: 'pending',
        attempts: entry.attempts + 1,
      });
      return fail('ONLINE_REQUIRED', created.error.message, created.error.details, true);
    }
    await store.updateOutbox({
      uid, journalId, operationId: entry.operationId, status: 'blocked',
      error: created.error.code,
      attempts: entry.attempts + 1,
    });
    return ok({ status: 'blocked' });
  }

  function dependenciesSatisfied(entry, statuses) {
    for (const dependency of entry.dependencies || []) {
      const status = statuses.get(dependency);
      if (status === 'acknowledged') continue;
      return false;
    }
    return true;
  }

  function dependencyBlocked(entry, statuses) {
    for (const dependency of entry.dependencies || []) {
      if (statuses.get(dependency) === 'blocked') return true;
    }
    return false;
  }

  async function synchronize({ uid, journalId, ownerId = 'sync', nowMs } = {}) {
    if (!uid || !journalId) {
      return fail('AUTH_REQUIRED', 'Нужна авторизация владельца', { path: 'uid' });
    }
    const lease = await store.acquireSyncLease({
      uid, journalId, ownerId, nowMs: nowMs === undefined ? clock.now() : nowMs,
    });
    if (!lease.ok) return lease;
    if (!lease.value.acquired) {
      return ok({ skipped: 'lease', holder: lease.value.holder });
    }

    try {
      const localBefore = await store.readSnapshot({ uid, journalId });
      const server = await repository.readJournal({ uid, journalId });
      if (!server.ok) {
        if (server.error.code === 'AUTH_REQUIRED') {
          await markAllBlocked(uid, journalId, localBefore.outbox, 'AUTH_REQUIRED');
        }
        return server;
      }

      const merged = await mergeServerSnapshot(uid, journalId, server.value, localBefore);
      if (!merged.ok) return merged;

      const snapshot = await store.readSnapshot({ uid, journalId });
      const statuses = new Map(snapshot.outbox.map((entry) => [entry.operationId, entry.status]));
      const anomalies = [...merged.value];
      const counters = { sent: 0, acknowledged: 0, unknown: 0, blocked: 0 };
      const deferredUnknown = new Set();

      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const entry of snapshot.outbox) {
          const current = statuses.get(entry.operationId);
          if (!SENDABLE.has(current) || deferredUnknown.has(entry.operationId)) continue;

          if (!dependenciesSatisfied(entry, statuses)) {
            if (dependencyBlocked(entry, statuses)) {
              await store.updateOutbox({
                uid, journalId, operationId: entry.operationId, status: 'blocked',
                error: 'DEPENDENCY_MISSING',
              });
              statuses.set(entry.operationId, 'blocked');
              counters.blocked += 1;
              progressed = true;
            }
            continue;
          }

          const result = await sendEntry(uid, journalId, entry, statuses);
          if (!result.ok) {
            if (result.error.code === 'ONLINE_REQUIRED') {
              statuses.set(entry.operationId, 'pending');
              return fail('ONLINE_REQUIRED', result.error.message, {
                ...result.error.details,
                ...counters,
              }, true);
            }
            statuses.set(entry.operationId, 'blocked');
            counters.blocked += 1;
            progressed = true;
            continue;
          }
          statuses.set(entry.operationId, result.value.status);
          if (result.value.status === 'sent') {
            statuses.set(entry.operationId, 'acknowledged');
            counters.sent += 1;
          } else if (result.value.status === 'acknowledged') counters.acknowledged += 1;
          else if (result.value.status === 'unknown') {
            deferredUnknown.add(entry.operationId);
            counters.unknown += 1;
          } else if (result.value.status === 'blocked') counters.blocked += 1;
          progressed = true;
        }
      }

      const finalSnapshot = await store.readSnapshot({ uid, journalId });
      const projection = replayJournal(finalSnapshot);
      const fingerprint = await hashSnapshot(finalSnapshot);
      return ok({
        ...counters,
        pending: statusCount(finalSnapshot.outbox, 'pending'),
        anomalies: anomalies.concat(projection.anomalies),
        projection,
        fingerprint,
      });
    } finally {
      await store.releaseSyncLease({ uid, journalId, ownerId });
    }
  }

  return {
    synchronize,
    getSyncState,
    project,
    reconcileReceipt: async ({ uid, journalId, path, entry }) => {
      if (!entry) return fail('INVALID_DATA', 'reconcileReceipt: нужен entry');
      return reconcileEntry(uid, journalId, { ...entry, path });
    },
  };
}
