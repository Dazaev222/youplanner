// Тесты синхронизации: single-flight вокруг syncToCloud.
//
// Аудит 2026-10-23: флаг syncing защищал только синхронные участки, но не
// держался во время await fetch. Два параллельных обмена (debounce-таймер +
// уход со вкладки) конкурирующе делали GET→PUT узла бэкапов — терялись
// записи истории, SYNC_TS мог уехать назад. Ожидание: обмены строго
// последовательны, правка во время обмена доезжает повторным обменом.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { habit } from './helpers/fixtures.mjs';

function makeFetch() {
  const calls = [];
  let active = 0;
  let maxActive = 0;

  function responseBody(url, method) {
    if (method === 'GET' && String(url).includes('backups')) return [];
    if (method === 'GET') return {};
    return {};
  }

  function fetchImpl(url, opts = {}) {
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: String(url), method });
    active += 1;
    if (active > maxActive) maxActive = active;
    return Promise.resolve().then(() => {
      active -= 1;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(responseBody(url, method)),
      };
    });
  }

  fetchImpl.stats = {
    calls,
    get maxActive() { return maxActive; },
    mainPuts: () => calls.filter(function (c) {
      return c.method === 'PUT' && c.url.includes('firebaseio.com') &&
        !c.url.includes('backups');
    }).length,
    mainGets: () => calls.filter(function (c) {
      return c.method === 'GET' && c.url.includes('firebaseio.com') &&
        !c.url.includes('backups');
    }).length,
  };
  return fetchImpl;
}

test('одиночная отправка делает один PUT и пишет метку времени', async () => {
  const fetchImpl = makeFetch();
  const { context, sandbox } = loadApp({ fetchImpl });
  await context.syncToCloud();
  assert.equal(fetchImpl.stats.mainPuts(), 1);
  assert.ok(sandbox.localStorage.getItem('youplanner.sync.ts'),
    'SYNC_TS не записан');
});

test('параллельные вызовы не перекрываются: обмены строго по одному', async () => {
  const fetchImpl = makeFetch();
  const { context } = loadApp({ fetchImpl });

  const first = context.syncToCloud();
  const second = context.syncToCloud();
  await Promise.all([first, second]);
  // очередь разбирается в микрозадачах; даём им доджойниться
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(fetchImpl.stats.maxActive, 1,
    'обмены с сервером выполнялись параллельно');
});

test('вызов во время обмена доезжает повторным обменом, а не теряется', async () => {
  const fetchImpl = makeFetch();
  const { context } = loadApp({ fetchImpl });

  const first = context.syncToCloud();
  context.syncToCloud(); // «правка» пришла, пока первый обмен в полёте
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Два обмена. Первый несёт бэкап с чтением узла данных; второй идёт после
  // успешной копии и пропускает бэкап по троттлингу (Г2) — чтений больше
  // нет, PUT уходит по текущему lastCloudEtag. Контрольный GET перед PUT
  // убран ещё в Г1: гонку B.2 закрывает условная запись (412).
  assert.equal(fetchImpl.stats.mainGets(), 1,
    'повторный обмен после очереди не состоялся');
  assert.equal(fetchImpl.stats.mainPuts(), 2);
});

test('выбор снимка: чистое правило timestamp и pending-правки', () => {
  const { context } = loadApp();

  assert.equal(context.serverSnapshotWins(200, 100, false), true);
  assert.equal(context.serverSnapshotWins(100, 200, false), false);
  assert.equal(context.serverSnapshotWins(200, 200, false), false);
  assert.equal(context.serverSnapshotWins(200, 100, true), false);
  assert.equal(context.serverSnapshotWins(0, 0, false), false);
  assert.equal(context.serverSnapshotWins('200', 100, false), true);
});

// ── Аутентификация (js/data/firebase-auth.js) ──────────────────────────────
// Токен добывается централизованно в fetchWithTimeout: при заданном ключе
// каждый firebaseio-обмен обязан уйти с заголовком Authorization: Bearer, при
// недоступной аутентификации — как раньше, без заголовка и без auth-параметра
// в URL (токен в URL попадает в логи серверов и историю браузера; аудиту
// секретов, задача 3.1, это обходится переводом на Bearer-заголовок). Ключ
// подставляется через context.setFirebaseApiKey(): верхнеуровневая
// function-объявление доступно как свойство контекста песочницы.

