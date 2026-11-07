// Тесты анонимной аутентификации Firebase (REST identitytoolkit).
//
// Контракт js/data/firebase-auth.js: getAuthToken() даёт строку idToken или
// null (null = «работаем как раньше, без токена»); любая неудача — null,
// без исключений; после неудачи пауза 5 минут, в ней сеть не дёргается;
// refresh-токен живёт в localStorage и переживает перезагрузку приложения.
//
// Песочница стартует с пустым ключом (tests/helpers/load-app.mjs обнуляет его
// намеренно: сетевые заглушки не должны получать лишних identitytoolkit-
// вызовов), поэтому тесты подставляют ключ через context.setFirebaseApiKey():
// getAuthToken/setFirebaseApiKey — верхнеуровневые function-объявления,
// песочница vm выставляет их свойствами контекста (как ctx.syncToCloud в
// sync.test.mjs). Что настоящий ключ из исходника никуда не делся, сторожит
// отдельный тест в конце файла — он читает сам файл.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/load-app.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// Полный разлогин (аудит секретов, задача 3.1): в хранилище не остаётся НИ
// ОДНОГО сессионного ключа. Два известных ключа ownerSignOut() стирает прямо;
// всё прочее, что когда-либо появится под пространством youplanner.fb.*
// (например, ключ старой версии приложения с токеном другого формата),
// стирает защитная зачистка пространства — иначе «обновление приложения +
// выход» оставило бы на устройстве живой токен, о котором новый код не знает.
test('полный разлогин: ни одного ключа youplanner.fb.* в localStorage', async () => {
  const fetchImpl = makeAuthFetch();
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  await context.ownerSignIn('owner@example.com', 'secret-pw');
  // Чужой ключ сессии «из старой версии»: под пространством youplanner.fb.*
  // зачистка обязана стереть и его.
  sandbox.localStorage.setItem('youplanner.fb.legacy-token', 'tok-из-старой-версии');
  assert.ok(sandbox.localStorage.getItem('youplanner.fb.legacy-token'),
    'подготовка не удалась: legacy-ключ не записан');

  context.ownerSignOut();

  const leftover = Object.keys(sandbox.localStorage._dump())
    .filter((k) => k.indexOf('youplanner.fb.') === 0);
  assert.deepEqual(leftover, [],
    'после разлогина остались сессионные ключи: ' + leftover.join(', '));
  assert.equal(context.getOwnerAccount(), null, 'состояние входа не сброшено');

  // Ровно то, ради чего зачистка: разлогиненное устройство добывает токен
  // свежим анонимным signUp'ом, а не по уцелевшему сессионному ключу.
  fetchImpl.calls.length = 0;
  assert.equal(await context.getAuthToken(), 'tok1',
    'после разлогина токен не из анонимного signUp');
  assert.equal(callsTo(fetchImpl.calls, 'securetoken').length, 0,
    'после разлогина прошёл обмен по уцелевшему refresh-токену');
});

// Гонка «выход во время обмена»: ответ securetoken, пришедший ПОСЛЕ
// ownerSignOut(), не имеет права записать свежую пару токенов обратно в
// хранилище — иначе «разлогиненное» устройство продолжало бы ходить в базу
// с uid владельца, ровно то, чего владелец ждал от кнопки «Выйти».
test('разлогин во время обмена: опоздавший ответ не возвращает сессию', async () => {
  let resolveRefresh = null;
  const fetchImpl = (url) => {
    if (String(url).indexOf('securetoken.googleapis.com') !== -1) {
      // Обмен висит, пока тест не разрешит его вручную
      return new Promise((resolve) => { resolveRefresh = () => resolve(okJson({
        id_token: 'tok-new', refresh_token: 'r-new-owner', expires_in: '3600',
      })); });
    }
    return Promise.resolve(okJson({}));
  };
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, 'r-owner');
  sandbox.localStorage.setItem(AUTH_OWNER_KEY,
    JSON.stringify({ email: 'owner@example.com', uid: OWNER_UID }));

  const pending = context.getAuthToken();
  // Дать обмену дойти до ожидания ответа сети: макрозадача вымоет все
  // микротаски цепочки getAuthToken → requestFreshToken → authPost
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(resolveRefresh, 'обмен не дошёл до сети до выхода');

  context.ownerSignOut();
  resolveRefresh();
  const token = await pending;

  assert.equal(token, null,
    'опоздавший токен обслуживает запросы после выхода');
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null,
    'опоздавший ответ вернул refresh-токен владельца в хранилище');
  assert.equal(context.getOwnerAccount(), null, 'состояние входа восстановилось');
  assert.deepEqual(Object.keys(sandbox.localStorage._dump())
    .filter((k) => k.indexOf('youplanner.fb.') === 0), [],
    'опоздавший ответ оставил сессионные ключи');
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

