/* Проекция журнала (ТЗ §4, §6): чистые функции, одинаковый результат при
   любой перестановке доставки. Некорректная цепь не становится историей. */

import { normalizeRecord, validateMutation } from './schema.js';

const MAX_CHAIN_LENGTH = 100000;

function anomaly(code, details = {}) {
  return { code, ...details };
}

/**
 * Чтение цепочки: начать с initial, применить операцию, перейти по её
 * operationId; конец — отсутствующий следующий узел.
 */
export function walkMutationChain(mutations, entityKey) {
  const chain = mutations && typeof mutations === 'object' ? mutations[entityKey] : null;
  if (!chain || typeof chain !== 'object') {
    return {
      ok: true,
      value: { operations: [], headOperationId: 'initial', anomalies: [] },
    };
  }

  const anomalies = [];
  const operations = [];
  const seenSlots = new Set();
  const seenOperations = new Set();
  let slot = 'initial';
  let previousSlot = null;

  while (Object.prototype.hasOwnProperty.call(chain, slot)) {
    if (seenSlots.has(slot)) {
      anomalies.push(anomaly('CHAIN_CYCLE', { entityKey, slot }));
      return { ok: true, value: { operations: [], headOperationId: 'initial', anomalies } };
    }
    seenSlots.add(slot);
    if (operations.length >= MAX_CHAIN_LENGTH) {
      anomalies.push(anomaly('CHAIN_TOO_LONG', { entityKey }));
      return { ok: true, value: { operations: [], headOperationId: 'initial', anomalies } };
    }

    const raw = chain[slot];
    const checked = validateMutation(raw, { slot, entityKey });
    if (!checked.ok) {
      const path = checked.error.details && checked.error.details.path;
      anomalies.push(anomaly(path === 'entityKey' ? 'ENTITY_MISMATCH' : 'INVALID_OPERATION', {
        entityKey,
        slot,
        operationId: raw && raw.operationId,
        path,
      }));
      return { ok: true, value: { operations: [], headOperationId: 'initial', anomalies } };
    }

    const node = checked.value;
    if (seenOperations.has(node.operationId)) {
      anomalies.push(anomaly('CHAIN_CYCLE', { entityKey, slot, operationId: node.operationId }));
      return { ok: true, value: { operations: [], headOperationId: 'initial', anomalies } };
    }
    if (previousSlot !== null && node.predecessorSlot !== previousSlot) {
      anomalies.push(anomaly('CHAIN_BROKEN', {
        entityKey, slot, reason: 'predecessorSlot не указывает на предыдущий узел',
      }));
      return { ok: true, value: { operations: [], headOperationId: 'initial', anomalies } };
    }

    seenOperations.add(node.operationId);
    operations.push(node);
    previousSlot = slot;
    slot = node.operationId;
  }

  const orphans = Object.keys(chain).filter((key) => !seenSlots.has(key));
  if (orphans.length > 0) {
    anomalies.push(anomaly('CHAIN_BROKEN', {
      entityKey,
      slot: orphans[0],
      reason: 'узел недостижим от initial',
    }));
    return { ok: true, value: { operations: [], headOperationId: 'initial', anomalies } };
  }

  return {
    ok: true,
    value: {
      operations,
      headOperationId: operations.length > 0
        ? operations[operations.length - 1].operationId
        : 'initial',
      anomalies,
    },
  };
}

/** Применяет допустимые editEvent к источнику; источник не мутируется. */
export function effectiveEvent(source, operations = []) {
  const base = normalizeRecord(source || {});
  const effective = { ...base };
  let headOperationId = 'initial';
  for (const operation of operations) {
    if (!operation || operation.type !== 'editEvent') continue;
    const changes = operation.changes || {};
    for (const key of ['occurredAtMs', 'reason', 'triggerId']) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) {
        effective[key] = changes[key];
      }
    }
    if (changes.removeTrigger === true) delete effective.triggerId;
    headOperationId = operation.operationId;
  }
  effective.source = source;
  effective.headOperationId = headOperationId;
  return effective;
}

export function effectiveTriggers(triggerCreations, mutations) {
  const triggers = {};
  const anomalies = [];
  for (const [triggerId, source] of Object.entries(triggerCreations || {})) {
    if (!source || typeof source !== 'object') continue;
    const chain = walkMutationChain(mutations, `trigger_${triggerId}`);
    anomalies.push(...chain.value.anomalies);
    let name = source.name;
    for (const operation of chain.value.operations) {
      if (operation.type === 'renameTrigger' && operation.changes && operation.changes.name) {
        name = operation.changes.name;
      }
    }
    triggers[triggerId] = {
      ...normalizeRecord(source),
      name,
      originalName: source.name,
      source,
      headOperationId: chain.value.headOperationId,
    };
  }
  return { triggers, anomalies };
}

export function effectivePolicy(mutations) {
  const chain = walkMutationChain(mutations, 'categoryPolicy');
  if (chain.value.operations.length === 0) {
    return { policy: null, anomalies: chain.value.anomalies };
  }
  const policy = { categories: {}, triggerMappings: {}, operationId: 'initial' };
  for (const operation of chain.value.operations) {
    if (operation.type !== 'applyCategoryPolicy') continue;
    policy.categories = normalizeRecord(operation.changes.categories || {});
    policy.triggerMappings = normalizeRecord(operation.changes.triggerMappings || {});
    policy.sourceAnalysisId = operation.changes.sourceAnalysisId;
    policy.operationId = operation.operationId;
  }
  return { policy, anomalies: chain.value.anomalies };
}

/** Восстанавливает сущности, применяет допустимые цепи, сортирует эффективные события. */
export function replayJournal(snapshot = {}) {
  const mutations = snapshot.mutations || {};
  const anomalies = [];

  const triggersResult = effectiveTriggers(snapshot.triggerCreations, mutations);
  anomalies.push(...triggersResult.anomalies);

  const policyResult = effectivePolicy(mutations);
  anomalies.push(...policyResult.anomalies);

  const events = [];
  for (const [eventId, source] of Object.entries(snapshot.events || {})) {
    if (!source || typeof source !== 'object') continue;
    const chain = walkMutationChain(mutations, `event_${eventId}`);
    if (chain.value.anomalies.length > 0) {
      anomalies.push(...chain.value.anomalies);
    }
    const effective = effectiveEvent(source, chain.value.operations);
    events.push(effective);
  }

  for (const entityKey of Object.keys(mutations || {})) {
    if (entityKey === 'categoryPolicy') continue;
    if (entityKey.startsWith('event_')) {
      const id = entityKey.slice(6);
      if (!snapshot.events || !snapshot.events[id]) {
        anomalies.push(anomaly('ENTITY_MISSING', { entityKey, entityId: id, kind: 'event' }));
      }
    } else if (entityKey.startsWith('trigger_')) {
      const id = entityKey.slice(8);
      if (!snapshot.triggerCreations || !snapshot.triggerCreations[id]) {
        anomalies.push(anomaly('ENTITY_MISSING', { entityKey, entityId: id, kind: 'trigger' }));
      }
    } else {
      anomalies.push(anomaly('UNKNOWN_ENTITY_KEY', { entityKey }));
    }
  }

  events.sort((a, b) => {
    if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
    return String(a.eventId) < String(b.eventId) ? -1
      : String(a.eventId) > String(b.eventId) ? 1 : 0;
  });

  return {
    schemaVersion: 1,
    initialization: snapshot.initialization || null,
    events,
    triggers: triggersResult.triggers,
    policy: policyResult.policy,
    anomalies,
  };
}
