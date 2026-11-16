// JSON-экспорт и добавляющий импорт (ТЗ §8, §10 этап 8, §11).
//
// Тесты гоняют реальные store/repository (fake-indexeddb + in-memory RTDB),
// а не заранее собранный «правильный» результат. Эмулятор Firebase Rules и
// настоящий браузер здесь не проверяются — это отмечено в отчёте.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { createDiaryStore } from '../js/harness/diary/indexeddb-store.js';
import { createFirebaseRepository } from '../js/harness/diary/firebase-repository.js';
import { replayJournal } from '../js/harness/diary/projection.js';
import { hashExport, hashSnapshot } from '../js/harness/diary/canonical.js';
import { LIMITS, SCHEMA_VERSION } from '../js/harness/diary/schema.js';
import {
  exportDiary,
  validateImport,
  planImport,
  executeImport,
  resumeImport,
} from '../js/harness/diary/backup.js';
import { createMemoryServer } from './helpers/diary-memory-server.mjs';

const UID = 'uid-owner';
const JOURNAL = 'journal-backup';
const BASE = Date.parse('2026-03-01T10:00:00Z');
const HOUR = 3600000;
const FP = `sha256:${'a'.repeat(64)}`;
const NOW = BASE + 6 * HOUR;

function initialization(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    journalId: JOURNAL,
    startedAtMs: BASE,
    initialDurationMs: HOUR,
    timeZone: 'Europe/Moscow',
    createdAtMs: BASE + HOUR,
    deviceId: 'device-source',
    acceptedAtMs: BASE + HOUR,
    ...overrides,
  };
}

function trigger(id, name = 'Стресс', overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    triggerId: id,
    name,
    createdAtMs: BASE + HOUR,
    deviceId: 'device-source',
    acceptedAtMs: BASE + HOUR,
    ...overrides,
  };
}

function event(id, occurredAtMs, overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: id,
    occurredAtMs,
    reason: 'Исходная причина',
    categoryPolicyOperationId: 'initial',
    deviceId: 'device-source',
    createdAtMs: occurredAtMs,
    acceptedAtMs: occurredAtMs,
    ...overrides,
  };
}

function mutation({
  entityKey, slot, operationId, predecessorSlot, type, changes, overrides = {},
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    operationId,
    predecessorOperationId: slot,
    ...(predecessorSlot ? { predecessorSlot } : {}),
    entityKey,
    type,
    changes,
    basisFingerprint: FP,
    createdAtMs: BASE + 2 * HOUR,
    deviceId: 'device-source',
    acceptedAtMs: BASE + 2 * HOUR,
    ...overrides,
  };
}

function editChain(eventId) {
  const entityKey = `event_${eventId}`;
  return {
    first: mutation({
      entityKey,
      slot: 'initial',
      operationId: 'operation-a',
      type: 'editEvent',
      changes: { reason: 'Исправленная причина' },
    }),
    second: mutation({
      entityKey,
      slot: 'operation-a',
      operationId: 'operation-b',
      predecessorSlot: 'initial',
      type: 'editEvent',
      changes: { occurredAtMs: BASE + 1.5 * HOUR },
    }),
  };
}

async function makeStore(name) {
  const indexedDB = new IDBFactory();
  const store = createDiaryStore({ indexedDB, name, clock: { now: () => NOW } });
  const opened = await store.open();
  assert.equal(opened.ok, true, opened.ok ? '' : opened.error.message);
  return { store, indexedDB };
}

