// Проекция журнала (ТЗ §2, §4, §6, §9): неизменяемые исходники,
// цепочки правок, равные времена, битые и циклические цепи, переименование.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  walkMutationChain,
  effectiveEvent,
  effectiveTriggers,
  effectivePolicy,
  replayJournal,
} from '../js/harness/diary/projection.js';

const BASE = 1790000000000;
const EVENT_A = 'event-a';
const EVENT_B = 'event-b';
const TRIGGER = 'trigger-t';

function event(id, occurredAtMs, overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAtMs,
    reason: 'Причина',
    categoryPolicyOperationId: 'initial',
    deviceId: 'device-1',
    createdAtMs: BASE,
    ...overrides,
  };
}

function editOperation(operationId, changes, overrides = {}) {
  return {
    schemaVersion: 1,
    operationId,
    predecessorOperationId: overrides.predecessorOperationId || 'initial',
    entityKey: overrides.entityKey || `event_${EVENT_A}`,
    type: 'editEvent',
    changes,
    basisFingerprint: 'sha256:' + 'a'.repeat(64),
    createdAtMs: BASE,
    deviceId: 'device-1',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    initialization: {
      schemaVersion: 1,
      journalId: 'journal-1',
      startedAtMs: BASE - 9000000,
      initialDurationMs: 9000000,
      timeZone: 'Europe/Moscow',
      createdAtMs: BASE,
      deviceId: 'device-1',
    },
    events: {
      [EVENT_A]: event(EVENT_A, BASE + 1000),
      [EVENT_B]: event(EVENT_B, BASE + 2000),
    },
    triggerCreations: {
      [TRIGGER]: {
        schemaVersion: 1, triggerId: TRIGGER, name: 'Стресс', createdAtMs: BASE, deviceId: 'device-1',
      },
    },
    mutations: {},
    ...overrides,
  };
}

test('walkMutationChain: цепь initial → operationId → конец, head корректен', () => {
  const mutations = {
    [`event_${EVENT_A}`]: {
      initial: editOperation('operation-A', { occurredAtMs: BASE + 500 }),
      'operation-A': editOperation('operation-B', { reason: 'Новая причина' }, {
        predecessorOperationId: 'operation-A', predecessorSlot: 'initial',
      }),
    },
  };
  const result = walkMutationChain(mutations, `event_${EVENT_A}`);
  assert.equal(result.ok, true);
  assert.equal(result.value.operations.length, 2);
  assert.equal(result.value.headOperationId, 'operation-B');
  assert.deepEqual(result.value.anomalies, []);
});

test('walkMutationChain: пустая цепь — head initial без аномалий', () => {
  const result = walkMutationChain({}, `event_${EVENT_A}`);
  assert.equal(result.ok, true);
  assert.equal(result.value.headOperationId, 'initial');
  assert.deepEqual(result.value.operations, []);
});

test('walkMutationChain: разрыв и чужой entityKey не становятся историей', () => {
  const broken = {
    [`event_${EVENT_A}`]: {
      'operation-A': editOperation('operation-B', { reason: 'x' }, {
        predecessorOperationId: 'operation-Z', predecessorSlot: 'initial',
      }),
    },
  };
  const brokenResult = walkMutationChain(broken, `event_${EVENT_A}`);
  assert.equal(brokenResult.value.operations.length, 0);
  assert.equal(brokenResult.value.anomalies[0].code, 'CHAIN_BROKEN');

  const foreign = {
    [`event_${EVENT_A}`]: {
      initial: editOperation('operation-A', { reason: 'x' }, { entityKey: `event_${EVENT_B}` }),
    },
  };
  const foreignResult = walkMutationChain(foreign, `event_${EVENT_A}`);
  assert.equal(foreignResult.value.operations.length, 0);
  assert.equal(foreignResult.value.anomalies[0].code, 'ENTITY_MISMATCH');
});

test('walkMutationChain: цикл по operationId обнаруживается и не применяется', () => {
  const mutations = {
    [`event_${EVENT_A}`]: {
      initial: editOperation('operation-A', { reason: 'x' }),
      'operation-A': editOperation('operation-B', { reason: 'y' }, {
        predecessorOperationId: 'operation-A', predecessorSlot: 'initial',
      }),
      'operation-B': editOperation('operation-A', { reason: 'z' }, {
        predecessorOperationId: 'operation-B', predecessorSlot: 'operation-A',
      }),
    },
  };
  const result = walkMutationChain(mutations, `event_${EVENT_A}`);
  assert.equal(result.value.operations.length, 0);
  assert.equal(result.value.anomalies.at(-1).code, 'CHAIN_CYCLE');
});

test('effectiveEvent применяет правки, не мутируя исходник', () => {
  const source = event(EVENT_A, BASE + 1000);
  const effective = effectiveEvent(source, [
    editOperation('operation-A', { occurredAtMs: BASE + 700 }),
    editOperation('operation-B', { reason: '  Новая  ', triggerId: TRIGGER }, {
      predecessorOperationId: 'operation-A', predecessorSlot: 'initial',
    }),
  ]);
  assert.equal(effective.occurredAtMs, BASE + 700);
  assert.equal(effective.reason, '  Новая  ');
  assert.equal(effective.triggerId, TRIGGER);
  assert.equal(effective.source, source);
  assert.equal(source.occurredAtMs, BASE + 1000, 'исходник не изменён');
  assert.equal(source.reason, 'Причина');
});