function makeAuthAwareFetch() {
  const calls = [];

  function responseBody(url, method) {
    if (String(url).indexOf('identitytoolkit') !== -1) {
      return { idToken: 'tok1', refreshToken: 'r1', expiresIn: '3600' };
    }
    if (method === 'GET' && String(url).includes('backups')) return [];
    if (method === 'GET') return {};
    return {};
  }

  function fetchImpl(url, opts = {}) {
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: String(url), method, headers: (opts && opts.headers) || {} });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(responseBody(url, method)),
    });
  }

  fetchImpl.stats = {
    calls,
    mainPuts: () => calls.filter(function (c) {
      return c.method === 'PUT' && c.url.includes('firebaseio.com') &&
        !c.url.includes('backups');
    }).length,
    mainGets: () => calls.filter(function (c) {
      return c.method === 'GET' && c.url.includes('firebaseio.com') &&
        !c.url.includes('backups');
    }).length,
  };
  return fetchImpl;
}

test('ключ задан: все firebaseio-обмены уходят с ?auth=, Bearer-заголовка нет', async () => {
  const fetchImpl = makeAuthAwareFetch();
  const { context } = loadApp({ fetchImpl });
  context.setFirebaseApiKey('AIzatest');

  await context.syncToCloud();

  const firebaseCalls = fetchImpl.stats.calls.filter(function (c) {
    return c.url.indexOf('firebaseio.com') !== -1;
  });
  assert.ok(firebaseCalls.length > 0, 'firebaseio-вызовы не состоялись');
  for (const c of firebaseCalls) {
    // RTDB REST признаёт Firebase ID-токен только параметром ?auth=:
    // Authorization: Bearer он отвечает 401 «Unauthorized request.» при
    // любой свежести токена (живая проверка 2026-11-07). Компромисс —
    // токен в URL оседает в логах; компенсация — App Check («Предложено»).
    const auth = (c.url.match(/[?&]auth=([^&]+)/) || [])[1];
    assert.equal(decodeURIComponent(auth || ''), 'tok1',
      'обмен без ?auth= токена: ' + c.url);
    assert.ok(!c.headers['Authorization'],
      'заголовок Authorization вернулся (RTDB его отвергает): ' + c.url);
  }
  // Фильтры счётчиков по подстроке firebaseio не должны заметить auth-серверы.
  // Чтение одно — бэкап: контрольный GET перед PUT убран (Г1), гонку B.2
  // закрывает условная запись (412).
  assert.equal(fetchImpl.stats.mainGets(), 1);
  assert.equal(fetchImpl.stats.mainPuts(), 1);
});

test('аутентификация недоступна: обмен идёт как раньше, без auth-параметра', async () => {
  const calls = [];
  const fetchImpl = function (url, opts = {}) {
    calls.push({ url: String(url), headers: (opts && opts.headers) || {} });
    return Promise.reject(new Error('нет сети'));
  };
  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey('AIzatest');

  await context.syncToCloud();

  const firebaseCalls = calls.filter(function (c) {
    return c.url.indexOf('firebaseio.com') !== -1;
  });
  assert.ok(firebaseCalls.length > 0, 'обмены не предпринимались вовсе');
  for (const c of firebaseCalls) {
    assert.ok(!c.url.includes('auth='),
      'graceful-деградация сломана, auth попал в URL: ' + c.url);
    assert.ok(!c.headers['Authorization'],
      'graceful-деградация сломана, Bearer-заголовок пустого токена ушёл в запрос: ' + c.url);
  }
  // signUp предпринят один раз: пауза аутентификации держит остальные обмены
  const authCalls = calls.filter(function (c) {
    return c.url.indexOf('googleapis.com') !== -1;
  });
  assert.equal(authCalls.length, 1,
    'офлайн-аутентификация дёргает сеть на каждый обмен');
  // PUT не прошёл — метка времени не записана, как и раньше при отказе сети
  assert.equal(sandbox.localStorage.getItem('youplanner.sync.ts'), null);
});

// ── «Всё или ничего» при квоте хранилища (applyCloudData) ───────────────────
// Аудит 2026-10-31: QuotaExceededError посреди применения раньше оставлял
// половину разделов — данные пользователя смешивались с серверными.
// Инъекция: k-й setItem песочницы бросает ошибку. Объект ошибки создаётся
// в реалме теста — applyCloudData ловит любую ошибку записи (не только
// по name), поэтому реалм не важен. Патчится сам sandbox.localStorage —
// тот же объект, чей Map-стаб читает _dump(), поэтому успешные записи
// через оригинальный setItem остаются видимыми.

// Снимок с сервера: все разделы валидны и непусты — каждый проходит
// валидатор и условие hasData, так что stage собирается целиком
function cloudSnapshot() {
  return {
    updatedAt: 1000,
    habits: [habit()],
    records: { '2026-10-25': { h1: true } },
    qaza: {
      version: 3,
      cursor: 0,
      remaining: { fajr: 4, zuhr: 4, asr: 4, maghrib: 4, isha: 4 },
      history: [],
    },
    prayer: { lat: 43.38085, lng: 45.83479, madhhab: 'shafi', method: 'dum-chr' },
    fast: { version: 1, remaining: 9, history: [] },
    qazaLog: { version: 1, since: '2026-10-05', entries: [] },
    sleep: {
      version: 4,
      bed: '23:30',
      fall: 15,
      wake: '06:00',
      actualWake: '06:00',
      sleepMin: 375,
      realWake: '05:30',
      realSleepMin: 345,
      excluded: false,
      history: [],
    },
    schedule: { weekday: [], weekend: [], fasting: [], physical: [] },
  };
}

