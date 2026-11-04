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
// constant-экспорт в песочне vm свойством контекста не становится (см.
// tests/helpers/load-app.mjs), поэтому имя ключа и UID здесь пересказаны.
const AUTH_OWNER_KEY = 'youplanner.fb.owner';
const OWNER_UID = 'OWNER-UID';

function okJson(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

// Мок auth-серверов: signUp отвечает в формате identitytoolkit
// (idToken/refreshToken/expiresIn), обмен refresh-токена — в формате
// securetoken (id_token/refresh_token/expires_in). signInWithPassword —
// тем же identitytoolkit, но с localId (UID) и email в ответе.
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
      if (u.indexOf('signInWithPassword') !== -1) {
        let email = '';
        try { email = JSON.parse(String(opts.body)).email || ''; } catch (e) { email = ''; }
        return Promise.resolve(okJson({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          idToken: 'tok-owner', refreshToken: 'r-owner', expiresIn: '3600',
          localId: OWNER_UID, email: email,
        }));
      }
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

// Временный сбой auth-сервера (5xx) — не доказательство смерти refresh-токена.
// Отказ обмена должен стирать ключ только при 4xx: 5xx значит «сервер не смог»,
// и живой ключ после него обязан дожить до следующей попытки.
test('5xx на обмене refresh-токена: живой ключ не стирается, signUp не дёргается', async () => {
  const signUpCalls = [];
  const fetchImpl = (url) => {
    const u = String(url);
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      return Promise.resolve(denied(503));
    }
    if (u.indexOf('identitytoolkit.googleapis.com') !== -1) {
      signUpCalls.push(u);
      return Promise.resolve(okJson({ idToken: 'tok-x', refreshToken: 'r-x', expiresIn: '3600' }));
    }
    return Promise.resolve(okJson({}));
  };
  const { sandbox, context } = loadApp({ fetchImpl });
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, 'r-live');
  context.setFirebaseApiKey(KEY);

  assert.equal(await context.getAuthToken(), null, '5xx должен дать null, а не токен');
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-live',
    'временный сбой сервера стёр живой refresh-токен');
  assert.equal(signUpCalls.length, 0,
    'после 5xx нельзя заводить новый аккаунт: токен не доказано, что мёртв');
});

/* ---------- Постоянный аккаунт владельца ----------------------------------
   database.rules.json привязан к auth.uid, а анонимный uid уникален на
   устройство, поэтому синхронизация работает только с одним постоянным
   аккаунтом. Вход — signInWithPassword; ответ даёт localId — тот самый UID,
   который владелец вшивает в правила. Пароль живёт только время вызова:
   в хранилище попадают refresh-токен и запись {email, uid}.
   Главное свойство, которое проверяют эти тесты: в режиме владельца
   приложение НЕ имеет права молча заводить анонимный аккаунт. Тихий
   signUp дал бы токен с чужим uid, правила ответили бы PERMISSION_DENIED,
   а человек увидел бы «синхронизации нет» без причины. */

// Приложение, уже живущее как владелец: вход сделан отдельной первой
// загрузкой, хранилище перенесено во вторую — это перезагрузка на том же
// устройстве. У второй загрузки свои вызовы (app.fetch.calls): по ним тест
// видит, в какую сеть сходил режим владельца.
async function loadOwnerApp(respond) {
  const seedFetch = makeAuthFetch();
  const first = loadApp({ fetchImpl: seedFetch });
  first.context.setFirebaseApiKey(KEY);
  await first.context.ownerSignIn('owner@example.com', 'secret-pw');

  const fetchImpl = function (url, opts) {
    fetchImpl.calls.push({ url: String(url), body: opts && opts.body });
    return respond(url, opts);
  };
  fetchImpl.calls = [];
  const app = loadApp({ fetchImpl });
  const dump = first.sandbox.localStorage._dump();
  Object.keys(dump).forEach((k) => app.sandbox.localStorage.setItem(k, dump[k]));
  app.context.setFirebaseApiKey(KEY);
  app.fetch = fetchImpl;
  return app;
}