/* ---------- Автообновление протухшего ID-токена (401 → refresh → повтор) ----
   Баг со второго устройства: ID-токен протух, сервер данных отвечает 401
   «INVALID_ID_TOKEN», автообновления нет — а настройки при этом показывают
   email и UID (запись владельца цела). Контракт исправления:
     * 401 с ошибкой протухшего токена → обмен refresh-токена (securetoken),
       новые токены на прежние ключи, ИСХОДНЫЙ запрос повторён один раз;
     * параллельные запросы делят один обмен (дедупликация in-flight);
     * отказ обмена (4xx) — принудительный разлогин: хранилище чистое,
       состояние входа сброшено, событие sync:auth-expired через bus;
     * повторный 401 после refresh — не зацикливается. */

// Сервер, пускающий в данные только с НОВЫМ токеном: запрос с токеном
// tok-owner отвечает 401 с ошибкой протухшего токена, с tok-new — 200. Токен
// принимается в ОБЕИХ формах REST RTDB — заголовком Authorization: Bearer
// (как теперь ходит синхронизация) и легаси-параметром ?auth= в URL (как
// ходят рукописные запросы в этих же тестах). Форма ошибки — строка, как у
// RTDB REST; отказ обмена — объект {error:{message}}, как у identitytoolkit.
// Вход владельца даёт пару tok-owner / r-owner.
function makeOwnerDataServer() {
  const state = {
    calls: [],
    dataCalls: [],
    securetokenCalls: [],
    // Поведение обмена refresh-токена: 'ok' | 'dead' (400) | 'network'
    refreshBehavior: 'ok',
    // Задержка обмена: параллельные 401 обязаны успеть сойтись в один вызов
    refreshDelayMs: 0,
    // Отвергать и новый токен (401 и после refresh) — проверка зацикливания
    rejectNewToken: false,
    // Текст ошибки в 401 данных: по умолчанию протухший токен, «Permission
    // denied» — отказ правил, который refresh-ом лечить нельзя
    dataError: 'INVALID_ID_TOKEN',
  };
  const impl = function (url, opts) {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    const headers = (opts && opts.headers) || {};
    state.calls.push({ url: u, method: method, headers: headers });
    if (u.indexOf('firebaseio.com') !== -1) {
      state.dataCalls.push({ url: u, method: method, headers: headers });
      // Обе формы: Bearer-заголовок или легаси ?auth= в URL
      const bearer = headers && typeof headers.Authorization === 'string'
        ? headers.Authorization.replace(/^Bearer\s+/i, '')
        : '';
      const match = u.match(/[?&]auth=([^&]+)/);
      const token = bearer || (match ? decodeURIComponent(match[1]) : '');
      if (token === 'tok-new' && !state.rejectNewToken) {
        return Promise.resolve(okJson({}));
      }
      return Promise.resolve({
        ok: false, status: 401,
        json: function () { return Promise.resolve({ error: state.dataError }); },
      });
    }
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      state.securetokenCalls.push({ url: u, body: opts && opts.body });
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (state.refreshBehavior === 'dead') {
            resolve({
              ok: false, status: 400,
              json: function () {
                return Promise.resolve({ error: { message: 'INVALID_REFRESH_TOKEN' } });
              },
            });
          } else if (state.refreshBehavior === 'network') {
            reject(new Error('нет сети'));
          } else {
            resolve(okJson({ id_token: 'tok-new', refresh_token: 'r-new', expires_in: '3600' }));
          }
        }, state.refreshDelayMs);
      });
    }
    if (u.indexOf('signInWithPassword') !== -1) {
      let email = '';
      try { email = JSON.parse(String(opts.body)).email || ''; } catch (e) { email = ''; }
      return Promise.resolve(okJson({
        kind: 'identitytoolkit#VerifyPasswordResponse',
        idToken: 'tok-owner', refreshToken: 'r-owner', expiresIn: '3600',
        localId: OWNER_UID, email: email,
      }));
    }
    return Promise.resolve(okJson({}));
  };
  impl.state = state;
  return impl;
}

// Владелец со входом (токен tok-owner в кэше, refresh-токен r-owner в
// хранилище) и подписчик bus на событие принудительного разлогина.
async function loadExpiredCase(server) {
  const app = loadApp({ fetchImpl: server });
  app.context.setFirebaseApiKey(KEY);
  await app.context.ownerSignIn('owner@example.com', 'secret-pw');
  app.run("globalThis.__expired = [];");
  app.run("bus.on('sync:auth-expired', function (p) { globalThis.__expired.push(p && p.reason); });");
  return app;
}

