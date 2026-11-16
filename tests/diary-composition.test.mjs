// Композиция Auth/RTDB/IndexedDB (ТЗ §7, §9): REST-транспорт с Firebase ID
// token, локальный ключ провайдера, OpenAI-совместимый адаптер и стабильные
// journalId/deviceId. Сеть и реальный провайдер здесь не вызываются.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import {
  createAnalysisProvider,
  createDiaryComposition,
  createFirebaseRestTransport,
  createLocalKeyStore,
} from '../js/harness/diary/composition.js';
import { createMemoryServer } from './helpers/diary-memory-server.mjs';

const UID = 'uid-owner';
const TOKEN = 'firebase-id-token-secret';
const T0 = Date.parse('2026-02-01T09:00:00Z');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test('REST-транспорт: GET/PUT через RTDB, токен только в ?auth=, без секрета в ошибках', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === 'PUT') return response(200, JSON.parse(options.body));
    return response(200, { ok: 1 });
  };
  const transport = createFirebaseRestTransport({
    fetchImpl,
    databaseUrl: 'https://example.firebaseio.com/root',
    getToken: async () => TOKEN,
  });

  const read = await transport.get('diaryV1/uid/journals/j');
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, { ok: 1 });
  assert.match(requests[0].url, /\.json/);
  assert.match(requests[0].url, /auth=firebase-id-token-secret/);
  assert.equal(requests[0].options.headers?.Authorization, undefined,
    'Firebase ID token ходит параметром, не Bearer');

  const created = await transport.create('diaryV1/uid/journals/j/events/e1', { eventId: 'e1' });
  assert.equal(created.ok, true);
  assert.equal(requests[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[1].options.body), { eventId: 'e1' });

  const denied = createFirebaseRestTransport({
    fetchImpl: async () => response(401, 'Permission denied'),
    getToken: async () => TOKEN,
  });
  const failure = await denied.get('diaryV1/uid/journals/j');
  assert.equal(failure.ok, false);
  const serialized = JSON.stringify(failure);
  assert.equal(serialized.includes(TOKEN), false, 'токен не попадает в ошибку');
});

test('REST-транспорт: занятый create-only слот — CONFLICT, пустой — PERMISSION_DENIED', async () => {
  let puts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'PUT') {
      puts += 1;
      return response(401, 'Permission denied');
    }
    if (url.includes('/events/e1')) return response(200, { eventId: 'e1', operationId: 'op-other' });
    return response(200, null);
  };
  const occupied = createFirebaseRestTransport({
    fetchImpl,
    databaseUrl: 'https://example.firebaseio.com/root',
    getToken: async () => TOKEN,
  });
  const conflict = await occupied.create('diaryV1/uid/journals/j/events/e1', { eventId: 'e1' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'CONFLICT');

  const empty = createFirebaseRestTransport({
    fetchImpl: async (url, options = {}) => (options.method === 'PUT'
      ? response(401, 'Permission denied')
      : response(200, null)),
    databaseUrl: 'https://example.firebaseio.com/root',
    getToken: async () => TOKEN,
  });
  const denied = await empty.create('diaryV1/uid/journals/j/events/e2', { eventId: 'e2' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.equal(puts > 0, true);
});

test('REST-транспорт: сеть/таймаут различаются, без скрытого offline replay', async () => {
  const network = createFirebaseRestTransport({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    databaseUrl: 'https://example.firebaseio.com/root',
    getToken: async () => TOKEN,
  });
  const offline = await network.get('diaryV1/uid/journals/j');
  assert.equal(offline.ok, false);
  assert.equal(offline.error.code, 'OFFLINE');

  const timeout = createFirebaseRestTransport({
    fetchImpl: async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    },
    databaseUrl: 'https://example.firebaseio.com/root',
    getToken: async () => TOKEN,
  });
  const timed = await timeout.get('diaryV1/uid/journals/j');
  assert.equal(timed.ok, false);
  assert.equal(timed.error.code, 'TIMEOUT');
});

test('локальный keyStore: читает существующий ключ, не создаёт его и не смешивает с данными', async () => {
  const storage = memoryStorage();
  const store = createLocalKeyStore({ storage });
  assert.equal(await store.getKey(), null);
  storage.setItem('youplanner.api_key', 'sk-existing');
  assert.equal(await store.getKey(), 'sk-existing');
  storage.setItem('youplanner.api_key', '   ');
  assert.equal(await store.getKey(), null);
});

