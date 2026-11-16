// Офлайн-синхронизация (ТЗ §5, §9): два изолированных store, один сервер,
// обратная доставка, равные времена, повтор, потеря ответа, зависимости.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { createDiaryStore } from '../js/harness/diary/indexeddb-store.js';
import { createFirebaseRepository } from '../js/harness/diary/firebase-repository.js';
import { createSyncQueue } from '../js/harness/diary/sync.js';
import { hashSnapshot } from '../js/harness/diary/canonical.js';
import { createMemoryServer } from './helpers/diary-memory-server.mjs';

const UID = 'uid-1';
const JOURNAL = 'journal-1';
const BASE = 1790000000000;

function eventPayload(id, occurredAtMs, overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAtMs,
    reason: 'Причина',
    categoryPolicyOperationId: 'initial',
    deviceId: 'device',
    createdAtMs: occurredAtMs,
    ...overrides,
  };
}

function triggerPayload(id, name) {
  return {
    schemaVersion: 1, triggerId: id, name, createdAtMs: BASE, deviceId: 'device',
  };
}

async function makeDevice(server, dbName, now = () => BASE) {
  const indexedDB = new IDBFactory();
  const store = createDiaryStore({
    indexedDB, name: dbName, clock: { now },
  });
  await store.open();
  const repository = createFirebaseRepository({ transport: server.transport });
  const sync = createSyncQueue({
    store,
    repository,
    clock: { now },
    generateId: (prefix) => `${prefix}-${Math.random().toString(16).slice(2)}`,
  });
  return { store, sync, repository, indexedDB };
}

async function addEvent(device, event, operationId, extra = {}) {
  return device.store.commitLocalCreate({
    uid: UID,
    journalId: JOURNAL,
    records: [{ kind: 'event', id: event.eventId, payload: event }],
    outbox: [{
      path: `events/${event.eventId}`,
      operationId,
      kind: 'event',
      payload: event,
      dependencies: [],
      ...extra,
    }],
  });
}

test('офлайн-срывы двух устройств доставляются и объединяются по ID', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  const b = await makeDevice(server, 'dev-b');

  await addEvent(a, eventPayload('event-a', BASE + 1000), 'operation-a');
  await addEvent(b, eventPayload('event-b', BASE + 1000), 'operation-b');

  const syncA = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(syncA.ok, true);
  assert.equal(syncA.value.sent, 1);

  await addEvent(b, eventPayload('event-b2', BASE + 120000), 'operation-b2');
  const syncB = await b.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(syncB.ok, true);

  const syncA2 = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(syncA2.ok, true);

  const snapshotA = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  const snapshotB = await b.store.readSnapshot({ uid: UID, journalId: JOURNAL });

  assert.deepEqual(Object.keys(snapshotA.events).sort(),
    ['event-a', 'event-b', 'event-b2']);
  assert.deepEqual(Object.keys(snapshotB.events).sort(),
    ['event-a', 'event-b', 'event-b2']);
  assert.equal(snapshotA.events['event-b'].occurredAtMs, BASE + 1000,
    'равные времена не схлопываются');
  assert.equal(await hashSnapshot(snapshotA), await hashSnapshot(snapshotB));
});

test('доставка в обратном порядке даёт ту же проекцию', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  const b = await makeDevice(server, 'dev-b');

  await addEvent(a, eventPayload('event-a', BASE + 5000), 'operation-a');
  await addEvent(a, eventPayload('event-a2', BASE + 1000), 'operation-a2');
  await a.sync.synchronize({ uid: UID, journalId: JOURNAL });

  await b.sync.synchronize({ uid: UID, journalId: JOURNAL });
  const snapshot = await b.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  const remote = a.sync.project(snapshot);
  assert.deepEqual(remote.events.map((item) => item.eventId), ['event-a2', 'event-a']);
});

test('повторная доставка пакета не создаёт дубль', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  const event = eventPayload('event-a', BASE + 1000);
  await addEvent(a, event, 'operation-a');

  const first = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(first.value.sent, 1);

  // Ответ потерян: неизвестно, принят ли create. Повторяется тот же operationId/payload.
  await a.store.updateOutbox({
    uid: UID, journalId: JOURNAL, operationId: 'operation-a', status: 'unknown',
  });
  const second = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(second.ok, true);
  assert.equal(second.value.acknowledged, 1);
  assert.equal(second.value.sent, 0);
  assert.equal(server.data.size, 1);
  assert.equal(server.creates.length, 1);
});

