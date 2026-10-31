// Тесты синхронизации: single-flight вокруг syncToCloud.
//
// Аудит 2026-10-23: флаг syncing защищал только синхронные участки, но не
// держался во время await fetch. Два параллельных обмена (debounce-таймер +
// уход со вкладки) konkурирующе делали GET→PUT узла бэкапов — терялись
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

  // Два обмена, и в каждом два чтения узла: первое — внутри бэкапа,
  // второе — повторная сверка непосредственно перед PUT (B.2).
  assert.equal(fetchImpl.stats.mainGets(), 4,
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
// каждый firebaseio-обмен обязан уйти с ?auth=, при недоступной аутентификации
// — как раньше, без auth-параметра. Ключ подставляется через
// context.setFirebaseApiKey(): верхнеуровневая function-объявление доступно
// как свойство контекста песочницы.

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
    calls.push({ url: String(url), method });
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

test('ключ задан: все firebaseio-обмены уходят с ?auth=, счётчики не меняются', async () => {
  const fetchImpl = makeAuthAwareFetch();
  const { context } = loadApp({ fetchImpl });
  context.setFirebaseApiKey('AIzatest');

  await context.syncToCloud();

  const firebaseCalls = fetchImpl.stats.calls.filter(function (c) {
    return c.url.indexOf('firebaseio.com') !== -1;
  });
  assert.ok(firebaseCalls.length > 0, 'firebaseio-вызовы не состоялись');
  for (const c of firebaseCalls) {
    assert.ok(
      c.url.includes('?auth=tok1') || c.url.includes('&auth=tok1'),
      'обмен без auth-параметра: ' + c.url);
  }
  // Фильтры счётчиков по подстроке firebaseio не должны заметить auth-серверы.
  // Чтений два: бэкап плюс повторная сверка перед PUT (B.2), оба с токеном.
  assert.equal(fetchImpl.stats.mainGets(), 2);
  assert.equal(fetchImpl.stats.mainPuts(), 1);
});

test('аутентификация недоступна: обмен идёт как раньше, без auth-параметра', async () => {
  const calls = [];
  const fetchImpl = function (url) {
    calls.push({ url: String(url) });
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
