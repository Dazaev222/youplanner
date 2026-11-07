// ТЗ «Мультидевайс»: два устройства против ОДНОГО мок-сервера RTDB с честной
// auth-семантикой. Проверяется сценарий из ТЗ:
//   1. Устройство А создаёт задачу Матрицы (createTask, js/data/matrix.js) и
//      публикует planner-узел; в середине обмена мок отзывает текущий id-токен
//      А — авто-refresh (обмен refresh-токена на securetoken, затем повтор
//      исходного запроса в fetchWithTimeout, js/sync/sync.js:127) должен
//      спасти публикацию. До фикса 401 публикация здесь падала и не доезжала.
//   2. Устройство Б синхронизируется — задача появляется у Б, снимки planner
//      на А и Б совпадают канонически.
//   3. Б переименовывает задачу — А подтягивает правку без ошибок.
//   4. У Б серверно отзывается и refresh-токен — принудительный разлогин
//      (сессионные ключи стёрты), данные на сервере не тронуты.
//
// Два устройства: каждый вызов loadApp() (tests/helpers/load-app.mjs) даёт
// свой vm-контекст — свой стаб localStorage и свою память модулей (authCache,
// deniedStatus, syncPending, счётчики envelope). Оба sandbox.fetch указывают
// на ОДИН объект мок-сервера — это и есть «одна база». Минимальный честный
// вариант: отдельные экземпляры приложения, тот же приём, что у «перезагрузки»
// в tests/firebase-auth.test.mjs, без хитростей с ?query-импортами.
//
// Мок-сервер (makeMultiDeviceServer ниже) собран из соседей: CAS-узлы данных
// с ETag/If-Match→412 — как makeCasServer в tests/planner-sync.test.mjs,
// auth-эндпоинты — как makeAuthFetch/makeOwnerDataServer в
// tests/firebase-auth.test.mjs. Честность auth:
//   * каждый вход/обмен выдаёт НОВУЮ пару токенов; signInWithPassword —
//     аккаунт владельца (uid OWNER-UID), accounts:signUp — анонимный аккаунт
//     с ДРУГИМ uid (правила базы узел владельца ему не открывают);
//   * данные (firebaseio.com) отвечают 200 только с токеном владельца —
//     заголовком Authorization: Bearer (как ходит синхронизация) или легаси
//     ?auth= в URL (рукописные запросы тестов);
//     нет токена / чужой uid — 401 «Permission denied» (отказ правил, refresh
//     его не лечит); отозванный (протухший) токен — 401
//     {"error":"INVALID_ID_TOKEN"} (лечится обменом refresh-токена);
//   * securetoken выдаёт новую пару по валидному refresh-токену и отвечает
//     400 INVALID_REFRESH_TOKEN на неизвестный/отозванный.
//
// RED (история бага): фикс авто-refresh уже в дереве, поэтому «старый код»
// показывается режимом мока STRICT_NO_REFRESH — переменная окружения
// MULTIDEVICE_STRICT_NO_REFRESH=1. Сервер данных по-прежнему отвергает
// протухший токен, а обмен refresh-токена отвечает 400. Приём честный, но
// ограниченный, и оговаривается прямо: исходник клиента НЕ откатывался,
// проверяется чувствительность сценария к багу — без рабочего refresh-обмена
// устройство А попадает в то же наблюдаемое состояние, что при старом коде
// (401 не вылечен, planner-PUT не состоялся, outbox не подтверждён), и тест
// падает на утверждении «planner-узел опубликован».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const KEY = 'AIzaSyTestKeyForUnit';
// constant-экспорты в песочнице vm свойствами контекста не становятся, поэтому
// имена ключей пересказаны (та же практика, что в tests/firebase-auth.test.mjs)
const AUTH_REFRESH_KEY = 'youplanner.fb.refresh';
const AUTH_OWNER_KEY = 'youplanner.fb.owner';
const ENVELOPE_KEY = 'youplanner.planner.v1';
const OWNER_UID = 'OWNER-UID';

// RED-режим: включается только переменной окружения, в обычном npm test его нет
const RED_STRICT_NO_REFRESH = process.env.MULTIDEVICE_STRICT_NO_REFRESH === '1';

