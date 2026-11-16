/* Команды домена (ТЗ §2, §3, §6, §9): initializeDiary, createTrigger,
   confirmRelapse — офлайн-create; prepareMutation/commitMutation — только онлайн,
   с явным согласием и без скрытой очереди. */

import { canonicalize, hashSnapshot, semanticRecord } from './canonical.js';
import { fail, ok, sanitizeMessage } from './errors.js';
import { newId } from './ids.js';
import { effectivePolicy, replayJournal, walkMutationChain } from './projection.js';
import {
  normalizeRecord,
  parseDuration,
  validateChanges,
  validateEvent,
  validateInitialization,
  validateMutation,
  validateTrigger,
  SCHEMA_VERSION,
} from './schema.js';

const SERVER_TIMESTAMP = { '.sv': 'timestamp' };

export async function resolveUid(auth) {
  if (!auth || typeof auth.getUid !== 'function') {
    return fail('AUTH_REQUIRED', 'Нужен Auth-адаптер владельца');
  }
  try {
    const uid = await auth.getUid();
    if (typeof uid !== 'string' || !uid) {
      return fail('AUTH_REQUIRED', 'Нет авторизованного uid');
    }
    return ok(uid);
  } catch (error) {
    return fail('AUTH_REQUIRED', sanitizeMessage(error && error.message));
  }
}

function typeForEntity(entityKey) {
  if (entityKey === 'categoryPolicy') return 'applyCategoryPolicy';
  if (typeof entityKey === 'string' && entityKey.startsWith('event_')) return 'editEvent';
  if (typeof entityKey === 'string' && entityKey.startsWith('trigger_')) return 'renameTrigger';
  return null;
}

function entityTarget(server, entityKey) {
  if (entityKey.startsWith('event_')) {
    return { kind: 'event', id: entityKey.slice(6), record: server.events[entityKey.slice(6)] };
  }
  if (entityKey.startsWith('trigger_')) {
    return {
      kind: 'trigger',
      id: entityKey.slice(8),
      record: server.triggerCreations[entityKey.slice(8)],
    };
  }
  return { kind: 'categoryPolicy', id: null, record: null };
}

function serverSnapshot(server) {
  return {
    initialization: server.initialization ? normalizeRecord(server.initialization) : null,
    events: server.events || {},
    triggerCreations: server.triggerCreations || {},
    mutations: server.mutations || {},
    analyses: server.analyses || {},
  };
}

function basisFor(kind, record) {
  return canonicalize(semanticRecord(kind, record || {}));
}

