/* JSON-экспорт и добавляющий импорт дневника (ТЗ §8, §11).
   Экспорт только читает локальный снимок. Импорт сначала валидирует файл
   целиком, затем строит план и лишь после этого пишет. Никакой UI здесь нет. */

import {
  equivalentDomainRecord,
  hashExport,
  hashSnapshot,
} from './canonical.js';
import { fail, ok, sanitizeMessage } from './errors.js';
import { isFirebaseKey, newId, RESERVED_OPERATION_ID } from './ids.js';
import { replayJournal, walkMutationChain } from './projection.js';
import { calculateStatistics } from './statistics.js';
import {
  LIMITS,
  SCHEMA_VERSION,
  normalizeRecord,
  validateAnalysis,
  validateEvent,
  validateExport,
  validateInitialization,
  validateMutation,
  validateTrigger,
} from './schema.js';

const SERVER_TIMESTAMP = { '.sv': 'timestamp' };
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const OUTBOX_STATUSES = new Set(['pending', 'sending', 'unknown', 'acknowledged', 'blocked']);
const TERMINAL_SKIP = new Set(['acknowledged', 'skipped', 'conflict', 'blocked']);
const RETRYABLE = new Set(['pending', 'unknown', 'sending']);
const UTF8 = new TextEncoder();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function bytesOf(value) {
  return UTF8.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function importInvalid(message, details = {}) {
  return fail('IMPORT_INVALID', message, details, false);
}

function limitExceeded(message, details = {}) {
  return fail('LIMIT_EXCEEDED', message, details, false);
}

function sizeOrLimit(text) {
  const bytes = bytesOf(text);
  if (bytes > LIMITS.exportBytes) {
    return {
      error: limitExceeded('Файл импорта больше 10 MiB', {
        limit: 'exportBytes', actualBytes: bytes, maxBytes: LIMITS.exportBytes,
      }),
    };
  }
  return { bytes };
}

function findForbiddenKey(value, path = '', depth = 0) {
  if (depth > 64) return { path: path || 'root', reason: 'MAX_DEPTH' };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) return { path: path ? `${path}.${key}` : key, reason: 'FORBIDDEN_KEY' };
    const found = findForbiddenKey(value[key], path ? `${path}.${key}` : key, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Заменяет {".sv":"timestamp"} числом. Экспорт не хранит placeholder. */
export function replaceServerTimestamps(value, fallbackMs) {
  if (Array.isArray(value)) {
    return value.map((item) => replaceServerTimestamps(item, fallbackMs));
  }
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '.sv' && value['.sv'] === 'timestamp') {
    return fallbackMs;
  }
  const out = {};
  for (const key of keys) {
    if (PROTO_KEYS.has(key)) continue;
    out[key] = replaceServerTimestamps(value[key], fallbackMs);
  }
  return out;
}

function mapRecords(section, fallbackMs) {
  const out = {};
  for (const [id, record] of Object.entries(section || {})) {
    if (!isObject(record)) continue;
    out[id] = replaceServerTimestamps(normalizeRecord(record), fallbackMs);
  }
  return out;
}

function mapMutations(section, fallbackMs) {
  const out = {};
  for (const [entityKey, chain] of Object.entries(section || {})) {
    if (!isObject(chain)) continue;
    const slots = {};
    for (const [slot, record] of Object.entries(chain)) {
      if (!isObject(record)) continue;
      slots[slot] = replaceServerTimestamps(normalizeRecord(record), fallbackMs);
    }
    out[entityKey] = slots;
  }
  return out;
}

function pathState(path, outboxByPath, receiptsByPath) {
  if (outboxByPath.has(path)) return outboxByPath.get(path).status || 'pending';
  if (receiptsByPath.has(path)) return receiptsByPath.get(path).status || 'acknowledged';
  return 'acknowledged';
}

function buildRecordStates(snapshot) {
  const states = {};
  const outboxByPath = new Map();
  for (const entry of snapshot.outbox || []) {
    if (entry && typeof entry.path === 'string') outboxByPath.set(entry.path, entry);
  }
  const receiptsByPath = new Map();
  for (const receipt of snapshot.receipts || []) {
    if (receipt && typeof receipt.path === 'string') receiptsByPath.set(receipt.path, receipt);
  }
  if (snapshot.initialization) {
    states.initialization = pathState('initialization', outboxByPath, receiptsByPath);
  }
  for (const id of Object.keys(snapshot.events || {})) {
    states[`events/${id}`] = pathState(`events/${id}`, outboxByPath, receiptsByPath);
  }
  for (const id of Object.keys(snapshot.triggerCreations || {})) {
    states[`triggerCreations/${id}`] = pathState(
      `triggerCreations/${id}`, outboxByPath, receiptsByPath);
  }
  for (const [entityKey, chain] of Object.entries(snapshot.mutations || {})) {
    for (const slot of Object.keys(chain || {})) {
      const path = `mutations/${entityKey}/${slot}`;
      states[path] = pathState(path, outboxByPath, receiptsByPath);
    }
  }
  for (const id of Object.keys(snapshot.analyses || {})) {
    states[`analyses/${id}`] = pathState(`analyses/${id}`, outboxByPath, receiptsByPath);
  }
  return states;
}

function pendingEventIds(snapshot) {
  const ids = [];
  for (const entry of snapshot.outbox || []) {
    if (!entry || entry.kind !== 'event') continue;
    if (entry.status === 'acknowledged') continue;
    const prefix = 'events/';
    if (typeof entry.path === 'string' && entry.path.startsWith(prefix)) {
      const id = entry.path.slice(prefix.length);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function syncComplete(snapshot) {
  for (const entry of snapshot.outbox || []) {
    if (!entry || entry.status !== 'acknowledged') return false;
  }
  return true;
}

/** Экспорт доступной локальной истории. Не подтверждает данные второго телефона. */
export async function exportDiary(snapshot, asOfMs) {
  if (!snapshot || !isObject(snapshot) || !isObject(snapshot.initialization)) {
    return fail('INVALID_DATA', 'Экспорт требует initialization', { path: 'initialization' });
  }
  if (!isSafeInt(asOfMs)) {
    return fail('INVALID_DATA', 'Экспорт требует exportedAtMs', { path: 'exportedAtMs' });
  }
  const initialization = replaceServerTimestamps(
    normalizeRecord(snapshot.initialization), asOfMs);
  const data = {
    initialization,
    events: mapRecords(snapshot.events, asOfMs),
    triggerCreations: mapRecords(snapshot.triggerCreations, asOfMs),
    mutations: mapMutations(snapshot.mutations, asOfMs),
    analyses: mapRecords(snapshot.analyses, asOfMs),
  };
  const projection = replayJournal(data);
  let statistics;
  try {
    statistics = normalizeRecord(calculateStatistics({
      startedAtMs: initialization.startedAtMs,
      events: projection.events,
      nowMs: asOfMs,
      timeZone: initialization.timeZone,
    }));
  } catch (error) {
    return fail('INVALID_DATA', sanitizeMessage(error && error.message), {
      path: 'statistics',
    });
  }

  const file = {
    format: 'youplanner-diary',
    schemaVersion: SCHEMA_VERSION,
    exportedAtMs: asOfMs,
    journalId: initialization.journalId,
    timeZone: initialization.timeZone,
    snapshot: {
      fingerprint: await hashSnapshot(data),
      scope: 'availableLocal',
      syncComplete: syncComplete(snapshot),
      pendingEventIds: pendingEventIds(snapshot),
    },
    data,
    statistics,
    recordStates: buildRecordStates(snapshot),
    integrity: { algorithm: 'SHA-256', contentHash: '' },
  };
  file.integrity.contentHash = await hashExport(file);
  return ok(file);
}

function countFile(file) {
  const data = file && isObject(file.data) ? file.data : {};
  let mutations = 0;
  for (const chain of Object.values(isObject(data.mutations) ? data.mutations : {})) {
    if (isObject(chain)) mutations += Object.keys(chain).length;
  }
  return {
    events: isObject(data.events) ? Object.keys(data.events).length : 0,
    triggers: isObject(data.triggerCreations) ? Object.keys(data.triggerCreations).length : 0,
    mutations,
    analyses: isObject(data.analyses) ? Object.keys(data.analyses).length : 0,
  };
}

function checkLimits(counts) {
  if (counts.events > LIMITS.events) {
    return limitExceeded('Слишком много событий в файле', {
      limit: 'events', actual: counts.events, max: LIMITS.events,
    });
  }
  if (counts.mutations > LIMITS.mutations) {
    return limitExceeded('Слишком много правок в файле', {
      limit: 'mutations', actual: counts.mutations, max: LIMITS.mutations,
    });
  }
  if (counts.triggers > LIMITS.triggers) {
    return limitExceeded('Слишком много триггеров в файле', {
      limit: 'triggers', actual: counts.triggers, max: LIMITS.triggers,
    });
  }
  return null;
}

function acceptedAtIsValid(record) {
  if (!Object.prototype.hasOwnProperty.call(record, 'acceptedAtMs')) return true;
  return isSafeInt(record.acceptedAtMs);
}

function parseImportInput(text) {
  if (typeof text === 'string') {
    const sized = sizeOrLimit(text);
    if (sized.error) return sized;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: importInvalid('Некорректный JSON', { path: 'json' }) };
    }
    return { value: parsed };
  }
  if (isObject(text)) {
    const sized = sizeOrLimit(text);
    if (sized.error) return sized;
    return { value: text };
  }
  return { error: importInvalid('Импорт ожидает JSON-текст', { path: 'text' }) };
}

/** Полная проверка недоверенного файла до планирования и записи. */
export async function validateImport(text) {
  const parsed = parseImportInput(text);
  if (parsed.error) return parsed.error;
  const forbidden = findForbiddenKey(parsed.value);
  if (forbidden) {
    return importInvalid('Запрещённый ключ объекта', forbidden);
  }
  const file = normalizeRecord(parsed.value);
  if (!isObject(file)) return importInvalid('Экспорт должен быть объектом', { path: 'root' });

  const counts = countFile(file);
  const limits = checkLimits(counts);
  if (limits) return limits;

  const shape = validateExport(file);
  if (!shape.ok) {
    return importInvalid(shape.error.message, {
      path: shape.error.details && shape.error.details.path,
      reason: 'schema',
    });
  }

  const initialization = validateInitialization(file.data.initialization);
  if (!initialization.ok) {
    return importInvalid(initialization.error.message, {
      path: 'data.initialization',
      reason: 'initialization',
    });
  }
  file.data.initialization = initialization.value;
  if (initialization.value.journalId !== file.journalId) {
    return importInvalid('journalId initialization не совпадает с файлом', {
      path: 'data.initialization.journalId',
    });
  }
  if (initialization.value.timeZone !== file.timeZone) {
    return importInvalid('timeZone initialization не совпадает с файлом', {
      path: 'data.initialization.timeZone',
    });
  }

  const expectedFingerprint = await hashSnapshot(file.data);
  if (file.snapshot.fingerprint !== expectedFingerprint) {
    return importInvalid('fingerprint снимка не совпадает с содержимым', {
      path: 'snapshot.fingerprint', reason: 'SNAPSHOT_FINGERPRINT_MISMATCH',
    });
  }
  const expectedHash = await hashExport(file);
  if (file.integrity.contentHash !== expectedHash) {
    return importInvalid('contentHash не совпадает с содержимым', {
      path: 'integrity.contentHash', reason: 'INTEGRITY_MISMATCH',
    });
  }

  for (const [id, raw] of Object.entries(file.data.events || {})) {
    if (!isFirebaseKey(id)) {
      return importInvalid('Недопустимый eventId', { path: `data.events.${id}` });
    }
    const checked = validateEvent(raw, { eventId: id });
    if (!checked.ok) {
      return importInvalid(checked.error.message, {
        path: `data.events.${id}`,
        reason: 'event',
      });
    }
    if (!acceptedAtIsValid(raw)) {
      return importInvalid('acceptedAtMs обязан быть числом', {
        path: `data.events.${id}.acceptedAtMs`,
      });
    }
    file.data.events[id] = checked.value;
  }

  for (const [id, raw] of Object.entries(file.data.triggerCreations || {})) {
    if (!isFirebaseKey(id)) {
      return importInvalid('Недопустимый triggerId', { path: `data.triggerCreations.${id}` });
    }
    const checked = validateTrigger(raw, { triggerId: id });
    if (!checked.ok) {
      return importInvalid(checked.error.message, {
        path: `data.triggerCreations.${id}`,
        reason: 'trigger',
      });
    }
    if (!acceptedAtIsValid(raw)) {
      return importInvalid('acceptedAtMs обязан быть числом', {
        path: `data.triggerCreations.${id}.acceptedAtMs`,
      });
    }
    file.data.triggerCreations[id] = checked.value;
  }

  const seenOperations = new Set();
  for (const [entityKey, chain] of Object.entries(file.data.mutations || {})) {
    if (!isFirebaseKey(entityKey) || !isObject(chain)) {
      return importInvalid('Недопустимая цепь правок', { path: `data.mutations.${entityKey}` });
    }
    for (const slot of Object.keys(chain)) {
      if (!isFirebaseKey(slot)) {
        return importInvalid('Недопустимый слот правки', {
          path: `data.mutations.${entityKey}.${slot}`,
        });
      }
    }
    const walked = walkMutationChain(file.data.mutations, entityKey);
    if (walked.value.anomalies.length > 0) {
      return importInvalid('Цепь правок повреждена', {
        path: `data.mutations.${entityKey}`,
        reason: 'BROKEN_CHAIN',
        anomalies: walked.value.anomalies,
      });
    }
    for (const operation of walked.value.operations) {
      if (seenOperations.has(operation.operationId)) {
        return importInvalid('operationId повторяется в разных цепях', {
          path: `data.mutations.${entityKey}.${operation.predecessorOperationId}`,
          reason: 'DUPLICATE_OPERATION_ID',
        });
      }
      seenOperations.add(operation.operationId);
      if (!acceptedAtIsValid(operation)) {
        return importInvalid('acceptedAtMs обязан быть числом', {
          path: `data.mutations.${entityKey}.${operation.predecessorOperationId}.acceptedAtMs`,
        });
      }
      file.data.mutations[entityKey][operation.predecessorOperationId] = operation;
    }
    if (entityKey.startsWith('event_')) {
      const id = entityKey.slice('event_'.length);
      if (!file.data.events[id]) {
        return importInvalid('Цепь правок ссылается на отсутствующее событие', {
          path: `data.mutations.${entityKey}`, reason: 'ENTITY_MISSING',
        });
      }
    } else if (entityKey.startsWith('trigger_')) {
      const id = entityKey.slice('trigger_'.length);
      if (!file.data.triggerCreations[id]) {
        return importInvalid('Цепь правок ссылается на отсутствующий триггер', {
          path: `data.mutations.${entityKey}`, reason: 'ENTITY_MISSING',
        });
      }
    } else if (entityKey !== 'categoryPolicy') {
      return importInvalid('Неизвестный entityKey', {
        path: `data.mutations.${entityKey}`, reason: 'UNKNOWN_ENTITY_KEY',
      });
    }
  }

  for (const [id, raw] of Object.entries(file.data.analyses || {})) {
    if (!isFirebaseKey(id)) {
      return importInvalid('Недопустимый analysisId', { path: `data.analyses.${id}` });
    }
    const checked = validateAnalysis(raw);
    if (!checked.ok) {
      return importInvalid(checked.error.message, {
        path: `data.analyses.${id}`, reason: 'analysis',
      });
    }
    if (!acceptedAtIsValid(raw)) {
      return importInvalid('acceptedAtMs обязан быть числом', {
        path: `data.analyses.${id}.acceptedAtMs`,
      });
    }
    if (bytesOf(raw) > LIMITS.analysisBytes) {
      return limitExceeded('Анализ больше 1 MiB', {
        path: `data.analyses.${id}`, limit: 'analysisBytes', max: LIMITS.analysisBytes,
      });
    }
    if (raw.coveredEventIds.some((eventId) => !file.data.events[eventId])) {
      return importInvalid('Анализ покрывает отсутствующее событие', {
        path: `data.analyses.${id}.coveredEventIds`, reason: 'ENTITY_MISSING',
      });
    }
    file.data.analyses[id] = checked.value;
  }

  if (!isObject(file.recordStates)) {
    return importInvalid('recordStates обязан быть объектом', { path: 'recordStates' });
  }
  for (const [path, status] of Object.entries(file.recordStates)) {
    if (!OUTBOX_STATUSES.has(status)) {
      return importInvalid('Неизвестное состояние записи', {
        path: `recordStates.${path}`,
      });
    }
  }
  for (const id of file.snapshot.pendingEventIds) {
    if (typeof id !== 'string' || !file.data.events[id]) {
      return importInvalid('pendingEventIds ссылается на отсутствующее событие', {
        path: 'snapshot.pendingEventIds', id,
      });
    }
  }

  return ok(file);
}

function asValidated(input) {
  if (input && input.ok === true && input.value) return input.value;
  return input;
}

function localSnapshot(current = {}) {
  return {
    initialization: current.initialization || null,
    events: current.events || {},
    triggerCreations: current.triggerCreations || {},
    mutations: current.mutations || {},
    analyses: current.analyses || {},
  };
}

function localHasData(local) {
  return Boolean(local.initialization)
    || Object.keys(local.events).length > 0
    || Object.keys(local.triggerCreations).length > 0
    || Object.keys(local.mutations).length > 0
    || Object.keys(local.analyses).length > 0;
}

function importedPayload(record, originImportId) {
  const copy = normalizeRecord(record);
  delete copy.acceptedAtMs;
  copy.acceptedAtMs = SERVER_TIMESTAMP;
  copy.originImportId = originImportId;
  return copy;
}

function parsedEntityKey(entityKey) {
  if (entityKey === 'categoryPolicy') {
    return { kind: 'categoryPolicy', id: null, sourcePath: null, sourceEntryId: null };
  }
  if (typeof entityKey !== 'string') return null;
  if (entityKey.startsWith('event_')) {
    const id = entityKey.slice('event_'.length);
    return {
      kind: 'event', id, sourcePath: `events/${id}`, sourceEntryId: `event:${id}`,
    };
  }
  if (entityKey.startsWith('trigger_')) {
    const id = entityKey.slice('trigger_'.length);
    return {
      kind: 'trigger', id, sourcePath: `triggerCreations/${id}`, sourceEntryId: `trigger:${id}`,
    };
  }
  return null;
}

function consentOf(reason, entityKey, slots) {
  return {
    kind: 'mutation',
    entityKey,
    reason,
    slots: [...slots],
    proposed: slots.map((slot) => slot.payload),
  };
}

/** План только добавляет. Конфликты и правки существующих сущностей не пишутся. */
export function planImport(validated, currentSnapshot = {}, options = {}) {
  const file = asValidated(validated);
  if (!isObject(file) || file.format !== 'youplanner-diary') {
    return importInvalid('Ожидается проверенный экспорт youplanner-diary', { path: 'format' });
  }
  const journalId = options.journalId || file.journalId;
  if (journalId !== file.journalId) {
    return fail('JOURNAL_MISMATCH', 'journalId файла и дневника различаются', {
      expected: journalId, actual: file.journalId,
    }, false);
  }
  const local = localSnapshot(currentSnapshot);
  if (local.initialization) {
    if (!equivalentDomainRecord('initialization', local.initialization, file.data.initialization)) {
      return fail('JOURNAL_MISMATCH', 'initialization локального дневника отличается', {
        path: 'initialization',
      }, false);
    }
  } else if (localHasData(local)) {
    return fail('JOURNAL_MISMATCH', 'Локальная история есть без initialization', {
      path: 'initialization',
    }, false);
  }

  let sessionId = options.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !isFirebaseKey(sessionId))) {
    return fail('INVALID_DATA', 'Некорректный sessionId', { path: 'sessionId' });
  }
  if (!sessionId) {
    try {
      sessionId = newId('import', options.crypto);
    } catch (error) {
      return fail('INVALID_DATA', sanitizeMessage(error && error.message), { path: 'sessionId' });
    }
  }
  const originImportId = options.originImportId || sessionId;
  if (typeof originImportId !== 'string' || !isFirebaseKey(originImportId)) {
    return fail('INVALID_DATA', 'Некорректный originImportId', { path: 'originImportId' });
  }

  const entries = [];
  const entryById = new Map();
  const skipped = [];
  const conflicts = [];
  const blocked = [];
  const consent = [];
  const conflictEvents = new Set();
  const conflictTriggers = new Set();
  const availableEvents = new Set(Object.keys(local.events));
  const availableTriggers = new Set(Object.keys(local.triggerCreations));
  let ordinal = 0;

  function addEntry({
    kind, id, path, payload, record, dependencies = [], sourcePath = null,
    sourceEntryId = null, entityKey = null, slot = null,
  }) {
    const entryId = kind === 'mutation' ? `mutation:${entityKey}:${slot}` : `${kind}:${id}`;
    if (entryById.has(entryId)) return entryById.get(entryId);
    const entry = {
      entryId,
      ordinal: ordinal++,
      kind,
      id,
      path,
      payload,
      record,
      dependencies: [...dependencies],
      outboxOperationId: '',
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourceEntryId ? { sourceEntryId } : {}),
      ...(entityKey ? { entityKey } : {}),
      ...(slot ? { slot } : {}),
    };
    entries.push(entry);
    entryById.set(entryId, entry);
    return entry;
  }

  function skip(kind, id, path, reason = 'equivalent-domain-record') {
    skipped.push({ kind, id, path, reason });
  }

  function conflict(kind, id, path, reason = 'payload-differs') {
    conflicts.push({ kind, id, path, reason });
  }

  // initialization
  if (local.initialization) {
    skip('initialization', journalId, 'initialization');
  } else {
    addEntry({
      kind: 'initialization',
      id: journalId,
      path: 'initialization',
      payload: importedPayload(file.data.initialization, originImportId),
      record: { kind: 'initialization', id: journalId },
    });
  }

  // triggers
  for (const id of Object.keys(file.data.triggerCreations).sort()) {
    const imported = file.data.triggerCreations[id];
    const existing = local.triggerCreations[id];
    if (existing) {
      if (equivalentDomainRecord('trigger', existing, imported)) {
        skip('trigger', id, `triggerCreations/${id}`);
      } else {
        conflictTriggers.add(id);
        conflict('trigger', id, `triggerCreations/${id}`);
      }
      continue;
    }
    addEntry({
      kind: 'trigger',
      id,
      path: `triggerCreations/${id}`,
      payload: importedPayload(imported, originImportId),
      record: { kind: 'trigger', id },
    });
    availableTriggers.add(id);
  }

  // events
  for (const id of Object.keys(file.data.events).sort()) {
    const imported = file.data.events[id];
    const existing = local.events[id];
    if (existing) {
      if (equivalentDomainRecord('event', existing, imported)) {
        skip('event', id, `events/${id}`);
      } else {
        conflictEvents.add(id);
        conflict('event', id, `events/${id}`);
      }
      continue;
    }
    if (imported.triggerId && !availableTriggers.has(imported.triggerId)) {
      blocked.push({
        kind: 'event',
        id,
        path: `events/${id}`,
        reason: 'DEPENDENCY_MISSING',
        missing: [`triggerCreations/${imported.triggerId}`],
      });
      continue;
    }
    const dependencies = imported.triggerId && !local.triggerCreations[imported.triggerId]
      ? [`trigger:${imported.triggerId}`]
      : [];
    addEntry({
      kind: 'event',
      id,
      path: `events/${id}`,
      payload: importedPayload(imported, originImportId),
      record: { kind: 'event', id },
      dependencies,
    });
    availableEvents.add(id);
  }

  // mutations
  const consentByEntity = new Map();
  for (const entityKey of Object.keys(file.data.mutations).sort()) {
    const chain = file.data.mutations[entityKey];
    const walked = walkMutationChain(file.data.mutations, entityKey);
    const operations = walked.value.operations;
    if (operations.length === 0) continue;

    if (entityKey === 'categoryPolicy') {
      const existingChain = local.mutations[entityKey] || {};
      const slots = [];
      for (const operation of operations) {
        const slot = operation.predecessorOperationId;
        const existing = existingChain[slot];
        if (existing && equivalentDomainRecord('mutation', existing, operation)) {
          skip('mutation', operation.operationId, `mutations/${entityKey}/${slot}`);
        } else if (existing) {
          conflict('mutation', operation.operationId, `mutations/${entityKey}/${slot}`);
        } else {
          slots.push({
            slot,
            payload: importedPayload(operation, originImportId),
          });
        }
      }
      if (slots.length > 0) consent.push(consentOf('policy-requires-consent', entityKey, slots));
      continue;
    }

    const parsed = parsedEntityKey(entityKey);
    if (!parsed) {
      conflict('mutation', entityKey, `mutations/${entityKey}`, 'UNKNOWN_ENTITY_KEY');
      continue;
    }
    const localEntity = parsed.kind === 'event'
      ? local.events[parsed.id]
      : local.triggerCreations[parsed.id];
    const importedEntity = parsed.kind === 'event'
      ? file.data.events[parsed.id]
      : file.data.triggerCreations[parsed.id];
    if (!importedEntity) {
      blocked.push({
        kind: 'mutation',
        id: entityKey,
        path: `mutations/${entityKey}`,
        reason: 'ENTITY_MISSING',
        missing: [parsed.sourcePath],
      });
      continue;
    }

    if (localEntity) {
      const existingChain = local.mutations[entityKey] || {};
      const slots = [];
      for (const operation of operations) {
        const slot = operation.predecessorOperationId;
        const existing = existingChain[slot];
        if (existing && equivalentDomainRecord('mutation', existing, operation)) {
          skip('mutation', operation.operationId, `mutations/${entityKey}/${slot}`);
        } else if (existing) {
          conflict('mutation', operation.operationId, `mutations/${entityKey}/${slot}`);
        } else {
          slots.push({
            slot,
            payload: importedPayload(operation, originImportId),
          });
        }
      }
      if (slots.length > 0) {
        consent.push(consentOf('existing-entity', entityKey, slots));
      }
      continue;
    }

    if ((parsed.kind === 'event' && conflictEvents.has(parsed.id))
      || (parsed.kind === 'trigger' && conflictTriggers.has(parsed.id))) {
      blocked.push({
        kind: 'mutation',
        id: entityKey,
        path: `mutations/${entityKey}`,
        reason: 'SOURCE_CONFLICT',
        missing: [parsed.sourcePath],
      });
      continue;
    }
    const existingChain = local.mutations[entityKey] || {};
    if (Object.keys(existingChain).length > 0) {
      conflict('mutation', entityKey, `mutations/${entityKey}`, 'ORPHAN_CHAIN');
      continue;
    }
    if (!entryById.has(parsed.sourceEntryId)) {
      blocked.push({
        kind: 'mutation',
        id: entityKey,
        path: `mutations/${entityKey}`,
        reason: 'SOURCE_NOT_PLANNED',
        missing: [parsed.sourcePath],
      });
      continue;
    }

    let dependency = parsed.sourceEntryId;
    for (const operation of operations) {
      const slot = operation.predecessorOperationId;
      const entry = addEntry({
        kind: 'mutation',
        id: operation.operationId,
        path: `mutations/${entityKey}/${slot}`,
        payload: importedPayload(operation, originImportId),
        record: { kind: 'mutation', id: operation.operationId, entityKey, slot },
        dependencies: dependency ? [dependency] : [],
        entityKey,
        slot,
        sourcePath: parsed.sourcePath,
        sourceEntryId: parsed.sourceEntryId,
      });
      dependency = entry.entryId;
    }
  }

  // analyses
  for (const id of Object.keys(file.data.analyses).sort()) {
    const imported = file.data.analyses[id];
    const existing = local.analyses[id];
    if (existing) {
      if (equivalentDomainRecord('analysis', existing, imported)) {
        skip('analysis', id, `analyses/${id}`);
      } else {
        conflict('analysis', id, `analyses/${id}`);
      }
      continue;
    }
    const missing = (imported.coveredEventIds || [])
      .filter((eventId) => !availableEvents.has(eventId));
    if (missing.length > 0) {
      blocked.push({
        kind: 'analysis',
        id,
        path: `analyses/${id}`,
        reason: 'DEPENDENCY_MISSING',
        missing: missing.map((eventId) => `events/${eventId}`),
      });
      continue;
    }
    const dependencies = (imported.coveredEventIds || [])
      .filter((eventId) => !local.events[eventId])
      .map((eventId) => `event:${eventId}`);
    addEntry({
      kind: 'analysis',
      id,
      path: `analyses/${id}`,
      payload: importedPayload(imported, originImportId),
      record: { kind: 'analysis', id },
      dependencies,
    });
  }

  for (const entry of entries) {
    entry.outboxOperationId = `${sessionId}--${entry.ordinal}`;
  }

  const requiresSeparateConsent = consent;
  return ok({
    format: 'youplanner-diary-import-plan',
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    originImportId,
    journalId,
    exportedAtMs: file.exportedAtMs,
    fingerprint: file.snapshot.fingerprint,
    entries,
    skipped,
    conflicts,
    blockedDependencies: blocked,
    requiresSeparateConsent,
    added: entries.length,
    skippedDuplicates: skipped.length,
    pending: entries.length,
    acknowledged: 0,
    localComplete: entries.length === 0,
    serverAcknowledged: entries.length === 0 && conflicts.length === 0
      && blocked.length === 0 && requiresSeparateConsent.length === 0,
  });
}