// Сеем прежние данные устройства: значения отличаются от снимка, поэтому
// побитовое сравнение _dump ловит и полуприменённый снимок, и потерю ключей.
// Все загрузчики с такими данными только читают — записи при чтении нет.
function seedDeviceStorage(sandbox) {
  const seed = {
    'youplanner.habits': [{ id: 'h2', name: 'Чтение Корана', type: 'boolean', unit: '', goal: null }],
    'youplanner.records': { '2026-10-20': { h2: true } },
    'youplanner.qaza': {
      version: 3,
      cursor: 3,
      remaining: { fajr: 2, zuhr: 2, asr: 2, maghrib: 2, isha: 2 },
      history: [],
    },
    'youplanner.prayer': { lat: 40.5, lng: 50.5, madhhab: 'hanafi', method: 'astro' },
    'youplanner.qaza.fast': { version: 1, remaining: 2, history: [] },
    'youplanner.qaza.log': { version: 1, since: '2026-10-01', entries: [] },
    'youplanner.sleep': {
      version: 4,
      bed: '23:30',
      fall: 15,
      wake: '06:00',
      actualWake: '06:00',
      sleepMin: 375,
      realWake: '06:00',
      realSleepMin: 375,
      excluded: false,
      history: [],
    },
    'youplanner.schedule': {
      weekday: [{ time: '07:00', text: 'Зарядка' }],
      weekend: [],
      fasting: [],
      physical: [],
    },
  };
  const keys = Object.keys(seed);
  for (let i = 0; i < keys.length; i++) {
    sandbox.localStorage.setItem(keys[i], JSON.stringify(seed[keys[i]]));
  }
}

// Обёртка setItem: k-й вызов бросает QuotaExceededError, остальные
// уходят в оригинальный Map-стаб
function failOnNthSetItem(storage, n) {
  const original = storage.setItem;
  const state = { calls: 0 };
  storage.setItem = function (key, value) {
    state.calls += 1;
    if (state.calls === n) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(key, value);
  };
  return state;
}

test('квота посреди применения снимка: откат всех ключей, без метки и sync:applied', () => {
  const app = loadApp();
  seedDeviceStorage(app.sandbox);
  const before = app.sandbox.localStorage._dump();
  // Отказ на 2-м setItem: habits успевает записаться, records — нет
  const patch = failOnNthSetItem(app.sandbox.localStorage, 2);
  app.run(`
    globalThis.__applied = 0;
    globalThis.__storageError = 0;
    bus.on('sync:applied', () => { globalThis.__applied++; });
    bus.on('storage:error', () => { globalThis.__storageError++; });
  `);

  const result = app.context.applyCloudData(cloudSnapshot(), 1000);

  assert.equal(result, false, 'отвергнутый снимок должен вернуть false');
  assert.ok(patch.calls >= 2, 'инъекция не сработала — откат не проверяется');
  assert.deepEqual(app.sandbox.localStorage._dump(), before,
    'после отката не все ключи равны прежним побитово');
  assert.equal(app.sandbox.localStorage.getItem('youplanner.sync.ts'), null,
    'SYNC_TS записан на отвергнутом снимке');
  assert.equal(app.run('globalThis.__applied'), 0,
    'sync:applied эмитился на отвергнутом снимке');
  assert.equal(app.run('globalThis.__storageError'), 1,
    'о квоте не сообщено через storage:error');
});

test('syncFromCloud при отвергнутом снимке: сервер помечен недоступным, данные не тронуты', async () => {
  const snapshot = cloudSnapshot();
  const fetchImpl = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(snapshot),
  });
  const app = loadApp({ fetchImpl });
  seedDeviceStorage(app.sandbox);
  const before = app.sandbox.localStorage._dump();
  failOnNthSetItem(app.sandbox.localStorage, 2);
  app.run("globalThis.__applied = 0;");
  app.run("bus.on('sync:applied', () => { globalThis.__applied++; })");

  const result = await app.context.syncFromCloud();

  // reachable:true + cloudReachable:false вместе возможны только в новой
  // ветке потребителя: сетевая ошибка дала бы reachable:false
  assert.equal(result.reachable, true);
  assert.equal(result.serverEmpty, false);
  assert.equal(app.run('cloudReachable'), false,
    'отвергнутый снимок должен помечать обмен несостоявшимся');
  assert.deepEqual(app.sandbox.localStorage._dump(), before,
    'после отката не все ключи равны прежним побитово');
  assert.equal(app.run('globalThis.__applied'), 0,
    'sync:applied эмитился на отвергнутом снимке');
});

