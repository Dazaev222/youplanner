/* Схема версии 1 домена «Дневник» (ТЗ §3, §4, §8, §9).
   Только чистые функции: allowlist полей, типы, диапазоны, зависимости.
   Полные календарные проверки, статистика и SHA-256 — в других модулях. */

import { invalid, ok } from './errors.js';
import { isFirebaseKey, RESERVED_OPERATION_ID } from './ids.js';

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  reasonLength: 4000,
  triggerNameLength: 200,
  exportBytes: 10 * 1024 * 1024,
  events: 100000,
  mutations: 100000,
  triggers: 10000,
  analysisBytes: 1024 * 1024,
});

export const MUTATION_TYPES = Object.freeze(['editEvent', 'renameTrigger', 'applyCategoryPolicy']);

const INITIALIZATION_FIELDS = ['schemaVersion', 'journalId', 'startedAtMs',
  'initialDurationMs', 'timeZone', 'createdAtMs', 'deviceId', 'acceptedAtMs',
  'originImportId'];
const EVENT_FIELDS = ['schemaVersion', 'eventId', 'occurredAtMs', 'reason', 'triggerId',
  'categoryPolicyOperationId', 'categoryId', 'deviceId', 'createdAtMs', 'acceptedAtMs',
  'originImportId'];
const TRIGGER_FIELDS = ['schemaVersion', 'triggerId', 'name', 'createdAtMs', 'deviceId',
  'acceptedAtMs', 'originImportId'];
const MUTATION_FIELDS = ['schemaVersion', 'operationId', 'predecessorOperationId',
  'predecessorSlot', 'entityKey', 'type', 'changes', 'basisFingerprint', 'createdAtMs',
  'deviceId', 'acceptedAtMs', 'originImportId'];
const ANALYSIS_FIELDS = ['analysisId', 'schemaVersion', 'sourceFingerprint', 'coveredEventIds',
  'model', 'generatedAtMs', 'proposal', 'completeness', 'acceptedAtMs', 'originImportId'];
const EXPORT_FIELDS = ['format', 'schemaVersion', 'exportedAtMs', 'journalId', 'timeZone',
  'snapshot', 'data', 'statistics', 'recordStates', 'integrity'];

const DURATION_RE = /^(\d{2,}):([0-5]\d)$/;
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInt(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function isText(value, min = 1, max = LIMITS.reasonLength) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function has(record, key) {
  return record[key] !== undefined && record[key] !== null;
}

export function isIanaTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Убирает null/undefined (RTDB их не хранит), не мутируя вход. */
export function normalizeRecord(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => normalizeRecord(item));
  }
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) continue;
    const item = value[key];
    if (item === null || item === undefined) continue;
    out[key] = normalizeRecord(item);
  }
  return out;
}

function checkFields(record, allowed, kind) {
  for (const key of Object.keys(record)) {
    if (PROTO_KEYS.has(key)) return invalid(key, 'Ключ объекта запрещён', { kind });
    if (!allowed.includes(key)) {
      return invalid(key, 'Неизвестное поле запрещено', { kind });
    }
  }
  return null;
}

function checkOriginImportId(record) {
  if (!has(record, 'originImportId')) return null;
  if (typeof record.originImportId !== 'string' || !isFirebaseKey(record.originImportId)) {
    return invalid('originImportId', 'originImportId — недопустимый ключ RTDB');
  }
  return null;
}

function requireKey(result, path) {
  if (!result.ok) return invalid(path, result.error.message, { path });
  return null;
}

// ---------------------------------------------------------------------------
// Длительность HH:MM
// ---------------------------------------------------------------------------

