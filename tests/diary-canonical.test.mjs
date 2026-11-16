// Канонизация и fingerprint (ТЗ §6, §8, §9): порядок ключей не влияет,
// semantic payload входит, acceptedAtMs/originImportId и сетевые метаданные — нет.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  semanticRecord,
  equivalentDomainRecord,
  hashSnapshot,
  hashExport,
  sha256,
} from '../js/harness/diary/canonical.js';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function event(id, overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAtMs: 1790000100000,
    reason: 'Стресс',
    categoryPolicyOperationId: 'initial',
    deviceId: 'device-1',
    createdAtMs: 1790000200000,
    acceptedAtMs: { '.sv': 'timestamp' },
    ...overrides,
  };
}

function snapshot() {
  return {
    initialization: {
      schemaVersion: 1,
      journalId: 'journal-1',
      startedAtMs: 1790000000000,
      initialDurationMs: 9000000,
      timeZone: 'Europe/Moscow',
      createdAtMs: 1790009000000,
      deviceId: 'device-1',
      acceptedAtMs: { '.sv': 'timestamp' },
    },
    events: {
      'event-b': event('event-b', { occurredAtMs: 1790000300000 }),
      'event-a': event('event-a'),
    },
    triggerCreations: {
      'trigger-b': { schemaVersion: 1, triggerId: 'trigger-b', name: 'B', createdAtMs: 1, deviceId: 'd' },
      'trigger-a': { schemaVersion: 1, triggerId: 'trigger-a', name: 'A', createdAtMs: 2, deviceId: 'd' },
    },
    mutations: {},
    analyses: { 'analysis-1': { analysisId: 'analysis-1', proposal: { summary: 'x' } } },
  };
}

test('canonicalize: порядок ключей и undefined не влияют на результат', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.equal(canonicalize({ a: undefined, b: [3, 2] }), '{"b":[3,2]}');
  assert.equal(canonicalize('строка'), '"строка"');
  assert.equal(canonicalize(null), 'null');
});

test('sha256: стабильный hex с префиксом', async () => {
  const hash = await sha256('abc');
  assert.match(hash, HASH_RE);
  assert.equal(hash, 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('semanticRecord: acceptedAtMs и originImportId исключены, причина входит', () => {
  const original = event('event-a');
  const semantic = semanticRecord('event', {
    ...original,
    acceptedAtMs: 123,
    originImportId: 'import-1',
    outboxStatus: 'pending',
    lastError: 'network',
  });
  assert.deepEqual(semantic, {
    schemaVersion: 1,
    eventId: 'event-a',
    occurredAtMs: 1790000100000,
    reason: 'Стресс',
    categoryPolicyOperationId: 'initial',
    deviceId: 'device-1',
    createdAtMs: 1790000200000,
  });
});

test('equivalentDomainRecord: метаданные приёма не создают конфликт, payload — создаёт', () => {
  const first = event('event-a');
  const same = { ...first, acceptedAtMs: 999, originImportId: 'import-1' };
  assert.equal(equivalentDomainRecord('event', first, same), true);

  const changed = { ...first, reason: 'Другая причина' };
  assert.equal(equivalentDomainRecord('event', first, changed), false);

  const changedTime = { ...first, occurredAtMs: first.occurredAtMs + 1 };
  assert.equal(equivalentDomainRecord('event', first, changedTime), false);
});

test('hashSnapshot: порядок доставки и acceptedAtMs не меняют отпечаток', async () => {
  const base = await hashSnapshot(snapshot());
  assert.match(base, HASH_RE);

  const reordered = {
    ...snapshot(),
    events: {
      'event-a': { ...snapshot().events['event-a'], acceptedAtMs: 1 },
      'event-b': { ...snapshot().events['event-b'], acceptedAtMs: 2 },
    },
  };
  assert.equal(await hashSnapshot(reordered), base);

  const swapped = snapshot();
  swapped.events = { 'event-a': swapped.events['event-a'], 'event-b': swapped.events['event-b'] };
  assert.equal(await hashSnapshot(swapped), base);
});

test('hashSnapshot: смысловое изменение меняет отпечаток, analysis не входит', async () => {
  const base = await hashSnapshot(snapshot());

  const changedEvent = snapshot();
  changedEvent.events['event-a'].reason = 'Другая причина';
  assert.notEqual(await hashSnapshot(changedEvent), base);

  const changedAnalysis = snapshot();
  changedAnalysis.analyses['analysis-1'].proposal.summary = 'другое';
  assert.equal(await hashSnapshot(changedAnalysis), base);

  const changedAccepted = snapshot();
  changedAccepted.initialization.acceptedAtMs = 5;
  assert.equal(await hashSnapshot(changedAccepted), base);
});

test('hashSnapshot: цепочка mutations входит в порядке пути', async () => {
  const a = snapshot();
  a.mutations['event_event-a'] = {
    initial: {
      schemaVersion: 1,
      operationId: 'operation-A',
      predecessorOperationId: 'initial',
      entityKey: 'event_event-a',
      type: 'editEvent',
      changes: { occurredAtMs: 1790000150000 },
      basisFingerprint: 'sha256:' + 'a'.repeat(64),
      createdAtMs: 1,
      deviceId: 'd',
    },
  };
  const b = snapshot();
  b.mutations['event_event-a'] = { ...a.mutations['event_event-a'] };
  b.mutations['event_event-a'].initial = {
    ...a.mutations['event_event-a'].initial,
    changes: { occurredAtMs: 1790000160000 },
  };
  assert.notEqual(await hashSnapshot(b), await hashSnapshot(a));

  const reorderedMutations = { ...a.mutations };
  assert.equal(await hashSnapshot({ ...a, mutations: reorderedMutations }), await hashSnapshot(a));
});

test('hashExport: сам integrity не входит, остальное содержимое входит', async () => {
  const exported = {
    format: 'youplanner-diary',
    schemaVersion: 1,
    exportedAtMs: 1790000000000,
    journalId: 'journal-1',
    timeZone: 'Europe/Moscow',
    snapshot: {
      fingerprint: 'sha256:' + 'a'.repeat(64),
      scope: 'availableLocal',
      syncComplete: false,
      pendingEventIds: [],
    },
    data: { initialization: {}, events: {}, triggerCreations: {}, mutations: {}, analyses: {} },
    statistics: { asOfMs: 1790000000000, currentMs: 1 },
    recordStates: { 'events/event-a': 'acknowledged' },
    integrity: { algorithm: 'SHA-256', contentHash: 'sha256:' + 'b'.repeat(64) },
  };
  const base = await hashExport(exported);
  assert.match(base, HASH_RE);

  assert.equal(await hashExport({
    ...exported,
    integrity: { algorithm: 'SHA-256', contentHash: 'sha256:' + 'c'.repeat(64) },
  }), base);

  assert.notEqual(await hashExport({
    ...exported,
    recordStates: { 'events/event-a': 'pending' },
  }), base);
});
