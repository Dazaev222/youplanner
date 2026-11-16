// Интеграция service API без UI (ТЗ §10 этап 9): инициализация, офлайн-триггер
// и срыв, второе устройство, одинаковые проекция и fingerprint, конфликт правки.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { createDiaryStore } from '../js/harness/diary/indexeddb-store.js';
import { createFirebaseRepository } from '../js/harness/diary/firebase-repository.js';
import { createDiaryService } from '../js/harness/diary/index.js';
import { createMemoryServer } from './helpers/diary-memory-server.mjs';

const UID = 'uid-owner';
const JOURNAL = 'journal-service';
const T0 = Date.parse('2026-02-01T09:00:00Z');
const HOUR = 3600000;

async function makeDevice(server, name, { uid = UID } = {}) {
  const indexedDB = new IDBFactory();
  const state = { now: T0 };
  const store = createDiaryStore({ indexedDB, name, clock: { now: () => state.now } });
  await store.open();
  const repository = createFirebaseRepository({ transport: server.transport });
  const service = createDiaryService({
    auth: { getUid: () => uid },
    repository,
    store,
    clock: { now: () => state.now },
    journalId: JOURNAL,
    deviceId: name,
  });
  return { indexedDB, store, repository, service, state };
}

test('полный цикл двух устройств: офлайн-срыв, синхронизация, равные fingerprint', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  const b = await makeDevice(server, 'device-b');

  const initA = await a.service.initializeDiary({ duration: '10:00', timeZone: 'Europe/Moscow' });
  assert.equal(initA.ok, true);
  assert.equal(initA.value.initialization.startedAtMs, T0 - 10 * HOUR);

  a.state.now = T0 + HOUR;
  const relapseA = await a.service.confirmRelapse({ reason: 'Стресс' });
  assert.equal(relapseA.ok, true);
  assert.equal(relapseA.value.local, 'committed');

  const pendingState = await a.service.getSyncState();
  assert.equal(pendingState.value.pending, 1);

  const syncA = await a.service.synchronize();
  assert.equal(syncA.ok, true);
  assert.equal(syncA.value.sent, 1);

  const initB = await b.service.initializeDiary({ duration: '99:00', timeZone: 'Asia/Tokyo' });
  assert.equal(initB.ok, true);
  assert.equal(initB.value.adopted, true);
  assert.equal(initB.value.initialization.startedAtMs, T0 - 10 * HOUR,
    'проигравший первичную настройку принимает серверную');

  await b.service.synchronize();
  b.state.now = T0 + 2 * HOUR;
  const relapseB = await b.service.confirmRelapse({ reason: 'Усталость' });
  assert.equal(relapseB.ok, true);
  await b.service.synchronize();
  await a.service.synchronize();

  const projectionA = await a.service.getProjection();
  const projectionB = await b.service.getProjection();
  assert.deepEqual(
    projectionA.events.map(({ source, ...rest }) => rest),
    projectionB.events.map(({ source, ...rest }) => rest),
  );
  assert.equal(projectionA.relapseCount, 2);
  assert.equal(await a.service.getFingerprint(), await b.service.getFingerprint());
});

test('офлайн новый триггер отправляется до срыва, таймер видит pending-событие', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  await a.service.initializeDiary({ duration: '00:00', timeZone: 'Europe/Moscow' });
  server.state.offline = true;

  const trigger = await a.service.createTrigger({ name: 'Стресс' });
  assert.equal(trigger.ok, true);
  assert.equal(trigger.value.local, 'committed');

  a.state.now = T0 + HOUR;
  const relapse = await a.service.confirmRelapse({ triggerId: trigger.value.trigger.triggerId });
  assert.equal(relapse.ok, true);

  const projectionOffline = await a.service.getProjection();
  assert.equal(projectionOffline.relapseCount, 1, 'pending-событие сразу в проекции');
  assert.equal(projectionOffline.currentMs, 0);

  server.state.offline = false;
  const sync = await a.service.synchronize();
  assert.equal(sync.ok, true);
  assert.equal(sync.value.sent, 2);

  const paths = server.creates.map((item) => item.path.split('/').slice(-2).join('/'))
    .filter((path) => path.startsWith('triggerCreations/') || path.startsWith('events/'));
  assert.deepEqual(paths, ['triggerCreations/' + trigger.value.trigger.triggerId,
    'events/' + relapse.value.event.eventId]);
});

test('новая настройка без сети: ONLINE_REQUIRED и без локальной initialization', async () => {
  const server = createMemoryServer();
  server.state.offline = true;
  const a = await makeDevice(server, 'device-a');
  const result = await a.service.initializeDiary({ duration: '01:00', timeZone: 'Europe/Moscow' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ONLINE_REQUIRED');
  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.initialization, null);
});

test('повторная инициализация с локальной историей не требует сети', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  await a.service.initializeDiary({ duration: '01:00', timeZone: 'Europe/Moscow' });
  server.state.offline = true;
  const again = await a.service.initializeDiary({ duration: '05:00', timeZone: 'Europe/Moscow' });
  assert.equal(again.ok, true);
  assert.equal(again.value.local, true);
  assert.equal(again.value.initialization.initialDurationMs, HOUR);
});