// pending — Set путей, которые ещё не подтверждены сервером.
async function seed(store, snapshot, { pending = new Set(), status = 'acknowledged' } = {}) {
  const records = [];
  const outbox = [];
  function add(kind, id, payload, path, extra = {}) {
    records.push({ kind, id, payload, ...extra });
    outbox.push({
      path,
      operationId: `seed-${outbox.length}`,
      kind,
      payload,
      dependencies: [],
      status: pending.has(path) ? 'pending' : status,
    });
  }
  if (snapshot.initialization) add('initialization', JOURNAL, snapshot.initialization,
    'initialization');
  for (const [id, payload] of Object.entries(snapshot.triggerCreations || {})) {
    add('trigger', id, payload, `triggerCreations/${id}`);
  }
  for (const [id, payload] of Object.entries(snapshot.events || {})) {
    add('event', id, payload, `events/${id}`);
  }
  for (const [entityKey, chain] of Object.entries(snapshot.mutations || {})) {
    for (const [slot, payload] of Object.entries(chain)) {
      add('mutation', payload.operationId, payload, `mutations/${entityKey}/${slot}`, {
        entityKey, slot,
      });
    }
  }
  for (const [id, payload] of Object.entries(snapshot.analyses || {})) {
    add('analysis', id, payload, `analyses/${id}`);
  }
  if (records.length > 0) {
    const committed = await store.commitLocalCreate({ uid: UID, journalId: JOURNAL, records, outbox });
    assert.equal(committed.ok, true, committed.ok ? '' : committed.error.message);
  }
}

async function snapshotOf(store) {
  return store.readSnapshot({ uid: UID, journalId: JOURNAL });
}

function repositoryFor(server) {
  return createFirebaseRepository({ transport: server.transport });
}

async function reseal(file) {
  file.snapshot.fingerprint = await hashSnapshot(file.data);
  file.integrity.contentHash = await hashExport(file);
  return file;
}

async function readValidated(text) {
  const validated = await validateImport(text);
  assert.equal(validated.ok, true, validated.ok ? '' : `${validated.error.message}`);
  return validated.value;
}

async function runImport(text, store, server, options = {}) {
  const validated = await readValidated(text);
  const current = await snapshotOf(store);
  const planned = planImport(validated, current, {
    journalId: JOURNAL,
    crypto: options.crypto,
    sessionId: options.sessionId,
  });
  assert.equal(planned.ok, true, planned.ok ? '' : planned.error.message);
  const report = await executeImport({
    plan: planned.value,
    store,
    repository: repositoryFor(server),
    clock: { now: () => NOW },
    uid: UID,
    journalId: JOURNAL,
    onEntry: options.onEntry,
    send: options.send,
  });
  return { validated, plan: planned.value, report };
}

async function makeSource(snapshot, options = {}) {
  const { store } = await makeStore(`source-${Math.random().toString(16).slice(2)}`);
  await seed(store, snapshot, options);
  return store;
}

