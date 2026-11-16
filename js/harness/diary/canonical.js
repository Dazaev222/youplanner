/* Канонический JSON и fingerprint версии снимка (ТЗ §6, §8, §9).
   Fingerprint — не авторизация и не CAS: он обнаруживает расхождение payload. */

import { normalizeRecord } from './schema.js';

const SEMANTIC_EXCLUDED = new Set([
  'acceptedAtMs',
  'originImportId',
  'outboxStatus',
  'syncStatus',
  'lastError',
  'attempts',
  'lease',
  'receipt',
]);

export function canonicalize(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Предметное содержимое записи без серверных/сетевых метаданных. */
export function semanticRecord(kind, record) {
  const normalized = normalizeRecord(record || {});
  const out = {};
  for (const key of Object.keys(normalized)) {
    if (SEMANTIC_EXCLUDED.has(key)) continue;
    out[key] = normalized[key];
  }
  return out;
}

export function equivalentDomainRecord(kind, left, right) {
  return canonicalize(semanticRecord(kind, left)) === canonicalize(semanticRecord(kind, right));
}

export async function sha256(text) {
  const subtle = typeof globalThis !== 'undefined' && globalThis.crypto
    ? globalThis.crypto.subtle
    : null;
  if (!subtle) throw new Error('crypto.subtle недоступен (нужен HTTPS или localhost)');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

// Порядок цепочки: initial → operationId предыдущего узла. Хвосты битой цепи
// сортируются по ключу слота — fingerprint остаётся детерминированным.
function orderChain(slots) {
  const ordered = [];
  const seenSlots = new Set();
  const seenOperations = new Set();
  let slot = 'initial';
  while (slots[slot]) {
    const node = slots[slot];
    if (seenSlots.has(slot) || seenOperations.has(node.operationId)) break;
    ordered.push(node);
    seenSlots.add(slot);
    seenOperations.add(node.operationId);
    slot = node.operationId;
  }
  const leftovers = Object.keys(slots)
    .filter((key) => !seenSlots.has(key))
    .sort()
    .map((key) => slots[key]);
  return ordered.concat(leftovers);
}

function mutationList(mutations) {
  if (!mutations || typeof mutations !== 'object') return [];
  const out = [];
  for (const entityKey of Object.keys(mutations).sort()) {
    const chain = mutations[entityKey];
    if (!chain || typeof chain !== 'object') continue;
    for (const node of orderChain(chain)) {
      out.push(semanticRecord('mutation', node));
    }
  }
  return out;
}

/** SHA-256 от семантического снимка initialization/events/triggers/mutations. */
export async function hashSnapshot(snapshot = {}) {
  const events = Object.values(snapshot.events || {})
    .filter((item) => item && typeof item === 'object')
    .map((item) => semanticRecord('event', item))
    .sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)));
  const triggers = Object.values(snapshot.triggerCreations || {})
    .filter((item) => item && typeof item === 'object')
    .map((item) => semanticRecord('trigger', item))
    .sort((a, b) => String(a.triggerId).localeCompare(String(b.triggerId)));

  const payload = {
    schemaVersion: 1,
    initialization: snapshot.initialization
      ? semanticRecord('initialization', snapshot.initialization)
      : null,
    events,
    triggerCreations: triggers,
    mutations: mutationList(snapshot.mutations),
  };
  return sha256(canonicalize(payload));
}

/** SHA-256 содержимого экспортного файла без самого поля integrity. */
export async function hashExport(exported) {
  const copy = {};
  for (const key of Object.keys(exported || {})) {
    if (key === 'integrity') continue;
    copy[key] = exported[key];
  }
  return sha256(canonicalize(copy));
}