test('вход владельца: signInWithPassword, UID из localId, анонимный signUp не дёрнут', async () => {
  const fetchImpl = makeAuthFetch();
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  const account = await context.ownerSignIn('owner@example.com', 'secret-pw');
  // Поля, а не deepEqual: объект создан в vm-контексте, и его прототип —
  // Object из другого realm (то же касается instanceof Error ниже).
  assert.equal(account.email, 'owner@example.com');
  assert.equal(account.uid, OWNER_UID,
    'ownerSignIn обязан вернуть и email, и uid — владелец копирует uid из этого ответа');

  const logins = callsTo(fetchImpl.calls, 'signInWithPassword');
  assert.equal(logins.length, 1, 'входа по паролю не было: ' + JSON.stringify(fetchImpl.calls.map((c) => c.url)));
  assert.ok(logins[0].url.indexOf('key=' + KEY) !== -1, 'ключ проекта не в URL входа');
  assert.deepEqual(JSON.parse(logins[0].body),
    { email: 'owner@example.com', password: 'secret-pw', returnSecureToken: true },
    'тело signInWithPassword не по протоколу');
  assert.equal(callsTo(fetchImpl.calls, 'accounts:signUp').length, 0,
    'вход владельца начался с анонимного signUp');

  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-owner',
    'refresh-токен владельца не сохранён: перезагрузка вернёт анонимный аккаунт');
  const stored = JSON.parse(sandbox.localStorage.getItem(AUTH_OWNER_KEY));
  assert.equal(stored.uid, OWNER_UID, 'запись владельца не сохранена');

  // Токен из ответа входа сразу в кэше: первый синк после входа не платит
  // отдельным обменом refresh-токена.
  fetchImpl.calls.length = 0;
  assert.equal(await context.getAuthToken(), 'tok-owner');
  assert.equal(fetchImpl.calls.length, 0, 'сразу после входа getAuthToken дёрнул сеть');
});

test('вход владельца: пароль не остаётся ни в одном ключе localStorage', async () => {
  const fetchImpl = makeAuthFetch();
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  await context.ownerSignIn('owner@example.com', 'secret-pw');
  const dump = JSON.stringify(sandbox.localStorage._dump());
  assert.doesNotMatch(dump, /secret-pw/, 'пароль уехал в localStorage');
});

test('вход владельца переживает перезагрузку: refresh-обмен, снова не signUp', async () => {
  const app = await loadOwnerApp(makeAuthFetch());

  assert.equal(await app.context.getAuthToken(), 'tok2',
    'после перезагрузки сессия владельца не восстановлена обменом');
  assert.equal(callsTo(app.fetch.calls, 'identitytoolkit').length, 0,
    'перезагрузка вывела анонимный signUp поверх сессии владельца');
  const account = app.context.getOwnerAccount();
  assert.equal(account && account.email, 'owner@example.com',
    'getOwnerAccount() не читает сохранённую запись владельца');
  assert.equal(account && account.uid, OWNER_UID);
});

test('режим владельца: refresh-токена нет — анонимный signUp не дёргается, ответ null', async () => {
  const app = await loadOwnerApp(makeAuthFetch());
  // Сессия потеряна: токен стёрт пользователем или не сохранился. Путь
  // «молча завести анонимный аккаунт» закрыт — его uid не совпадёт с пином
  // в правилах, и человек получил бы вечный PERMISSION_DENIED без причины.
  app.sandbox.localStorage.removeItem(AUTH_REFRESH_KEY);
  app.context.resetAuthForTests();

  assert.equal(await app.context.getAuthToken(), null);
  assert.equal(callsTo(app.fetch.calls, 'accounts:signUp').length, 0,
    'тихий анонимный аккаунт в режиме владельца');
});

test('режим владельца: 400 на обмене — мёртвый ключ стёрт, signUp не дёрнут', async () => {
  const respond = (url) => {
    if (String(url).indexOf('securetoken.googleapis.com') !== -1) {
      return Promise.resolve(denied(400));
    }
    return Promise.resolve(okJson({ idToken: 'tok-x', refreshToken: 'r-x', expiresIn: '3600' }));
  };
  const app = await loadOwnerApp(respond);

  assert.equal(await app.context.getAuthToken(), null,
    'мёртвый refresh-токен в режиме владельца обязан дать null, а не анонимный токен');
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null,
    'доказанно мёртвый refresh-токен не стёрт');
  assert.equal(callsTo(app.fetch.calls, 'accounts:signUp').length, 0,
    '400 на обмене вывёл анонимный signUp поверх режима владельца');
});