test('офлайн-экспорт включает pending, точку статистики и не содержит секретов', async () => {
  const { store } = await makeStore('export-source');
  const ev = event('event-pending', BASE + HOUR);
  await seed(store, {
    initialization: initialization(),
    triggerCreations: { 'trigger-a': trigger('trigger-a') },
    events: { 'event-pending': ev },
    mutations: {},
    analyses: {},
  }, { pending: new Set(['events/event-pending']) });

  const snapshot = await snapshotOf(store);
  const exported = await exportDiary(snapshot, NOW);
  assert.equal(exported.ok, true, exported.ok ? '' : exported.error.message);
  const file = exported.value;

  assert.equal(file.format, 'youplanner-diary');
  assert.equal(file.schemaVersion, SCHEMA_VERSION);
  assert.equal(file.exportedAtMs, NOW);
  assert.equal(file.snapshot.scope, 'availableLocal');
  assert.equal(file.snapshot.syncComplete, false);
  assert.deepEqual(file.snapshot.pendingEventIds, ['event-pending']);
  assert.equal(file.recordStates['events/event-pending'], 'pending');
  assert.equal(typeof file.data.events['event-pending'].acceptedAtMs, 'number',
    'placeholder {".sv":"timestamp"} обязан быть заменён числом');
  assert.equal(file.integrity.algorithm, 'SHA-256');
  assert.match(file.integrity.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(file.statistics.asOfMs, NOW);
  assert.equal(file.statistics.relapseCount, 1);
  assert.equal(file.snapshot.fingerprint, await hashSnapshot(snapshot));

  const text = JSON.stringify(file);
  assert.doesNotMatch(text, /uid-owner/, 'uid не должен попадать в экспорт');
  assert.doesNotMatch(text, /"outbox"|"receipts"|"lease"|"token"|"lastError"/,
    'служебные и секретные поля не должны попадать в файл');
  assert.doesNotMatch(text, /\.sv/, 'placeholder серверного времени не экспортируется');

  const validated = await validateImport(text);
  assert.equal(validated.ok, true, validated.ok ? '' : validated.error.message);
});

test('round-trip сохраняет исходные ID и правки; повторный импорт не растёт', async () => {
  const { store: source } = await makeStore('roundtrip-source');
  const chain = editChain('event-a');
  const sourceSnapshot = {
    initialization: initialization(),
    triggerCreations: { 'trigger-a': trigger('trigger-a') },
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: { 'event_event-a': { initial: chain.first, 'operation-a': chain.second } },
    analyses: {},
  };
  await seed(source, sourceSnapshot);
  const exported = await exportDiary(await snapshotOf(source), NOW);
  assert.equal(exported.ok, true);
  const text = JSON.stringify(exported.value);

  const { store: target } = await makeStore('roundtrip-target');
  const server = createMemoryServer();
  const { plan, report } = await runImport(text, target, server);

  assert.equal(report.ok, true, report.ok ? '' : report.error.message);
  assert.equal(plan.added, 5, 'initialization + trigger + event + 2 правки');
  assert.equal(report.value.added, 5);
  assert.equal(report.value.pending, 0);
  assert.equal(report.value.acknowledged, 5);
  assert.equal(report.value.serverAcknowledged, true);
  assert.equal(report.value.localComplete, true);

  const targetSnapshot = await snapshotOf(target);
  assert.deepEqual(Object.keys(targetSnapshot.events), ['event-a']);
  assert.deepEqual(Object.keys(targetSnapshot.triggerCreations), ['trigger-a']);
  assert.deepEqual(Object.keys(targetSnapshot.mutations['event_event-a']).sort(),
    ['initial', 'operation-a']);
  assert.match(targetSnapshot.events['event-a'].originImportId, /^import-/);
  assert.equal(targetSnapshot.mutations['event_event-a'].initial.operationId, 'operation-a');
  assert.equal(targetSnapshot.mutations['event_event-a']['operation-a'].operationId, 'operation-b');

  const projection = replayJournal(targetSnapshot);
  const effective = projection.events.find((item) => item.eventId === 'event-a');
  assert.equal(effective.reason, 'Исправленная причина');
  assert.equal(effective.occurredAtMs, BASE + 1.5 * HOUR);
  assert.equal(effective.source.reason, 'Исходная причина', 'исходник остаётся в events');

  // Второй чистый дневник получает ту же предметную историю и fingerprint.
  const { store: target2 } = await makeStore('roundtrip-target-2');
  const server2 = createMemoryServer();
  await runImport(text, target2, server2);
  assert.equal(await hashSnapshot(await snapshotOf(target2)), await hashSnapshot(sourceSnapshot));

  // Повторный импорт в уже заполненный дневник: только skippedDuplicate.
  const createsBefore = server.creates.length;
  const repeat = await runImport(text, target, server);
  assert.equal(repeat.report.value.added, 0);
  assert.equal(repeat.report.value.skippedDuplicates, 5);
  assert.equal(repeat.report.value.pending, 0);
  assert.equal(repeat.report.value.serverAcknowledged, true);
  assert.equal(server.creates.length, createsBefore, 'повтор не создаёт новых записей');
  assert.equal(Object.keys((await snapshotOf(target)).events).length, 1);
});

test('старый файл не откатывает уже принятую правку', async () => {
  const { store: target } = await makeStore('stale-target');
  const chain = editChain('event-a');
  await seed(target, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: { 'event_event-a': { initial: chain.first } },
    analyses: {},
  });
  const before = await snapshotOf(target);
  const fingerprintBefore = await hashSnapshot(before);

  const { store: oldSource } = await makeStore('stale-source');
  await seed(oldSource, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: {},
    analyses: {},
  });
  const oldFile = await exportDiary(await snapshotOf(oldSource), NOW - HOUR);
  assert.equal(oldFile.ok, true);

  const server = createMemoryServer();
  const { plan, report } = await runImport(JSON.stringify(oldFile.value), target, server);
  assert.equal(report.ok, true);
  assert.equal(plan.added, 0);
  assert.equal(report.value.added, 0);
  assert.equal(report.value.skippedDuplicates, 2);

  const after = await snapshotOf(target);
  assert.equal(await hashSnapshot(after), fingerprintBefore, 'локальная история не изменилась');
  const effective = replayJournal(after).events.find((item) => item.eventId === 'event-a');
  assert.equal(effective.reason, 'Исправленная причина');
});