const DATA_URL = 'https://youplanner-5c2f5-default-rtdb.firebaseio.com/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9';
const SIGN_IN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + KEY;
const SIGN_UP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + KEY;
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token?key=' + KEY;

function okJson(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function failJson(status, error) {
  // text() обязателен: обёртка синка читает тело 401 текстом (RTDB отвечает
  // и JSON'ом, и текстом), не-JSON непустое тело считается протухшим токеном
  return {
    ok: false,
    status: status,
    text: () => Promise.resolve(JSON.stringify(error)),
    json: () => Promise.resolve(error),
  };
}

// ── Мок-сервер: одна база, честная auth-семантика ───────────────────────────

function makeMultiDeviceServer() {
  let credSeq = 0;
  const state = {
    // выданные пары (журнал): { idToken, refreshToken, uid, email }
    issued: [],
    idTokens: new Map(),      // idToken -> {uid, email, refreshToken}
    refreshTokens: new Map(), // refreshToken -> {uid, email, idToken}
    revokedIdTokens: new Set(), // «протухшие» id-токены: 401 INVALID_ID_TOKEN
    // три узла данных с независимыми ETag, как у настоящей базы проекта
    nodes: {
      root: { name: 'root', data: null, etag: 'root-etag-1' },
      planner: { name: 'planner', data: null, etag: 'planner-etag-1' },
      backups: { name: 'backups', data: null, etag: 'backups-etag-1' },
    },
    etagSeq: 1,
    // RED-режим: обмен refresh-токена всегда 400, даже с валидным ключом
    strictNoRefresh: false,
    // середина полёта: после N-го запроса данных его токен истекает
    expireTokenOnDataCall: null,
    // журналы вызовов (dataCalls — только узлы данных)
    calls: [],
    dataCalls: [],
    securetokenCalls: [],
    signUpCalls: [],
    // Сетевая моргла для тестов релога: столько СЛЕДУЮЩИХ GET к узлам данных
    // отклоняется как сетевой сбой (до auth-проверки, как в реальности)
    failNextDataGets: 0,
  };

  // Новая пара токенов для аккаунта (uid, email)
  function issue(email, uid) {
    credSeq += 1;
    const pair = { idToken: 'id-' + credSeq, refreshToken: 'refresh-' + credSeq, uid: uid, email: email };
    state.issued.push(pair);
    state.idTokens.set(pair.idToken, { uid: uid, email: email, refreshToken: pair.refreshToken });
    state.refreshTokens.set(pair.refreshToken, { uid: uid, email: email, idToken: pair.idToken });
    return pair;
  }

  // Отзыв сессии на сервере (как смена пароля): умирает refresh-токен
  // и выпущенный с ним id-токен
  state.revokeSession = function (refreshToken) {
    const cred = state.refreshTokens.get(refreshToken);
    if (!cred) return false;
    state.revokedIdTokens.add(cred.idToken);
    state.refreshTokens.delete(refreshToken);
    return true;
  };

  // Токен запроса в ОБЕИХ формах REST RTDB: заголовок Authorization: Bearer
  // (как теперь ходит синхронизация, аудит секретов 3.1) и легаси-параметр
  // ?auth= в URL (как ходят рукописные запросы в этих же тестах).
  function tokenOf(url, headers) {
    const h = headers || {};
    if (typeof h.Authorization === 'string' && /^Bearer\s+/i.test(h.Authorization)) {
      return h.Authorization.replace(/^Bearer\s+/i, '');
    }
    const match = String(url).match(/[?&]auth=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function pickNode(url) {
    const u = String(url);
    if (u.indexOf('-planner') !== -1) return state.nodes.planner;
    if (u.indexOf('-backups') !== -1) return state.nodes.backups;
    return state.nodes.root;
  }

  // GET/PUT одного узла данных: ETag на чтении, условная запись If-Match → 412
  // (та же модель CAS, что makeCasServer в tests/planner-sync.test.mjs)
  function dataResponse(url, method, headers, body) {
    const node = pickNode(url);
    if (method === 'GET') {
      return {
        ok: true, status: 200,
        headers: { get: function (name) { return String(name).toLowerCase() === 'etag' ? node.etag : null; } },
        json: function () { return Promise.resolve(node.data); },
      };
    }
    const match = headers['If-Match'];
    if (match && match !== node.etag) {
      return failJson(412, { error: 'conflict' });
    }
    state.etagSeq += 1;
    node.etag = node.name + '-etag-' + state.etagSeq;
    node.data = JSON.parse(body);
    return { ok: true, status: 200, json: function () { return Promise.resolve(node.data); } };
  }

  state.respond = function (url, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const u = String(url);
    state.calls.push({ url: u, method: method });

    if (u.indexOf('firebaseio.com') !== -1) {
      // Сетевая моргла: транспорт лёг до auth-проверки — отклонение промиса,
      // как у настоящего fetch без сети
      if (method === 'GET' && state.failNextDataGets > 0) {
        state.failNextDataGets -= 1;
        return Promise.reject(new Error('сеть недоступна (тест)'));
      }
      const token = tokenOf(u, headers);
      const cred = token ? state.idTokens.get(token) : null;
      let response;
      if (!cred) {
        // нет токена или токен неизвестен: правила базы не пускают —
        // это НЕ «протухший токен», refresh-обмен его не лечит
        response = failJson(401, { error: 'Permission denied' });
      } else if (state.revokedIdTokens.has(token)) {
        // протухший/отозванный id-токен — лечится обменом refresh-токена
        response = failJson(401, { error: 'INVALID_ID_TOKEN' });
      } else if (cred.uid !== OWNER_UID) {
        // анонимный (или чужой) uid: узел владельца закрыт правилами
        response = failJson(401, { error: 'Permission denied' });
      } else {
        response = dataResponse(u, method, headers, options.body);
      }
      state.dataCalls.push({ url: u, method: method, auth: token, status: response.status });
      // середина полёта: N-й запрос данных отработал — его токен истёк
      if (token && state.expireTokenOnDataCall === state.dataCalls.length) {
        state.revokedIdTokens.add(token);
      }
      return Promise.resolve(response);
    }

    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      let request = null;
      try { request = JSON.parse(String(options.body)); } catch (e) { request = null; }
      const refreshToken = request && request.refresh_token;
      let response;
      if (state.strictNoRefresh) {
        response = failJson(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
      } else if (!refreshToken || !state.refreshTokens.has(refreshToken)) {
        response = failJson(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
      } else {
        const cred = state.refreshTokens.get(refreshToken);
        const pair = issue(cred.email, cred.uid);
        // формат ответа securetoken: id_token/refresh_token/expires_in
        response = okJson({ id_token: pair.idToken, refresh_token: pair.refreshToken, expires_in: '3600' });
      }
      state.securetokenCalls.push({ url: u, body: options.body, status: response.status });
      return Promise.resolve(response);
    }

    if (u.indexOf('identitytoolkit.googleapis.com') !== -1) {
      if (u.indexOf('accounts:signUp') !== -1) {
        state.signUpCalls.push(u);
        const anonUid = 'anon-' + (credSeq + 1); // анонимный uid ≠ uid владельца
        const pair = issue('', anonUid);
        return Promise.resolve(okJson({ idToken: pair.idToken, refreshToken: pair.refreshToken, expiresIn: '3600' }));
      }
      // вход владельца: uid OWNER-UID — тот самый, что вшит в правила
      let email = '';
      try { email = JSON.parse(String(options.body)).email || ''; } catch (e) { email = ''; }
      const pair = issue(email, OWNER_UID);
      return Promise.resolve(okJson({
        kind: 'identitytoolkit#VerifyPasswordResponse',
        idToken: pair.idToken, refreshToken: pair.refreshToken, expiresIn: '3600',
        localId: OWNER_UID, email: email,
      }));
    }

    return Promise.resolve(okJson({}));
  };
  return state;
}

// ── Помощники ───────────────────────────────────────────────────────────────

function callsWithAuth(calls, token) {
  return calls.filter(function (c) { return c.auth === token; });
}

// Каноническая форма снимка planner устройства (сравнение состояний А и Б)
function plannerSnapshotCanonical(app) {
  return app.run('plannerCanonicalJson(loadPlannerEnvelope().snapshot)');
}

function outboxOf(app) {
  const raw = app.sandbox.localStorage.getItem(ENVELOPE_KEY);
  return raw === null ? null : JSON.parse(raw).outbox;
}

function subscribeSyncEvents(app) {
  app.run("globalThis.__authExpired = []; globalThis.__denied = [];" +
    "bus.on('sync:auth-expired', function (p) { globalThis.__authExpired.push(p && p.reason); });" +
    "bus.on('sync:denied', function (p) { globalThis.__denied.push(p && p.status); });");
}

// ── 1. Самопроверка мока: он честно притворяется Firebase ───────────────────

test('мок-сервер: валидный токен пускает, протухший даёт 401 INVALID_ID_TOKEN, refresh выдаёт новую пару', async () => {
  const server = makeMultiDeviceServer();

  // вход владельца выдаёт пару с uid владельца
  const sign = await server.respond(SIGN_IN_URL, { method: 'POST', body: JSON.stringify({ email: 'o@e', password: 'pw' }) });
  assert.equal(sign.status, 200);
  const owner = await sign.json();
  assert.equal(owner.localId, OWNER_UID);
  const idToken = owner.idToken;
  const refreshToken = owner.refreshToken;

  // данные с валидным токеном — 200 с ETag
  const good = await server.respond(DATA_URL + '.json?auth=' + idToken, { headers: { 'X-Firebase-ETag': 'true' } });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('ETag'), 'root-etag-1');

  // без токена — отказ правил, а не «протухший токен»
  const noAuth = await server.respond(DATA_URL + '.json');
  assert.equal(noAuth.status, 401);
  assert.deepEqual(await noAuth.json(), { error: 'Permission denied' });

  // середина полёта: следующий запрос отработает, его токен истечёт следом
  server.expireTokenOnDataCall = server.dataCalls.length + 1;
  const stillGood = await server.respond(DATA_URL + '.json?auth=' + idToken);
  assert.equal(stillGood.status, 200);
  const expired = await server.respond(DATA_URL + '.json?auth=' + idToken);
  assert.equal(expired.status, 401);
  assert.deepEqual(await expired.json(), { error: 'INVALID_ID_TOKEN' });
  server.expireTokenOnDataCall = null;

  // securetoken: обмен валидного refresh-токена даёт новую рабочую пару
  const refresh = await server.respond(REFRESH_URL, {
    method: 'POST',
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  assert.equal(refresh.status, 200);
  const pair = await refresh.json();
  assert.ok(pair.id_token && pair.refresh_token && Number(pair.expires_in) > 0,
    'ответ обмена не в формате securetoken');
  assert.equal((await server.respond(DATA_URL + '.json?auth=' + pair.id_token)).status, 200,
    'новый id-токен не пущен в данные');

  // обмен мусором — 400 INVALID_REFRESH_TOKEN
  const bad = await server.respond(REFRESH_URL, {
    method: 'POST',
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'мусор' }),
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: { message: 'INVALID_REFRESH_TOKEN' } });

  // отзыв сессии: умирают и refresh-токен, и выпущенный с ним id-токен
  assert.equal(server.revokeSession(pair.refresh_token), true);
  const dead = await server.respond(DATA_URL + '.json?auth=' + pair.id_token);
  assert.equal(dead.status, 401);
  assert.deepEqual(await dead.json(), { error: 'INVALID_ID_TOKEN' });
  const deadRefresh = await server.respond(REFRESH_URL, {
    method: 'POST',
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: pair.refresh_token }),
  });
  assert.equal(deadRefresh.status, 400);

  // условная запись: PUT с устаревшим If-Match → 412
  const sign2 = await server.respond(SIGN_IN_URL, { method: 'POST', body: JSON.stringify({ email: 'o@e', password: 'pw' }) });
  const t2 = (await sign2.json()).idToken;
  assert.equal((await server.respond(DATA_URL + '.json?auth=' + t2, { method: 'PUT', body: '{"a":1}' })).status, 200);
  const stale = await server.respond(DATA_URL + '.json?auth=' + t2, {
    method: 'PUT', headers: { 'If-Match': 'root-etag-1' }, body: '{"a":2}',
  });
  assert.equal(stale.status, 412);

  // анонимный signUp: свой uid, узел владельца для него закрыт
  const anon = await server.respond(SIGN_UP_URL, { method: 'POST', body: '{}' });
  const anonTok = (await anon.json()).idToken;
  const anonData = await server.respond(DATA_URL + '.json?auth=' + anonTok);
  assert.equal(anonData.status, 401);
  assert.deepEqual(await anonData.json(), { error: 'Permission denied' });

  // STRICT_NO_REFRESH (RED-приём): обмен отвергнут даже с валидным ключом
  server.strictNoRefresh = true;
  const strict = await server.respond(REFRESH_URL, {
    method: 'POST',
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  assert.equal(strict.status, 400);
  assert.deepEqual(await strict.json(), { error: { message: 'INVALID_REFRESH_TOKEN' } });
});

// ── 2. Сценарий двух устройств ──────────────────────────────────────────────

test('два устройства: публикация А доезжает сквозь 401, правки ходят в обе стороны, мёртвый refresh разлогинивает Б', async () => {
  const server = makeMultiDeviceServer();
  server.strictNoRefresh = RED_STRICT_NO_REFRESH;

  // Два независимых экземпляра приложения: свои vm-контексты, свои стабы
  // localStorage, своя память модулей — против одного мок-сервера
  const deviceA = loadApp({ fetchImpl: server.respond });
  const deviceB = loadApp({ fetchImpl: server.respond });
  deviceA.context.setFirebaseApiKey(KEY);
  deviceB.context.setFirebaseApiKey(KEY);

  // Оба устройства входят ОДНИМ аккаунтом владельца — как в жизни: uid один,
  // пары токенов у каждого свои (мок выдаёт новую пару на каждый вход)
  await deviceA.context.ownerSignIn('owner@example.com', 'secret-pw');
  const aPair = server.issued[server.issued.length - 1];
  await deviceB.context.ownerSignIn('owner@example.com', 'secret-pw');
  const bPair = server.issued[server.issued.length - 1];
  assert.notEqual(aPair.idToken, bPair.idToken, 'устройства получили один токен');

  subscribeSyncEvents(deviceA);
  subscribeSyncEvents(deviceB);

  // ── Фаза 1: А создаёт задачу и публикует planner-узел сквозь инвалидацию ──
  // После двух корневых чтений (бэкап + сверка) токен А «протухает»: все
  // дальнейшие запросы с ним отвечают 401 INVALID_ID_TOKEN
  server.expireTokenOnDataCall = 2;

  const task = deviceA.context.createTask({ title: 'Матрица: задача с А', due: '2026-11-07', priority: 2 });
  const taskId = task.id;
  const existingA = Array.from(deviceA.context.loadTasks());
  assert.equal(deviceA.context.saveTasks(existingA.concat([task])), true, 'saveTasks не сработал');

  await deviceA.context.syncToCloudNow();

  // Предусловие (справедливо в обоих режимах): 401 случился посреди обмена,
  // клиент заплатил РОВНО одним обменом refresh-токена с протоколом securetoken
  assert.ok(callsWithAuth(server.dataCalls, aPair.idToken).some(function (c) { return c.status === 401; }),
    'инвалидация в середине полёта не сработала: 401 не был получен');
  assert.equal(server.securetokenCalls.length, 1,
    'обменов refresh-токена: ' + server.securetokenCalls.length);
  assert.deepEqual(JSON.parse(server.securetokenCalls[0].body),
    { grant_type: 'refresh_token', refresh_token: aPair.refreshToken },
    'обмен не взял refresh-токен А из хранилища');

  // До фикса 401 публикация падала и не доезжала — это утверждение и есть
  // проверка фикса; в режиме STRICT_NO_REFRESH оно падает (см. шапку файла)
  const plannerNode = server.nodes.planner.data;
  assert.ok(plannerNode, 'planner-узел не опубликован: публикация упала на 401 и не повторилась');
  assert.equal(plannerNode.entries[taskId].fields.title.value, 'Матрица: задача с А',
    'на сервере не та задача');

  // Повтор исходного запроса пошёл с НОВЫМ токеном и дошёл
  const aNewRefresh = deviceA.sandbox.localStorage.getItem(AUTH_REFRESH_KEY);
  assert.ok(aNewRefresh && aNewRefresh !== aPair.refreshToken, 'refresh-токен А не сменился');
  const aNew = server.issued.filter(function (p) { return p.refreshToken === aNewRefresh; })[0];
  assert.ok(aNew, 'новой пары А нет на сервере');
  assert.ok(callsWithAuth(server.dataCalls, aNew.idToken).some(function (c) { return c.status === 200; }),
    'повтор с новым токеном не состоялся');

  // Ровно один успешный planner-PUT и один корневой PUT; бэкап не ходил (узел был пуст).
  // Без контрольного GET (Г1) 401 середины полёта падает на сам planner-PUT:
  // в dataCalls две записи — попытка с 401 и её повтор с новым токеном, но это
  // один и тот же запрос транспорта, успешных публикаций одна.
  const plannerPuts = server.dataCalls.filter(function (c) {
    return c.method === 'PUT' && c.url.indexOf('-planner') !== -1;
  });
  assert.equal(plannerPuts.filter(function (c) { return c.status === 200; }).length, 1);
  assert.equal(plannerPuts[plannerPuts.length - 1].status, 200);
  const rootPuts = server.dataCalls.filter(function (c) {
    return c.method === 'PUT' && c.url.indexOf('firebaseio.com') !== -1 &&
      c.url.indexOf('-planner') === -1 && c.url.indexOf('-backups') === -1;
  });
  assert.equal(rootPuts.length, 1);
  assert.equal(rootPuts[0].status, 200);

  // Операция подтверждена, 401 вылечен — ни отказа прав, ни разлогина наружу
  assert.deepEqual(outboxOf(deviceA), [], 'outbox А не подтверждён после успешной публикации');
  assert.equal(deviceA.run('deniedStatus'), 0, 'вылеченный 401 залип в deniedStatus');
  assert.deepEqual(Array.from(deviceA.run('globalThis.__authExpired')), [], 'А разлогинило на живой сессии');
  assert.deepEqual(Array.from(deviceA.run('globalThis.__denied')), [], 'А увидел sync:denied на вылеченном 401');
  server.expireTokenOnDataCall = null;

  // ── Фаза 2: Б синхронизируется — задача появляется ─────────────────────────
  const pulledB = await deviceB.context.syncFromCloud();
  assert.equal(pulledB.reachable, true, 'Б не смог синхронизироваться');
  const arrived = Array.from(deviceB.context.loadTasks()).filter(function (t) { return t.id === taskId; })[0];
  assert.ok(arrived, 'задача А не появилась у Б');
  assert.equal(arrived.title, 'Матрица: задача с А');
  assert.equal(plannerSnapshotCanonical(deviceB), plannerSnapshotCanonical(deviceA),
    'снимки planner на А и Б разошлись');
  assert.equal(deviceB.run('deniedStatus'), 0);

  // ── Фаза 3: Б переименовывает — А подтягивает без ошибок ───────────────────
  const tasksOnB = Array.from(deviceB.context.loadTasks());
  tasksOnB[0].title = 'Переименовано на Б';
  assert.equal(deviceB.context.saveTasks(tasksOnB), true, 'правка Б не сохранилась');
  await deviceB.context.syncToCloudNow();
  assert.equal(server.nodes.planner.data.entries[taskId].fields.title.value, 'Переименовано на Б',
    'правка Б не доехала до сервера');
  assert.deepEqual(outboxOf(deviceB), [], 'outbox Б не подтверждён после публикации');

  const pulledA = await deviceA.context.syncFromCloud();
  assert.equal(pulledA.reachable, true, 'А не смог синхронизироваться');
  const renamed = Array.from(deviceA.context.loadTasks()).filter(function (t) { return t.id === taskId; })[0];
  assert.ok(renamed, 'задача пропала у А');
  assert.equal(renamed.title, 'Переименовано на Б', 'А не подтянул правку Б');
  assert.equal(plannerSnapshotCanonical(deviceA), plannerSnapshotCanonical(deviceB),
    'снимки planner разошлись после правки Б');
  assert.equal(deviceA.run('deniedStatus'), 0, 'А поймал отказ прав при подтягивании правки');
  assert.deepEqual(Array.from(deviceA.run('globalThis.__authExpired')), [], 'А разлогинило при подтягивании правки');
  assert.deepEqual(Array.from(deviceA.run('globalThis.__denied')), [], 'А увидел sync:denied при подтягивании правки');

  // ── Фаза 4: у Б отзывают и refresh-токен — разлогин, сервер не тронут ──────
  const plannerBefore = JSON.stringify(server.nodes.planner.data);
  const rootBefore = JSON.stringify(server.nodes.root.data);
  const etagsBefore = [server.nodes.planner.etag, server.nodes.root.etag];

  const bRefresh = deviceB.sandbox.localStorage.getItem(AUTH_REFRESH_KEY);
  assert.ok(bRefresh, 'у Б нет refresh-токена к моменту отзыва');
  assert.equal(server.revokeSession(bRefresh), true, 'сессия Б не отозвана сервером');

  const deadSync = await deviceB.context.syncFromCloud();
  assert.equal(deadSync.reachable, false, 'с мёртвой сессией синк обязан остаться отказом');

  // 401 был, обмен был и был ОТКАЗАН сервером (400 на мёртвый refresh-токен)
  const lastData = server.dataCalls[server.dataCalls.length - 1];
  assert.equal(lastData.auth, bPair.idToken, 'последний запрос Б пошёл не с его токеном');
  assert.equal(lastData.status, 401);
  assert.equal(server.securetokenCalls[server.securetokenCalls.length - 1].status, 400,
    'обмен мёртвым refresh-токеном не получил 400');

  // Принудительный разлогин: сессионные ключи стёрты (данные Матрицы —
  // пользовательские, их разлогин не трогает; чистится именно сессия)
  assert.equal(deviceB.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null, 'мёртвый refresh-токен не стёрт');
  assert.equal(deviceB.sandbox.localStorage.getItem(AUTH_OWNER_KEY), null, 'запись владельца осталась');
  assert.equal(deviceB.context.getOwnerAccount(), null, 'состояние входа не сброшено');
  assert.deepEqual(Array.from(deviceB.run('globalThis.__authExpired')), ['INVALID_REFRESH_TOKEN'],
    'событие sync:auth-expired не пришло или с другой причиной');
  assert.ok(Array.from(deviceB.run('globalThis.__denied')).indexOf(401) !== -1,
    'отказ не дошёл до sync:denied');

  // Данные на сервере не тронуты: ни байты узлов, ни их ETag
  assert.equal(JSON.stringify(server.nodes.planner.data), plannerBefore, 'planner-узел сервера изменён');
  assert.equal(JSON.stringify(server.nodes.root.data), rootBefore, 'корневой узел сервера изменён');
  assert.deepEqual([server.nodes.planner.etag, server.nodes.root.etag], etagsBefore,
    'ETag узлов изменился — сервер кто-то писал после отзыва сессии');
  assert.equal(server.nodes.planner.data.entries[taskId].fields.title.value, 'Переименовано на Б',
    'правка Б пропала с сервера');
});

// ── 3. Релог с протухшим кэшем: удалённая привычка не воскресает ────────────
// Баг владельца (2026-11-07): устройство Б долго не синхронизировалось, его
// локальный кэш всё ещё держит привычку, которую А успела удалить и
// опубликовать. После релога первый обмен Б — отправка (кнопка/правка:
// ownerSignIn в Настройках не перезапускает init, сверка могла моргнуть) —
// и удалённая привычка возвращалась на сервер, а с ним и на А. Контракт:
// надгробие выигрывает и на пути релога; кэш, противоречащий свежему
// надгробию, выбрасывает привычку (clearStaleCache, js/sync/merge.js).
test('релог с протухшим кэшем: удалённая на А привычка не возвращается ни у А, ни у Б', async () => {
  const server = makeMultiDeviceServer();
  const deviceA = loadApp({ fetchImpl: server.respond });
  const deviceB = loadApp({ fetchImpl: server.respond });
  deviceA.context.setFirebaseApiKey(KEY);
  deviceB.context.setFirebaseApiKey(KEY);
  await deviceA.context.ownerSignIn('owner@example.com', 'secret-pw');
  await deviceB.context.ownerSignIn('owner@example.com', 'secret-pw');

  const habitIds = function (app) {
    return Array.from(app.context.loadHabits()).map(function (h) { return h.id; });
  };

  // ── Фаза 1: А заводит две привычки и публикует ──
  const keeper = deviceA.context.addHabit({ name: 'Чтение', type: 'boolean' });
  const deleted = deviceA.context.addHabit({ name: 'Бег', type: 'boolean' });
  await deviceA.context.syncToCloudNow();
  assert.deepEqual(server.nodes.root.data.habits.map(function (h) { return h.id; }),
    [keeper.id, deleted.id], 'предусловие: списка А нет на сервере');

  // ── Фаза 2: Б сверяется — на этот момент кэш Б свежий ──
  const pulled = await deviceB.context.syncFromCloud();
  assert.equal(pulled.reachable, true, 'предусловие: Б не смог свериться');
  assert.deepEqual(habitIds(deviceB), [keeper.id, deleted.id]);
  // Дальше Б «уходит в офлайн»: сервер уезжает вперёд, кэш Б — нет

  // ── Фаза 3: А удаляет привычку и публикует; Б этого не видел ──
  assert.equal(deviceA.context.removeHabit(deleted.id), true);
  await deviceA.context.syncToCloudNow();
  const afterDelete = server.nodes.root.data;
  assert.deepEqual(afterDelete.habits.map(function (h) { return h.id; }),
    [keeper.id], 'предусловие: удаление не доехало до сервера');
  assert.ok(Number.isFinite(afterDelete.tombstones[deleted.id]),
    'предусловие: надгробия нет на сервере');

  // ── Фаза 4: релог Б — свежий экземпляр приложения, хранилище то же ──
  // (приём «перезагрузки» из tests/firebase-auth.test.mjs: данные устройства
  // переживают процесс, память модулей — нет). Кэш Б протух: привычка ещё в
  // списке, надгробия он не видел, метка сверки старше серверной.
  const reloggedB = loadApp({ fetchImpl: server.respond });
  const dump = deviceB.sandbox.localStorage._dump();
  Object.keys(dump).forEach(function (k) { reloggedB.sandbox.localStorage.setItem(k, dump[k]); });
  reloggedB.context.setFirebaseApiKey(KEY);
  await reloggedB.context.ownerSignIn('owner@example.com', 'secret-pw');
  assert.deepEqual(habitIds(reloggedB), [keeper.id, deleted.id],
    'предусловие: в кэше Б привычка ещё жива');
  assert.equal(reloggedB.sandbox.localStorage.getItem('youplanner.tombstones'), null,
    'предусловие: кэш Б не видел надгробия');

  // ── Фаза 5: первый обмен после релога: сверка моргнула, отправка прошла ──
  server.failNextDataGets = 1;
  const failed = await reloggedB.context.syncFromCloud();
  assert.equal(failed.reachable, false, 'предусловие: сверка не удалась');
  // Отправка (кнопка или дебаунс правки) — единственный успешный контакт
  // с сервером: уходит с ещё протухшим кэшем
  await reloggedB.context.syncToCloudNow();

  // ── Фаза 6: привычка не вернулась ни на сервер, ни у А, ни у Б ──
  const finalRoot = server.nodes.root.data;
  assert.deepEqual(finalRoot.habits.map(function (h) { return h.id; }),
    [keeper.id], 'удалённая привычка уехала обратно на сервер с PUT Б');
  assert.ok(Number.isFinite(finalRoot.tombstones[deleted.id]),
    'надгробие стёрлось на сервере вместе с PUT Б');
  const pulledA = await deviceA.context.syncFromCloud();
  assert.equal(pulledA.reachable, true);
  assert.deepEqual(habitIds(deviceA), [keeper.id],
    'удалённая привычка вернулась на А со сверкой');
  assert.ok(Number.isFinite(deviceA.context.loadTombstones()[deleted.id]),
    'надгробие стёрлось на А');
  assert.deepEqual(habitIds(reloggedB), [keeper.id],
    'удалённая привычка осталась в списке Б после релога');
  assert.ok(Number.isFinite(reloggedB.context.loadTombstones()[deleted.id]),
    'надгробие не записалось на Б');
});
