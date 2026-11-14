// Адаптер Bridge-Firebase (U5.8, CONTRACT-0.5 §3, §6): узкие пути, commandId
// ДО отправки, digest канонического JSON, условная запись решения (If-Match),
// серверное время и нормализованные ошибки. Сеть — подмена fetch, подписки —
// подмена EventSource: тесты на фейке, не на сети.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIREBASE_PATH = join(ROOT, 'js', 'harness', 'firebase.js');

assert.ok(existsSync(FIREBASE_PATH), 'js/harness/firebase.js не существует (ожидаются RED)');

const { createHarnessFirebase, canonicalJson } =
  await import('file://' + FIREBASE_PATH);

const CONFIG = {
  apiKey: 'test-api-key',
  databaseURL: 'https://telegram-claude-tunnel-default-rtdb.europe-west1.firebasedatabase.app',
  authDomain: 'telegram-claude-tunnel.firebaseapp.com',
  projectId: 'telegram-claude-tunnel',
};

function stubResponse({ status = 200, data = null, etag = null, date = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'etag') return etag;
        if (key === 'date') return date;
        return null;
      },
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    return handler(calls[calls.length - 1], calls);
  };
  impl.calls = calls;
  return impl;
}

const STORAGE = {
  _map: new Map(),
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
  setItem(k, v) { this._map.set(k, String(v)); },
  removeItem(k) { this._map.delete(k); },
};

function makeFirebase({ fetchImpl = recordingFetch(() => stubResponse({ data: {} })), now = 1_000_000 } = {}) {
  return createHarnessFirebase({
    config: CONFIG,
    fetchImpl,
    storage: STORAGE,
    now: () => now,
  });
}

/* --- Путь/схема команды (CONTRACT-0.5 §3.1) ----------------------------------- */

