// Тесты анонимной аутентификации Firebase (REST identitytoolkit).
//
// Контракт js/data/firebase-auth.js: getAuthToken() даёт строку idToken или
// null (null = «работаем как раньше, без токена»); любая неудача — null,
// без исключений; после неудачи пауза 5 минут, в ней сеть не дёргается;
// refresh-токен живёт в localStorage и переживает перезагрузку приложения.
//
// Ключ в репозитории пустой, поэтому тесты подставляют его через
// context.setFirebaseApiKey(): getAuthToken/setFirebaseApiKey — верхне-
// уровневые function-объявления, песочница vm выставляет их свойствами
// контекста (как ctx.syncToCloud в sync.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const KEY = 'AIzaSyTestKeyForUnit';
const AUTH_REFRESH_KEY = 'youplanner.fb.refresh';

function okJson(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

// Мок auth-серверов: signUp отвечает в формате identitytoolkit
// (idToken/refreshToken/expiresIn), обмен refresh-токена — в формате
// securetoken (id_token/refresh_token/expires_in).
function makeAuthFetch() {
  const calls = [];
  function fetchImpl(url, opts = {}) {
    const u = String(url);
    calls.push({
      url: u,
      method: (opts && opts.method) || 'GET',
      body: opts && typeof opts.body === 'string' ? opts.body : null,
    });
    if (u.indexOf('identitytoolkit.googleapis.com') !== -1) {
      return Promise.resolve(okJson({ idToken: 'tok1', refreshToken: 'r1', expiresIn: '3600' }));
    }
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      return Promise.resolve(okJson({ id_token: 'tok2', refresh_token: 'r2', expires_in: '3600' }));
    }
    return Promise.resolve(okJson({}));
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function callsTo(calls, host) {
  return calls.filter((c) => c.url.indexOf(host) !== -1);
}

test('ключ задан: signUp даёт токен, повторный вызов берёт его из кэша', async () => {
  const fetchImpl = makeAuthFetch();
  const { context } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  assert.equal(await context.getAuthToken(), 'tok1');
  assert.equal(await context.getAuthToken(), 'tok1', 'второй вызов потерял кэш');
  assert.equal(callsTo(fetchImpl.calls, 'googleapis').length, 1,
    'повторный вызов дёрнул сеть: кэш токена не работает');

  const signUp = callsTo(fetchImpl.calls, 'identitytoolkit')[0];
  assert.ok(signUp.url.indexOf('accounts:signUp') !== -1, ' signUp не по тому эндпоинту: ' + signUp.url);
  assert.ok(signUp.url.indexOf('key=' + KEY) !== -1, 'ключ проекта не в URL');
  assert.deepEqual(JSON.parse(signUp.body), { returnSecureToken: true },
    'тело signUp не запрашивает анонимный аккаунт');
});

test('refresh-токен переживает новую загрузку приложения: обмен вместо signUp', async () => {
  const fetch1 = makeAuthFetch();
  const first = loadApp({ fetchImpl: fetch1 });
  first.context.setFirebaseApiKey(KEY);
  assert.equal(await first.context.getAuthToken(), 'tok1');
  assert.equal(first.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r1',
    'refresh-токен signUp не сохранён');

  // «Перезагрузка»: новый loadApp с чистой памятью модуля, но тем же
  // устройством — хранилище переносим из первого приложения.
  const fetch2 = makeAuthFetch();
  const second = loadApp({ fetchImpl: fetch2 });
  const dump = first.sandbox.localStorage._dump();
  Object.keys(dump).forEach((k) => second.sandbox.localStorage.setItem(k, dump[k]));
  second.context.setFirebaseApiKey(KEY);

  assert.equal(await second.context.getAuthToken(), 'tok2',
    'refresh-обмен не дал новый idToken');
  assert.equal(callsTo(fetch2.calls, 'identitytoolkit').length, 0,
    'signUp повторился: refresh-токен из localStorage не прочитан');
  assert.equal(callsTo(fetch2.calls, 'securetoken').length, 1);
  const refresh = callsTo(fetch2.calls, 'securetoken')[0];
  assert.deepEqual(JSON.parse(refresh.body),
    { grant_type: 'refresh_token', refresh_token: 'r1' },
    'тело обмена refresh-токена не по протоколу');
  assert.equal(second.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r2',
    'свежий refresh-токен не сохранён');
});

test('сброс памяти модуля (resetAuthForTests) оставляет refresh-токен жить', async () => {
  const fetchImpl = makeAuthFetch();
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  assert.equal(await context.getAuthToken(), 'tok1');
  await context.resetAuthForTests();
  assert.equal(await context.getAuthToken(), 'tok2',
    'после сброса памяти должен пойти refresh-обмен');
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r2',
    'resetAuthForTests стёр localStorage');
});

test('отказ сети: null и пауза — повтор сразу не дёргает сеть', async () => {
  let networkCalls = 0;
  const fetchImpl = () => {
    networkCalls += 1;
    return Promise.reject(new Error('нет сети'));
  };
  const { context } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  assert.equal(await context.getAuthToken(), null);
  assert.equal(await context.getAuthToken(), null, 'повтор сразу после неудачи');
  assert.equal(await context.getAuthToken(), null, 'третий вызов в паузу');
  assert.equal(networkCalls, 1,
    'пауза не удержала сеть: сетевых вызовов ' + networkCalls);
});

test('пустой ключ: null без единого сетевого вызова', async () => {
  const fetchImpl = makeAuthFetch();
  const { context } = loadApp({ fetchImpl });
  // ключ пустой по умолчанию — как в репозитории, владелец ещё не вписал

  assert.equal(await context.getAuthToken(), null);
  assert.equal(fetchImpl.calls.length, 0,
    'пустой ключ не должен выходить в сеть');
});

// Восстановление при протухшем refresh-токене: securetoken отвечает
// 400 (INVALID_REFRESH_TOKEN), и обменять мёртвый токен нельзя. Хранить
// ключ дальше значило бы умирать вечно: он стирается, и запрос
// повторяется один раз свежим signUp'ом — заводится новый анонимный
// аккаунт, данные это не затрагивает.
function denied(status) {
  return {
    ok: false,
    status: status,
    json: () => Promise.resolve({ error: { message: 'INVALID_REFRESH_TOKEN' } }),
  };
}

test('протухший refresh-токен: 400 на обмен — ключ удалён, повтор идёт signUp\'ом', async () => {
  // Устройство с сохранённым refresh-токеном: signUp даёт r1
  const fetch1 = makeAuthFetch();
  const first = loadApp({ fetchImpl: fetch1 });
  first.context.setFirebaseApiKey(KEY);
  assert.equal(await first.context.getAuthToken(), 'tok1');
  assert.equal(first.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r1');

  // Перезагрузка: refresh-токен с устройства протух — обмен отвечает 400
  const fetch2 = makeAuthFetch();
  const securetokenCalls = [];
  const signUpCalls = [];
  fetch2.calls = [];
  fetch2.impl = function (url, opts = {}) {
    const u = String(url);
    fetch2.calls.push({ url: u, body: opts && opts.body });
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      securetokenCalls.push(u);
      return Promise.resolve(denied(400));
    }
    if (u.indexOf('identitytoolkit.googleapis.com') !== -1) {
      signUpCalls.push(u);
      return Promise.resolve(okJson({ idToken: 'tok3', refreshToken: 'r3', expiresIn: '3600' }));
    }
    return Promise.resolve(okJson({}));
  };

  const second = loadApp({ fetchImpl: fetch2.impl });
  const dump = first.sandbox.localStorage._dump();
  Object.keys(dump).forEach((k) => second.sandbox.localStorage.setItem(k, dump[k]));
  second.context.setFirebaseApiKey(KEY);

  assert.equal(await second.context.getAuthToken(), 'tok3',
    'после 400 на обмен должен прийти signUp-токен, а не null навсегда');
  assert.equal(securetokenCalls.length, 1, 'обмен должен случиться ровно один раз');
  assert.equal(signUpCalls.length, 1, 'повтор должен быть ровно один signUp');
  assert.equal(second.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r3',
    'мёртвый ключ не удалён из localStorage');
});

test('протухший refresh-токен и signUp отказал: null, пауза держит сеть', async () => {
  let networkCalls = 0;
  const fetchImpl = () => {
    networkCalls += 1;
    return Promise.resolve(denied(400));
  };
  const { sandbox, context } = loadApp({ fetchImpl });
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, 'r-dead');
  context.setFirebaseApiKey(KEY);

  assert.equal(await context.getAuthToken(), null);
  // Обмен + один signUp-повтор — и ни одного запроса сверх: зацикливания нет
  assert.equal(networkCalls, 2,
    'повторов больше одного: endless-loop, вызовов ' + networkCalls);
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null,
    'мёртвый refresh-токен должен быть удалён и при отказе signUp');

  // Пауза 5 минут: повтор сразу не выходит в сеть
  assert.equal(await context.getAuthToken(), null);
  assert.equal(networkCalls, 2, 'пауза не удержала сеть после двойной неудачи');
});

test('битый ответ 200 без idToken: null, повтор сразу — тоже null', async () => {
  let networkCalls = 0;
  const fetchImpl = () => {
    networkCalls += 1;
    return Promise.resolve(okJson({ kind: 'identitytoolkit#SignupResponse' }));
  };
  const { context } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  assert.equal(await context.getAuthToken(), null, 'ответ без idToken принят за токен');
  assert.equal(await context.getAuthToken(), null);
  assert.equal(networkCalls, 1, 'битый ответ дёргает сеть повторно');
});
