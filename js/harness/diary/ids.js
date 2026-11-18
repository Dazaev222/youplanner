/* ID и ключи RTDB (ТЗ §3, §4, §9): только криптографическая случайность,
   запрещённые символы ключей, зарезервированный initial. */

function keyError(message, code = 'INVALID_DATA') {
  const err = new Error(message);
  err.code = code;
  return err;
}

export const RESERVED_OPERATION_ID = 'initial';
export const MAX_FIREBASE_KEY_LENGTH = 768;

const FORBIDDEN_KEY_RE = /[.#$\[\]/\s\u0000-\u001f\u007f]/;
const ID_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_PREFIX_RE = /^[a-z][a-z0-9]*$/;

function cryptoSource(source) {
  const impl = source || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
  if (!impl || (typeof impl.randomUUID !== 'function'
    && typeof impl.getRandomValues !== 'function')) {
    return null;
  }
  return impl;
}

// UUID v4 из getRandomValues — криптографический запасной путь без Math.random.
function uuidFromBytes(impl) {
  const bytes = new Uint8Array(16);
  impl.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Новый ID домена: `event-<uuid>`, `trigger-<uuid>`, `operation-<uuid>`. */
export function newId(prefix, cryptoImpl) {
  if (typeof prefix !== 'string' || !ID_PREFIX_RE.test(prefix)) {
    const err = new Error('Некорректный префикс ID');
    err.code = 'INVALID_DATA';
    throw err;
  }
  const impl = cryptoSource(cryptoImpl);
  if (!impl) {
    const err = new Error('crypto.randomUUID/getRandomValues недоступен');
    err.code = 'INVALID_DATA';
    throw err;
  }
  const uuid = typeof impl.randomUUID === 'function'
    ? impl.randomUUID()
    : uuidFromBytes(impl);
  if (typeof uuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(uuid)) {
    const err = new Error('Источник crypto вернул некорректный UUID');
    err.code = 'INVALID_DATA';
    throw err;
  }
  return `${prefix}-${uuid.toLowerCase()}`;
}

export function isFirebaseKey(key) {
  if (typeof key !== 'string') return false;
  if (!key || key.length > MAX_FIREBASE_KEY_LENGTH) return false;
  if (FORBIDDEN_KEY_RE.test(key)) return false;
  if (ID_PROTO_KEYS.has(key)) return false;
  return key.trim() === key;
}

/**
 * Проверка ключа RTDB.
 * options.operationId — запрещает зарезервированный initial.
 * options.slot — наоборот, разрешает initial (слот первой правки).
 */
export function assertFirebaseKey(key, options = {}) {
  if (options.operationId && key === RESERVED_OPERATION_ID) {
    throw keyError('Ключ initial зарезервирован для первой правки');
  }
  if (!isFirebaseKey(key)) {
    throw keyError('Недопустимый ключ RTDB');
  }
  return key;
}
