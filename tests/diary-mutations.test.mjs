// Онлайн-правки (ТЗ §6, §9, §11): prepareMutation/commitMutation, согласие,
// конфликт head, две правки одного слота, отсутствие глобального lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { createDiaryStore } from '../js/harness/diary/indexeddb-store.js';
import { createFirebaseRepository } from '../js/harness/diary/firebase-repository.js';
import { createDiaryService } from '../js/harness/diary/index.js';
import { replayJournal } from '../js/harness/diary/projection.js';
import { createMemoryServer } from './helpers/diary-memory-server.mjs';

const UID = 'uid-1';
const JOURNAL = 'journal-1';
const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3600000;

async function makeDevice(server, name = 'dev-a') {
  const indexedDB = new IDBFactory();
  const state = { now: T0 };
  const store = createDiaryStore({ indexedDB, name, clock: { now: () => state.now } });
  await store.open();
  const repository = createFirebaseRepository({ transport: server.transport });
  const service = createDiaryService({
    auth: { getUid: () => UID },
    repository,
    store,
    clock: { now: () => state.now },
    journalId: JOURNAL,
    deviceId: name,
    indexedDB,
  });
  return { store, repository, service, state, indexedDB };
}

async function setupWithEvents() {
  const server = createMemoryServer();
  const a = await makeDevice(server, 'dev-a');
  const init = await a.service.initializeDiary({ duration: '10:00', timeZone: 'Europe/Moscow' });
  assert.equal(init.ok, true);

  a.state.now = T0 + HOUR;
  const first = await a.service.confirmRelapse({ reason: 'Первый' });
  assert.equal(first.ok, true);
  a.state.now = T0 + 2 * HOUR;
  const second = await a.service.confirmRelapse({ reason: 'Второй' });
  assert.equal(second.ok, true);
  const sync = await a.service.synchronize();
  assert.equal(sync.ok, true);
  return { server, a, firstId: first.value.event.eventId, secondId: second.value.event.eventId };
}

test('prepareMutation: offline отказ, outbox не растёт', async () => {
  const { server, a, firstId } = await setupWithEvents();
  const before = (await a.store.readSnapshot({ uid: UID, journalId: JOURNAL })).outbox.length;
  server.state.offline = true;

  const proposal = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'Новая' },
  });
  assert.equal(proposal.ok, false);
  assert.equal(proposal.error.code, 'ONLINE_REQUIRED');
  const after = (await a.store.readSnapshot({ uid: UID, journalId: JOURNAL })).outbox.length;
  assert.equal(after, before, 'правка не превращается в скрытую офлайн-команду');
});

test('commitMutation без явного согласия отклоняется', async () => {
  const { a, firstId } = await setupWithEvents();
  const proposal = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'Новая' },
  });
  assert.equal(proposal.ok, true);
  const result = await a.service.commitMutation(proposal.value, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_DATA');
  assert.equal(result.error.details.path, 'consent');
});

test('онлайн-правка применяется отдельным узлом цепочки, исходник неизменен', async () => {
  const { server, a, firstId } = await setupWithEvents();
  const proposal = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { occurredAtMs: T0 + 1.5 * HOUR },
  });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.value.headOperationId, 'initial');
  assert.match(proposal.value.basisFingerprint, /^sha256:/);

  const committed = await a.service.commitMutation(proposal.value, true);
  assert.equal(committed.ok, true);
  assert.equal(committed.value.operationId, proposal.value.operationId);

  const base = `diaryV1/${UID}/journals/${JOURNAL}`;
  const source = await server.transport._get(`${base}/events/${firstId}`);
  assert.equal(source.occurredAtMs, T0 + HOUR, 'исходник не переписан');
  const node = await server.transport._get(
    `${base}/mutations/event_${firstId}/initial`,
  );
  assert.equal(node.operationId, proposal.value.operationId);
  assert.equal(node.predecessorOperationId, 'initial');

  const projection = await a.service.getProjection();
  const effective = projection.events.find((item) => item.eventId === firstId);
  assert.equal(effective.occurredAtMs, T0 + 1.5 * HOUR);
});