test('провайдер: OpenAI-совместимый запрос, ключ только в заголовке, коды ошибок', async () => {
  const requests = [];
  const provider = createAnalysisProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, {
        choices: [{ message: { content: '{"categories":[]}' } }],
      });
    },
    endpoint: 'https://api.example/v1/chat/completions',
    model: 'test-model',
    timeoutMs: 50,
  });
  const answer = await provider.complete({
    messages: [{ role: 'user', content: 'привет' }],
    apiKey: 'sk-provider-secret',
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.value.text, '{"categories":[]}');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk-provider-secret');
  assert.equal(JSON.stringify(requests[0].options.body).includes('sk-provider-secret'), false);
  assert.equal(JSON.parse(requests[0].options.body).model, 'test-model');

  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMIT'],
    [500, 'PROVIDER_UNAVAILABLE']]) {
    const failed = createAnalysisProvider({
      fetchImpl: async () => response(status, 'error'),
      endpoint: 'https://api.example/v1/chat/completions',
      model: 'test-model',
    });
    const result = await failed.complete({ messages: [], apiKey: 'sk-provider-secret' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes('sk-provider-secret'), false);
  }

  const cors = createAnalysisProvider({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    endpoint: 'https://api.example/v1/chat/completions',
    model: 'test-model',
  });
  const corsResult = await cors.complete({ messages: [], apiKey: 'sk-provider-secret' });
  assert.equal(corsResult.ok, false);
  assert.equal(corsResult.error.code, 'PROVIDER_BROWSER_UNAVAILABLE');
});

test('композиция: связывает Auth, IndexedDB, RTDB и сервис, journalId стабилен', async () => {
  const server = createMemoryServer();
  const storage = memoryStorage();
  const indexedDB = new IDBFactory();
  const auth = { getUid: async () => UID, getToken: async () => TOKEN };

  const first = await createDiaryComposition({
    indexedDB,
    storage,
    auth,
    transport: server.transport,
    clock: { now: () => T0 },
    dbName: 'composition-device',
    provider: {
      model: 'test-model',
      async complete() { return { ok: true, value: { text: '{}' } }; },
    },
    keyStore: { getKey: async () => 'sk-test' },
    crypto: globalThis.crypto,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const composition = first.value;
  for (const method of ['initializeDiary', 'requestAnalysis', 'prepareCategoryPolicy',
    'applyAnalysis', 'subscribe']) {
    assert.equal(typeof composition.service[method], 'function', `service.${method}`);
  }
  assert.equal(composition.journalId, first.value.journalId);
  assert.equal(composition.deviceId.length > 0, true);

  const init = await composition.service.initializeDiary({
    duration: '10:00', timeZone: 'Europe/Moscow',
  });
  assert.equal(init.ok, true, JSON.stringify(init));
  const created = await composition.service.createTrigger({ name: 'Стресс' });
  assert.equal(created.ok, true);

  const second = await createDiaryComposition({
    indexedDB,
    storage,
    auth,
    transport: server.transport,
    clock: { now: () => T0 },
    dbName: 'composition-device',
    crypto: globalThis.crypto,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.journalId, composition.journalId,
    'journalId переживает повторную композицию, иначе история станет невидимой');
  assert.equal(second.value.deviceId, composition.deviceId);
});

test('композиция: нет uid — AUTH_REQUIRED, store не открывается молча', async () => {
  const result = await createDiaryComposition({
    indexedDB: new IDBFactory(),
    storage: memoryStorage(),
    auth: { getUid: async () => null, getToken: async () => null },
    transport: createMemoryServer().transport,
    clock: { now: () => T0 },
    dbName: 'composition-no-uid',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH_REQUIRED');
});

test('композиция: нет IndexedDB — честная ошибка, без подмены памятью', async () => {
  const result = await createDiaryComposition({
    indexedDB: null,
    storage: memoryStorage(),
    auth: { getUid: async () => UID, getToken: async () => TOKEN },
    transport: createMemoryServer().transport,
    clock: { now: () => T0 },
    dbName: 'composition-no-idb',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_DATA');
});