function snapshotPathMap(snapshot, journalId) {
  const map = new Map();
  if (snapshot.initialization) {
    map.set('initialization', {
      kind: 'initialization', id: journalId, payload: snapshot.initialization,
    });
  }
  for (const [id, payload] of Object.entries(snapshot.events || {})) {
    map.set(`events/${id}`, { kind: 'event', id, payload });
  }
  for (const [id, payload] of Object.entries(snapshot.triggerCreations || {})) {
    map.set(`triggerCreations/${id}`, { kind: 'trigger', id, payload });
  }
  for (const [entityKey, chain] of Object.entries(snapshot.mutations || {})) {
    for (const [slot, payload] of Object.entries(chain || {})) {
      map.set(`mutations/${entityKey}/${slot}`, {
        kind: 'mutation',
        id: payload && payload.operationId ? payload.operationId : `${entityKey}:${slot}`,
        entityKey,
        slot,
        payload,
      });
    }
  }
  for (const [id, payload] of Object.entries(snapshot.analyses || {})) {
    map.set(`analyses/${id}`, { kind: 'analysis', id, payload });
  }
  return map;
}

function pushUnique(list, item) {
  const key = JSON.stringify(item);
  if (!list.some((existing) => JSON.stringify(existing) === key)) list.push(item);
}