test('нет авторизации: AUTH_REQUIRED до любых записей', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-anon', { uid: null });
  const result = await a.service.initializeDiary({ duration: '01:00', timeZone: 'Europe/Moscow' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH_REQUIRED');
  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.initialization, null);
  assert.equal(server.creates.length, 0);
});

test('конфликт правки: проигравший переподтверждает на новом head', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  const b = await makeDevice(server, 'device-b');
  await a.service.initializeDiary({ duration: '10:00', timeZone: 'Europe/Moscow' });
  a.state.now = T0 + HOUR;
  const relapse = await a.service.confirmRelapse({ reason: 'Исходная' });
  await a.service.synchronize();
  await b.service.initializeDiary({ duration: '10:00', timeZone: 'Europe/Moscow' });
  await b.service.synchronize();

  const eventKey = `event_${relapse.value.event.eventId}`;
  const proposalA = await a.service.prepareMutation({
    entityKey: eventKey, changes: { reason: 'Правка A' },
  });
  const proposalB = await b.service.prepareMutation({
    entityKey: eventKey, changes: { reason: 'Правка B' },
  });
  assert.equal((await a.service.commitMutation(proposalA.value, true)).ok, true);

  const conflict = await b.service.commitMutation(proposalB.value, true);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'CONFLICT_RECONFIRM');

  await b.service.synchronize();
  const reproposal = await b.service.prepareMutation({
    entityKey: eventKey, changes: { reason: 'Правка B' },
  });
  const accepted = await b.service.commitMutation(reproposal.value, true);
  assert.equal(accepted.ok, true);

  await a.service.synchronize();
  const projection = await a.service.getProjection();
  const effective = projection.events.find((item) => item.eventId === relapse.value.event.eventId);
  assert.equal(effective.reason, 'Правка B');
  assert.equal(effective.source.reason, 'Исходная', 'исходный текст сохранён в журнале');
});

test('срыв без триггера и без причины отклоняется, отмена не создаёт операцию', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  await a.service.initializeDiary({ duration: '01:00', timeZone: 'Europe/Moscow' });
  const before = (await a.store.readSnapshot({ uid: UID, journalId: JOURNAL })).outbox.length;

  const invalid = await a.service.confirmRelapse({ reason: '   ' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_DATA');

  const after = (await a.store.readSnapshot({ uid: UID, journalId: JOURNAL })).outbox.length;
  assert.equal(after, before);
});

test('неизвестный триггер не создаёт событие', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  await a.service.initializeDiary({ duration: '01:00', timeZone: 'Europe/Moscow' });
  const result = await a.service.confirmRelapse({ triggerId: 'trigger-missing' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEPENDENCY_MISSING');
  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.deepEqual(Object.keys(snapshot.events), []);
});

test('триггер без initialization не создаётся (зависимость)', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  const result = await a.service.createTrigger({ name: 'Стресс' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEPENDENCY_MISSING');
  assert.equal(result.error.details.path, 'initialization');
  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.deepEqual(Object.keys(snapshot.triggerCreations), []);
  assert.deepEqual(snapshot.outbox, []);
});

test('service API экспортирует и импортирует дневник без UI', async () => {
  const serverA = createMemoryServer();
  const a = await makeDevice(serverA, 'device-a');
  await a.service.initializeDiary({ duration: '10:00', timeZone: 'Europe/Moscow' });
  a.state.now = T0 + HOUR;
  const relapse = await a.service.confirmRelapse({ reason: 'Стресс' });
  assert.equal(relapse.ok, true);
  await a.service.synchronize();

  const exported = await a.service.exportBackup();
  assert.equal(exported.ok, true, exported.ok ? '' : exported.error.message);
  const text = JSON.stringify(exported.value);

  const serverB = createMemoryServer();
  const b = await makeDevice(serverB, 'device-b');
  const validated = await b.service.validateBackup(text);
  assert.equal(validated.ok, true, validated.ok ? '' : validated.error.message);
  const planned = await b.service.planBackupImport(validated.value);
  assert.equal(planned.ok, true, planned.ok ? '' : planned.error.message);
  assert.equal(planned.value.added, 2, 'initialization и событие');

  const imported = await b.service.importBackup({ plan: planned.value });
  assert.equal(imported.ok, true, imported.ok ? '' : imported.error.message);
  assert.equal(imported.value.added, 2);
  assert.equal(imported.value.localComplete, true);
  assert.equal(imported.value.serverAcknowledged, true);

  b.state.now = T0 + 2 * HOUR;
  const projectionB = await b.service.getProjection();
  assert.equal(projectionB.relapseCount, 1);
  assert.equal(await a.service.getFingerprint(), await b.service.getFingerprint());
});

test('будущее событие из сбитых часов сохраняется с timeAnomaly и без отрицательной серии', async () => {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'device-a');
  await a.service.initializeDiary({ duration: '01:00', timeZone: 'Europe/Moscow' });

  a.state.now = T0 + 5 * 3600000;
  const future = await a.service.confirmRelapse({ reason: 'Часы убежали' });
  assert.equal(future.ok, true);

  a.state.now = T0 + 3600000;
  const projection = await a.service.getProjection();
  assert.equal(projection.timeAnomaly, true);
  assert.equal(projection.currentMs, 0, 'серия не становится отрицательной');
  assert.equal(projection.relapseCount, 1, 'событие не удаляется');
});
