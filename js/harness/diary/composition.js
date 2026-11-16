/* Композиция браузерного дневника (ТЗ §7, §9): Auth → RTDB REST → IndexedDB
   → сервис. Токены получает Auth-адаптер и не отдаёт доменному коду; ключ ИИ
   читается только локальным keyStore и уходит лишь в заголовок провайдера. */

import { fail, ok, sanitizeMessage } from './errors.js';
import { newId } from './ids.js';
import { createFirebaseRepository } from './firebase-repository.js';
import { createDiaryService } from './index.js';
import { createDiaryStore, DB_NAME } from './indexeddb-store.js';
import { FIREBASE_URL } from '../../sync/core.js';

export const DIARY_JOURNAL_KEY_PREFIX = 'youplanner.diary.journalId';
export const DIARY_DEVICE_KEY = 'youplanner.diary.deviceId';
export const ASSISTANT_API_KEY = 'youplanner.api_key';

const DEFAULT_ENDPOINT = 'https://api.neuraldeep.ru/v1/chat/completions';
const DEFAULT_MODEL = 'qwen3.6-35b-a3b';
const RTDB_TIMEOUT_MS = 20000;
const PROVIDER_TIMEOUT_MS = 60000;

function isHeaderSafeKey(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 255) return false;
  }
  return true;
}

function transportFailure(code, message) {
  return { ok: false, error: { code, message } };
}

function trimBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Минимальный RTDB REST-транспорт стабильного проекта. Firebase ID token
 * передаётся легаси-параметром ?auth= (Bearer RTDB отвергает), как в sync.js.
 * Create — PUT; при отказе занятость слота отличается чтением того же пути.
 */