function callsWithAuth(calls, token) {
  return calls.filter(function (c) {
    // Токен в записи вызова: Bearer-заголовок (как ходит синхронизация)
    // или легаси ?auth= в URL (рукописные запросы тестов)
    const header = c.headers && typeof c.headers.Authorization === 'string'
      ? c.headers.Authorization.replace(/^Bearer\s+/i, '')
      : '';
    return header === token || c.url.indexOf('auth=' + token) !== -1;
  });
}

test('401 INVALID_ID_TOKEN: refresh-обмен и повтор ИСХОДНОГО запроса с новым токеном', async () => {
  const server = makeOwnerDataServer();
  const app = await loadExpiredCase(server);
  const state = server.state;

  const result = await app.context.syncFromCloud();

  assert.equal(result.reachable, true,
    'запрос не повторён с новым токеном: синк посчитал сервер недоступным');
  // Обмен ровно один, по протоколу securetoken, refresh-токен из хранилища
  assert.equal(state.securetokenCalls.length, 1,
    'обменов refresh-токена: ' + state.securetokenCalls.length);
  assert.ok(state.securetokenCalls[0].url.indexOf('key=' + KEY) !== -1,
    'обмен без ключа проекта');
  assert.deepEqual(JSON.parse(state.securetokenCalls[0].body),
    { grant_type: 'refresh_token', refresh_token: 'r-owner' },
    'тело обмена не берёт refresh-токен из хранилища');
  // Повтор: тот же запрос данных, уже с новым токеном
  assert.ok(callsWithAuth(state.dataCalls, 'tok-owner').length >= 1,
    'первый запрос с протухшим токеном не состоялся вовсе');
  assert.ok(callsWithAuth(state.dataCalls, 'tok-new').length >= 1,
    'запрос не повторён с НОВЫМ токеном');
  // Новые токены на прежних ключах
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-new',
    'новый refresh-токен не записан на прежний ключ');
  assert.equal(await app.context.getAuthToken(), 'tok-new',
    'новый id-токен не в кэше: следующий обмен пойдёт со старым');
  // Вылеченный 401 — не отказ: deniedStatus не залип
  assert.equal(app.run('deniedStatus'), 0, 'вылеченный 401 залип в deniedStatus');
});

test('мёртвый refresh-токен: принудительный разлогин — хранилище чистое, состояние «нужен вход»', async () => {
  const server = makeOwnerDataServer();
  server.state.refreshBehavior = 'dead';
  const app = await loadExpiredCase(server);
  const state = server.state;

  const result = await app.context.syncFromCloud();

  // Обмен был ровно один, исходный запрос не повторялся — повторять нечем
  assert.equal(state.securetokenCalls.length, 1, 'обменов больше одного');
  assert.equal(callsWithAuth(state.dataCalls, 'tok-new').length, 0,
    'повтор после НЕУДАВШЕГО refresh');
  assert.equal(result.reachable, false, 'упорный 401 должен остаться отказом');

  // Хранилище чистое: ни refresh-токена, ни записи владельца
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null,
    'мёртвый refresh-токен не стёрт');
  assert.equal(app.sandbox.localStorage.getItem(AUTH_OWNER_KEY), null,
    'запись владельца осталась: настройки показывают email/UID при мёртвой сессии');
  assert.equal(app.context.getOwnerAccount(), null,
    'состояние входа не сброшено: приложение не понимает, что нужен вход');

  // Событие о разлогине — с причиной из отказа auth-сервера
  assert.deepEqual(Array.from(app.run('globalThis.__expired')), ['INVALID_REFRESH_TOKEN'],
    'событие sync:auth-expired не пришло или без причины');
});

test('параллельные запросы на 401: ровно ОДИН вызов refresh', async () => {
  const server = makeOwnerDataServer();
  // Задержка обмена: оба запроса успевают упереться в 401 до его конца
  server.state.refreshDelayMs = 20;
  const app = await loadExpiredCase(server);
  const state = server.state;

  const results = await Promise.all([
    app.context.syncFromCloud(),
    app.context.syncFromCloud(),
  ]);

  assert.equal(state.securetokenCalls.length, 1,
    'параллельные 401 породили ' + state.securetokenCalls.length +
    ' обменов: обещание refresh не разделяется');
  assert.equal(results.filter(function (r) { return r && r.reachable; }).length, 2,
    'не оба запроса дошли до сервера с новым токеном');
  assert.ok(callsWithAuth(state.dataCalls, 'tok-owner').length >= 2,
    'не оба исходных запроса ушли с протухшим токеном');
  assert.ok(callsWithAuth(state.dataCalls, 'tok-new').length >= 2,
    'повторы с новым токеном не состоялись');
});

