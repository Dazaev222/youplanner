/* Адаптер RTDB (ТЗ §5, §9). Транспорт внедряется: реальный REST/SDK проекта
   или тестовый in-memory. Доменный код не видит токены и сетевые детали. */

import { fail, ok, sanitizeMessage } from './errors.js';

export function journalPath(uid, journalId) {
  return `diaryV1/${uid}/journals/${journalId}`;
}

function scopeError() {
  return fail('INVALID_DATA', 'Нужны uid и journalId', { path: 'scope' });
}

export function mapTransportError(error) {
  const code = error && error.code;
  const message = sanitizeMessage(error && error.message);
  if (code === 'PERMISSION_DENIED') {
    return fail('AUTH_REQUIRED', 'Нет доступа к дневнику', { reason: 'permission-denied' }, false);
  }
  if (code === 'UNKNOWN') {
    return fail('UNKNOWN_COMMIT', 'Исход запроса неизвестен', { reason: 'unknown' }, false);
  }
  if (code === 'CONFLICT') {
    return fail('CONFLICT_RECONFIRM', 'Слот уже занят', { reason: 'exists' }, false);
  }
  if (code === 'OFFLINE' || code === 'NETWORK' || code === 'TIMEOUT') {
    return fail('ONLINE_REQUIRED', message || 'Нет сети', { reason: 'offline' }, true);
  }
  return fail('INVALID_DATA', message || 'Ошибка транспорта', { reason: 'transport' }, false);
}

export function createFirebaseRepository({ transport } = {}) {
  if (!transport || typeof transport.get !== 'function'
    || typeof transport.create !== 'function') {
    throw new TypeError('createFirebaseRepository: нужен transport.get/create');
  }

  async function readAt(path) {
    const response = await transport.get(path);
    if (!response || response.ok !== true) return mapTransportError(response && response.error);
    return ok(response.value);
  }

  async function readJournal({ uid, journalId } = {}) {
    if (!uid || !journalId) return scopeError();
    const result = await readAt(journalPath(uid, journalId));
    if (!result.ok) return result;
    const tree = result.value;
    const present = tree !== null && tree !== undefined;
    return ok({
      present,
      initialization: present && tree.initialization ? tree.initialization : null,
      events: present && tree.events ? tree.events : {},
      triggerCreations: present && tree.triggerCreations ? tree.triggerCreations : {},
      mutations: present && tree.mutations ? tree.mutations : {},
      analyses: present && tree.analyses ? tree.analyses : {},
    });
  }

  async function readEntityChain({ uid, journalId, entityKey } = {}) {
    if (!uid || !journalId || typeof entityKey !== 'string') return scopeError();
    const result = await readAt(`${journalPath(uid, journalId)}/mutations/${entityKey}`);
    if (!result.ok) return result;
    return ok(result.value && typeof result.value === 'object' ? result.value : {});
  }

  async function readServerPath({ uid, journalId, relativePath } = {}) {
    if (!uid || !journalId || typeof relativePath !== 'string') return scopeError();
    const result = await readAt(`${journalPath(uid, journalId)}/${relativePath}`);
    if (!result.ok) return result;
    return ok({ exists: result.value !== null && result.value !== undefined, value: result.value });
  }

  async function createAtPath({ uid, journalId, relativePath, payload } = {}) {
    if (!uid || !journalId || typeof relativePath !== 'string') return scopeError();
    const response = await transport.create(
      `${journalPath(uid, journalId)}/${relativePath}`,
      payload,
    );
    if (!response || response.ok !== true) return mapTransportError(response && response.error);
    return ok(response.value === undefined ? payload : response.value);
  }

  async function readReceipt({ uid, journalId, relativePath } = {}) {
    return readServerPath({ uid, journalId, relativePath });
  }

  function subscribeCreates({ uid, journalId, onChange } = {}) {
    if (typeof transport.subscribe !== 'function') return () => {};
    return transport.subscribe(`${journalPath(uid, journalId)}`, onChange);
  }

  return {
    readJournal,
    readEntityChain,
    readServerPath,
    createAtPath,
    readReceipt,
    subscribeCreates,
  };
}