export function createFirebaseRestTransport({
  fetchImpl = globalThis.fetch,
  databaseUrl = FIREBASE_URL,
  getToken,
  timeoutMs = RTDB_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createFirebaseRestTransport: нужен fetch');
  }

  async function requestUrl(path) {
    const base = `${trimBase(databaseUrl)}/${String(path).replace(/^\/+/, '')}.json`;
    let token = null;
    if (typeof getToken === 'function') {
      try {
        token = await getToken();
      } catch (error) {
        token = null;
      }
    }
    if (typeof token !== 'string' || !token) return base;
    return `${base}${base.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
  }

  async function call(method, path, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = controller
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
      : null;
    try {
      const url = await requestUrl(path);
      const response = await fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      return { response, timedOut };
    } catch (error) {
      if (timedOut || (error && (error.name === 'TimeoutError' || error.name === 'AbortError'))) {
        return transportFailure('TIMEOUT', 'Сервер не ответил вовремя');
      }
      return transportFailure('OFFLINE', 'Нет связи с сервером');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function readBody(response) {
    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  const transport = {
    async get(path) {
      const result = await call('GET', path);
      if (result.ok === false) return result;
      const { response } = result;
      if (response.status === 401 || response.status === 403) {
        return transportFailure('PERMISSION_DENIED', 'Нет доступа к дневнику');
      }
      if (response.status >= 500 || response.status === 429) {
        return transportFailure('UNKNOWN', 'Сервер временно недоступен');
      }
      if (!response.ok) {
        return transportFailure('UNKNOWN', `Сервер ответил ${response.status}`);
      }
      return { ok: true, value: await readBody(response) };
    },

    async create(path, value) {
      const result = await call('PUT', path, value);
      if (result.ok === false) return result;
      const { response } = result;
      if (response.status === 401 || response.status === 403) {
        // Rules разрешают только create отсутствующего листа. Отказ на занятом
        // слоте и на чужой uid выглядят одинаково — различаем контрольным GET.
        const current = await transport.get(path);
        if (current.ok && current.value !== null && current.value !== undefined) {
          return transportFailure('CONFLICT', 'Слот уже занят');
        }
        return transportFailure('PERMISSION_DENIED', 'Нет доступа к дневнику');
      }
      if (response.status >= 500 || response.status === 429) {
        return transportFailure('UNKNOWN', 'Сервер временно недоступен');
      }
      if (!response.ok) {
        return transportFailure('UNKNOWN', `Сервер ответил ${response.status}`);
      }
      const body = await readBody(response);
      return { ok: true, value: body === null ? value : body };
    },
  };
  return transport;
}

/** Локальный ключ ИИ: только этот origin, не входит в экспорт/Firebase. */
export function createLocalKeyStore({
  storage = globalThis.localStorage,
  key = ASSISTANT_API_KEY,
} = {}) {
  return {
    async getKey() {
      if (!storage || typeof storage.getItem !== 'function') return null;
      try {
        const value = storage.getItem(key);
        if (typeof value !== 'string' || value.trim().length === 0) return null;
        return value;
      } catch (error) {
        return null;
      }
    },
    async setKey(value) {
      if (!storage || typeof storage.setItem !== 'function') return false;
      try {
        storage.setItem(key, String(value));
        return storage.getItem(key) === String(value);
      } catch (error) {
        return false;
      }
    },
    async clear() {
      if (!storage || typeof storage.removeItem !== 'function') return false;
      try {
        storage.removeItem(key);
        return true;
      } catch (error) {
        return false;
      }
    },
  };
}

/**
 * OpenAI-совместимый адаптер существующего провайдера. Ключ идёт только в
 * Authorization; тело запроса и тексты ошибок его не содержат.
 */
export function createAnalysisProvider({
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  timeoutMs = PROVIDER_TIMEOUT_MS,
} = {}) {
  return {
    model,
    async complete({ messages, apiKey, model: requestedModel, signal } = {}) {
      if (typeof fetchImpl !== 'function') {
        return fail('PROVIDER_BROWSER_UNAVAILABLE', 'Нет браузерного fetch', {}, false);
      }
      if (typeof apiKey !== 'string' || apiKey.trim().length === 0
        || !isHeaderSafeKey(apiKey)) {
        return fail('PROVIDER_KEY_MISSING', 'Ключ ИИ не настроен', { path: 'key' }, false);
      }
      if (signal && signal.aborted) {
        return fail('PROVIDER_CANCELLED', 'Запрос анализа отменён', {}, false);
      }

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      const timer = controller
        ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
        : null;
      const abortExternal = () => controller && controller.abort();
      if (controller && signal) signal.addEventListener('abort', abortExternal, { once: true });

      try {
        const body = {
          model: requestedModel || model,
          messages,
        };
        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            ...(controller ? { signal: controller.signal } : {}),
          });
        } catch (error) {
          if (signal && signal.aborted) {
            return fail('PROVIDER_CANCELLED', 'Запрос анализа отменён', {}, false);
          }
          if (timedOut || (error && error.name === 'TimeoutError')) {
            return fail('PROVIDER_TIMEOUT', 'Провайдер не ответил вовремя', {}, true);
          }
          if (error && error.name === 'TypeError') {
            return fail('PROVIDER_BROWSER_UNAVAILABLE',
              'Браузер не смог обратиться к провайдеру (сеть или CORS)', {}, false);
          }
          return fail('PROVIDER_UNAVAILABLE', 'Провайдер ИИ недоступен', {}, true);
        }

        if (response.status === 401 || response.status === 403) {
          return fail('PROVIDER_AUTH', 'Ключ ИИ не принят провайдером', {}, false);
        }
        if (response.status === 429) {
          return fail('PROVIDER_RATE_LIMIT', 'Провайдер ограничил число запросов', {}, true);
        }
        if (!response.ok) {
          return fail('PROVIDER_UNAVAILABLE', 'Провайдер ИИ вернул ошибку', {
            status: response.status,
          }, true);
        }

        let data;
        try {
          data = await response.json();
        } catch (error) {
          return fail('PROVIDER_UNAVAILABLE', 'Провайдер вернул не JSON', {}, true);
        }
        const text = data && data.choices && data.choices[0]
          && data.choices[0].message && data.choices[0].message.content;
        if (typeof text !== 'string') {
          return fail('PROVIDER_UNAVAILABLE', 'Провайдер вернул пустой ответ', {}, true);
        }
        return ok({ text, model: requestedModel || model });
      } finally {
        if (timer) clearTimeout(timer);
        if (controller && signal) signal.removeEventListener('abort', abortExternal);
      }
    },
  };
}

async function browserAuthAdapter() {
  const module = await import('../../data/firebase-auth.js');
  return {
    async getUid() {
      const owner = module.getOwnerAccount();
      return owner && typeof owner.uid === 'string' && owner.uid ? owner.uid : null;
    },
    getToken: () => module.getAuthToken(),
  };
}

async function resolveAuthUid(auth) {
  if (!auth || typeof auth.getUid !== 'function') {
    return fail('AUTH_REQUIRED', 'Нужен Auth-адаптер владельца');
  }
  try {
    const uid = await auth.getUid();
    if (typeof uid !== 'string' || !uid) {
      return fail('AUTH_REQUIRED', 'Нет авторизованного uid');
    }
    return ok(uid);
  } catch (error) {
    return fail('AUTH_REQUIRED', sanitizeMessage(error && error.message));
  }
}

async function stableId({ storage, key, prefix, explicit, crypto }) {
  if (typeof explicit === 'string' && explicit) return ok(explicit);
  if (storage && typeof storage.getItem === 'function') {
    let existing = null;
    try {
      existing = storage.getItem(key);
    } catch (error) {
      existing = null;
    }
    if (typeof existing === 'string' && existing) return ok(existing);
  }
  const generated = newId(prefix, crypto);
  if (!storage || typeof storage.setItem !== 'function') return ok(generated);
  try {
    storage.setItem(key, generated);
    const readBack = storage.getItem(key);
    if (readBack !== generated) {
      return fail('STORAGE_FULL', 'Не удалось сохранить идентификатор дневника', {
        path: key,
      });
    }
  } catch (error) {
    return fail('STORAGE_FULL', 'Не удалось сохранить идентификатор дневника', {
      path: key,
    });
  }
  return ok(generated);
}

/**
 * Собирает браузерный сервис дневника. Все внешние зависимости можно
 * подменить в тестах; без подмены Auth берётся из js/data/firebase-auth.js.
 */
export async function createDiaryComposition({
  indexedDB = globalThis.indexedDB,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  auth,
  clock = { now: () => Date.now() },
  journalId,
  deviceId,
  dbName = DB_NAME,
  databaseUrl = FIREBASE_URL,
  transport,
  provider,
  keyStore,
  model,
  apiEndpoint,
  crypto,
} = {}) {
  try {
    const resolvedAuth = auth || await browserAuthAdapter();
    const uidResult = await resolveAuthUid(resolvedAuth);
    if (!uidResult.ok) return uidResult;
    const uid = uidResult.value;

    const journal = await stableId({
      storage,
      key: `${DIARY_JOURNAL_KEY_PREFIX}.${uid}`,
      prefix: 'journal',
      explicit: journalId,
      crypto,
    });
    if (!journal.ok) return journal;

    const device = await stableId({
      storage,
      key: DIARY_DEVICE_KEY,
      prefix: 'device',
      explicit: deviceId,
      crypto,
    });
    if (!device.ok) return device;

    if (!indexedDB) {
      return fail('INVALID_DATA', 'IndexedDB недоступен в этом окружении');
    }

    const store = createDiaryStore({ indexedDB, name: dbName, clock });
    const opened = await store.open();
    if (!opened.ok) return opened;

    const restTransport = transport || createFirebaseRestTransport({
      fetchImpl,
      databaseUrl,
      getToken: typeof resolvedAuth.getToken === 'function'
        ? () => resolvedAuth.getToken()
        : undefined,
    });
    const repository = createFirebaseRepository({ transport: restTransport });
    const resolvedKeyStore = keyStore || createLocalKeyStore({ storage });
    const analysisProvider = provider || createAnalysisProvider({
      fetchImpl,
      endpoint: apiEndpoint,
      model,
    });

    const service = createDiaryService({
      auth: resolvedAuth,
      repository,
      store,
      clock,
      journalId: journal.value,
      deviceId: device.value,
      crypto,
      analysisProvider,
      keyStore: resolvedKeyStore,
    });

    return ok({
      service,
      store,
      repository,
      auth: resolvedAuth,
      keyStore: resolvedKeyStore,
      provider: analysisProvider,
      clock,
      journalId: journal.value,
      deviceId: device.value,
      uid,
    });
  } catch (error) {
    return fail('INVALID_DATA', sanitizeMessage(error && error.message));
  }
}