// database.rules.json привязан к auth.uid владельца. Пока устройство не вошло
// в постоянный аккаунт (или сессия потеряна), сервер отвечает 401/403
// PERMISSION_DENIED — а для интерфейса это неотличимо от «нет сети»: человек
// видел бы «нет связи» вечно и искал бы её там, где её нет.
// fetchWithTimeout — единственная обёртка всех запросов данных, поэтому
// событие снимает недоумение с любого из них: и GET, и PUT, и бэкапы.
test('сервер ответил 403: событие sync:denied со статусом', async () => {
  const fetchImpl = () => Promise.resolve({
    ok: false, status: 403,
    json: () => Promise.resolve({ error: 'PERMISSION_DENIED' }),
  });
  const app = loadApp({ fetchImpl });
  app.run("globalThis.__denied = [];");
  app.run("bus.on('sync:denied', (p) => { globalThis.__denied.push(p && p.status); })");

  await app.context.syncFromCloud();
  // Array.from: массив создан в vm-контексте, и deepStrictEqual сверял бы
  // прототипы двух realm'ов
  assert.deepEqual(Array.from(app.run('globalThis.__denied')), [403],
    'отказ по правам не отличим от сетевой ошибки — подписчик не уведомлён');
  assert.equal(app.run('deniedStatus'), 403,
    'deniedStatus не выставлен: интерфейс не отличит 403 от «нет связи»');

  app.run('globalThis.__denied = []');
  await app.context.syncToCloud();
  assert.ok(app.run('globalThis.__denied').length >= 1,
    'PUT под правилами тоже обязан сообщать о отказе по правам');
});

// Успешный обмен обязан снимать отказ: залипший deniedStatus заставил бы
// интерфейс вечно советовать «войдите в аккаунт владельца» там, где всё
// уже работает.
test('после успешного обмена отказ по правам снимается', async () => {
  let response = { ok: false, status: 403, json: () => Promise.resolve({}) };
  const app = loadApp({ fetchImpl: () => Promise.resolve(response) });
  await app.context.syncFromCloud();
  assert.equal(app.run('deniedStatus'), 403);

  response = { ok: true, status: 200, json: () => Promise.resolve(null) };
  await app.context.syncFromCloud();
  assert.equal(app.run('deniedStatus'), 0, 'успех не снял прежний отказ');
});

// 401 (токен не подписан этим проектом / просрочен) — то же «нас не пускают».
// 500 и сетевой сбой — нет: совет «проверьте вход» при них вводил бы в
// заблуждение. syncFromCloud при этих статусах уже ведёт себя как при ошибке
// сети, поэтому считается только число событий.
async function countDenied(response) {
  const failing = response instanceof Error;
  const app = loadApp({
    fetchImpl: () => (failing ? Promise.reject(response) : Promise.resolve(response)),
  });
  app.run("globalThis.__denied = 0;");
  app.run("bus.on('sync:denied', () => { globalThis.__denied++; })");
  await app.context.syncFromCloud();
  return app.run('globalThis.__denied');
}

test('401 — тоже отказ по правам; 500 и сетевой сбой — нет', async () => {
  assert.equal(await countDenied({ ok: false, status: 401, json: () => Promise.resolve({}) }), 1,
    '401 не признан отказом по правам');
  assert.equal(await countDenied({ ok: false, status: 500, json: () => Promise.resolve({}) }), 0,
    '500 — сбой сервера, а не отказ по правам: «проверьте вход» здесь обманет');
  assert.equal(await countDenied(new Error('нет сети')), 0,
    'сетевой сбой притворяется отказом по правам');
});

// ── Квота на запись метки времени после успешного PUT ───────────────────────
// syncExchange писал SYNC_TS_KEY сырым localStorage.setItem внутри того же
// try, чей catch считает ЛЮБОЙ бросок «сетью отвалилась»: отказ квоты именно
// на метке задним числом превращал успешную отправку в мнимый сетевой сбой
// (cloudReachable=false, вызывающий видел undefined при ушедших данных).
// Весь проект пишет через safeSetItem именно чтобы квота не бросала.