function reportFrom(plan, statuses, state) {
  const entries = plan.entries || [];
  const statusOf = (entry) => statuses[entry.entryId] || 'planned';
  const pending = entries.filter((entry) => RETRYABLE.has(statusOf(entry))).length;
  const blockedCount = entries.filter((entry) => statusOf(entry) === 'blocked').length;
  const acknowledged = entries.filter((entry) => statusOf(entry) === 'acknowledged').length;
  const skippedDuplicates = state.skipped.length;
  const localComplete = entries.every((entry) => statusOf(entry) !== 'planned'
    && statusOf(entry) !== 'sending');
  const serverAcknowledged = pending === 0
    && blockedCount === 0
    && state.conflicts.length === 0
    && state.blockedDependencies.length === 0
    && state.requiresSeparateConsent.length === 0;
  return {
    sessionId: plan.sessionId,
    originImportId: plan.originImportId,
    journalId: plan.journalId,
    added: state.addedIds.size,
    skippedDuplicates,
    conflicts: state.conflicts,
    blockedDependencies: state.blockedDependencies,
    requiresSeparateConsent: state.requiresSeparateConsent,
    pending,
    acknowledged,
    blocked: blockedCount,
    localComplete,
    serverAcknowledged,
    complete: localComplete && serverAcknowledged,
    entries: entries.map((entry) => ({
      entryId: entry.entryId,
      kind: entry.kind,
      id: entry.id,
      path: entry.path,
      status: statusOf(entry),
    })),
  };
}