test('replayJournal сортирует по effectiveOccurredAtMs, при равенстве — по eventId', () => {
  const mutations = {
    [`event_${EVENT_A}`]: {
      initial: editOperation('operation-A', { occurredAtMs: BASE + 2000 }, {
        predecessorOperationId: 'initial', predecessorSlot: undefined,
      }),
    },
  };
  const journal = replayJournal(snapshot({
    events: {
      [EVENT_A]: event(EVENT_A, BASE + 1000),
      [EVENT_B]: event(EVENT_B, BASE + 2000),
    },
    mutations,
  }));
  assert.deepEqual(journal.events.map((item) => item.eventId), [EVENT_A, EVENT_B],
    'при равном времени event-a раньше event-b');
  assert.equal(journal.events[0].occurredAtMs, BASE + 2000);
});

test('replayJournal: разрыв цепи оставляет исходник, аномалия видна', () => {
  const journal = replayJournal(snapshot({
    mutations: {
      [`event_${EVENT_A}`]: {
        'operation-X': editOperation('operation-Y', { reason: 'не должно примениться' }, {
          predecessorOperationId: 'operation-MISSING', predecessorSlot: 'initial',
        }),
      },
    },
  }));
  const a = journal.events.find((item) => item.eventId === EVENT_A);
  assert.equal(a.reason, 'Причина');
  assert.equal(journal.anomalies.some((item) => item.code === 'CHAIN_BROKEN'), true);
});

test('replayJournal: переименование триггера меняет производное имя, исходное доступно', () => {
  const journal = replayJournal(snapshot({
    mutations: {
      [`trigger_${TRIGGER}`]: {
        initial: {
          schemaVersion: 1,
          operationId: 'operation-R',
          predecessorOperationId: 'initial',
          entityKey: `trigger_${TRIGGER}`,
          type: 'renameTrigger',
          changes: { name: 'Тревога' },
          basisFingerprint: 'sha256:' + 'b'.repeat(64),
          createdAtMs: BASE,
          deviceId: 'device-1',
        },
      },
    },
  }));
  assert.equal(journal.triggers[TRIGGER].name, 'Тревога');
  assert.equal(journal.triggers[TRIGGER].originalName, 'Стресс');
});

test('effectivePolicy: последняя полная карта побеждает, исходные события не меняются', () => {
  const policyKey = 'categoryPolicy';
  const policyNode = (operationId, name, predecessorOperationId, predecessorSlot) => ({
    schemaVersion: 1,
    operationId,
    predecessorOperationId,
    ...(predecessorSlot ? { predecessorSlot } : {}),
    entityKey: policyKey,
    type: 'applyCategoryPolicy',
    changes: {
      categories: { 'cat-1': { name } },
      triggerMappings: { [TRIGGER]: 'cat-1' },
    },
    basisFingerprint: 'sha256:' + 'c'.repeat(64),
    createdAtMs: BASE,
    deviceId: 'device-1',
  });
  const mutations = {
    [policyKey]: {
      initial: policyNode('operation-P1', 'Работа', 'initial'),
      'operation-P1': policyNode('operation-P2', 'Личное', 'operation-P1', 'initial'),
    },
  };
  const result = effectivePolicy(mutations);
  assert.equal(result.policy.categories['cat-1'].name, 'Личное');
  assert.equal(result.policy.operationId, 'operation-P2');

  const journal = replayJournal(snapshot({ mutations }));
  assert.equal(journal.events[0].categoryId, undefined, 'историческая атрибуция не переписана');
});

test('порядок доставки mutations не влияет на проекцию', () => {
  const slots = {
    initial: editOperation('operation-A', { occurredAtMs: BASE + 1500 }),
    'operation-A': editOperation('operation-B', { reason: 'Финал' }, {
      predecessorOperationId: 'operation-A', predecessorSlot: 'initial',
    }),
  };
  const first = replayJournal(snapshot({ mutations: { [`event_${EVENT_A}`]: slots } }));
  const second = replayJournal(snapshot({
    mutations: { [`event_${EVENT_A}`]: { 'operation-A': slots['operation-A'], initial: slots.initial } },
  }));
  assert.deepEqual(
    first.events.map(({ source, ...rest }) => rest),
    second.events.map(({ source, ...rest }) => rest),
  );
});

test('effectiveTriggers отдаёт исходное имя и производное', () => {
  const triggers = {
    [TRIGGER]: { schemaVersion: 1, triggerId: TRIGGER, name: 'Стресс', createdAtMs: BASE, deviceId: 'd' },
  };
  const result = effectiveTriggers(triggers, {
    [`trigger_${TRIGGER}`]: {
      initial: {
        schemaVersion: 1,
        operationId: 'operation-R',
        predecessorOperationId: 'initial',
        entityKey: `trigger_${TRIGGER}`,
        type: 'renameTrigger',
        changes: { name: 'Тревога' },
        basisFingerprint: 'sha256:' + 'd'.repeat(64),
        createdAtMs: BASE,
        deviceId: 'd',
      },
    },
  });
  assert.equal(result.triggers[TRIGGER].name, 'Тревога');
  assert.equal(result.triggers[TRIGGER].source.name, 'Стресс');
});