test('две правки одного head: ровно одна принята, проигравший получает CONFLICT_RECONFIRM', async () => {
  const { server, firstId } = await setupWithEvents();
  const a = await makeDevice(server, 'dev-a2');
  const b = await makeDevice(server, 'dev-b2');
  await a.service.synchronize();
  await b.service.synchronize();

  const proposalA = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'От A' },
  });
  const proposalB = await b.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'От B' },
  });
  assert.equal(proposalA.value.headOperationId, 'initial');
  assert.equal(proposalB.value.headOperationId, 'initial');

  const commitA = await a.service.commitMutation(proposalA.value, true);
  assert.equal(commitA.ok, true);
  const commitB = await b.service.commitMutation(proposalB.value, true);
  assert.equal(commitB.ok, false);
  assert.equal(commitB.error.code, 'CONFLICT_RECONFIRM');

  const base = `diaryV1/${UID}/journals/${JOURNAL}/mutations/event_${firstId}`;
  const chainResponse = await server.transport.get(base);
  const chain = chainResponse.value;
  assert.deepEqual(Object.keys(chain), ['initial']);
  assert.equal(chain.initial.operationId, commitA.value.operationId);

  // Проигравший перечитывает цепь и подтверждает заново.
  await b.service.synchronize();
  const retry = await b.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'От B' },
  });
  assert.equal(retry.value.headOperationId, commitA.value.operationId);
  const commitRetry = await b.service.commitMutation(retry.value, true);
  assert.equal(commitRetry.ok, true);
});

test('чужая сущность не блокирует правку: новый офлайн-срыв не отменяет commit', async () => {
  const { server, a, firstId } = await setupWithEvents();
  const b = await makeDevice(server, 'dev-b3');
  await b.service.synchronize();

  const proposal = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'Правка A' },
  });

  b.state.now = T0 + 90 * 60000;
  const late = await b.service.confirmRelapse({ reason: 'Поздний офлайн' });
  assert.equal(late.ok, true);
  await b.service.synchronize();

  const committed = await a.service.commitMutation(proposal.value, true);
  assert.equal(committed.ok, true, 'глобального lock нет');
});

test('время правки: будущее, раньше старта и через соседа отклоняются', async () => {
  const { a, firstId, secondId } = await setupWithEvents();
  const cases = [
    [{ occurredAtMs: T0 + 5 * HOUR }, 'occurredAtMs'],
    [{ occurredAtMs: T0 - 11 * HOUR }, 'occurredAtMs'],
    [{ occurredAtMs: T0 + 3 * HOUR }, 'occurredAtMs'],
  ];
  for (const [changes, path] of cases) {
    const proposal = await a.service.prepareMutation({
      entityKey: `event_${firstId}`, changes,
    });
    assert.equal(proposal.ok, false, `должно упасть: ${JSON.stringify(changes)}`);
    assert.equal(proposal.error.details.path, path);
  }

  const ok = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { occurredAtMs: T0 + 90 * 60000 },
  });
  assert.equal(ok.ok, true);
  assert.equal(secondId !== firstId, true);
});

test('потеря ответа после commit: UNKNOWN_COMMIT, повтор принимает прежний путь без дубля', async () => {
  const { server, a, firstId } = await setupWithEvents();
  const proposal = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'После потери' },
  });
  const base = `diaryV1/${UID}/journals/${JOURNAL}`;
  server.state.loseResponseFor.add(`${base}/mutations/event_${firstId}/initial`);

  const unknown = await a.service.commitMutation(proposal.value, true);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_COMMIT');

  const localBefore = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(localBefore.mutations[`event_${firstId}`], undefined,
    'проекция до подтверждения не меняется');

  const retried = await a.service.commitMutation(proposal.value, true);
  assert.equal(retried.ok, true);
  assert.equal(retried.value.operationId, proposal.value.operationId);

  const chainResponse = await server.transport.get(`${base}/mutations/event_${firstId}`);
  assert.equal(Object.keys(chainResponse.value).length, 1, 'дубль операции не создан');
});

test('offline во время commit: ONLINE_REQUIRED, без локального узла', async () => {
  const { server, a, firstId } = await setupWithEvents();
  const proposal = await a.service.prepareMutation({
    entityKey: `event_${firstId}`, changes: { reason: 'Офлайн' },
  });
  server.state.offline = true;
  const result = await a.service.commitMutation(proposal.value, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ONLINE_REQUIRED');
  const snapshot = await a.store.readSnapshot({ uid: UID, journalId: JOURNAL });
  assert.equal(snapshot.mutations[`event_${firstId}`], undefined);
});

test('переименование триггера — онлайн-правка с согласием', async () => {
  const { a } = await setupWithEvents();
  const created = await a.service.createTrigger({ name: 'Стресс' });
  assert.equal(created.ok, true);
  await a.service.synchronize();
  const triggerId = created.value.trigger.triggerId;

  const proposal = await a.service.prepareMutation({
    entityKey: `trigger_${triggerId}`, changes: { name: 'Тревога' },
  });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.value.type, 'renameTrigger');
  const committed = await a.service.commitMutation(proposal.value, true);
  assert.equal(committed.ok, true);

  const projection = replayJournal(await a.store.readSnapshot({ uid: UID, journalId: JOURNAL }));
  assert.equal(projection.triggers[triggerId].name, 'Тревога');
});
