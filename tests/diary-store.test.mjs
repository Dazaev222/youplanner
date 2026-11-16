// Локальное хранилище IndexedDB (ТЗ §5, §9): атомарность records+outbox,
// ошибка квоты, разграничение uid, lease двух вкладок, перезапуск, миграция.
//
// fake-indexeddb — maintained fake для unit-тестов. Реальная браузерная
// проверка IndexedDB этим файлом НЕ доказана.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { createDiaryStore, mapStorageError } from '../js/harness/diary/indexeddb-store.js';

const NOW = 1790000000000;
const UID = 'uid-owner-1';
const JOURNAL = 'journal-1';

function makeStore({ name = 'diary-test', version = 1, indexedDB = new IDBFactory() } = {}) {
  return {
    indexedDB,
    store: createDiaryStore({
      indexedDB,
      name,
      version,
      clock: { now: () => NOW },
    }),
  };
}

function eventRecord(id = 'event-a') {
  return {
    kind: 'event',
    id,
    payload: {
      schemaVersion: 1,
      eventId: id,
      occurredAtMs: NOW,
      reason: 'Причина',
      categoryPolicyOperationId: 'initial',
      deviceId: 'd',
      createdAtMs: NOW,
    },
  };
}

function outboxEntry(overrides = {}) {
  return {
    path: `diaryV1/${UID}/journals/${JOURNAL}/events/event-a`,
    operationId: 'operation-1',
    payload: { eventId: 'event-a' },
    dependencies: [],
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

test('commitLocalCreate: событие и outbox фиксируются вместе', async () => {
  const { store } = makeStore();
  await store.open();
  const result = await store.commitLocalCreate({
    uid: UID,
    journalId: JOURNAL,
    records: [eventRecord()],
    outbox: [outboxEntry()],
  });
  assert.equal(result.ok, true);

  const snapshot = await store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.events['event-a'].reason, 'Причина');
  assert.equal(snapshot.outbox.length, 1);
  assert.equal(snapshot.outbox[0].status, 'pending');
  assert.deepEqual(snapshot.outbox[0].payload, { eventId: 'event-a' });
});

test('commitLocalCreate: сбой посреди транзакции откатывает и records, и outbox', async () => {
  const { store } = makeStore();
  await store.open();
  const result = await store.commitLocalCreate({
    uid: UID,
    journalId: JOURNAL,
    records: [eventRecord('event-a'), { kind: 'event', id: undefined, payload: {} }],
    outbox: [outboxEntry()],
  });
  assert.equal(result.ok, false);

  const snapshot = await store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.deepEqual(Object.keys(snapshot.events), [], 'частичная запись недопустима');
  assert.deepEqual(snapshot.outbox, [], 'outbox не должен остаться после сбоя');
});

test('ошибка квоты распознаётся как STORAGE_FULL, не ложный успех', () => {
  const quota = new Error('quota');
  quota.name = 'QuotaExceededError';
  const mapped = mapStorageError(quota);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.error.code, 'STORAGE_FULL');

  const other = new Error('DataError');
  other.name = 'DataError';
  assert.equal(mapStorageError(other).error.code, 'INVALID_DATA');
});

test('пространство ключей разделяет uid и journalId', async () => {
  const { store } = makeStore();
  await store.open();
  await store.commitLocalCreate({
    uid: 'uid-a', journalId: 'journal-1',
    records: [eventRecord('event-a')], outbox: [outboxEntry()],
  });
  await store.commitLocalCreate({
    uid: 'uid-b', journalId: 'journal-1',
    records: [eventRecord('event-b')], outbox: [],
  });

  const first = await store.readSnapshot({ uid: 'uid-a', journalId: 'journal-1' });
  const second = await store.readSnapshot({ uid: 'uid-b', journalId: 'journal-1' });
  assert.deepEqual(Object.keys(first.events), ['event-a']);
  assert.deepEqual(Object.keys(second.events), ['event-b']);
  assert.equal(first.outbox.length, 1);
  assert.equal(second.outbox.length, 0);
});