test('отказ входа: неверный пароль — ошибка без пароля, живая сессия цела', async () => {
  const denyLogin = (url, opts) => {
    if (String(url).indexOf('signInWithPassword') !== -1) {
      return Promise.resolve({
        ok: false, status: 400,
        json: () => Promise.resolve({ error: { message: 'INVALID_PASSWORD' } }),
      });
    }
    if (String(url).indexOf('securetoken.googleapis.com') !== -1) {
      return Promise.resolve(okJson({ id_token: 'tok2', refresh_token: 'r2', expires_in: '3600' }));
    }
    return Promise.resolve(okJson({}));
  };
  // Устройство уже работает как владелец (вход в seed-загрузке), и вторая
  // попытка с неверным паролем не имеет права рушить рабочую сессию.
  const app = await loadOwnerApp(denyLogin);

  const err = await app.context.ownerSignIn('owner@example.com', 'wrong-pass').then(
    () => null, (e) => e);
  assert.ok(err, 'неверный пароль обязан бросить Error, а не разрешиться');
  assert.match(err.message, /INVALID_PASSWORD/, 'причина отказа не передана пользователю: ' + err.message);
  assert.doesNotMatch(err.message, /wrong-pass/, 'текст ошибки содержит пароль');
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-owner',
    'неудачная попытка стёрла рабочую сессию владельца');
  assert.equal(callsTo(app.fetch.calls, 'accounts:signUp').length, 0,
    'отказ входа завёл анонимный аккаунт');
  // Сессия жива: токен по-прежнему добывается, а не null навсегда
  assert.equal(await app.context.getAuthToken(), 'tok2');
});

test('выход владельца: сессия, refresh-токен и кэш токена стёрты', async () => {
  const fetchImpl = makeAuthFetch();
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  await context.ownerSignIn('owner@example.com', 'secret-pw');
  assert.equal(await context.getAuthToken(), 'tok-owner');

  context.ownerSignOut();
  assert.equal(context.getOwnerAccount(), null, 'выход не снял запись владельца');
  assert.equal(sandbox.localStorage.getItem(AUTH_OWNER_KEY), null);
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null,
    'выход оставил refresh-токен владельца: «разлогиненное» устройство ходит его uid');

  // После выхода приложение снова работает анонимно — ровно то, что нужно
  // до публикации правил и на чужом устройстве.
  fetchImpl.calls.length = 0;
  assert.equal(await context.getAuthToken(), 'tok1',
    'после выхода не вернулся анонимный режим (кэш токена не сброшен)');
  assert.equal(callsTo(fetchImpl.calls, 'accounts:signUp').length, 1);
});

test('без входа: getOwnerAccount() пуст, анонимный режим работает как раньше', async () => {
  const fetchImpl = makeAuthFetch();
  const { context } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  assert.equal(context.getOwnerAccount(), null);
  assert.equal(await context.getAuthToken(), 'tok1');
});

// Ответ входа без refresh-токена — не «половина настроенной сессии»: если бы
// мы приняли его, в AUTH_REFRESH_KEY остался бы СТАРЫЙ анонимный ключ, обмен
// ходил бы по нему, а правила по uid отвечали бы 403 вечно при видимом
// «вход выполнен».
test('вход без refresh-токена в ответе: отказ, анонимный ключ не тронут', async () => {
  const fetchImpl = (url) => {
    if (String(url).indexOf('signInWithPassword') !== -1) {
      return Promise.resolve(okJson({ idToken: 'tok-x', expiresIn: '3600', localId: OWNER_UID }));
    }
    if (String(url).indexOf('securetoken.googleapis.com') !== -1) {
      return Promise.resolve(okJson({ id_token: 'tok2', refresh_token: 'r2', expires_in: '3600' }));
    }
    return Promise.resolve(okJson({}));
  };
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, 'r-anon');

  const err = await context.ownerSignIn('owner@example.com', 'pw').then(() => null, (e) => e);
  assert.ok(err, 'ответ без refresh-токена принят как успешный вход');
  assert.match(err.message, /refresh/i);
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-anon',
    'отказ входа тронул рабочий анонимный ключ');
  assert.equal(sandbox.localStorage.getItem(AUTH_OWNER_KEY), null,
    'запись владельца появилась несмотря на отказ');
  // и приложение продолжает работать анонимно
  assert.equal(await context.getAuthToken(), 'tok2');
});

test('пустые email или пароль: ошибка до сети, ни одного запроса', async () => {  const fetchImpl = makeAuthFetch();
  const { context } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  await assert.rejects(() => context.ownerSignIn('', 'pw'), /email/i);
  await assert.rejects(() => context.ownerSignIn('owner@example.com', ''), /парол/i);
  assert.equal(fetchImpl.calls.length, 0, 'проверка полей ушла в сеть');
});