test('конфликт ID: разный payload не перезаписывается', async () => {
  const { store: target } = await makeStore('conflict-target');
  await seed(target, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR, { reason: 'Локальная' }) },
    mutations: {},
    analyses: {},
  });

  const { store: source } = await makeStore('conflict-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR, { reason: 'Импортная' }) },
    mutations: {},
    analyses: {},
  });
  const file = await exportDiary(await snapshotOf(source), NOW);
  const server = createMemoryServer();

  const { plan, report } = await runImport(JSON.stringify(file.value), target, server);
  assert.equal(report.ok, true);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].kind, 'event');
  assert.equal(report.value.added, 0);
  assert.equal(report.value.conflicts.length, 1);
  assert.equal(report.value.serverAcknowledged, false);

  const local = await snapshotOf(target);
  assert.equal(local.events['event-a'].reason, 'Локальная', 'локальный payload сохранён');
  assert.equal(server.data.size, 0, 'сервер не получил конфликтную запись');
});

test('существующей сущности не добавляются скрытые imported mutations', async () => {
  const { store: target } = await makeStore('consent-target');
  await seed(target, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: {},
    analyses: {},
  });

  const { store: source } = await makeStore('consent-source');
  const chain = editChain('event-a');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: { 'event_event-a': { initial: chain.first, 'operation-a': chain.second } },
    analyses: {},
  });
  const file = await exportDiary(await snapshotOf(source), NOW);
  const server = createMemoryServer();

  const { plan, report } = await runImport(JSON.stringify(file.value), target, server);
  assert.equal(report.ok, true);
  assert.equal(plan.added, 0);
  assert.equal(plan.requiresSeparateConsent.length, 1);
  assert.equal(plan.requiresSeparateConsent[0].entityKey, 'event_event-a');
  assert.equal(report.value.added, 0);
  assert.equal(report.value.requiresSeparateConsent.length, 1);
  assert.equal(report.value.serverAcknowledged, false);

  const local = await snapshotOf(target);
  assert.deepEqual(local.mutations, {}, 'правки не добавлены без согласия');
  assert.equal(server.data.size, 0);
});

test('новая сущность восстанавливается вместе со всей цепочкой правок', async () => {
  const { store: source } = await makeStore('restore-source');
  const chain = editChain('event-new');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-new': event('event-new', BASE + HOUR) },
    mutations: { 'event_event-new': { initial: chain.first, 'operation-a': chain.second } },
    analyses: {},
  });
  const file = await exportDiary(await snapshotOf(source), NOW);
  const { store: target } = await makeStore('restore-target');
  const server = createMemoryServer();

  const { plan, report } = await runImport(JSON.stringify(file.value), target, server);
  assert.equal(report.ok, true);
  assert.equal(plan.added, 4);
  assert.equal(report.value.acknowledged, 4);
  const local = await snapshotOf(target);
  assert.equal(Object.keys(local.mutations['event_event-new']).length, 2);
  const effective = replayJournal(local).events.find((item) => item.eventId === 'event-new');
  assert.equal(effective.reason, 'Исправленная причина');
  assert.equal(effective.occurredAtMs, BASE + 1.5 * HOUR);
});

