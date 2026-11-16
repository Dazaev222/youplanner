// Схема домена «Дневник» (ТЗ §3, §4, §8, §9): HH:MM, allowlist полей,
// зависимости события, мутации по путям, нормализация null/отсутствия.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  LIMITS,
  parseDuration,
  formatDuration,
  normalizeRecord,
  validateInitialization,
  validateEvent,
  validateTrigger,
  validateMutation,
  validateAnalysis,
  validateExport,
} from '../js/harness/diary/schema.js';

const BASE = 1790000000000;

function initialization(overrides = {}) {
  return {
    schemaVersion: 1,
    journalId: 'journal-00000000-1111-4222-8333-444444444444',
    startedAtMs: BASE,
    initialDurationMs: 9000000,
    timeZone: 'Europe/Moscow',
    createdAtMs: BASE + 9000000,
    deviceId: 'device-1',
    acceptedAtMs: { '.sv': 'timestamp' },
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: 'event-00000000-1111-4222-8333-444444444444',
    occurredAtMs: BASE + 1000,
    reason: 'Стресс на работе',
    triggerId: 'trigger-00000000-1111-4222-8333-444444444444',
    categoryPolicyOperationId: 'initial',
    deviceId: 'device-1',
    createdAtMs: BASE + 2000,
    acceptedAtMs: { '.sv': 'timestamp' },
    ...overrides,
  };
}

function mutation(overrides = {}) {
  return {
    schemaVersion: 1,
    operationId: 'operation-A',
    predecessorOperationId: 'initial',
    entityKey: 'event_event-00000000-1111-4222-8333-444444444444',
    type: 'editEvent',
    changes: { occurredAtMs: BASE + 500 },
    basisFingerprint: 'sha256:' + 'a'.repeat(64),
    createdAtMs: BASE + 3000,
    deviceId: 'device-1',
    acceptedAtMs: { '.sv': 'timestamp' },
    ...overrides,
  };
}

test('SCHEMA_VERSION и лимиты версии 1 объявлены', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(LIMITS.reasonLength, 4000);
  assert.equal(LIMITS.triggerNameLength, 200);
  assert.equal(LIMITS.exportBytes, 10 * 1024 * 1024);
  assert.equal(LIMITS.events, 100000);
  assert.equal(LIMITS.mutations, 100000);
  assert.equal(LIMITS.triggers, 10000);
  assert.equal(LIMITS.analysisBytes, 1024 * 1024);
});

test('HH:MM: часы больше 23 допустимы, минуты 00..59, 00:00 = ноль', () => {
  assert.equal(parseDuration('00:00').value, 0);
  assert.equal(parseDuration('00:01').value, 60000);
  assert.equal(parseDuration('25:30').value, (25 * 60 + 30) * 60000);
  assert.equal(parseDuration('999:59').value, (999 * 60 + 59) * 60000);
  assert.equal(formatDuration(9000000), '02:30');
  assert.equal(formatDuration(0), '00:00');
});

test('HH:MM: неверные строки отклоняются с кодом INVALID_DATA и путём duration', () => {
  for (const bad of ['', ' ', '25', '25:60', '24:99', '-1:00', '1:30', '01:3',
    '01:30 ', '01:3a', '00:00:00', null, 42]) {
    const result = parseDuration(bad);
    assert.equal(result.ok, false, `должно быть отклонено: ${String(bad)}`);
    assert.equal(result.error.code, 'INVALID_DATA');
    assert.equal(result.error.details.path, 'duration');
  }
});

test('initialization: согласованные поля валидны, null нормализуется', () => {
  const result = validateInitialization(initialization());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, initialization());

  const withNull = initialization({ originImportId: null });
  const normalized = validateInitialization(withNull);
  assert.equal(normalized.ok, true);
  assert.equal('originImportId' in normalized.value, false);
});

test('initialization: несогласованный старт, битый пояс и лишние поля отклоняются', () => {
  const cases = [
    [{ startedAtMs: BASE + 1 }, 'startedAtMs'],
    [{ initialDurationMs: -1 }, 'initialDurationMs'],
    [{ timeZone: 'Mars/Olympus' }, 'timeZone'],
    [{ schemaVersion: 2 }, 'schemaVersion'],
    [{ extra: 1 }, 'extra'],
    [{ deviceId: '' }, 'deviceId'],
  ];
  for (const [patch, path] of cases) {
    const result = validateInitialization(initialization(patch));
    assert.equal(result.ok, false, `должно упасть: ${JSON.stringify(patch)}`);
    assert.equal(result.error.code, 'INVALID_DATA');
    assert.equal(result.error.details.path, path);
  }
});