export function createCommands({
  auth,
  repository,
  store,
  clock,
  journalId,
  deviceId,
  crypto,
} = {}) {
  if (!repository || !store || !clock) {
    throw new TypeError('createCommands: нужны repository, store, clock');
  }

  function id(prefix) {
    return newId(prefix, crypto);
  }

  async function persistAcceptedMutation(uid, proposal, node, slot) {
    const committed = await store.commitLocalCreate({
      uid,
      journalId,
      records: [{
        kind: 'mutation',
        id: node.operationId,
        entityKey: proposal.entityKey,
        slot,
        payload: node,
      }],
      outbox: [],
    });
    if (!committed.ok) return committed;
    await store.saveReceipt({
      uid,
      journalId,
      path: `mutations/${proposal.entityKey}/${slot}`,
      status: 'acknowledged',
      operationId: node.operationId,
    });
    return ok(true);
  }

  async function initializeDiary({ duration, initialDurationMs, timeZone } = {}) {
    const uidResult = await resolveUid(auth);
    if (!uidResult.ok) return uidResult;
    const uid = uidResult.value;

    const local = await store.readSnapshot({ uid, journalId });
    if (local.initialization) {
      const checked = validateInitialization(local.initialization);
      if (!checked.ok) return checked;
      return ok({ initialization: checked.value, adopted: false, local: true });
    }

    let durationMs = initialDurationMs;
    if (typeof duration === 'string') {
      const parsed = parseDuration(duration);
      if (!parsed.ok) return parsed;
      durationMs = parsed.value;
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      return fail('INVALID_DATA', 'Нужна длительность HH:MM или initialDurationMs', {
        path: 'duration',
      });
    }
    if (!timeZone) {
      return fail('INVALID_DATA', 'Нужен IANA-пояс', { path: 'timeZone' });
    }

    const server = await repository.readJournal({ uid, journalId });
    if (!server.ok) return server;

    if (server.value.initialization) {
      const checked = validateInitialization(server.value.initialization);
      if (!checked.ok) return checked;
      const saved = await store.commitLocalCreate({
        uid,
        journalId,
        records: [{ kind: 'initialization', id: journalId, payload: checked.value }],
        outbox: [],
      });
      if (!saved.ok) return saved;
      return ok({ initialization: checked.value, adopted: true });
    }

    const nowMs = clock.now();
    const initialization = {
      schemaVersion: SCHEMA_VERSION,
      journalId,
      startedAtMs: nowMs - durationMs,
      initialDurationMs: durationMs,
      timeZone,
      createdAtMs: nowMs,
      deviceId,
      acceptedAtMs: SERVER_TIMESTAMP,
    };
    const checked = validateInitialization(initialization);
    if (!checked.ok) return checked;

    const created = await repository.createAtPath({
      uid,
      journalId,
      relativePath: 'initialization',
      payload: checked.value,
    });

    if (!created.ok) {
      if (created.error.code === 'CONFLICT_RECONFIRM'
        || created.error.code === 'UNKNOWN_COMMIT') {
        const reread = await repository.readJournal({ uid, journalId });
        if (!reread.ok) return created;
        if (reread.value.initialization) {
          const serverInit = validateInitialization(reread.value.initialization);
          if (!serverInit.ok) return serverInit;
          const saved = await store.commitLocalCreate({
            uid,
            journalId,
            records: [{ kind: 'initialization', id: journalId, payload: serverInit.value }],
            outbox: [],
          });
          if (!saved.ok) return saved;
          return ok({ initialization: serverInit.value, adopted: true });
        }
        return created;
      }
      return created;
    }

    const saved = await store.commitLocalCreate({
      uid,
      journalId,
      records: [{ kind: 'initialization', id: journalId, payload: checked.value }],
      outbox: [],
    });
    if (!saved.ok) return saved;
    return ok({ initialization: checked.value, adopted: false, local: 'committed' });
  }

  async function createTrigger({ name } = {}) {
    const uidResult = await resolveUid(auth);
    if (!uidResult.ok) return uidResult;
    const uid = uidResult.value;

    const snapshot = await store.readSnapshot({ uid, journalId });
    if (!snapshot.initialization) {
      return fail('DEPENDENCY_MISSING', 'Сначала нужна initialization', {
        path: 'initialization',
      });
    }

    const triggerId = id('trigger');
    const nowMs = clock.now();
    const trigger = {
      schemaVersion: SCHEMA_VERSION,
      triggerId,
      name,
      createdAtMs: nowMs,
      deviceId,
      acceptedAtMs: SERVER_TIMESTAMP,
    };
    const checked = validateTrigger(trigger);
    if (!checked.ok) return checked;

    const operationId = id('operation');
    const committed = await store.commitLocalCreate({
      uid,
      journalId,
      records: [{ kind: 'trigger', id: triggerId, payload: checked.value }],
      outbox: [{
        path: `triggerCreations/${triggerId}`,
        operationId,
        kind: 'trigger',
        payload: checked.value,
        dependencies: [],
      }],
    });
    if (!committed.ok) return committed;
    return ok({
      trigger: checked.value,
      operationId,
      local: 'committed',
    });
  }

  async function confirmRelapse({ reason, triggerId } = {}) {
    const uidResult = await resolveUid(auth);
    if (!uidResult.ok) return uidResult;
    const uid = uidResult.value;

    const snapshot = await store.readSnapshot({ uid, journalId });
    if (!snapshot.initialization) {
      return fail('DEPENDENCY_MISSING', 'Сначала нужна initialization', {
        path: 'initialization',
      });
    }

    if (triggerId !== undefined && triggerId !== null) {
      if (typeof triggerId !== 'string' || !snapshot.triggerCreations[triggerId]) {
        return fail('DEPENDENCY_MISSING', 'Триггер не найден', { path: 'triggerId' });
      }
    }

    const nowMs = clock.now();
    let categoryId;
    let categoryPolicyOperationId = 'initial';
    if (typeof triggerId === 'string') {
      const policy = effectivePolicy(snapshot.mutations).policy;
      if (policy && policy.triggerMappings[triggerId]) {
        categoryId = policy.triggerMappings[triggerId];
        categoryPolicyOperationId = policy.operationId;
      }
    }

    const eventId = id('event');
    const event = {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      occurredAtMs: nowMs,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(typeof triggerId === 'string' ? { triggerId } : {}),
      categoryPolicyOperationId,
      ...(categoryId ? { categoryId } : {}),
      deviceId,
      createdAtMs: nowMs,
      acceptedAtMs: SERVER_TIMESTAMP,
    };
    const checked = validateEvent(event, { eventId });
    if (!checked.ok) return checked;

    let dependencies = [];
    if (typeof triggerId === 'string') {
      const triggerEntry = snapshot.outbox.find((entry) => entry.kind === 'trigger'
        && entry.payload && entry.payload.triggerId === triggerId);
      if (triggerEntry && triggerEntry.status !== 'acknowledged') {
        dependencies = [triggerEntry.operationId];
      }
    }

    const operationId = id('operation');
    const committed = await store.commitLocalCreate({
      uid,
      journalId,
      records: [{ kind: 'event', id: eventId, payload: checked.value }],
      outbox: [{
        path: `events/${eventId}`,
        operationId,
        kind: 'event',
        payload: checked.value,
        dependencies,
      }],
    });
    if (!committed.ok) return committed;

    return ok({
      event: checked.value,
      operationId,
      local: 'committed',
      timeAnomaly: false,
    });
  }

  async function prepareMutation({ entityKey, changes, type } = {}) {
    const uidResult = await resolveUid(auth);
    if (!uidResult.ok) return uidResult;
    const uid = uidResult.value;

    const mutationType = type || typeForEntity(entityKey);
    if (!mutationType) {
      return fail('INVALID_DATA', 'Недопустимый entityKey', { path: 'entityKey' });
    }
    const changesChecked = validateChanges(mutationType, changes);
    if (changesChecked) return changesChecked;

    const server = await repository.readJournal({ uid, journalId });
    if (!server.ok) return server;
    const snapshot = serverSnapshot(server.value);

    if (!snapshot.initialization) {
      return fail('DEPENDENCY_MISSING', 'Серверный дневник не инициализирован', {
        path: 'initialization',
      });
    }

    const target = entityTarget(snapshot, entityKey);
    if (target.kind !== 'categoryPolicy' && !target.record) {
      return fail('DEPENDENCY_MISSING', 'Целевая сущность отсутствует', {
        path: 'entityKey',
      });
    }

    const chain = walkMutationChain(snapshot.mutations, entityKey);
    if (chain.value.anomalies.length > 0) {
      return fail('INVALID_DATA', 'Цепь правок повреждена', {
        path: 'mutations',
        anomalies: chain.value.anomalies,
      });
    }
    const headOperationId = chain.value.headOperationId;

    const projection = replayJournal(snapshot);
    const normalizedChanges = normalizeRecord(changes);

    if (mutationType === 'editEvent') {
      const targetEffective = projection.events.find((item) => item.eventId === target.id);
      if (!targetEffective) {
        return fail('DEPENDENCY_MISSING', 'Событие отсутствует в проекции');
      }
      const others = projection.events.filter((item) => item.eventId !== target.id);
      const currentMs = targetEffective.occurredAtMs;

      if (normalizedChanges.occurredAtMs !== undefined) {
        const nextMs = normalizedChanges.occurredAtMs;
        if (nextMs > clock.now()) {
          return fail('INVALID_DATA', 'Время не может быть будущим', {
            path: 'occurredAtMs',
          });
        }
        if (nextMs < snapshot.initialization.startedAtMs) {
          return fail('INVALID_DATA', 'Время раньше начала учёта', {
            path: 'occurredAtMs',
          });
        }
        const previous = others
          .filter((item) => item.occurredAtMs < currentMs)
          .reduce((max, item) => (max === null || item.occurredAtMs > max ? item.occurredAtMs : max), null);
        const next = others
          .filter((item) => item.occurredAtMs > currentMs)
          .reduce((min, item) => (min === null || item.occurredAtMs < min ? item.occurredAtMs : min), null);
        if (previous !== null && nextMs <= previous) {
          return fail('INVALID_DATA', 'Время пересекает предыдущего соседа', {
            path: 'occurredAtMs',
          });
        }
        if (next !== null && nextMs >= next) {
          return fail('INVALID_DATA', 'Время пересекает следующего соседа', {
            path: 'occurredAtMs',
          });
        }
      }

      const effective = {
        ...target.record,
        ...normalizedChanges,
      };
      if (normalizedChanges.reason !== undefined || normalizedChanges.triggerId !== undefined) {
        const effectiveChecked = validateEvent(effective);
        if (!effectiveChecked.ok) return effectiveChecked;
        if (normalizedChanges.triggerId
          && !snapshot.triggerCreations[normalizedChanges.triggerId]) {
          return fail('DEPENDENCY_MISSING', 'Триггер не найден на сервере', {
            path: 'changes.triggerId',
          });
        }
      }
    }

    const basisFingerprint = await hashSnapshot(snapshot);
    const operations = chain.value.operations;
    const predecessorSlot = operations.length === 0
      ? undefined
      : operations.length === 1
        ? 'initial'
        : operations[operations.length - 2].operationId;

    return ok({
      schemaVersion: SCHEMA_VERSION,
      entityKey,
      type: mutationType,
      changes: normalizedChanges,
      operationId: id('operation'),
      headOperationId,
      predecessorSlot,
      basisFingerprint,
      basisTarget: basisFor(target.kind, target.record),
      basisInitialization: basisFor('initialization', snapshot.initialization),
      createdAtMs: clock.now(),
      deviceId,
      targetId: target.id,
    });
  }

  async function commitMutation(proposal, explicitConsent) {
    const consent = explicitConsent === true
      || (explicitConsent && explicitConsent.consent === true);
    if (!consent) {
      return fail('INVALID_DATA', 'Нужно явное подтверждение правки', { path: 'consent' });
    }
    if (!proposal || typeof proposal.entityKey !== 'string') {
      return fail('INVALID_DATA', 'Нужен proposal от prepareMutation');
    }
    const uidResult = await resolveUid(auth);
    if (!uidResult.ok) return uidResult;
    const uid = uidResult.value;

    const slot = proposal.headOperationId || 'initial';

    // Потерянный ответ: сначала проверить прежний путь, операция могла быть принята.
    const existingAtSlot = await repository.readServerPath({
      uid, journalId, relativePath: `mutations/${proposal.entityKey}/${slot}`,
    });
    if (!existingAtSlot.ok) return existingAtSlot;
    if (existingAtSlot.value.exists
      && existingAtSlot.value.value
      && existingAtSlot.value.value.operationId === proposal.operationId
      && equivalentProposalNode(existingAtSlot.value.value, proposal)) {
      const persisted = await persistAcceptedMutation(uid, proposal, existingAtSlot.value.value, slot);
      if (!persisted.ok) return persisted;
      return ok({
        operationId: proposal.operationId,
        headOperationId: proposal.operationId,
        accepted: true,
        recovered: true,
      });
    }

    const server = await repository.readJournal({ uid, journalId });
    if (!server.ok) return server;
    const snapshot = serverSnapshot(server.value);
    if (!snapshot.initialization) {
      return fail('DEPENDENCY_MISSING', 'Серверный дневник не инициализирован');
    }

    const chain = walkMutationChain(snapshot.mutations, proposal.entityKey);
    if (chain.value.anomalies.length > 0) {
      return fail('INVALID_DATA', 'Цепь правок повреждена', { path: 'mutations' });
    }
    if (chain.value.headOperationId !== proposal.headOperationId) {
      return fail('CONFLICT_RECONFIRM', 'Head цепочки изменился', {
        expectedHead: proposal.headOperationId,
        actualHead: chain.value.headOperationId,
      });
    }

    const target = entityTarget(snapshot, proposal.entityKey);
    if (proposal.basisTarget !== basisFor(target.kind, target.record)) {
      return fail('CONFLICT_RECONFIRM', 'Целевая сущность изменилась', {
        entityKey: proposal.entityKey,
      });
    }
    if (proposal.basisInitialization
      !== basisFor('initialization', snapshot.initialization)) {
      return fail('CONFLICT_RECONFIRM', 'Initialization изменилась');
    }

    const node = {
      schemaVersion: SCHEMA_VERSION,
      operationId: proposal.operationId,
      predecessorOperationId: slot,
      ...(proposal.predecessorSlot ? { predecessorSlot: proposal.predecessorSlot } : {}),
      entityKey: proposal.entityKey,
      type: proposal.type,
      changes: normalizeRecord(proposal.changes),
      basisFingerprint: proposal.basisFingerprint,
      createdAtMs: clock.now(),
      deviceId,
      acceptedAtMs: SERVER_TIMESTAMP,
    };
    const checked = validateMutation(node, {
      slot,
      entityKey: proposal.entityKey,
    });
    if (!checked.ok) return checked;

    const created = await repository.createAtPath({
      uid,
      journalId,
      relativePath: `mutations/${proposal.entityKey}/${slot}`,
      payload: checked.value,
    });

    if (created.ok) {
      const persisted = await persistAcceptedMutation(uid, proposal, checked.value, slot);
      if (!persisted.ok) return persisted;
      return ok({
        operationId: proposal.operationId,
        headOperationId: proposal.operationId,
        accepted: true,
      });
    }

    if (created.error.code === 'CONFLICT_RECONFIRM') {
      const reread = await repository.readServerPath({
        uid, journalId, relativePath: `mutations/${proposal.entityKey}/${slot}`,
      });
      if (reread.ok && reread.value.exists && reread.value.value
        && reread.value.value.operationId === proposal.operationId
        && equivalentProposalNode(reread.value.value, proposal)) {
        const persisted = await persistAcceptedMutation(uid, proposal, reread.value.value, slot);
        if (!persisted.ok) return persisted;
        return ok({
          operationId: proposal.operationId,
          headOperationId: proposal.operationId,
          accepted: true,
          recovered: true,
        });
      }
      return fail('CONFLICT_RECONFIRM', 'Слот занят другой правкой', {
        entityKey: proposal.entityKey,
        slot,
      });
    }
    return created;
  }

  function equivalentProposalNode(node, proposal) {
    return node.entityKey === proposal.entityKey
      && node.type === proposal.type
      && canonicalize(normalizeRecord(node.changes)) === canonicalize(normalizeRecord(proposal.changes));
  }

  return {
    initializeDiary,
    createTrigger,
    confirmRelapse,
    prepareMutation,
    commitMutation,
  };
}