test('lease: одна вкладка держит, вторая ждёт истечения', async () => {
  const { indexedDB } = makeStore();
  const first = createDiaryStore({ indexedDB, name: 'diary-lease', clock: { now: () => NOW } });
  const second = createDiaryStore({ indexedDB, name: 'diary-lease', clock: { now: () => NOW } });
  await first.open();
  await second.open();

  const a = await first.acquireSyncLease({
    uid: UID, journalId: JOURNAL, ownerId: 'tab-a', ttlMs: 5000,
  });
  assert.equal(a.ok, true);
  assert.equal(a.value.acquired, true);

  const b = await second.acquireSyncLease({
    uid: UID, journalId: JOURNAL, ownerId: 'tab-b', ttlMs: 5000,
  });
  assert.equal(b.ok, true);
  assert.equal(b.value.acquired, false);
  assert.equal(b.value.holder, 'tab-a');

  const c = await second.acquireSyncLease({
    uid: UID, journalId: JOURNAL, ownerId: 'tab-b', ttlMs: 5000,
    nowMs: NOW + 6000,
  });
  assert.equal(c.value.acquired, true);
});

test('перезапуск: sending превращается в unknown, payload не удалён', async () => {
  const { indexedDB } = makeStore();
  const name = 'diary-restart';
  const first = createDiaryStore({ indexedDB, name, clock: { now: () => NOW } });
  await first.open();
  await first.commitLocalCreate({
    uid: UID, journalId: JOURNAL, records: [eventRecord()], outbox: [outboxEntry()],
  });
  await first.updateOutbox({
    uid: UID, journalId: JOURNAL, operationId: 'operation-1', status: 'sending',
  });
  await first.close();

  const second = createDiaryStore({ indexedDB, name, clock: { now: () => NOW } });
  await second.open();
  const snapshot = await second.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.outbox[0].status, 'unknown');
  assert.deepEqual(snapshot.outbox[0].payload, { eventId: 'event-a' });
});

test('квитанции, прогресс импорта и черновики анализа сохраняются раздельно', async () => {
  const { store } = makeStore();
  await store.open();
  await store.saveReceipt({
    uid: UID, journalId: JOURNAL,
    path: `diaryV1/${UID}/journals/${JOURNAL}/events/event-a`,
    status: 'acknowledged', operationId: 'operation-1', payloadHash: 'sha256:' + 'a'.repeat(64),
  });
  await store.saveImportProgress({
    uid: UID, journalId: JOURNAL, sessionId: 'import-1',
    progress: { stage: 'events', done: 3, total: 10 },
  });
  await store.saveAnalysisDraft({ uid: UID, journalId: JOURNAL, draftId: 'draft-1', payload: { summary: 'x' } });

  const snapshot = await store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.receipts[0].status, 'acknowledged');
  assert.deepEqual(await store.readImportProgress({
    uid: UID, journalId: JOURNAL, sessionId: 'import-1',
  }), { stage: 'events', done: 3, total: 10 });
  assert.equal((await store.readAnalysisDrafts({ uid: UID, journalId: JOURNAL })).length, 1);
});

test('миграция версии сохраняет историю', async () => {
  const { indexedDB } = makeStore();
  const name = 'diary-migrate';
  const v1 = createDiaryStore({ indexedDB, name, version: 1, clock: { now: () => NOW } });
  await v1.open();
  await v1.commitLocalCreate({
    uid: UID, journalId: JOURNAL, records: [eventRecord()], outbox: [outboxEntry()],
  });
  await v1.close();

  const v2 = createDiaryStore({ indexedDB, name, version: 2, clock: { now: () => NOW } });
  await v2.open();
  const snapshot = await v2.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.events['event-a'].reason, 'Причина');
  assert.equal(snapshot.outbox.length, 1);
});