test('401 и ПОСЛЕ refresh: повтор ровно один, зацикливания нет', async () => {
  const server = makeOwnerDataServer();
  server.state.rejectNewToken = true; // сервер отвергает и новый токен
  const app = await loadExpiredCase(server);
  const state = server.state;

  const result = await app.context.syncFromCloud();

  assert.equal(state.securetokenCalls.length, 1,
    'refresh вызван и после повторного 401: зацикливание');
  // Исходный запрос + ровно один повтор
  assert.equal(state.dataCalls.length, 2,
    'запросов данных: ' + state.dataCalls.length);
  assert.equal(result.reachable, false, 'упорный 401 должен остаться отказом');
  assert.equal(app.run('deniedStatus'), 401,
    'повторный 401 не доведён до sync:denied-статуса');
});

test('сеть отвалилась на обмене refresh-токена: сессия цела, повтора нет', async () => {
  const server = makeOwnerDataServer();
  server.state.refreshBehavior = 'network';
  const app = await loadExpiredCase(server);
  const state = server.state;

  const result = await app.context.syncFromCloud();

  // Живой refresh-токен не доказано, что мёртв: сессию храним — стирает
  // только отказ САМОГО обмена (4xx), не сетевой сбой (принцип 5xx-ветки
  // requestFreshToken). Выздоровевшая сеть сама вылечит обмен.
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-owner',
    'сетевой сбой обмена стёр живую сессию');
  assert.ok(app.sandbox.localStorage.getItem(AUTH_OWNER_KEY),
    'сетевой сбой обмена снял запись владельца');
  assert.deepEqual(Array.from(app.run('globalThis.__expired')), [],
    'сетевой сбой обмена разлогинил');
  assert.equal(callsWithAuth(state.dataCalls, 'tok-new').length, 0,
    'повтор без нового токена');
  assert.equal(result.reachable, false);
});

test('401 Permission denied — правила, а не протухший токен: refresh не дёргается', async () => {
  const server = makeOwnerDataServer();
  server.state.dataError = 'Permission denied';
  const app = await loadExpiredCase(server);
  const state = server.state;

  const result = await app.context.syncFromCloud();

  assert.equal(state.securetokenCalls.length, 0,
    'отказ правил запустил обмен токена: причина не протухший токен');
  assert.equal(result.reachable, false);
  assert.equal(app.run('deniedStatus'), 401, 'отказ правил не дошёл до sync:denied');
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-owner',
    'отказ правил стёр сессию');
  assert.deepEqual(Array.from(app.run('globalThis.__expired')), [],
    'отказ правил разлогинил');
});

// Вход по email/паролю падает с «Ключ Firebase-проекта не задан», если
// FIREBASE_WEB_API_KEY пуст. Песочница тестов обнуляет ключ намеренно,
// поэтому проверить настоящий исходник можно только снаружи: чтение файла, а
// не контекста. Ключ web-приложения Firebase не секрет (идентификатор
// проекта, свободно живёт в клиентском бандле), поэтому в репозитории он и
// лежит.
test('исходник аутентификации: рабочий ключ Firebase вписан', () => {
  const source = readFileSync(join(ROOT, 'js', 'data', 'firebase-auth.js'), 'utf8');
  const match = source.match(/export let FIREBASE_WEB_API_KEY = '([^']*)'/);
  assert.ok(match, 'строка FIREBASE_WEB_API_KEY не найдена — формат изменился, правь и тест');
  assert.match(match[1], /^AIza[A-Za-z0-9_-]{20,}$/,
    'ключ web-приложения пуст или обрезан: вход владельца не поднимется');
});

// Тот же класс ошибки, но на другом конце: модули приложения обязаны быть в
// precache service worker. Не-HTML отдаётся network-first, и при офлайне или
// битом ответе браузер получает копию из кэша — устаревшая firebase-auth.js
// без ключа и давала «ключ не вписан» при целом исходнике (2026-11-04).
test('service worker кэширует модули аутентификации и синхронизации', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  for (const file of ['./js/data/firebase-auth.js', './js/sync/sync.js', './js/app.js']) {
    assert.ok(sw.indexOf("'" + file + "'") !== -1,
      file + ' нет в ASSETS sw.js: офлайн-копия клиента останется без него');
  }
});