/** 'HH:MM' → миллисекунды. Часы могут превышать 23; 00:00 допустим. */
export function parseDuration(text) {
  if (typeof text !== 'string') {
    return invalid('duration', 'Длительность должна быть строкой HH:MM');
  }
  const match = DURATION_RE.exec(text);
  if (!match) {
    return invalid('duration', 'Ожидается HH:MM (минуты 00–59, часы ≥ 00)');
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const ms = (hours * 60 + minutes) * 60000;
  if (!Number.isSafeInteger(ms)) {
    return invalid('duration', 'Длительность слишком велика');
  }
  return ok(ms);
}

/** Миллисекунды → 'HH:MM' (без округления в большую сторону). */
export function formatDuration(ms) {
  if (!isSafeInt(ms)) throw new TypeError('formatDuration: нужно неотрицательное целое');
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// initialization
// ---------------------------------------------------------------------------

export function validateInitialization(raw) {
  if (!isObject(raw)) return invalid('initialization', 'initialization должен быть объектом');
  const record = normalizeRecord(raw);
  const fields = checkFields(record, INITIALIZATION_FIELDS, 'initialization');
  if (fields) return fields;
  const origin = checkOriginImportId(record);
  if (origin) return origin;

  if (record.schemaVersion !== SCHEMA_VERSION) {
    return invalid('schemaVersion', 'Поддерживается только schemaVersion 1');
  }
  const journalKey = requireKey(
    keyResult(record.journalId, 'journalId'), 'journalId');
  if (journalKey) return journalKey;
  if (!isSafeInt(record.startedAtMs)) {
    return invalid('startedAtMs', 'startedAtMs должен быть целым ≥ 0');
  }
  if (!isSafeInt(record.initialDurationMs)) {
    return invalid('initialDurationMs', 'initialDurationMs должен быть целым ≥ 0');
  }
  if (!isSafeInt(record.createdAtMs)) {
    return invalid('createdAtMs', 'createdAtMs должен быть целым ≥ 0');
  }
  if (record.startedAtMs + record.initialDurationMs !== record.createdAtMs) {
    return invalid('startedAtMs', 'startedAtMs + initialDurationMs должны давать createdAtMs');
  }
  if (!isIanaTimeZone(record.timeZone)) {
    return invalid('timeZone', 'Нужен действующий IANA-пояс');
  }
  if (!isText(record.deviceId, 1, 128)) {
    return invalid('deviceId', 'deviceId обязателен');
  }
  return ok(record);
}

function keyResult(value, path) {
  if (typeof value !== 'string' || !isFirebaseKey(value)) {
    return { ok: false, error: { message: 'Недопустимый ключ RTDB' } };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export function validateEvent(raw, options = {}) {
  if (!isObject(raw)) return invalid('event', 'Событие должно быть объектом');
  const record = normalizeRecord(raw);
  const fields = checkFields(record, EVENT_FIELDS, 'event');
  if (fields) return fields;
  const origin = checkOriginImportId(record);
  if (origin) return origin;

  if (record.schemaVersion !== SCHEMA_VERSION) {
    return invalid('schemaVersion', 'Поддерживается только schemaVersion 1');
  }
  const eventId = requireKey(keyResult(record.eventId, 'eventId'), 'eventId');
  if (eventId) return eventId;
  if (!record.eventId.startsWith('event-')) {
    return invalid('eventId', 'eventId должен начинаться с event-');
  }
  if (options.eventId && record.eventId !== options.eventId) {
    return invalid('eventId', 'eventId не совпадает с ключом пути');
  }
  if (!isSafeInt(record.occurredAtMs)) {
    return invalid('occurredAtMs', 'occurredAtMs должен быть целым ≥ 0');
  }
  if (has(record, 'reason') && (typeof record.reason !== 'string'
    || record.reason.length > LIMITS.reasonLength)) {
    return invalid('reason', `reason: строка до ${LIMITS.reasonLength} символов`);
  }

  // RTDB не хранит null: отсутствие триггера и null — одно и то же.
  const reasonIsEmpty = !has(record, 'reason') || record.reason.trim() === '';
  const triggerIsEmpty = !has(record, 'triggerId') || record.triggerId.trim() === '';
  if (reasonIsEmpty && triggerIsEmpty) {
    return invalid('triggerId|reason', 'Нужен ровно один триггер либо непустая причина');
  }

  if (has(record, 'triggerId')) {
    const triggerId = requireKey(keyResult(record.triggerId, 'triggerId'), 'triggerId');
    if (triggerId) return triggerId;
    if (!record.triggerId.startsWith('trigger-')) {
      return invalid('triggerId', 'triggerId должен начинаться с trigger-');
    }
  }

  const policyOperationId = has(record, 'categoryPolicyOperationId')
    ? record.categoryPolicyOperationId
    : RESERVED_OPERATION_ID;
  if (policyOperationId !== RESERVED_OPERATION_ID && !isFirebaseKey(policyOperationId)) {
    return invalid('categoryPolicyOperationId', 'Недопустимый categoryPolicyOperationId');
  }
  if (has(record, 'categoryId')) {
    const categoryId = requireKey(keyResult(record.categoryId, 'categoryId'), 'categoryId');
    if (categoryId) return categoryId;
    if (policyOperationId === RESERVED_OPERATION_ID) {
      return invalid('categoryId', 'Категория допустима только по принятой политике');
    }
  }
  if (!isText(record.deviceId, 1, 128)) {
    return invalid('deviceId', 'deviceId обязателен');
  }
  if (!isSafeInt(record.createdAtMs)) {
    return invalid('createdAtMs', 'createdAtMs должен быть целым ≥ 0');
  }
  if (!has(record, 'categoryPolicyOperationId')) {
    record.categoryPolicyOperationId = policyOperationId;
  }
  return ok(record);
}

// ---------------------------------------------------------------------------
// triggerCreations
// ---------------------------------------------------------------------------

export function validateTrigger(raw, options = {}) {
  if (!isObject(raw)) return invalid('trigger', 'Триггер должен быть объектом');
  const record = normalizeRecord(raw);
  const fields = checkFields(record, TRIGGER_FIELDS, 'trigger');
  if (fields) return fields;
  const origin = checkOriginImportId(record);
  if (origin) return origin;

  if (record.schemaVersion !== SCHEMA_VERSION) {
    return invalid('schemaVersion', 'Поддерживается только schemaVersion 1');
  }
  const triggerId = requireKey(keyResult(record.triggerId, 'triggerId'), 'triggerId');
  if (triggerId) return triggerId;
  if (!record.triggerId.startsWith('trigger-')) {
    return invalid('triggerId', 'triggerId должен начинаться с trigger-');
  }
  if (options.triggerId && record.triggerId !== options.triggerId) {
    return invalid('triggerId', 'triggerId не совпадает с ключом пути');
  }
  if (!isText(record.name, 1, LIMITS.triggerNameLength)) {
    return invalid('name', `name: 1–${LIMITS.triggerNameLength} символов без пробелов вокруг`);
  }
  if (!isText(record.deviceId, 1, 128)) {
    return invalid('deviceId', 'deviceId обязателен');
  }
  if (!isSafeInt(record.createdAtMs)) {
    return invalid('createdAtMs', 'createdAtMs должен быть целым ≥ 0');
  }
  return ok(record);
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function parseEntityKey(entityKey) {
  if (entityKey === 'categoryPolicy') return { kind: 'categoryPolicy' };
  if (typeof entityKey !== 'string') return null;
  for (const [prefix, kind] of [['event_', 'event'], ['trigger_', 'trigger']]) {
    if (entityKey.startsWith(prefix)) {
      const id = entityKey.slice(prefix.length);
      const idPrefix = kind === 'event' ? 'event-' : 'trigger-';
      return isFirebaseKey(id) && id.startsWith(idPrefix) ? { kind, id } : null;
    }
  }
  return null;
}

export function validateMutation(raw, options = {}) {
  if (!isObject(raw)) return invalid('mutation', 'Мутация должна быть объектом');
  const record = normalizeRecord(raw);
  const fields = checkFields(record, MUTATION_FIELDS, 'mutation');
  if (fields) return fields;
  const origin = checkOriginImportId(record);
  if (origin) return origin;

  if (record.schemaVersion !== SCHEMA_VERSION) {
    return invalid('schemaVersion', 'Поддерживается только schemaVersion 1');
  }
  const slot = options.slot;
  if (typeof slot !== 'string' || !(slot === RESERVED_OPERATION_ID || isFirebaseKey(slot))) {
    return invalid('slot', 'Некорректный слот цепочки');
  }
  if (!isFirebaseKey(record.operationId) || record.operationId === RESERVED_OPERATION_ID) {
    return invalid('operationId', 'operationId — новый ключ, не initial');
  }
  if (record.operationId === slot || record.operationId === record.predecessorOperationId) {
    return invalid('operationId', 'operationId повторяет предшественника');
  }
  if (record.predecessorOperationId !== slot) {
    return invalid('predecessorOperationId', 'predecessorOperationId должен совпадать со слотом пути');
  }

  if (slot === RESERVED_OPERATION_ID) {
    if (has(record, 'predecessorSlot')) {
      return invalid('predecessorSlot', 'У первой правки predecessorSlot отсутствует');
    }
  } else {
    if (!has(record, 'predecessorSlot') || !isFirebaseKey(record.predecessorSlot)) {
      return invalid('predecessorSlot', 'Нужен ключ узла предыдущей операции');
    }
    if (record.predecessorSlot === slot) {
      return invalid('predecessorSlot', 'predecessorSlot указывает на узел до предыдущего');
    }
  }

  const entity = parseEntityKey(record.entityKey);
  if (!entity) return invalid('entityKey', 'Недопустимый entityKey');
  if (options.entityKey && record.entityKey !== options.entityKey) {
    return invalid('entityKey', 'entityKey не совпадает с ключом пути');
  }

  const expectedType = entity.kind === 'event' ? 'editEvent'
    : entity.kind === 'trigger' ? 'renameTrigger' : 'applyCategoryPolicy';
  if (!MUTATION_TYPES.includes(record.type)) {
    return invalid('type', 'Неизвестный тип мутации');
  }
  if (record.type !== expectedType) {
    return invalid('type', 'Тип не соответствует entityKey');
  }

  const changesError = validateChanges(record.type, record.changes);
  if (changesError) return changesError;

  if (typeof record.basisFingerprint !== 'string' || !FINGERPRINT_RE.test(record.basisFingerprint)) {
    return invalid('basisFingerprint', 'Ожидается sha256:<64 hex>');
  }
  if (!isSafeInt(record.createdAtMs)) {
    return invalid('createdAtMs', 'createdAtMs должен быть целым ≥ 0');
  }
  if (!isText(record.deviceId, 1, 128)) {
    return invalid('deviceId', 'deviceId обязателен');
  }
  return ok(record);
}

export function validateChanges(type, rawChanges) {
  const changes = normalizeRecord(rawChanges);
  if (!isObject(changes) || Object.keys(changes).length === 0) {
    return invalid('changes', 'changes обязателен и не пуст');
  }
  const keys = Object.keys(changes);

  if (type === 'editEvent') {
    for (const key of keys) {
      if (!['occurredAtMs', 'reason', 'triggerId', 'removeTrigger'].includes(key)) {
        return invalid(`changes.${key}`, 'editEvent меняет только occurredAtMs/reason/triggerId/removeTrigger');
      }
    }
    if (has(changes, 'occurredAtMs') && !isSafeInt(changes.occurredAtMs)) {
      return invalid('changes.occurredAtMs', 'occurredAtMs должен быть целым ≥ 0');
    }
    if (has(changes, 'reason') && (typeof changes.reason !== 'string'
      || changes.reason.length > LIMITS.reasonLength)) {
      return invalid('changes.reason', `reason: строка до ${LIMITS.reasonLength} символов`);
    }
    if (has(changes, 'triggerId')) {
      if (!isFirebaseKey(changes.triggerId)) {
        return invalid('changes.triggerId', 'Недопустимый triggerId');
      }
    }
    // Явный маркер переживает нормализацию и транспорт RTDB (в отличие от null).
    if (has(changes, 'removeTrigger') && (changes.removeTrigger !== true || has(changes, 'triggerId'))) {
      return invalid('changes.removeTrigger', 'removeTrigger должен быть true без triggerId');
    }
    if (!has(changes, 'occurredAtMs') && !has(changes, 'reason') && !has(changes, 'triggerId') && changes.removeTrigger !== true) {
      return invalid('changes', 'Нет допустимых изменений');
    }
    return null;
  }

  if (type === 'renameTrigger') {
    for (const key of keys) {
      if (key !== 'name') {
        return invalid(`changes.${key}`, 'renameTrigger меняет только name');
      }
    }
    if (!isText(changes.name, 1, LIMITS.triggerNameLength)) {
      return invalid('changes.name', `name: 1–${LIMITS.triggerNameLength} символов`);
    }
    return null;
  }

  if (type === 'applyCategoryPolicy') {
    for (const key of keys) {
      if (!['categories', 'triggerMappings', 'sourceAnalysisId'].includes(key)) {
        return invalid(`changes.${key}`, 'Недопустимое поле политики категорий');
      }
    }
    if (!isObject(changes.categories) || Object.keys(changes.categories).length === 0) {
      return invalid('changes.categories', 'categories обязана быть полной картой');
    }
    for (const [categoryId, category] of Object.entries(changes.categories)) {
      if (!isFirebaseKey(categoryId) || categoryId.startsWith('__')) {
        return invalid(`changes.categories.${categoryId}`, 'Недопустимый categoryId');
      }
      if (!isObject(category) || !isText(category.name, 1, LIMITS.triggerNameLength)) {
        return invalid(`changes.categories.${categoryId}.name`, 'category.name обязателен');
      }
      for (const key of Object.keys(category)) {
        if (key !== 'name') {
          return invalid(`changes.categories.${categoryId}.${key}`, 'Лишнее поле категории');
        }
      }
    }
    if (!isObject(changes.triggerMappings)) {
      return invalid('changes.triggerMappings', 'triggerMappings обязана быть картой');
    }
    for (const [triggerId, categoryId] of Object.entries(changes.triggerMappings)) {
      if (!isFirebaseKey(triggerId) || triggerId.startsWith('__')) {
        return invalid(`changes.triggerMappings.${triggerId}`, 'Недопустимый triggerId');
      }
      if (typeof categoryId !== 'string' || !changes.categories[categoryId]) {
        return invalid(`changes.triggerMappings.${triggerId}`,
          'Сопоставление ссылается на отсутствующую категорию');
      }
    }
    if (has(changes, 'sourceAnalysisId') && !isFirebaseKey(changes.sourceAnalysisId)) {
      return invalid('changes.sourceAnalysisId', 'Недопустимый sourceAnalysisId');
    }
    return null;
  }

  return invalid('type', 'Неизвестный тип мутации');
}

// ---------------------------------------------------------------------------
// analyses
// ---------------------------------------------------------------------------

const COMPLETENESS_VALUES = ['complete', 'partial', 'unknown'];

export function validateAnalysis(raw) {
  if (!isObject(raw)) return invalid('analysis', 'Анализ должен быть объектом');
  const record = normalizeRecord(raw);
  const fields = checkFields(record, ANALYSIS_FIELDS, 'analysis');
  if (fields) return fields;
  const origin = checkOriginImportId(record);
  if (origin) return origin;

  if (record.schemaVersion !== SCHEMA_VERSION) {
    return invalid('schemaVersion', 'Поддерживается только schemaVersion 1');
  }
  if (!isFirebaseKey(record.analysisId)) {
    return invalid('analysisId', 'Недопустимый analysisId');
  }
  if (typeof record.sourceFingerprint !== 'string' || !FINGERPRINT_RE.test(record.sourceFingerprint)) {
    return invalid('sourceFingerprint', 'Ожидается sha256:<64 hex>');
  }
  if (!Array.isArray(record.coveredEventIds) || record.coveredEventIds.length === 0) {
    return invalid('coveredEventIds', 'Нужен непустой список событий');
  }
  const seen = new Set();
  for (const id of record.coveredEventIds) {
    if (!isFirebaseKey(id)) {
      return invalid('coveredEventIds', 'Недопустимый eventId в покрытии');
    }
    if (seen.has(id)) {
      return invalid('coveredEventIds', 'eventId не должен повторяться');
    }
    seen.add(id);
  }
  if (!isText(record.model, 1, 200)) {
    return invalid('model', 'model обязателен');
  }
  if (!isSafeInt(record.generatedAtMs)) {
    return invalid('generatedAtMs', 'generatedAtMs должен быть целым ≥ 0');
  }
  if (!COMPLETENESS_VALUES.includes(record.completeness)
    && !isObject(record.completeness)) {
    return invalid('completeness', 'completeness: complete/partial/unknown');
  }
  const proposalError = validateAnalysisProposal(record.proposal);
  if (proposalError) return proposalError;
  return ok(record);
}

export function validateAnalysisProposal(raw) {
  if (!isObject(raw)) return invalid('proposal', 'proposal должен быть объектом');
  for (const key of Object.keys(raw)) {
    if (!['categories', 'triggerMappings', 'reasonGroups', 'summary'].includes(key)) {
      return invalid('proposal', `Лишнее поле proposal: ${key}`);
    }
  }
  if (!Array.isArray(raw.categories)) return invalid('proposal', 'categories — массив');
  const categoryIds = new Set();
  for (const item of raw.categories) {
    if (!isObject(item) || !isFirebaseKey(item.id) || !isText(item.name, 1, LIMITS.triggerNameLength)) {
      return invalid('proposal', 'Нужны categories [{id,name}]');
    }
    if (Object.keys(item).some((key) => !['id', 'name'].includes(key))) {
      return invalid('proposal', 'Лишние поля категории в proposal');
    }
    if (categoryIds.has(item.id)) return invalid('proposal', 'Повтор category id');
    categoryIds.add(item.id);
  }
  if (!Array.isArray(raw.triggerMappings)) {
    return invalid('proposal', 'triggerMappings — массив');
  }
  for (const item of raw.triggerMappings) {
    if (!isObject(item) || !isFirebaseKey(item.triggerId)
      || !isFirebaseKey(item.categoryId) || !categoryIds.has(item.categoryId)) {
      return invalid('proposal', 'Нужны triggerMappings [{triggerId,categoryId}]');
    }
  }
  if (!Array.isArray(raw.reasonGroups)) return invalid('proposal', 'reasonGroups — массив');
  for (const item of raw.reasonGroups) {
    if (!isObject(item) || !isText(item.label, 1, LIMITS.triggerNameLength)
      || !Array.isArray(item.eventIds) || item.eventIds.length === 0
      || item.eventIds.some((id) => !isFirebaseKey(id))) {
      return invalid('proposal', 'Нужны reasonGroups [{label,eventIds}]');
    }
  }
  if (typeof raw.summary !== 'string' || raw.summary.length > 4000) {
    return invalid('proposal', 'summary — строка до 4000 символов');
  }
  return null;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export function validateExport(raw) {
  if (!isObject(raw)) return invalid('export', 'Экспорт должен быть объектом');
  const record = normalizeRecord(raw);
  const fields = checkFields(record, EXPORT_FIELDS, 'export');
  if (fields) return fields;

  if (record.format !== 'youplanner-diary') {
    return invalid('format', 'Ожидается формат youplanner-diary');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    return invalid('schemaVersion', 'Поддерживается только schemaVersion 1');
  }
  if (!isSafeInt(record.exportedAtMs)) {
    return invalid('exportedAtMs', 'exportedAtMs должен быть целым ≥ 0');
  }
  if (!isFirebaseKey(record.journalId)) {
    return invalid('journalId', 'Недопустимый journalId');
  }
  if (!isIanaTimeZone(record.timeZone)) {
    return invalid('timeZone', 'Нужен действующий IANA-пояс');
  }

  const snapshot = record.snapshot;
  if (!isObject(snapshot)) return invalid('snapshot', 'snapshot обязателен');
  if (typeof snapshot.fingerprint !== 'string' || !FINGERPRINT_RE.test(snapshot.fingerprint)) {
    return invalid('snapshot.fingerprint', 'Нужен sha256-отпечаток');
  }
  if (!['availableLocal', 'server'].includes(snapshot.scope)) {
    return invalid('snapshot.scope', 'scope: availableLocal/server');
  }
  if (typeof snapshot.syncComplete !== 'boolean') {
    return invalid('snapshot.syncComplete', 'syncComplete должен быть boolean');
  }
  if (!Array.isArray(snapshot.pendingEventIds)) {
    return invalid('snapshot.pendingEventIds', 'pendingEventIds — массив');
  }

  if (!isObject(record.data)) return invalid('data', 'data обязателен');
  for (const section of ['events', 'triggerCreations', 'mutations', 'analyses']) {
    if (!isObject(record.data[section])) {
      return invalid(`data.${section}`, `Раздел data.${section} должен быть объектом`);
    }
  }
  if (!isObject(record.statistics)) return invalid('statistics', 'statistics обязателен');
  if (!isObject(record.recordStates)) return invalid('recordStates', 'recordStates обязателен');

  const integrity = record.integrity;
  if (!isObject(integrity)) return invalid('integrity', 'integrity обязателен');
  if (integrity.algorithm !== 'SHA-256') {
    return invalid('integrity.algorithm', 'Поддерживается только SHA-256');
  }
  if (typeof integrity.contentHash !== 'string' || !FINGERPRINT_RE.test(integrity.contentHash)) {
    return invalid('integrity.contentHash', 'Нужен sha256-contentHash');
  }
  return ok(record);
}
