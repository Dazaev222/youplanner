/* Firebase-адаптер Harness (ТЗ U5.8; CONTRACT-0.5 §1–§7).

   Ходит в RTDB проекта Bridge (telegram-claude-tunnel) по публичному
   веб-конфигу (BR/служебное/get_web_config.py) и в Auth того же проекта
   по email/паролю владельца. Существующий sync-клиент YouPlanner не
   трогает: свои ключи хранилища (harness.refresh.*), свои подписки,
   свои токены. Модуль не читает DOM и не импортирует UI.

   ПРИМЕЧАНИЕ О ТРАНСПОРТЕ: в YP Firebase SDK запрещён (ни одной сторонней
   библиотеки, CSP script-src 'self', без CDN) — поэтому протокол говорим
   напрямую через REST. Это ровно то, что разрешает контракт §6:
   «SDK transaction ЛИБО REST-пара GET ?x-firebase-etag=true → PUT/PATCH c
   If-Match». Решение владельца — PATCH {decision, decidedAt} с If-Match.

   Пути (CONTRACT-0.5 §3):
     bridge/commands/{ownerUid}/{deviceId}/{commandId}   — create-only владелец
     bridge/executions/{ownerUid}/{deviceId}/{commandId} — читаем
     bridge/approvals_v2/{ownerUid}/{approvalId}         — read + decision
     bridge/results/{ownerUid}/{deviceId}/{commandId}/{attemptId} — читаем
     bridge/device_presence/{ownerUid}/{deviceId}        — heartbeat
   Подписки — EventSource (RTDB REST SSE, ?auth=<idToken>).

   Токены не логируются: все сообщения ошибок проходят redact() по списку
   секретов, увиденных этой фабрикой. */

import { timeoutGuard } from '../core/dom.js';

export const HARNESS_DEVICE_HEARTBEAT_MS = 15000;
export const HARNESS_DEVICE_STALE_MS = 45000;

// Таймаут одного REST-запроса Harness: обмен/чтение не должен висеть вечно,
// потерянный ответ разрешается сверкой того же ID наверху (P2.3).
const HARNESS_REQUEST_TIMEOUT_MS = 20000;
const HARNESS_AUTH_TIMEOUT_MS = 30000;

const COMMAND_TTL_MS = 15 * 60 * 1000;   // срок допуска команды к запуску
const TOKEN_MARGIN_MS = 300 * 1000;

// Ключи хранилища сессии Harness. Оба содержат «refresh» намеренно: это
// одно пространство сессии Bridge, отдельно от youplanner.fb.* синка.
const REFRESH_TOKEN_KEY = 'harness.refresh.token';
const OWNER_RECORD_KEY = 'harness.refresh.owner';

/* --- Канонический JSON (стабильный порядок ключей, без undefined) -------------- */