test('некорректный JSON, версия, hash, __proto__ и лишнее поле отклоняются', async () => {
  const { store } = await makeStore('invalid-source');
  await seed(store, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: {},
    analyses: {},
  });
  const good = (await exportDiary(await snapshotOf(store), NOW)).value;

  const badJson = await validateImport('{not json');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error.code, 'IMPORT_INVALID');

  const badVersion = structuredClone(good);
  badVersion.schemaVersion = 2;
  await reseal(badVersion);
  assert.equal((await validateImport(JSON.stringify(badVersion))).error.code, 'IMPORT_INVALID');

  const badHash = structuredClone(good);
  badHash.integrity.contentHash = `sha256:${'0'.repeat(64)}`;
  assert.equal((await validateImport(JSON.stringify(badHash))).error.code, 'IMPORT_INVALID');

  const proto = '{"format":"youplanner-diary","data":{"events":{"event-a":{"__proto__":{"polluted":true}}}}}';
  const protoResult = await validateImport(proto);
  assert.equal(protoResult.ok, false);
  assert.equal(protoResult.error.code, 'IMPORT_INVALID');

  const extraField = structuredClone(good);
  extraField.data.events['event-a'].uid = UID;
  await reseal(extraField);
  assert.equal((await validateImport(JSON.stringify(extraField))).error.code, 'IMPORT_INVALID');

  const longReason = structuredClone(good);
  longReason.data.events['event-a'].reason = 'x'.repeat(LIMITS.reasonLength + 1);
  await reseal(longReason);
  assert.equal((await validateImport(JSON.stringify(longReason))).error.code, 'IMPORT_INVALID');

  const placeholder = structuredClone(good);
  placeholder.data.events['event-a'].acceptedAtMs = { '.sv': 'timestamp' };
  await reseal(placeholder);
  assert.equal((await validateImport(JSON.stringify(placeholder))).error.code, 'IMPORT_INVALID');

  const badJournal = structuredClone(good);
  badJournal.data.initialization.journalId = 'journal-other';
  await reseal(badJournal);
  assert.equal((await validateImport(JSON.stringify(badJournal))).error.code, 'IMPORT_INVALID');
});

test('разорванная цепь правок не становится историей', async () => {
  const { store } = await makeStore('broken-chain-source');
  const chain = editChain('event-a');
  await seed(store, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: { 'event_event-a': { initial: chain.first, 'operation-a': chain.second } },
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(store), NOW)).value;
  file.data.mutations['event_event-a']['operation-a'].predecessorSlot = 'operation-a';
  await reseal(file);
  const result = await validateImport(JSON.stringify(file));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'IMPORT_INVALID');
});

test('лимиты: размер файла и число событий дают LIMIT_EXCEEDED без обрезания', async () => {
  const tooBig = 'x'.repeat(LIMITS.exportBytes + 1);
  const sizeResult = await validateImport(tooBig);
  assert.equal(sizeResult.ok, false);
  assert.equal(sizeResult.error.code, 'LIMIT_EXCEEDED');

  const { store } = await makeStore('limit-source');
  await seed(store, {
    initialization: initialization(),
    triggerCreations: {},
    events: {},
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(store), NOW)).value;
  const events = {};
  for (let i = 0; i <= LIMITS.events; i += 1) events[`event-${i}`] = {};
  file.data.events = events;
  await reseal(file);
  const countResult = await validateImport(JSON.stringify(file));
  assert.equal(countResult.ok, false);
  assert.equal(countResult.error.code, 'LIMIT_EXCEEDED');
});