test('квота на SYNC_TS_KEY не превращает успешный PUT в сетевой сбой', async () => {
  const fetchImpl = makeAuthAwareFetch();
  const app = loadApp({ fetchImpl });

  // Флаг доступности поднимает только успешная сверка: ниже проверяем, что
  // обмен его НЕ уронит — при баге catch на записи метки ронял флаг задним
  // числом, и данные считались «не отправленными» при ушедшем PUT.
  await app.context.syncFromCloud();
  assert.equal(app.run('cloudReachable'), true, 'успешная сверка: сервер доступен');

  const original = app.sandbox.localStorage.setItem;
  let tsWriteAttempts = 0;
  app.sandbox.localStorage.setItem = function (key, value) {
    if (key === 'youplanner.sync.ts') {
      tsWriteAttempts += 1;
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(key, value);
  };

  const response = await app.context.syncToCloud();

  assert.ok(tsWriteAttempts >= 1, 'инъекция не сработала — тест ничего не проверяет');
  assert.ok(response && response.ok === true,
    'успешный ответ сервера доходит до вызывающего, а не глотается catch');
  assert.equal(app.run('cloudReachable'), true,
    'сервер остаётся доступным: сетевого сбоя не было');
});

// ── plannerV1 в выделенном корне (защита от затирания старым клиентом) ──────
// Клиент на кэше ниже v43 ключа plannerV1 не знает, и его корневой PUT стирал
// Матрицу на сервере (status.md, заходит 2026-11-05). planner-состояние живёт
// СОСЕДНИМ корнем FIREBASE_PLANNER_URL по образцу FIREBASE_BACKUPS_URL
// (js/sync/core.js): PUT корневого узла заменяет только его, соседние корни
// не трогает, а старый клиент их не адресует вовсе. Оба URL берутся из
// исходника (app.run), а не пересказываются руками: тест обязан проверять
// контракт кода, а не мои ожидания.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNC_TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Модель RTDB: три соседних корня — рабочий узел, выделенный узел planner и
// бэкапы. PUT заменяет узел целиком (на этом держится вся защита), GET
// отдаёт ETag. state.planner моделирует выделенный узел, state.main — корень.
function makePlannerServer() {
  const state = {
    main: {},
    planner: null,
    etagSeq: 0,
    calls: [],
  };
  function nextEtag() {
    state.etagSeq += 1;
    return 'etag-' + state.etagSeq;
  }
  function respond(url, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    const u = String(url);
    state.calls.push({ url: u, method, headers: options.headers || {}, body: options.body });
    if (u.includes('backups')) {
      if (method === 'GET') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    const node = u.includes('-planner') ? 'planner' : 'main';
    if (method === 'GET') {
      const value = state[node];
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name) => String(name).toLowerCase() === 'etag' ? nextEtag() : null },
        json: () => Promise.resolve(value),
      });
    }
    // PUT заменяет узел целиком — как настоящий RTDB
    state[node] = JSON.parse(options.body);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(state[node]) });
  }
  respond.state = state;
  respond.putsToPlanner = () => state.calls.filter((c) => c.method === 'PUT' && c.url.includes('-planner'));
  respond.rootPutBodies = () => state.calls
    .filter((c) => c.method === 'PUT' && c.url.includes('firebaseio.com') &&
      !c.url.includes('backups') && !c.url.includes('-planner'))
    .map((c) => JSON.parse(c.body));
  return respond;
}

// Снимок plannerV1 и запись с Lamport-версией — форма из контракта §1.3,
// которую normalizePlannerV1 принимает (см. tests/planner-sync.test.mjs)
function plannerEntry(id, title, counter, actor) {
  return {
    id: id,
    fields: { title: { value: title, version: { counter: counter, actorId: actor } } },
  };
}

function plannerSnapshot(entries) {
  return { schemaVersion: 1, entries: entries || {}, settings: {}, tombstones: {} };
}

test('старомодный корневой PUT без planner-узла не трогает данные planner на выделенном пути', async () => {
  const server = makePlannerServer();
  const legacyPlanner = plannerSnapshot({ t1: plannerEntry('t1', 'Сервер', 4, 'devA') });
  server.state.planner = legacyPlanner;
  server.state.main = { habits: [], updatedAt: 5 };
  const app = loadApp({ fetchImpl: server });

  const FIREBASE_URL = app.run('FIREBASE_URL');
  const FIREBASE_PLANNER_URL = app.run('FIREBASE_PLANNER_URL');
  assert.ok(FIREBASE_PLANNER_URL, 'выделенный узел planner не объявлен в js/sync/core.js');
  assert.ok(!FIREBASE_PLANNER_URL.startsWith(FIREBASE_URL + '/'),
    'planner-узел вложен в корневой: старомодный PUT сотрёт его, как /backups раньше');

  // Старомодный клиент: PUT корневого узла целиком, ключа plannerV1 в теле нет
  const response = await server(FIREBASE_URL + '.json', {
    method: 'PUT',
    body: JSON.stringify({ habits: [], updatedAt: 6 }),
  });
  assert.ok(response.ok, 'корневой PUT старомодного клиента не прошёл');
  assert.deepEqual(server.state.planner, legacyPlanner,
    'корневой PUT без planner-узла стёр выделенный узел planner');
});

