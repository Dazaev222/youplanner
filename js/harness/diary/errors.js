/* Единый контракт Result домена «Дневник» (ТЗ §9).
   Успех: {ok:true, value}; ошибка: {ok:false, error:{code, message, details, retryable}}.
   Ошибки не содержат секретов, токенов и полных личных текстов. */

export const ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  ONLINE_REQUIRED: 'ONLINE_REQUIRED',
  STORAGE_FULL: 'STORAGE_FULL',
  INVALID_DATA: 'INVALID_DATA',
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  CONFLICT_RECONFIRM: 'CONFLICT_RECONFIRM',
  UNKNOWN_COMMIT: 'UNKNOWN_COMMIT',
  TIME_ANOMALY: 'TIME_ANOMALY',
  STALE_ANALYSIS: 'STALE_ANALYSIS',
  PROVIDER_BROWSER_UNAVAILABLE: 'PROVIDER_BROWSER_UNAVAILABLE',
  PROVIDER_KEY_MISSING: 'PROVIDER_KEY_MISSING',
  PROVIDER_AUTH: 'PROVIDER_AUTH',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_CANCELLED: 'PROVIDER_CANCELLED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  ANALYSIS_TOO_LARGE: 'ANALYSIS_TOO_LARGE',
  IMPORT_INVALID: 'IMPORT_INVALID',
  JOURNAL_MISMATCH: 'JOURNAL_MISMATCH',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
});

const RETRYABLE = new Set(['ONLINE_REQUIRED', 'UNKNOWN_COMMIT', 'AUTH_REQUIRED',
  'PROVIDER_RATE_LIMIT', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']);

export function ok(value) {
  return { ok: true, value };
}

export function fail(code, message, details = {}, retryable) {
  const codeValue = ERROR_CODES[code] || 'INVALID_DATA';
  return {
    ok: false,
    error: {
      code: codeValue,
      message: String(message || codeValue),
      details: details && typeof details === 'object' ? details : {},
      retryable: retryable === undefined ? RETRYABLE.has(codeValue) : Boolean(retryable),
    },
  };
}

// Ошибка валидации с путём поля: единый формат для schema.js.
export function invalid(path, message, details = {}) {
  return fail('INVALID_DATA', message || 'Некорректные данные', { path, ...details });
}

export function isOk(result) {
  return Boolean(result && result.ok === true);
}

export function unwrap(result) {
  if (!result || result.ok !== true) {
    const error = result && result.error;
    const err = new Error(error && error.message ? error.message : 'Diary error');
    err.code = error ? error.code : 'INVALID_DATA';
    err.details = error ? error.details : {};
    throw err;
  }
  return result.value;
}

// Не даёт тексту ошибки транспорта попасть в отчёт вместе с личными данными.
export function sanitizeMessage(value, limit = 300) {
  if (typeof value !== 'string') return 'Ошибка без описания';
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Ошибка без описания';
  return clean.slice(0, limit);
}