export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return '{' + keys.map((key) =>
      JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function sha256Hex(text) {
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle)
    ? crypto.subtle
    : null;
  if (!subtle) throw new Error('crypto.subtle недоступен (нужен HTTPS/localhost)');
  const digest = await subtle.digest('SHA-256',
    new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomCommandId(nowMs) {
  const timePart = Number(nowMs || Date.now()).toString(36);
  const randomPart = Math.random().toString(36).slice(2, 12);
  return 'c' + timePart + randomPart;
}

export function createHarnessFirebase({ config, fetchImpl, storage, now }) {
  if (!config || !config.databaseURL || !config.apiKey) {
    throw new Error('Веб-конфиг Bridge-Firebase не задан (apiKey/databaseURL)');
  }
  const baseUrl = String(config.databaseURL).replace(/\/+$/, '');
  const clock = now || (() => Date.now());
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);

  const state = {
    eventSourceImpl: (typeof EventSource === 'function') ? EventSource : null,
    token: null,          // { value, expiresAt }
    owner: null,          // { email, uid }
    secrets: [],          // строки, запрещённые к попаданию в сообщения
    serverOffsetMs: 0,    // оценка: серверное время − локальные часы
  };

  // Активный fetch живёт на api.fetch: сетевые вызовы читают его при каждом
  // вызове, поэтому тесты подменяют транспорт присваиванием fb.fetch = ….
  const api = {
    config,
    fetch: fetchImpl || (typeof fetch === 'function' ? fetch : null),
  };

  function callFetch(url, options) {
    const impl = api.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!impl) return Promise.reject(normalizeError(new TypeError('нет сети')));
    return impl(url, options);
  }

  /* --- Секреты и ошибки ------------------------------------------------------------ */

  function registerSecret(value) {
    if (value && typeof value === 'string' && value.length > 8) {
      state.secrets.push(value);
    }
  }

  function redact(text) {
    let out = String(text === null || text === undefined ? '' : text);
    for (const secret of state.secrets) {
      out = out.split(secret).join('[redacted]');
    }
    // auth= в URL и JWT-подобные строки в текстах никогда не показываем
    out = out.replace(/([?&]auth=)[^&\s"']+/g, '$1[redacted]');
    out = out.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[redacted]');
    return out;
  }

  // Нормализация: у каждой ошибки понятный код без деталей транспорта.
  function normalizeError(err) {
    const error = (err instanceof Error) ? err : new Error(String(err));
    const status = error.status || (err && err.status) || 0;
    let code = 'unknown';
    if (error.name === 'AbortError') {
      // Таймаут или аборт: сеть недоказана, но запрос результата не имеет.
      code = 'network';
      error.message = 'запрос прерван по таймауту';
    } else if (error.name === 'TypeError' || /Failed to fetch|NetworkError|нет сети/i.test(error.message || '')) {
      code = 'network';
    } else if (status === 412) {
      code = 'conflict';
    } else if (status === 401 || status === 400) {
      code = 'auth';
    } else if (status === 403) {
      code = 'denied';
    } else if (status >= 500) {
      code = 'server';
    }
    const mapped = {
      network: 'Нет связи с Firebase. Проверьте интернет и попробуйте ещё раз.',
      auth: 'Сессия недействительна — войдите снова.',
      denied: 'Правила базы отклонили операцию для этого аккаунта.',
      conflict: 'Запись изменена параллельно (версия не совпала).',
      server: 'Firebase временно недоступен (ошибка сервера).',
      unknown: 'Неизвестная ошибка обращения к Firebase.',
    }[code];
    error.code = error.code || code;
    error.message = mapped + (error.message
      ? ' Детали: ' + redact(error.message).slice(0, 300)
      : '');
    return error;
  }

  api.normalizeError = normalizeError;

  /* --- Транспорт ---------------------------------------------------------------------- */

  function authQuery(token) {
    return token ? '?auth=' + encodeURIComponent(token) : '';
  }

  function currentToken() {
    if (state.token && clock() < state.token.expiresAt) return state.token.value;
    return null;
  }

  async function request(path, options) {
    const token = currentToken();
    const url = baseUrl + '/' + path + '.json' + authQuery(token);
    const opts = Object.assign({}, options || {});
    const guard = (typeof timeoutGuard === 'function')
      ? timeoutGuard(HARNESS_REQUEST_TIMEOUT_MS) : null;
    if (guard && guard.signal && !opts.signal) opts.signal = guard.signal;
    try {
      const response = await callFetch(url, opts);
      if (!response.ok) {
        const err = new Error('HTTP ' + response.status);
        err.status = response.status;
        let detail = '';
        try {
          const body = await response.json();
          detail = (body && body.error && (body.error.message || body.error)) ||
            (typeof body === 'string' ? body : '');
        } catch (e) { /* тело не обязано быть JSON */ }
        if (detail) err.message = String(detail);
        throw normalizeError(err);
      }
      return response;
    } catch (err) {
      throw (err && err.code) ? err : normalizeError(err);
    } finally {
      if (guard) guard.cancel();
    }
  }

  /* --- Серверное время: оценка по Date-заголовку ответа -------------------------------- */

  function noteServerDate(response) {
    const raw = response && response.headers && response.headers.get('date');
    if (!raw) return;
    const serverMs = Date.parse(raw);
    if (!Number.isFinite(serverMs)) return;
    state.serverOffsetMs = serverMs - clock();
  }

  api.serverNow = function serverNow() {
    return clock() + state.serverOffsetMs;
  };

  /* --- Команды (CONTRACT-0.5 §3.1) ------------------------------------------------------ */

  // Команда строится ДО отправки: commandId устойчив, сохраняется вызывающим
  // для повторной отправки того же ID (P2.3 — потеря ответа разрешается
  // чтением прежнего commandId, не новым ID).
  api.makeCommand = async function makeCommand({ ownerUid, deviceId, type, params, serverTime }) {
    const commandId = randomCommandId(clock());
    const canonical = canonicalJson({ schemaVersion: 1, type, params, deviceId });
    const digest = await sha256Hex(canonical);
    const createdAt = Number(serverTime) || api.serverNow();
    return {
      commandId,
      path: 'bridge/commands/' + ownerUid + '/' + deviceId + '/' + commandId,
      payload: {
        schemaVersion: 1,
        commandId,
        ownerUid: String(ownerUid),
        deviceId: String(deviceId),
        issuer: 'owner',
        type: String(type),
        params: params || {},
        createdAt,
        expiresAt: createdAt + COMMAND_TTL_MS,
        digest,
      },
    };
  };

  api.sendCommand = async function sendCommand(made) {
    if (!made || !made.path || !made.payload) {
      throw normalizeError(new Error('команда не построена через makeCommand'));
    }
    await request(made.path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(made.payload),
    });
    return { ok: true, commandId: made.commandId };
  };

  /* --- Approvals_v2: чтение и решение владельца ------------------------------------------ */

  api.readApproval = async function readApproval({ ownerUid, approvalId }) {
    const response = await request(
      'bridge/approvals_v2/' + ownerUid + '/' + approvalId, { method: 'GET' });
    noteServerDate(response);
    const data = await response.json();
    return {
      ok: true,
      data,
      etag: response.headers ? response.headers.get('etag') : null,
    };
  };

  // Решение — одним PATCH-парой с If-Match (уникальный способ менять
  // decision по контракту §6; Rules проверяют pending и expiresAt).
  api.decideApproval = async function decideApproval({ ownerUid, approvalId, decision, etag, serverTime }) {
    if (decision !== 'approved' && decision !== 'rejected') {
      throw normalizeError(new Error('недопустимое решение: ' + decision));
    }
    const decidedAt = Number(serverTime) || api.serverNow();
    await request('bridge/approvals_v2/' + ownerUid + '/' + approvalId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': String(etag || '*'),
      },
      body: JSON.stringify({ decision, decidedAt }),
    });
    return { ok: true };
  };

  api.readExecution = async function readExecution({ ownerUid, deviceId, commandId }) {
    const response = await request(
      'bridge/executions/' + ownerUid + '/' + deviceId + '/' + commandId,
      { method: 'GET' });
    noteServerDate(response);
    const data = await response.json();
    return { ok: Boolean(data), data, etag: response.headers.get('etag') };
  };

  // Чтение команды по ТОМУ ЖЕ commandId: сверка потерянного ответа (P2.3).
  // Отказ сети здесь не бросок — наверху решают, что делать с неизвестным
  // исходом; отсутствие записи (null) отличимо от ошибки сети.
  api.readCommand = async function readCommand(path) {
    try {
      const response = await request(path, { method: 'GET' });
      noteServerDate(response);
      const data = await response.json();
      return { ok: Boolean(data), data };
    } catch (err) {
      return { ok: false, error: err };
    }
  };

  /* --- Auth владельца (проект Bridge, email/пароль) ---------------------------------------- */

  function authPost(endpoint, body) {
    const url = endpoint + '?key=' + encodeURIComponent(config.apiKey);
    const guard = (typeof timeoutGuard === 'function')
      ? timeoutGuard(HARNESS_AUTH_TIMEOUT_MS) : null;
    return callFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: guard ? guard.signal : undefined,
    }).finally(function () {
      if (guard) guard.cancel();
    });
  }

  api.signIn = async function signIn(email, password) {
    const login = String(email || '').trim();
    const secret = String(password || '');
    if (!login) throw new Error('Нужен email аккаунта владельца');
    if (!secret) throw new Error('Нужен пароль');
    let response = null;
    try {
      response = await authPost(
        'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
        { email: login, password: secret, returnSecureToken: true });
    } catch (err) {
      throw normalizeError(err);
    }
    let data = null;
    try {
      data = await response.json();
    } catch (e) { data = null; }
    if (!response.ok) {
      const reason = (data && data.error && data.error.message) ||
        ('HTTP ' + response.status);
      const err = new Error(String(reason));
      err.status = response.status;
      throw normalizeError(err);
    }
    const idToken = data && data.idToken;
    const refreshToken = data && data.refreshToken;
    const uid = data && data.localId;
    const expiresIn = Number((data && data.expiresIn) || 0);
    if (!idToken || !refreshToken || !uid || expiresIn <= 0) {
      throw normalizeError(new Error('ответ без токенов или uid'));
    }
    registerSecret(idToken);
    registerSecret(refreshToken);
    registerSecret(secret);
    state.token = { value: idToken, expiresAt: clock() + (expiresIn * 1000 - TOKEN_MARGIN_MS) };
    state.owner = { email: login, uid: String(uid) };
    if (store) {
      try {
        store.setItem(REFRESH_TOKEN_KEY, refreshToken);
        store.setItem(OWNER_RECORD_KEY, JSON.stringify(state.owner));
      } catch (e) {
        // недоступное хранилище: сессия живёт в памяти до перезагрузки
      }
    }
    return { uid: String(uid), email: login };
  };

  api.getAccount = function getAccount() {
    if (state.owner) return state.owner;
    if (store) {
      try {
        const raw = store.getItem(OWNER_RECORD_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.uid) {
            state.owner = { email: String(parsed.email || ''), uid: String(parsed.uid) };
            return state.owner;
          }
        }
      } catch (e) { /* битая запись = нет записи */ }
    }
    return null;
  };

  api.getAccessToken = async function getAccessToken() {
    if (currentToken()) return currentToken();
    if (!store) return null;
    let refreshToken = null;
    try {
      refreshToken = store.getItem(REFRESH_TOKEN_KEY);
    } catch (e) { refreshToken = null; }
    if (!refreshToken) return null;
    registerSecret(refreshToken);
    try {
      const response = await authPost('https://securetoken.googleapis.com/v1/token',
        { grant_type: 'refresh_token', refresh_token: refreshToken });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          // refresh-токен мёртв: сессия закончена, хранить её нельзя
          api.signOut();
        }
        return null;
      }
      const data = await response.json();
      const idToken = data && (data.id_token || data.idToken);
      const freshRefresh = data && (data.refresh_token || data.refreshToken);
      const expiresIn = Number(data && (data.expires_in || data.expiresIn) || 0);
      if (!idToken || expiresIn <= 0) return null;
      registerSecret(idToken);
      state.token = {
        value: idToken,
        expiresAt: clock() + (expiresIn * 1000 - TOKEN_MARGIN_MS),
      };
      if (freshRefresh && store && freshRefresh !== refreshToken) {
        try {
          store.setItem(REFRESH_TOKEN_KEY, freshRefresh);
          registerSecret(freshRefresh);
        } catch (e) { /* хранилище недоступно */ }
      }
      return idToken;
    } catch (err) {
      return null;   // сеть недоступна: не доказана смерть токена — сессию храним
    }
  };

  api.signOut = function signOut() {
    state.token = null;
    state.owner = null;
    if (store) {
      try {
        store.removeItem(REFRESH_TOKEN_KEY);
        store.removeItem(OWNER_RECORD_KEY);
      } catch (e) { /* глотаем */ }
    }
  };

  /* --- Подписки (RTDB REST SSE через EventSource) ------------------------------------------- */

  api.setEventSourceImpl = function setEventSourceImpl(Impl) {
    state.eventSourceImpl = Impl;
  };

  api.setAccessTokenForTests = function setAccessTokenForTests(token) {
    registerSecret(token);
    state.token = { value: token, expiresAt: clock() + 3600 * 1000 };
  };

  // spec: { kind: 'commands'|'executions'|'results'|'approvals'|'presence',
  //         ownerUid, deviceId?, commandId? }
  function specToPath(spec) {
    const owner = encodeURIComponent(String(spec.ownerUid));
    const device = spec.deviceId ? encodeURIComponent(String(spec.deviceId)) : null;
    switch (spec.kind || (device ? 'commands' : 'approvals')) {
      case 'commands':
        return 'bridge/commands/' + owner + '/' + device;
      case 'executions':
        return 'bridge/executions/' + owner + '/' + device;
      case 'results':
        return 'bridge/results/' + owner + '/' + device;
      case 'approvals':
        return 'bridge/approvals_v2/' + owner;
      case 'presence':
        return 'bridge/device_presence/' + owner + '/' + device;
      default:
        throw new Error('неизвестный вид подписки: ' + spec.kind);
    }
  }

  api.subscribe = function subscribe(spec, onData, onError) {
    if (!state.eventSourceImpl) {
      // EventSource нет: подписка невозможна — честный отказ, не тихий null.
      throw new Error('EventSource недоступен в этом браузере');
    }
    const path = specToPath(spec);
    const token = currentToken();
    const source = new state.eventSourceImpl(
      baseUrl + '/' + path + '.json' + authQuery(token));
    source.onmessage = function (event) {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (e) {
        return;   // битый кадр пропускаем, подписка живёт
      }
      if (typeof onData === 'function') onData(payload);
    };
    if (typeof onError === 'function') {
      source.onerror = function (event) { onError(event); };
    }
    let closed = false;
    return function unsubscribe() {
      if (closed) return;
      closed = true;
      source.close();
    };
  };

  return api;
}