test('публикация нового клиента пишет planner в выделенный узел, корневой PUT без plannerV1', async () => {
  const server = makePlannerServer();
  const app = loadApp({ fetchImpl: server });
  app.sandbox.localStorage.setItem('youplanner.fb.owner', JSON.stringify({ email: 'o@e', uid: 'uid-A' }));
  app.sandbox.localStorage.setItem('youplanner.sync.ts', '1');
  assert.equal(app.context.saveTasks([{ id: 'tA', title: 'Задача A' }]), true);

  await app.context.syncToCloudNow();

  // planner уехал выделенным PUT, а не корневым
  const plannerPuts = server.putsToPlanner();
  assert.equal(plannerPuts.length, 1,
    'ожидается ровно один PUT в выделенный узел planner: ' + plannerPuts.length);
  const plannerBody = JSON.parse(plannerPuts[0].body);
  assert.ok(plannerBody.entries && plannerBody.entries.tA,
    'задачи нет в выделенном узле planner');
  assert.equal(plannerBody.schemaVersion, 1);
  assert.ok(plannerPuts[0].headers['If-Match'],
    'PUT planner без If-Match: ETag узла был прочитан GET-ом этого же обмена');

  // корневой PUT больше не несёт plannerV1 — этим ключом старый клиент стирал Матрицу
  const rootBodies = server.rootPutBodies();
  assert.ok(rootBodies.length >= 1, 'корневой PUT не состоялся');
  for (const body of rootBodies) {
    assert.equal(body.plannerV1, undefined, 'plannerV1 уехал корневым PUT');
    assert.equal(body.sectionTs && body.sectionTs.plannerV1, undefined,
      'метка свежести plannerV1 осталась в корневом снимке');
  }
  assert.equal(server.state.main.plannerV1, undefined,
    'в корневом узле сервера появился plannerV1');

  // подтверждение операций — после успешного PUT выделенного узла
  const env = JSON.parse(app.sandbox.localStorage.getItem('youplanner.planner.v1'));
  assert.equal(env.outbox.length, 0, 'outbox не подтверждён после публикации');
});

test('миграция: legacy plannerV1 из корневого узла копируется в выделенный при первой загрузке', async () => {
  const legacy = plannerSnapshot({ t1: plannerEntry('t1', 'Из legacy', 3, 'devA') });
  const server = makePlannerServer();
  server.state.main = {
    updatedAt: 1000,
    habits: [{ id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null }],
    plannerV1: legacy,
  };
  server.state.planner = null; // выделенный узел ещё пуст — данные только в legacy
  const app = loadApp({ fetchImpl: server });
  app.sandbox.localStorage.setItem('youplanner.sync.ts', '1');

  await app.context.syncFromCloud();

  const plannerPuts = server.putsToPlanner();
  assert.equal(plannerPuts.length, 1,
    'legacy-снимок не скопирован в выделенный узел: ' + plannerPuts.length);
  const copied = JSON.parse(plannerPuts[0].body);
  assert.ok(copied.entries && copied.entries.t1, 'в выделенный узел скопировано не то');
  const env = JSON.parse(app.sandbox.localStorage.getItem('youplanner.planner.v1'));
  assert.ok(env && env.snapshot.entries.t1, 'legacy-запись не слилась в локальный envelope');

  // Повторяемость миграции: выделенный узел уже непуст — вторая сверка
  // не перезаписывает его
  const plannerPutsBefore = server.putsToPlanner().length;
  await app.context.syncFromCloud();
  assert.equal(server.putsToPlanner().length - plannerPutsBefore, 0,
    'миграция перезаписала непустой выделенный узел');
});

// ── LWW-конверты цельных разделов qaza/prayer/fast/schedule (P1-3) ──────────
// Одновременная правка одного раздела с двух устройств теряла данные:
// cloudSnapshotWins решает по метке ВСЕГО снимка, и снимок, опубликованный
// позже, переписывал разделы целиком — даже записанный на приёмнике позже
// чужой правки. Разделы ходят в конвертах {v, ts}: ts — часы отправителя на
// момент записи раздела; на приёмнике побеждает больший ts, при равенстве —
// локальная версия; раздел без конверта (старый клиент) — ts=0.

const QAZA_KEY = 'youplanner.qaza';

function qazaPayload(cursor) {
  return {
    version: 3,
    cursor: cursor,
    remaining: { fajr: 4, zuhr: 4, asr: 4, maghrib: 4, isha: 4 },
    history: [],
  };
}

function sectionWriteTsKey(app) {
  const key = app.run('SECTION_WRITE_TS_KEY');
  assert.ok(key, 'ключ карты меток записи не объявлен в js/data/storage.js');
  return key;
}

function seedSectionWrites(app, map) {
  app.sandbox.localStorage.setItem(sectionWriteTsKey(app), JSON.stringify(map));
}

function readSectionWrites(app) {
  const raw = app.sandbox.localStorage.getItem(sectionWriteTsKey(app));
  return raw ? JSON.parse(raw) : {};
}