test('event: ровно один триггер либо непустая причина; оба допустимы', () => {
  assert.equal(validateEvent(event()).ok, true);
  assert.equal(validateEvent(event({ triggerId: undefined, reason: 'Причина' })).ok, true);
  assert.equal(validateEvent(event({ reason: undefined })).ok, true);

  for (const bad of [
    { triggerId: undefined, reason: undefined },
    { triggerId: null, reason: '   ' },
    { triggerId: '   ', reason: '' },
  ]) {
    const result = validateEvent(event(bad));
    assert.equal(result.ok, false, `должно упасть: ${JSON.stringify(bad)}`);
    assert.equal(result.error.code, 'INVALID_DATA');
    assert.equal(result.error.details.path, 'triggerId|reason');
  }
});

test('event: причина хранится исходно, проверка непустоты через trim', () => {
  const original = '  стресс  ';
  const result = validateEvent(event({ reason: original, triggerId: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.value.reason, original);
});

test('event: allowlist, категория только по принятой политике, ID пути', () => {
  assert.equal(validateEvent(event({ categoryId: 'cat-1' })).ok, false,
    'categoryId при categoryPolicyOperationId=initial недопустим');
  assert.equal(validateEvent(event({
    categoryId: 'cat-1', categoryPolicyOperationId: 'operation-P',
  })).ok, true);

  for (const [patch, path] of [
    [{ extra: true }, 'extra'],
    [{ occurredAtMs: NaN }, 'occurredAtMs'],
    [{ occurredAtMs: 1.5 }, 'occurredAtMs'],
    [{ reason: 'x'.repeat(4001), triggerId: undefined }, 'reason'],
    [{ eventId: 'trigger-x' }, 'eventId'],
    [{ categoryPolicyOperationId: '' }, 'categoryPolicyOperationId'],
  ]) {
    const result = validateEvent(event(patch));
    assert.equal(result.ok, false, `должно упасть: ${JSON.stringify(patch)}`);
    assert.equal(result.error.details.path, path);
  }
});

test('trigger: имя 1..200 после trim, allowlist', () => {
  const trigger = {
    schemaVersion: 1,
    triggerId: 'trigger-x',
    name: '  Стресс ',
    createdAtMs: BASE,
    deviceId: 'device-1',
    acceptedAtMs: { '.sv': 'timestamp' },
  };
  const ok = validateTrigger(trigger);
  assert.equal(ok.ok, true);

  for (const [patch, path] of [
    [{ name: '   ' }, 'name'],
    [{ name: 'x'.repeat(201) }, 'name'],
    [{ triggerId: 'event-x' }, 'triggerId'],
    [{ extra: 1 }, 'extra'],
  ]) {
    const result = validateTrigger({ ...trigger, ...patch });
    assert.equal(result.ok, false);
    assert.equal(result.error.details.path, path);
  }
});

test('mutation: первая правка в /initial без predecessorSlot', () => {
  assert.equal(validateMutation(mutation(), {
    slot: 'initial', entityKey: mutation().entityKey,
  }).ok, true);

  const withSlot = validateMutation(mutation({ predecessorSlot: 'initial' }), {
    slot: 'initial', entityKey: mutation().entityKey,
  });
  assert.equal(withSlot.ok, false);
  assert.equal(withSlot.error.details.path, 'predecessorSlot');
});

test('mutation: вторая правка — slot = predecessorOperationId, operationId новый', () => {
  const second = mutation({
    operationId: 'operation-B',
    predecessorOperationId: 'operation-A',
    predecessorSlot: 'initial',
  });
  assert.equal(validateMutation(second, {
    slot: 'operation-A', entityKey: second.entityKey,
  }).ok, true);

  for (const [patch, path] of [
    [{ operationId: 'operation-A' }, 'operationId'],
    [{ predecessorOperationId: 'initial' }, 'predecessorOperationId'],
    [{ predecessorSlot: 'operation-A' }, 'predecessorSlot'],
    [{ predecessorSlot: undefined }, 'predecessorSlot'],
    [{ operationId: 'initial' }, 'operationId'],
  ]) {
    const result = validateMutation({ ...second, ...patch }, {
      slot: 'operation-A', entityKey: second.entityKey,
    });
    assert.equal(result.ok, false, `должно упасть: ${JSON.stringify(patch)}`);
    assert.equal(result.error.details.path, path);
  }
});

test('mutation: тип связан с entityKey и полями changes', () => {
  const eventKey = mutation().entityKey;
  const triggerKey = 'trigger_trigger-x';

  assert.equal(validateMutation(mutation({ type: 'renameTrigger', changes: { name: 'X' } }), {
    slot: 'initial', entityKey: eventKey,
  }).ok, false);
  assert.equal(validateMutation(mutation({ entityKey: triggerKey, type: 'renameTrigger',
    changes: { name: 'X' } }), { slot: 'initial', entityKey: triggerKey }).ok, true);

  for (const badChanges of [
    { eventId: 'event-other' },
    { occurredAtMs: -1 },
    { reason: 42 },
    { categoryId: 'cat' },
    {},
  ]) {
    const result = validateMutation(mutation({ changes: badChanges }), {
      slot: 'initial', entityKey: eventKey,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.details.path.startsWith('changes'), true);
  }

  const policyKey = 'categoryPolicy';
  const policy = mutation({
    entityKey: policyKey,
    type: 'applyCategoryPolicy',
    changes: {
      categories: { 'cat-1': { name: 'Работа' } },
      triggerMappings: { 'trigger-x': 'cat-1' },
    },
  });
  assert.equal(validateMutation(policy, { slot: 'initial', entityKey: policyKey }).ok, true);
  assert.equal(validateMutation({ ...policy, changes: {
    categories: { 'cat-1': { name: 'Работа' }, evil: {} },
    triggerMappings: { 'trigger-x': 'missing' },
  } }, { slot: 'initial', entityKey: policyKey }).ok, false);
  assert.equal(validateMutation({ ...policy, changes: {
    categories: { 'cat-1': { name: 'Работа' } },
    triggerMappings: { 'trigger-x': 'cat-1', __proto__bad: 'cat-1' },
  } }, { slot: 'initial', entityKey: policyKey }).ok, false);
});

test('normalizeRecord: null и отсутствие эквивалентны, объект не мутируется', () => {
  const raw = { a: 1, b: null, c: undefined, d: { e: null, f: 2 } };
  const normalized = normalizeRecord(raw);
  assert.deepEqual(normalized, { a: 1, d: { f: 2 } });
  assert.equal(normalized.c, undefined);
  assert.equal(raw.b, null, 'вход не мутируется');
  assert.equal(raw.d.e, null, 'вложенный вход не мутируется');
});

test('analysis: fingerprint, proposal, completeness, allowlist', () => {
  const analysis = {
    analysisId: 'analysis-1',
    schemaVersion: 1,
    sourceFingerprint: 'sha256:' + 'b'.repeat(64),
    coveredEventIds: ['event-x'],
    model: 'glm-4.5',
    generatedAtMs: BASE,
    proposal: {
      categories: [{ id: 'cat-1', name: 'Работа' }],
      triggerMappings: [],
      reasonGroups: [{ label: 'Стресс', eventIds: ['event-x'] }],
      summary: 'ok',
    },
    completeness: 'complete',
    acceptedAtMs: { '.sv': 'timestamp' },
  };
  assert.equal(validateAnalysis(analysis).ok, true);

  for (const [patch, path] of [
    [{ sourceFingerprint: 'md5:xx' }, 'sourceFingerprint'],
    [{ model: '' }, 'model'],
    [{ coveredEventIds: ['event-x', 'event-x'] }, 'coveredEventIds'],
    [{ proposal: { categories: [{ id: 'cat-1' }] } }, 'proposal'],
    [{ apiKey: 'secret' }, 'apiKey'],
  ]) {
    const result = validateAnalysis({ ...analysis, ...patch });
    assert.equal(result.ok, false, `должно упасть: ${JSON.stringify(patch)}`);
    assert.equal(result.error.details.path, path);
  }
});

test('export: формат, scope, обязательные разделы', () => {
  const exported = {
    format: 'youplanner-diary',
    schemaVersion: 1,
    exportedAtMs: BASE,
    journalId: 'journal-1',
    timeZone: 'Europe/Moscow',
    snapshot: {
      fingerprint: 'sha256:' + 'c'.repeat(64),
      scope: 'availableLocal',
      syncComplete: false,
      pendingEventIds: ['event-x'],
    },
    data: { initialization: {}, events: {}, triggerCreations: {}, mutations: {}, analyses: {} },
    statistics: { asOfMs: BASE },
    recordStates: {},
    integrity: { algorithm: 'SHA-256', contentHash: 'sha256:' + 'd'.repeat(64) },
  };
  assert.equal(validateExport(exported).ok, true);
  assert.equal(validateExport({ ...exported, format: 'other' }).ok, false);
  assert.equal(validateExport({ ...exported, snapshot: { ...exported.snapshot, scope: 'all' } }).ok, false);
  assert.equal(validateExport({ ...exported, data: undefined }).ok, false);
  assert.equal(validateExport({ ...exported, integrity: { algorithm: 'MD5', contentHash: 'x' } }).ok, false);
});