/** Исполнение плана: локальная запись + outbox, затем серверный create. */
export async function executeImport(planOrOptions, dependencies = {}) {
  const wrapped = Boolean(planOrOptions && planOrOptions.plan);
  const plan = wrapped ? planOrOptions.plan : planOrOptions;
  const options = wrapped ? planOrOptions : dependencies;
  if (!isObject(plan) || !Array.isArray(plan.entries) || typeof plan.sessionId !== 'string') {
    return fail('INVALID_DATA', 'Нужен план импорта', { path: 'plan' });
  }
  const {
    store, repository, clock = { now: () => Date.now() }, onEntry, send = true,
  } = options;
  if (!store || !repository) {
    return fail('INVALID_DATA', 'executeImport: нужны store и repository', { path: 'dependencies' });
  }
  const uid = options.uid;
  const journalId = options.journalId || plan.journalId;
  if (!uid) return fail('AUTH_REQUIRED', 'Импорт требует uid владельца', { path: 'uid' });
  if (journalId !== plan.journalId) {
    return fail('JOURNAL_MISMATCH', 'План принадлежит другому journalId', {
      expected: journalId, actual: plan.journalId,
    }, false);
  }

  const sessionId = plan.sessionId;
  const originImportId = plan.originImportId || sessionId;
  const prior = await store.readImportProgress({ uid, journalId, sessionId });
  const progress = prior && isObject(prior) ? prior : {};
  const statuses = { ...(progress.statuses || {}) };
  const ownedPaths = new Set(progress.ownedPaths || []);
  const addedIds = new Set(progress.addedIds || []);
  const state = {
    skipped: [...(progress.skipped || [])],
    conflicts: [...(progress.conflicts || [])],
    blockedDependencies: [...(progress.blockedDependencies || [])],
    requiresSeparateConsent: plan.requiresSeparateConsent || [],
    addedIds,
  };
  const entryById = new Map((plan.entries || []).map((entry) => [entry.entryId, entry]));
  const local = await store.readSnapshot({ uid, journalId });
  const localByPath = snapshotPathMap(local, journalId);
  const outboxByPath = new Map();
  for (const entry of local.outbox || []) {
    if (entry && typeof entry.path === 'string') outboxByPath.set(entry.path, entry);
  }

  for (const item of plan.conflicts || []) pushUnique(state.conflicts, item);
  for (const item of plan.blockedDependencies || []) pushUnique(state.blockedDependencies, item);
  for (const item of plan.skipped || []) pushUnique(state.skipped, item);

  let progressError = null;

  async function persist() {
    const saved = await store.saveImportProgress({
      uid,
      journalId,
      sessionId,
      progress: {
        plan,
        statuses: { ...statuses },
        ownedPaths: [...ownedPaths],
        addedIds: [...addedIds],
        skipped: state.skipped,
        conflicts: state.conflicts,
        blockedDependencies: state.blockedDependencies,
        requiresSeparateConsent: state.requiresSeparateConsent,
        updatedAtMs: clock.now(),
      },
    });
    // Без сохранённого прогресса resume невозможен: молча продолжать нельзя,
    // иначе отчёт «complete» будет неправдой.
    if (!saved.ok && !progressError) progressError = saved;
    return saved;
  }

  function setStatus(entry, status) {
    statuses[entry.entryId] = status;
  }

  function dependenciesServerReady(entry) {
    for (const dependencyId of entry.dependencies || []) {
      const status = statuses[dependencyId];
      if (status !== 'acknowledged' && status !== 'skipped') return false;
    }
    return true;
  }

  function dependencyConflict(entry) {
    for (const dependencyId of entry.dependencies || []) {
      const status = statuses[dependencyId];
      if (status === 'blocked' || status === 'conflict') return dependencyId;
    }
    return null;
  }

  function outboxDependencies(entry) {
    const ids = [];
    for (const dependencyId of entry.dependencies || []) {
      const status = statuses[dependencyId];
      if (status === 'acknowledged' || status === 'skipped') continue;
      const dependency = entryById.get(dependencyId);
      if (dependency && dependency.outboxOperationId) ids.push(dependency.outboxOperationId);
    }
    return ids;
  }

  function outboxSpec(entry, status) {
    return {
      path: entry.path,
      operationId: entry.outboxOperationId,
      kind: entry.kind,
      payload: entry.payload,
      dependencies: outboxDependencies(entry),
      status,
    };
  }

  function recordSpec(entry) {
    return {
      kind: entry.record.kind,
      id: entry.record.id,
      payload: entry.payload,
      ...(entry.entityKey ? { entityKey: entry.entityKey } : {}),
      ...(entry.slot ? { slot: entry.slot } : {}),
    };
  }

  async function saveExistingLocal(entry, value) {
    if (localByPath.has(entry.path)) return null;
    const committed = await store.commitLocalCreate({
      uid,
      journalId,
      records: [{
        kind: entry.record.kind,
        id: entry.record.id,
        payload: value,
        ...(entry.entityKey ? { entityKey: entry.entityKey } : {}),
        ...(entry.slot ? { slot: entry.slot } : {}),
      }],
      outbox: [],
    });
    if (committed.ok) {
      localByPath.set(entry.path, { ...entry.record, payload: value });
    }
    return committed;
  }

  async function commitPending(entry, status = 'pending') {
    const existing = localByPath.get(entry.path);
    const outbox = outboxByPath.get(entry.path);
    if (existing && outbox) {
      setStatus(entry, status);
      return ok(true);
    }
    if (existing && !equivalentDomainRecord(entry.kind, existing.payload, entry.payload)) {
      pushUnique(state.conflicts, {
        kind: entry.kind, id: entry.id, path: entry.path, reason: 'LOCAL_PAYLOAD_DIFFERS',
      });
      setStatus(entry, 'conflict');
      return ok(true);
    }
    const records = existing ? [] : [recordSpec(entry)];
    const committed = await store.commitLocalCreate({
      uid,
      journalId,
      records,
      outbox: [outboxSpec(entry, status)],
    });
    if (!committed.ok) return committed;
    if (!existing) {
      localByPath.set(entry.path, { ...entry.record, payload: entry.payload });
      addedIds.add(entry.entryId);
    }
    outboxByPath.set(entry.path, { ...entry, status });
    setStatus(entry, status);
    return ok(true);
  }

  async function acknowledge(entry) {
    setStatus(entry, 'acknowledged');
    ownedPaths.add(entry.path);
    await store.saveReceipt({
      uid,
      journalId,
      path: entry.path,
      status: 'acknowledged',
      operationId: entry.outboxOperationId,
    });
  }

  async function markSkipped(entry, reason = 'equivalent-domain-record') {
    setStatus(entry, 'skipped');
    pushUnique(state.skipped, {
      kind: entry.kind, id: entry.id, path: entry.path, reason,
    });
  }

  async function markConflict(entry, reason) {
    setStatus(entry, 'conflict');
    pushUnique(state.conflicts, {
      kind: entry.kind, id: entry.id, path: entry.path, reason,
    });
  }

  async function updateOutbox(entry, status, error) {
    return store.updateOutbox({
      uid, journalId, operationId: entry.outboxOperationId, status, error,
    });
  }

  let serverUnavailable = false;
  let permissionBlocked = false;

  await persist();
  if (progressError) return progressError;

  for (let index = 0; index < plan.entries.length; index += 1) {
    if (progressError) return progressError;
    const entry = plan.entries[index];
    const current = statuses[entry.entryId];
    if (TERMINAL_SKIP.has(current)) continue;
    if (current === 'sending') statuses[entry.entryId] = 'unknown';

    const blockingDependency = dependencyConflict(entry);
    if (blockingDependency) {
      setStatus(entry, 'blocked');
      pushUnique(state.blockedDependencies, {
        kind: entry.kind,
        id: entry.id,
        path: entry.path,
        reason: 'DEPENDENCY_BLOCKED',
        missing: [blockingDependency],
      });
      await persist();
      continue;
    }

    let sourceServerOwned = true;
    if (entry.kind === 'mutation') {
      const sourcePath = entry.sourcePath;
      const sourceLocal = sourcePath ? localByPath.get(sourcePath) : null;
      const localOwned = Boolean(sourceLocal && sourceLocal.payload
        && sourceLocal.payload.originImportId === originImportId);
      sourceServerOwned = Boolean(sourcePath && ownedPaths.has(sourcePath));
      if (!sourceServerOwned && !localOwned) {
        await markConflict(entry, 'SOURCE_NOT_OWNED_BY_IMPORT');
        await persist();
        continue;
      }
    }

    if (typeof onEntry === 'function') {
      await onEntry({ entry, index });
    }

    let serverExists = false;
    let serverValue = null;
    if (send && !permissionBlocked && (entry.kind !== 'mutation' || sourceServerOwned)) {
      const read = await repository.readServerPath({
        uid, journalId, relativePath: entry.path,
      });
      if (read.ok) {
        serverExists = read.value.exists;
        serverValue = read.value.value;
      } else if (read.error.code === 'AUTH_REQUIRED') {
        permissionBlocked = true;
        const committed = await commitPending(entry, 'blocked');
        if (!committed.ok) return committed;
        await updateOutbox(entry, 'blocked', 'AUTH_REQUIRED');
        setStatus(entry, 'blocked');
        pushUnique(state.blockedDependencies, {
          kind: entry.kind,
          id: entry.id,
          path: entry.path,
          reason: 'AUTH_REQUIRED',
          missing: [],
        });
        await persist();
        continue;
      } else {
        serverUnavailable = true;
      }
    }

    if (serverExists) {
      if (entry.kind === 'initialization'
        && !equivalentDomainRecord('initialization', serverValue, entry.payload)) {
        // Два разных дневника нельзя сливать: initialization — идентичность
        // журнала, а не обычная запись, которую можно объявить конфликтом.
        return fail('JOURNAL_MISMATCH', 'На сервере другой initialization', {
          path: 'initialization', reason: 'SERVER_INITIALIZATION_DIFFERS',
        }, false);
      }
      if (equivalentDomainRecord(entry.kind, serverValue, entry.payload)) {
        const localExisting = localByPath.get(entry.path);
        if (localExisting
          && !equivalentDomainRecord(entry.kind, localExisting.payload, serverValue)) {
          await markConflict(entry, 'LOCAL_PAYLOAD_DIFFERS');
          await persist();
          continue;
        }
        const owned = isObject(serverValue) && serverValue.originImportId === originImportId;
        const saved = await saveExistingLocal(entry, serverValue);
        if (saved && !saved.ok) return saved;
        if (owned) {
          await acknowledge(entry);
        } else {
          await markSkipped(entry);
        }
        await persist();
        continue;
      }
      await markConflict(entry, 'SERVER_PAYLOAD_DIFFERS');
      await persist();
      continue;
    }

    const committed = await commitPending(entry, 'pending');
    if (!committed.ok) return committed;

    const canSend = send
      && !serverUnavailable
      && !permissionBlocked
      && dependenciesServerReady(entry)
      && (entry.kind !== 'mutation' || sourceServerOwned);

    if (!canSend) {
      setStatus(entry, 'pending');
      await persist();
      continue;
    }

    const created = await repository.createAtPath({
      uid, journalId, relativePath: entry.path, payload: entry.payload,
    });

    if (created.ok) {
      await updateOutbox(entry, 'acknowledged');
      await acknowledge(entry);
      await persist();
      continue;
    }

    if (created.error.code === 'CONFLICT_RECONFIRM') {
      const reread = await repository.readServerPath({
        uid, journalId, relativePath: entry.path,
      });
      if (reread.ok && reread.value.exists
        && equivalentDomainRecord(entry.kind, reread.value.value, entry.payload)) {
        const owned = isObject(reread.value.value)
          && reread.value.value.originImportId === originImportId;
        const saved = await saveExistingLocal(entry, reread.value.value);
        if (saved && !saved.ok) return saved;
        await updateOutbox(entry, 'acknowledged');
        if (owned) await acknowledge(entry);
        else await markSkipped(entry);
      } else {
        await updateOutbox(entry, 'blocked', 'CONFLICT_ID');
        await markConflict(entry, 'CONFLICT_ID');
      }
      await persist();
      continue;
    }

    if (created.error.code === 'UNKNOWN_COMMIT') {
      await updateOutbox(entry, 'unknown');
      setStatus(entry, 'unknown');
      await persist();
      continue;
    }

    if (created.error.code === 'ONLINE_REQUIRED') {
      await updateOutbox(entry, 'pending');
      setStatus(entry, 'pending');
      serverUnavailable = true;
      await persist();
      continue;
    }

    if (created.error.code === 'AUTH_REQUIRED') {
      permissionBlocked = true;
      await updateOutbox(entry, 'blocked', 'AUTH_REQUIRED');
      setStatus(entry, 'blocked');
      pushUnique(state.blockedDependencies, {
        kind: entry.kind,
        id: entry.id,
        path: entry.path,
        reason: 'AUTH_REQUIRED',
        missing: [],
      });
      await persist();
      continue;
    }

    await updateOutbox(entry, 'blocked', created.error.code);
    setStatus(entry, 'blocked');
    await persist();
  }

  const report = reportFrom(plan, statuses, state);
  return ok(report);
}

/** Возобновление сохранённой сессии импорта теми же ID и payload. */
export async function resumeImport(sessionIdOrOptions, dependencies = {}) {
  const options = typeof sessionIdOrOptions === 'string'
    ? { ...dependencies, sessionId: sessionIdOrOptions }
    : sessionIdOrOptions;
  if (!isObject(options)) {
    return fail('INVALID_DATA', 'resumeImport: нужны зависимости', { path: 'options' });
  }
  const {
    sessionId, store, repository, clock, uid, journalId, onEntry, send,
  } = options;
  if (!sessionId || !store || !repository || !uid) {
    return fail('INVALID_DATA', 'resumeImport: нужны sessionId/store/repository/uid', {
      path: 'dependencies',
    });
  }
  const progress = await store.readImportProgress({ uid, journalId, sessionId });
  if (!progress || !isObject(progress) || !isObject(progress.plan)) {
    return importInvalid('Сессия импорта не найдена', { path: 'sessionId', sessionId });
  }
  return executeImport({
    plan: progress.plan,
    store,
    repository,
    clock,
    uid,
    journalId,
    onEntry,
    send,
  });
}