// Устройство A: раздел записан в момент 100 (карта меток — контракт
// хранилища, её читают публикация и приём), затем снимок публикуется.
async function publishedSnapshotFromA() {
  const server = makePlannerServer();
  const appA = loadApp({ fetchImpl: server });
  appA.sandbox.localStorage.setItem(QAZA_KEY, JSON.stringify(qazaPayload(0)));
  seedSectionWrites(appA, { qaza: 100 });
  await appA.context.syncToCloudNow();
  const bodies = server.rootPutBodies();
  assert.ok(bodies.length >= 1, 'устройство A не опубликовало снимок');
  return bodies[0];
}

test('публикация несёт цельные разделы в конвертах {v, ts} с меткой записи раздела', async () => {
  const snapshot = await publishedSnapshotFromA();

  assert.ok(snapshot.qaza && typeof snapshot.qaza === 'object', 'раздела qaza нет в снимке');
  assert.deepEqual(snapshot.qaza.v, qazaPayload(0), 'в конверте не полезные данные раздела');
  assert.equal(snapshot.qaza.ts, 100, 'метка конверта — не время записи раздела');
  // Разделы без метки записи уходят по-прежнему голыми: выдумывать им время
  // публикации нельзя — оно омолаживало бы раздел на каждом PUT'е
  assert.ok(!snapshot.fast || snapshot.fast.v === undefined,
    'fast без метки записи ушёл конвертом');
});

test('снимок со СТАРЫМ конвертом не затирает свежую локальную правку (A: ts=100, B: ts=200 → B)', async () => {
  const snapshotA = await publishedSnapshotFromA();

  const server = makePlannerServer();
  server.state.main = snapshotA;
  const appB = loadApp({ fetchImpl: server });
  appB.sandbox.localStorage.setItem(QAZA_KEY, JSON.stringify(qazaPayload(3)));
  seedSectionWrites(appB, { qaza: 200 });

  const result = await appB.context.syncFromCloud();
  assert.equal(result.reachable, true, 'сверка не состоялась — тест ничего не проверяет');
  assert.deepEqual(JSON.parse(appB.sandbox.localStorage.getItem(QAZA_KEY)), qazaPayload(3),
    'снимок с конвертом ts=100 затёр локальную правку ts=200');
  assert.equal(readSectionWrites(appB).qaza, 200, 'метка локальной записи сдвинулась');
});

test('СВЕЖИЙ конверт побеждает локальную правку и переносит метку в локальную карту', async () => {
  const snapshotA = await publishedSnapshotFromA();
  // A записал раздел ещё раз (ts=300) — конверт свежее локальной правки B
  const snapshotA2 = Object.assign({}, snapshotA, {
    qaza: { v: qazaPayload(1), ts: 300 },
  });

  const server = makePlannerServer();
  server.state.main = snapshotA2;
  const appB = loadApp({ fetchImpl: server });
  appB.sandbox.localStorage.setItem(QAZA_KEY, JSON.stringify(qazaPayload(3)));
  seedSectionWrites(appB, { qaza: 200 });

  await appB.context.syncFromCloud();

  assert.deepEqual(JSON.parse(appB.sandbox.localStorage.getItem(QAZA_KEY)), qazaPayload(1),
    'свежий конверт не применился');
  assert.equal(readSectionWrites(appB).qaza, 300,
    'метка применённого конверта не перенесена в локальную карту');
  // Полезные данные в хранилище остаются голыми: ключ читают напрямую
  // ассистент и файловые бэкапы, формы разделов они не знают
});

test('legacy-раздел из снимка (старый клиент) не затирает локальный конверт', async () => {
  const snapshot = { updatedAt: 5000, qaza: qazaPayload(0) }; // без конверта
  const server = makePlannerServer();
  server.state.main = snapshot;
  const appB = loadApp({ fetchImpl: server });
  appB.sandbox.localStorage.setItem(QAZA_KEY, JSON.stringify(qazaPayload(3)));
  seedSectionWrites(appB, { qaza: 200 });

  await appB.context.syncFromCloud();

  assert.deepEqual(JSON.parse(appB.sandbox.localStorage.getItem(QAZA_KEY)), qazaPayload(3),
    'голый раздел старого клиента затёр локальный конверт');
  assert.equal(readSectionWrites(appB).qaza, 200);
});

test('конверт принимается устройством с legacy-данными: новый формат побеждает при первом обмене', async () => {
  const snapshot = { updatedAt: 5000, qaza: { v: qazaPayload(2), ts: 300 } };
  const server = makePlannerServer();
  server.state.main = snapshot;
  const appB = loadApp({ fetchImpl: server });
  // Локальные данные писаны прежней версией: голый раздел, метки записи нет
  appB.sandbox.localStorage.setItem(QAZA_KEY, JSON.stringify(qazaPayload(3)));

  await appB.context.syncFromCloud();

  assert.deepEqual(JSON.parse(appB.sandbox.localStorage.getItem(QAZA_KEY)), qazaPayload(2),
    'конверт не принят устройством с legacy-данными');
  assert.equal(readSectionWrites(appB).qaza, 300, 'метка конверта не записана');
});