test('потеря ответа после серверного commit: unknown → проверка того же пути', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  const event = eventPayload('event-a', BASE + 1000);
  await addEvent(a, event, 'operation-a');
  server.state.loseResponseFor.add(`diaryV1/${UID}/journals/${JOURNAL}/events/event-a`);

  const first = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(first.ok, true);
  assert.equal(first.value.unknown, 1);

  const second = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(second.value.acknowledged, 1);
  assert.equal(second.value.unknown, 0);
  assert.equal(server.creates.length, 1, 'новая операция не создаётся');
});

test('перезапуск в sending: unknown и без удаления payload', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  await addEvent(a, eventPayload('event-a', BASE + 1000), 'operation-a');
  await a.store.updateOutbox({
    uid: UID, journalId: JOURNAL, operationId: 'operation-a', status: 'sending',
  });
  await a.store.close();

  const reopened = createDiaryStore({
    indexedDB: a.indexedDB, name: 'dev-a', clock: { now: () => BASE },
  });
  await reopened.open();
  const snapshot = await reopened.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.outbox[0].status, 'unknown');
  assert.equal(snapshot.outbox[0].payload.eventId, 'event-a');
});

test('зависимость нового триггера: сначала триггер, затем срыв', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  const trigger = triggerPayload('trigger-a', 'Стресс');
  const event = eventPayload('event-a', BASE + 1000, { triggerId: 'trigger-a', reason: undefined });

  await a.store.commitLocalCreate({
    uid: UID, journalId: JOURNAL,
    records: [{ kind: 'trigger', id: 'trigger-a', payload: trigger }],
    outbox: [{
      path: 'triggerCreations/trigger-a', operationId: 'operation-trigger',
      kind: 'trigger', payload: trigger, dependencies: [],
    }],
  });
  await a.store.commitLocalCreate({
    uid: UID, journalId: JOURNAL,
    records: [{ kind: 'event', id: 'event-a', payload: event }],
    outbox: [{
      path: 'events/event-a', operationId: 'operation-event', kind: 'event',
      payload: event, dependencies: ['operation-trigger'],
    }],
  });

  const result = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(result.ok, true);
  assert.deepEqual(server.creates.map((item) => item.path), [
    `diaryV1/${UID}/journals/${JOURNAL}/triggerCreations/trigger-a`,
    `diaryV1/${UID}/journals/${JOURNAL}/events/event-a`,
  ]);
});

test('permission-denied блокирует запись без бесконечного повтора', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  await addEvent(a, eventPayload('event-a', BASE + 1000), 'operation-a');
  server.state.permissionDenied = true;

  const result = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH_REQUIRED');

  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.outbox[0].status, 'blocked');
  assert.equal(snapshot.events['event-a'] !== undefined, true, 'локальная история сохранена');
});

test('offline: локальные срывы сохранены, повтор при появлении сети', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  await addEvent(a, eventPayload('event-a', BASE + 1000), 'operation-a');
  server.state.offline = true;

  const result = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ONLINE_REQUIRED');
  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.outbox[0].status, 'pending');

  server.state.offline = false;
  const retry = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(retry.ok, true);
  assert.equal(retry.value.sent, 1);
});

test('конфликт ID с другим payload блокируется без перезаписи', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  const path = `diaryV1/${UID}/journals/${JOURNAL}/events/event-a`;
  await server.transport._seed(path, eventPayload('event-a', BASE + 9999, { reason: 'Чужое' }));

  await addEvent(a, eventPayload('event-a', BASE + 1000), 'operation-a');
  const result = await a.sync.synchronize({ uid: UID, journalId: JOURNAL });
  assert.equal(result.ok, true);
  assert.equal(result.value.blocked, 1);

  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.outbox[0].status, 'blocked');
  const stored = await server.transport._get(path);
  assert.equal(stored.reason, 'Чужое', 'сервер не перезаписан');
});