test('JOURNAL_MISMATCH: другая initialization или чужой journalId', async () => {
  const { store: source } = await makeStore('mismatch-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: {},
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;

  const { store: target } = await makeStore('mismatch-target');
  await seed(target, {
    initialization: initialization({ startedAtMs: BASE - HOUR, createdAtMs: BASE }),
    triggerCreations: {},
    events: {},
    mutations: {},
    analyses: {},
  });
  const local = await snapshotOf(target);
  const result = planImport(file, local, { journalId: JOURNAL });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'JOURNAL_MISMATCH');

  const { store: empty } = await makeStore('mismatch-empty');
  const foreign = planImport(file, await snapshotOf(empty), { journalId: 'journal-other' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'JOURNAL_MISMATCH');
});

test('остановка посередине и resume: повтор не создаёт дубли', async () => {
  const { store: source } = await makeStore('resume-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: {
      'event-a': event('event-a', BASE + HOUR),
      'event-b': event('event-b', BASE + 2 * HOUR),
      'event-c': event('event-c', BASE + 3 * HOUR),
    },
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;
  const { store: target } = await makeStore('resume-target');
  const server = createMemoryServer();

  let index = 0;
  const first = await runImport(JSON.stringify(file), target, server, {
    onEntry: async () => {
      if (index === 1) server.state.offline = true;
      index += 1;
    },
  });
  assert.equal(first.report.ok, true);
  assert.ok(first.report.value.pending >= 2, 'часть записей осталась pending');
  assert.equal(first.report.value.serverAcknowledged, false);
  assert.equal(first.report.value.localComplete, true);

  const localBefore = await snapshotOf(target);
  assert.equal(Object.keys(localBefore.events).length, 3, 'локально импорт завершён');

  server.state.offline = false;
  const resumed = await resumeImport({
    sessionId: first.report.value.sessionId,
    store: target,
    repository: repositoryFor(server),
    clock: { now: () => NOW },
    uid: UID,
    journalId: JOURNAL,
  });
  assert.equal(resumed.ok, true, resumed.ok ? '' : resumed.error.message);
  assert.equal(resumed.value.pending, 0);
  assert.equal(resumed.value.serverAcknowledged, true);
  assert.equal(resumed.value.added, 4);

  const paths = [...server.data.keys()].filter((path) => path.endsWith('events/event-a')
    || path.endsWith('events/event-b') || path.endsWith('events/event-c'));
  assert.equal(paths.length, 3);

  const again = await resumeImport({
    sessionId: first.report.value.sessionId,
    store: target,
    repository: repositoryFor(server),
    clock: { now: () => NOW },
    uid: UID,
    journalId: JOURNAL,
  });
  assert.equal(again.value.pending, 0);
  assert.equal(again.value.added, 4, 'повторный resume не добавляет записи');
  assert.equal([...server.data.keys()].filter((path) => path.includes('/events/')).length, 3);
});

test('гонка: событие другого телефона с тем же ID не перезаписывается', async () => {
  const { store: source } = await makeStore('race-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR, { reason: 'Из импорта' }) },
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;
  const { store: target } = await makeStore('race-target');
  const server = createMemoryServer();
  const prefix = `diaryV1/${UID}/journals/${JOURNAL}`;
  await server.transport._seed(`${prefix}/initialization`, initialization());
  await server.transport._seed(`${prefix}/events/event-a`,
    event('event-a', BASE + HOUR, { reason: 'Другой телефон' }));

  const { report } = await runImport(JSON.stringify(file), target, server);
  assert.equal(report.ok, true);
  assert.ok(report.value.conflicts.length >= 1);
  assert.equal(report.value.added, 0);
  assert.equal((await server.transport._get(`${prefix}/events/event-a`)).reason,
    'Другой телефон', 'запись другого телефона не перезаписана');
});

test('гонка: независимо появившаяся сущность не получает imported mutations', async () => {
  const { store: source } = await makeStore('race-chain-source');
  const chain = editChain('event-a');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: { 'event_event-a': { initial: chain.first } },
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;
  const { store: target } = await makeStore('race-chain-target');
  const server = createMemoryServer();
  const prefix = `diaryV1/${UID}/journals/${JOURNAL}`;
  await server.transport._seed(`${prefix}/initialization`, initialization());
  await server.transport._seed(`${prefix}/events/event-a`, event('event-a', BASE + HOUR));

  const { report } = await runImport(JSON.stringify(file), target, server);
  assert.equal(report.ok, true);
  assert.equal(report.value.added, 0);
  assert.ok(report.value.conflicts.length >= 1
    || report.value.blockedDependencies.length >= 1,
  'правка к чужой сущности обязана быть остановлена');
  assert.equal(server.transport._has(`${prefix}/mutations/event_event-a/initial`), false,
    'правка не добавлена к независимо появившейся сущности');
});

test('экспорт без initialization отклоняется', async () => {
  const { store } = await makeStore('no-init-source');
  const result = await exportDiary(await snapshotOf(store), NOW);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_DATA');
});

test('чужой initialization на сервере даёт JOURNAL_MISMATCH, а не конфликт', async () => {
  const { store: source } = await makeStore('foreign-init-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: {},
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;
  const { store: target } = await makeStore('foreign-init-target');
  const server = createMemoryServer();
  const prefix = `diaryV1/${UID}/journals/${JOURNAL}`;
  await server.transport._seed(`${prefix}/initialization`, initialization({
    startedAtMs: BASE - HOUR,
    createdAtMs: BASE,
  }));

  const validated = await readValidated(JSON.stringify(file));
  const planned = planImport(validated, await snapshotOf(target), { journalId: JOURNAL });
  assert.equal(planned.ok, true, planned.ok ? '' : planned.error.message);
  const report = await executeImport({
    plan: planned.value,
    store: target,
    repository: repositoryFor(server),
    clock: { now: () => NOW },
    uid: UID,
    journalId: JOURNAL,
  });
  assert.equal(report.ok, false,
    'два разных дневника нельзя сливать в один и называть это конфликтом записи');
  assert.equal(report.error.code, 'JOURNAL_MISMATCH');
  assert.equal(server.transport._has(`${prefix}/events/event-a`), false);
});

test('локальное расхождение с сервером не выдаётся за дубликат', async () => {
  const { store: source } = await makeStore('race-local-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR, { reason: 'Из импорта' }) },
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;
  const { store: target } = await makeStore('race-local-target');
  const server = createMemoryServer();
  const prefix = `diaryV1/${UID}/journals/${JOURNAL}`;
  const validEvent = file.data.events['event-a'];
  await server.transport._seed(`${prefix}/initialization`, file.data.initialization);
  await server.transport._seed(`${prefix}/events/event-a`, validEvent);

  const validated = await readValidated(JSON.stringify(file));
  const planned = planImport(validated, await snapshotOf(target), { journalId: JOURNAL });
  assert.equal(planned.ok, true, planned.ok ? '' : planned.error.message);
  // Гонка: пока план строился, локально уже появилась другая версия записи.
  await seed(target, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR, { reason: 'Локальная' }) },
    mutations: {},
    analyses: {},
  });

  const report = await executeImport({
    plan: planned.value,
    store: target,
    repository: repositoryFor(server),
    clock: { now: () => NOW },
    uid: UID,
    journalId: JOURNAL,
  });
  assert.equal(report.ok, true, report.ok ? '' : report.error.message);
  assert.equal(report.value.serverAcknowledged, false);
  assert.ok(report.value.conflicts.some((item) => item.path === 'events/event-a'
    && item.reason === 'LOCAL_PAYLOAD_DIFFERS'),
  'расхождение локальной и серверной версии обязано быть конфликтом');
  assert.equal((await snapshotOf(target)).events['event-a'].reason, 'Локальная');
});

test('если прогресс импорта не сохраняется, импорт не притворяется успешным', async () => {
  const { store: source } = await makeStore('progress-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;
  const { store: target } = await makeStore('progress-target');
  const server = createMemoryServer();

  const validated = await readValidated(JSON.stringify(file));
  const planned = planImport(validated, await snapshotOf(target), { journalId: JOURNAL });
  assert.equal(planned.ok, true, planned.ok ? '' : planned.error.message);

  const failingStore = {
    ...target,
    saveImportProgress: async () => ({
      ok: false,
      error: {
        code: 'STORAGE_FULL', message: 'quota', details: {}, retryable: false,
      },
    }),
  };
  const report = await executeImport({
    plan: planned.value,
    store: failingStore,
    repository: repositoryFor(server),
    clock: { now: () => NOW },
    uid: UID,
    journalId: JOURNAL,
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'STORAGE_FULL');
});

test('импорт не копирует statistics файла в локальную историю', async () => {
  const { store: source } = await makeStore('stats-source');
  await seed(source, {
    initialization: initialization(),
    triggerCreations: {},
    events: { 'event-a': event('event-a', BASE + HOUR) },
    mutations: {},
    analyses: {},
  });
  const file = (await exportDiary(await snapshotOf(source), NOW)).value;
  file.statistics.relapseCount = 999;
  await reseal(file);

  const { store: target } = await makeStore('stats-target');
  const server = createMemoryServer();
  const { report } = await runImport(JSON.stringify(file), target, server);
  assert.equal(report.ok, true);
  const local = await snapshotOf(target);
  assert.equal(replayJournal(local).events.length, 1);
  assert.equal(local.statistics, undefined, 'statistics не является частью локальной истории');
});