test('оба раздела legacy (без конвертов) — прежнее поведение: снимок применяется как раньше', async () => {
  const snapshot = { updatedAt: 5000, qaza: qazaPayload(2) };
  const server = makePlannerServer();
  server.state.main = snapshot;
  const appB = loadApp({ fetchImpl: server });
  appB.sandbox.localStorage.setItem(QAZA_KEY, JSON.stringify(qazaPayload(3)));

  await appB.context.syncFromCloud();

  assert.deepEqual(JSON.parse(appB.sandbox.localStorage.getItem(QAZA_KEY)), qazaPayload(2),
    'legacy-снимок перестал применяться к legacy-устройству');
});

test('метку записи ставит правка пользователя (saveQaza), а не нормализация при чтении', () => {
  const app = loadApp();
  app.run('Date.now = function () { return 555; };');
  assert.equal(app.context.saveQaza(qazaPayload(0)), true);
  assert.equal(readSectionWrites(app).qaza, 555, 'правка раздела не поставила метку записи');

  app.run('Date.now = function () { return 777; };');
  app.context.loadQaza(); // чтение переписывает нормализованное состояние
  assert.equal(readSectionWrites(app).qaza, 555,
    'нормализующая запись при чтении омолаживала бы раздел на каждом обмене');
});

test('гонка обмена: конверт из чужого снимка свежее локальной записи — применяется, метка переносится', async () => {
  const previous = {
    updatedAt: 5000,
    qaza: { v: qazaPayload(2), ts: 300 },
    sectionTs: { qaza: 5000 },
  };
  const server = makePlannerServer();
  server.state.main = previous; // GET внутри обмена вернёт чужой снимок
  const app = loadApp({ fetchImpl: server });
  app.sandbox.localStorage.setItem(QAZA_KEY, JSON.stringify(qazaPayload(3)));
  seedSectionWrites(app, { qaza: 200 });
  app.sandbox.localStorage.setItem('youplanner.sync.ts', '1000');

  await app.context.syncToCloudNow();

  assert.deepEqual(JSON.parse(app.sandbox.localStorage.getItem(QAZA_KEY)), qazaPayload(2),
    'слияние перед PUT не применило свежий конверт');
  assert.equal(readSectionWrites(app).qaza, 300,
    'метка конверта не перенесена в локальную карту при слиянии');
});

test('правила: выделенный узел planner объявлен, валиден по JSON и закрыт на владельца', () => {
  // Публикация правил — ручной шаг владельца; здесь проверяется только
  // проект файлов (см. tests/firebase-rules.test.mjs)
  const publicRules = JSON.parse(
    readFileSync(join(SYNC_TEST_ROOT, 'database.rules.json'), 'utf8')).rules;
  const localRules = JSON.parse(
    readFileSync(join(SYNC_TEST_ROOT, 'database.rules.local.json'), 'utf8')).rules;

  // Имя узла — из исходника core.js, а не пересказано руками
  const coreSource = readFileSync(join(SYNC_TEST_ROOT, 'js/sync/core.js'), 'utf8');
  const urlMatch = coreSource.match(/const FIREBASE_PLANNER_URL = '([^']+)'/);
  assert.ok(urlMatch, 'в js/sync/core.js нет константы FIREBASE_PLANNER_URL');
  const plannerNode = urlMatch[1].slice(urlMatch[1].indexOf('.com/') + '.com/'.length).split('/')[0];
  assert.ok(plannerNode, 'FIREBASE_PLANNER_URL обязан указывать на именованный узел');

  for (const [name, tree] of [['database.rules.json', publicRules], ['database.rules.local.json', localRules]]) {
    const node = tree[plannerNode];
    assert.ok(node, name + ': нет правил для выделенного узла «' + plannerNode + '»');
    // запись только владельцу — тот же пин, что у рабочих узлов
    assert.match(String(node['.write']), /auth\s*!=\s*null/,
      name + ': .write выделенного узла без явной проверки сессии');
    assert.match(String(node['.write']), /auth\.uid\s*==/,
      name + ': .write выделенного узла не привязан к uid владельца');
    assert.equal(String(node['.read']), String(node['.write']),
      name + ': условия read/write выделенного узла расходятся');
    // защитный валидатор схемы — как у прежнего plannerV1 в корневом узле
    assert.match(String(node['.validate']), /schemaVersion/,
      name + ': на выделенном узле нет валидатора схемы');
  }

  // Корень базы по-прежнему deny-by-default (PUT-null по корню — отказ)
  assert.equal(publicRules['.read'], false);
  assert.equal(publicRules['.write'], false);
});