test('команда создаётся с commandId ДО отправки: makeCommand ≠ send', async () => {
  const fb = makeFirebase();
  const made = await fb.makeCommand({
    ownerUid: 'uid-owner', deviceId: 'pc-main-01', type: 'run_task',
    params: { task: 'Собери статистику' }, serverTime: 1_000_000,
  });
  assert.match(made.commandId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(made.path, 'bridge/commands/uid-owner/pc-main-01/' + made.commandId);
  assert.equal(made.payload.commandId, made.commandId);
  assert.equal(made.payload.schemaVersion, 1);
  assert.equal(made.payload.issuer, 'owner');
  assert.equal(made.payload.ownerUid, 'uid-owner');
  assert.equal(made.payload.deviceId, 'pc-main-01');
  assert.equal(made.payload.expiresAt, 1_000_000 + 15 * 60 * 1000,
    'у команды свой срок допуска к запуску (15 минут)');
  // Отправка берёт именно этот ID — повтор возможен тем же commandId
  fb.fetch = recordingFetch(() => stubResponse({ data: made.payload }));
  await fb.sendCommand(made);
  assert.match(fb.fetch.calls[0].url, new RegExp('/' + made.commandId + '\\.json'));
  assert.equal(fb.fetch.calls[0].options.method, 'PUT');
});

test('digest — SHA-256 канонического JSON {schemaVersion,type,params,deviceId}', async () => {
  const fb = makeFirebase();
  const a = await fb.makeCommand({
    ownerUid: 'o', deviceId: 'pc-main-01', type: 'run_task',
    params: { b: 2, a: 1 }, serverTime: 1000,
  });
  const b = await fb.makeCommand({
    ownerUid: 'o', deviceId: 'pc-main-01', type: 'run_task',
    params: { a: 1, b: 2 }, serverTime: 1000,
  });
  assert.equal(a.payload.digest, b.payload.digest,
    'порядок ключей params не должен менять digest');
  assert.equal(a.payload.digest.length, 64, 'hex-дайджест длиной 64');
  // digest не зависит от createdAt/expiresAt (они не входят в канонический JSON)
  const c = await fb.makeCommand({
    ownerUid: 'o', deviceId: 'pc-main-01', type: 'run_task',
    params: { a: 1, b: 2 }, serverTime: 999_000,
  });
  assert.equal(c.payload.digest, a.payload.digest);
});

test('канонический JSON стабилен и не вставляет undefined', () => {
  assert.equal(canonicalJson({ a: 1, b: { c: 'x' } }), '{"a":1,"b":{"c":"x"}}');
  assert.equal(canonicalJson({ a: undefined, b: 2 }), '{"b":2}');
});

/* --- Auth владельца (email/password в проекте Bridge) --------------------------- */

test('вход владельца в Bridge-проекте: свои ключи хранилища, uid наружу', async () => {
  const fetchImpl = recordingFetch(() => stubResponse({
    data: { idToken: 'id-token-xyz', refreshToken: 'refresh-token-xyz',
      expiresIn: '3600', localId: 'Sdlw3hRi0WYUL29Wz9Gi7X2L3I33' },
  }));
  const fb = makeFirebase({ fetchImpl });
  const account = await fb.signIn('apti@example.com', 'пароль');
  assert.equal(account.uid, 'Sdlw3hRi0WYUL29Wz9Gi7X2L3I33');
  assert.equal(account.email, 'apti@example.com');
  assert.match(fb.fetch.calls[0].url, /identitytoolkit\.googleapis\.com\/v1\/accounts:signInWithPassword/);
  assert.match(fb.fetch.calls[0].url, /key=test-api-key/);
  // Сессия Harness живёт в своих ключах, а не в youplanner.fb.*
  const harnessKeys = [...STORAGE._map.keys()].filter((k) => k.startsWith('harness.'));
  assert.ok(harnessKeys.length >= 1,
    'сессия хранится под ключом harness.*, чтобы не мешать синку YouPlanner');
  const refreshTokenKey = harnessKeys.find(
    (k) => STORAGE.getItem(k) === 'refresh-token-xyz');
  assert.ok(refreshTokenKey, 'refresh-токен сохранён под ключом harness.*');
  const ownerRecordKey = harnessKeys.find(
    (k) => STORAGE.getItem(k).includes('Sdlw3hRi0WYUL29Wz9Gi7X2L3I33'));
  assert.ok(ownerRecordKey, 'запись владельца (email/uid) сохранена под harness.*');
  assert.notEqual(refreshTokenKey, ownerRecordKey);
});

test('отказ входа — нормализованная ошибка без токенов и пароля', async () => {
  const fetchImpl = recordingFetch(() => stubResponse({
    status: 400,
    data: { error: { message: 'INVALID_PASSWORD' } },
  }));
  const fb = makeFirebase({ fetchImpl });
  await assert.rejects(
    () => fb.signIn('apti@example.com', 'секретный-пароль'),
    (err) => {
      assert.equal(err.code, 'auth');
      assert.doesNotMatch(err.message, /секретный-пароль/);
      assert.doesNotMatch(err.message, /id-token|refresh-token/i);
      return true;
    },
  );
});

test('нормализация ошибок сети/сервера/прав/конфликта', () => {
  const fb = makeFirebase();
  assert.equal(fb.normalizeError(new TypeError('Failed to fetch')).code, 'network');
  const http = (status) => {
    const err = new Error('HTTP ' + status);
    err.status = status;
    return fb.normalizeError(err);
  };
  assert.equal(http(401).code, 'auth');
  assert.equal(http(403).code, 'denied');
  assert.equal(http(412).code, 'conflict');
  assert.equal(http(500).code, 'server');
});

/* --- Запись решения (PATCH без If-Match: RTDB REST не поддерживает
     If-Match для PATCH — проверено 2026-11-14; одноразовость и срок
     гарантируют Правила атомарно) ---------------- */

test('решение — PATCH {decision, decidedAt} на approvals_v2/owner без If-Match', async () => {
  const fetchImpl = recordingFetch(() => stubResponse({ data: {}, etag: 'etag-new' }));
  const fb = makeFirebase({ fetchImpl });
  await fb.decideApproval({
    ownerUid: 'uid-owner',
    approvalId: 'apr-1',
    decision: 'approved',
    serverTime: 1_234_567,
  });
  const call = fb.fetch.calls[0];
  assert.match(call.url, /bridge\/approvals_v2\/uid-owner\/apr-1\.json/);
  assert.equal(call.options.method, 'PATCH');
  assert.equal(call.options.headers['If-Match'], undefined,
    'If-Match на PATCH RTDB отвергает (400) — одноразовость дают Правила');
  const body = JSON.parse(call.options.body);
  assert.deepEqual(Object.keys(body).sort(), ['decidedAt', 'decision'],
    'решение — ровно пара decision/decidedAt одним PATCH');
  assert.equal(body.decision, 'approved');
  assert.equal(body.decidedAt, 1_234_567, 'decidedAt — серверное время, одним запросом');
});

test('отказ правил на решении — нормализованная denied, наверху перечитывают победителя', async () => {
  const fetchImpl = recordingFetch(() => stubResponse({ status: 403, data: { error: 'Permission denied' } }));
  const fb = makeFirebase({ fetchImpl });
  await assert.rejects(
    () => fb.decideApproval({ ownerUid: 'o', approvalId: 'a', decision: 'approved', serverTime: 1 }),
    (err) => { assert.equal(err.code, 'denied'); return true; },
  );
  assert.equal(fb.fetch.calls.length, 1, 'адаптер не молча повторяет — перечитывает наверху');
});

/* --- Чтение approval с ETag -------------------------------------------------- */

test('readApproval возвращает {ok, data, etag} одной записи', async () => {
  const item = { approvalId: 'apr-1', tool: 'fs_delete', expiresAt: 5000 };
  const fetchImpl = recordingFetch(() => stubResponse({ data: item, etag: 'W/"etag-1"' }));
  const fb = makeFirebase({ fetchImpl });
  const result = await fb.readApproval({ ownerUid: 'o', approvalId: 'apr-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, item);
  assert.equal(result.etag, 'W/"etag-1"');
  assert.match(fb.fetch.calls[0].url, /bridge\/approvals_v2\/o\/apr-1\.json/);
});

/* --- Серверное время ----------------------------------------------------------- */

test('serverNow оценивается от Date-заголовка ответа, не от локальных часов', async () => {
  // Локальные часы: 1_000_000. Сервер в ответе говорит: 1_010_000.
  const serverDate = new Date(1_010_000).toUTCString();
  const fetchImpl = recordingFetch(() => stubResponse({ data: {}, date: serverDate }));
  const fb = makeFirebase({ fetchImpl, now: 1_000_000 });
  await fb.readApproval({ ownerUid: 'o', approvalId: 'apr-1' });
  assert.equal(fb.serverNow(), 1_010_000,
    'offset сервера применён к локальным часам (оценка, не декремент)');
});

/* --- Подписки ----------------------------------------------------------------- */

test('подписка — узкий путь с auth-токеном, отписка закрывает источник', async () => {
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onmessage = null;
      this.onerror = null;
      sources.push(this);
    }
    close() { this.closed = true; }
  }
  const fb = makeFirebase();
  fb.setEventSourceImpl(FakeEventSource);
  fb.setAccessTokenForTests('token-abc');
  const seen = [];
  const unsubscribe = fb.subscribe(
    { ownerUid: 'uid-owner', deviceId: 'pc-main-01' },
    (data) => seen.push(data),
  );
  assert.equal(sources.length, 1);
  assert.match(sources[0].url, /bridge\/commands\/uid-owner\/pc-main-01\.json/);
  assert.match(sources[0].url, /auth=token-abc/, 'auth передаётся параметром RTDB REST');
  // Событие с данными доходит до колбэка
  sources[0].onmessage({ data: JSON.stringify({ cmd1: { type: 'run_task' } }) });
  assert.deepEqual(seen, [{ cmd1: { type: 'run_task' } }]);
  unsubscribe();
  assert.equal(sources[0].closed, true, 'unsubscribe закрывает подписку');
});

test('токены не попадают в тексты ошибок и логи', async () => {
  const fetchImpl = recordingFetch(() => stubResponse({
    status: 401,
    data: { error: 'Unauthorized request. id-token-xyz' },
  }));
  const fb = makeFirebase({ fetchImpl });
  fb.setAccessTokenForTests('super-secret-token');
  await assert.rejects(
    () => fb.readApproval({ ownerUid: 'o', approvalId: 'a' }),
    (err) => {
      assert.doesNotMatch(err.message, /super-secret-token/,
        'токен не должен утекать в нормализованную ошибку');
      return true;
    },
  );
});
