// Тесты надгробий удалённых привычек (B.3).
//
// Проблема: mergeHabitsById аддитивен — привычка, удалённая на устройстве A,
// воскресает с сервера (ветка extra чужого снимка). removeHabit не оставлял
// следа. Решение: localStorage-ключ youplanner.tombstones — { habitId: ts }.
// Ветка extra не привозит привычку, чьё надгробие не старше метки раздела
// habits снимка (консервативно: равные метки — не привозить); метка раздела
// новее надгробия — чужая правка привычки победила, привычка возрождается.
// Надгробия синхронизируются новым необязательным разделом tombstones
// (слияние по max(ts) — надгробие никогда не «воскрешается»); в файловые
// бэкапы раздел не входит (версия формата не растёт).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCloudIntoLocal, mergeHabitsById, mergeTombstonesById, sectionTsOf,
} from '../js/sync/merge.js';
import { validCloudTombstones } from '../js/sync/validators.js';
import { TOMBSTONES_LIMIT } from '../js/data/habits.js';
import { loadApp } from './helpers/load-app.mjs';
import { habit } from './helpers/fixtures.mjs';

const LOCAL_TS = 1000;
const CLOUD_TS = 5000;
const DELETE_TS = 9000;

function baseLocal() {
  return {
    habits: [habit()],
    records: { '2026-10-20': { h2: true } },
    qaza: { version: 3, cursor: 3, remaining: { fajr: 2, zuhr: 2, asr: 2, maghrib: 2, isha: 2 }, history: [] },
    prayer: { lat: 40.5, lng: 50.5, madhhab: 'hanafi', method: 'astro' },
    fast: { version: 1, remaining: 2, history: [{ date: '2026-10-01', count: 1, source: 'done' }] },
    qazaLog: { version: 1, since: '2026-10-01', entries: [{ date: '2026-10-02', namaz: 'fajr', source: 'done' }] },
    sleep: {
      version: 4, bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00',
      sleepMin: 375, realWake: null, realSleepMin: null, excluded: false,
      history: [{ date: '2026-10-20', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375 }],
    },
    schedule: { weekday: [{ time: '07:00', text: 'Зарядка' }], weekend: [], fasting: [], physical: [] },
    archive: null,
  };
}

function baseCloud() {
  return {
    updatedAt: CLOUD_TS,
    sectionTs: {
      habits: CLOUD_TS, records: CLOUD_TS, qaza: CLOUD_TS, prayer: CLOUD_TS,
      fast: CLOUD_TS, qazaLog: CLOUD_TS, sleep: CLOUD_TS, schedule: CLOUD_TS,
    },
    habits: [habit()],
    records: { '2026-10-25': { h1: true } },
    qaza: { version: 3, cursor: 0, remaining: { fajr: 4, zuhr: 4, asr: 4, maghrib: 4, isha: 4 }, history: [] },
    prayer: { lat: 43.38085, lng: 45.83479, madhhab: 'shafi', method: 'dum-chr' },
    fast: { version: 1, remaining: 9, history: [] },
    qazaLog: { version: 1, since: '2026-10-05', entries: [{ date: '2026-10-06', namaz: 'isha', source: 'done' }] },
    sleep: {
      version: 4, bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00',
      sleepMin: 375, realWake: '05:30', realSleepMin: 345, excluded: false,
      history: [{ date: '2026-10-25', bed: '23:00', fall: 15, wake: '06:30', actualWake: '06:30', sleepMin: 435 }],
    },
    schedule: { weekday: [], weekend: [], fasting: [], physical: [] },
    archive: { version: 1, sleep: { months: {} }, fast: { months: {} }, qaza: { months: {} }, records: { months: {} } },
  };
}

function merge(local, cloud, opts) {
  return mergeCloudIntoLocal(local, cloud, Object.assign({ pending: false, localTs: LOCAL_TS }, opts));
}

// ── Валидатор: объект id → число, мусор отбрасывается ───────────────────────

test('validCloudTombstones: мусор отбрасывается, годные записи остаются', () => {
  assert.deepEqual(validCloudTombstones({
    a: 100, b: 'мусор', c: null, d: -5, e: NaN, '': 7, f: Infinity, g: 2,
  }), { a: 100, g: 2 });
});

test('validCloudTombstones: не-объект — раздела нет (null)', () => {
  assert.equal(validCloudTombstones(null), null);
  assert.equal(validCloudTombstones(undefined), null);
  assert.equal(validCloudTombstones([100, 200]), null);
  assert.equal(validCloudTombstones('мусор'), null);
  assert.deepEqual(validCloudTombstones({}), {});
});

test('validCloudTombstones: лишние записи сверх лимита отбрасываются', () => {
  const big = {};
  for (let i = 0; i < TOMBSTONES_LIMIT + 50; i++) big['h' + i] = i + 1;
  const clean = validCloudTombstones(big);
  assert.ok(clean, 'лимит не должен отвергать раздел целиком');
  assert.equal(Object.keys(clean).length, TOMBSTONES_LIMIT);
  // Порядок исходных ключей сохранён: вошли первые по порядку
  assert.equal(clean.h0, 1);
  assert.equal(clean['h' + (TOMBSTONES_LIMIT - 1)], TOMBSTONES_LIMIT);
  assert.equal(clean['h' + TOMBSTONES_LIMIT], undefined);
});

// ── Слияние надгробий: по max(ts), аддитивно ────────────────────────────────

test('mergeTombstonesById: на id берётся максимум, чужие дописываются', () => {
  assert.deepEqual(
    mergeTombstonesById({ h9: 100, hx: 200 }, { h9: 300, hy: 50 }),
    { h9: 300, hx: 200, hy: 50 }
  );
});

test('mergeTombstonesById: надгробие никогда не воскрешается и мусор не проходит', () => {
  // Локальное надгробие без пары на сервере остаётся
  assert.deepEqual(mergeTombstonesById({ h9: 100 }, {}), { h9: 100 });
  assert.deepEqual(mergeTombstonesById({}, { h9: 100 }), { h9: 100 });
  // Битые значения обеих сторон не проходят
  assert.deepEqual(
    mergeTombstonesById({ bad: 'мусор', ok: 5 }, { worse: null, also: NaN }),
    { ok: 5 }
  );
  assert.deepEqual(mergeTombstonesById(null, null), {});
  assert.deepEqual(mergeTombstonesById([1], 'мусор'), {});
});

// ── Ветка extra: надгробие против метки раздела habits ──────────────────────

test('mergeHabitsById: надгробие не старше метки раздела — привычка не привозится', () => {
  const opts = { tombstones: { h9: DELETE_TS }, sectionTs: DELETE_TS };
  assert.deepEqual(mergeHabitsById([], [habit({ id: 'h9' })], true, opts), [],
    'равные метки должны блокировать привоз (консервативно)');
  const older = { tombstones: { h9: DELETE_TS }, sectionTs: DELETE_TS - 1 };
  assert.deepEqual(mergeHabitsById([], [habit({ id: 'h9' })], true, older), []);
  // Присутствующая локально привычка надгробием не выбрасывается: ветка
  // extra её не касается, а совпадающий id живёт по правилам cloudWins
  const present = mergeHabitsById([habit({ id: 'h9', name: 'Локальная' })], [habit({ id: 'h9' })], true, opts);
  assert.deepEqual(present.map(function (h) { return h.id; }), ['h9'],
    'надгробие не должно удалять присутствующую привычку');
});

test('mergeHabitsById: метка раздела новее надгробия — привычка возрождается', () => {
  const opts = { tombstones: { h9: DELETE_TS }, sectionTs: DELETE_TS + 1 };
  assert.deepEqual(mergeHabitsById([], [habit({ id: 'h9' })], true, opts).map(function (h) { return h.id; }), ['h9']);
  // Без надгробий — прежнее поведение
  assert.deepEqual(mergeHabitsById([], [habit({ id: 'h9' })], true).map(function (h) { return h.id; }), ['h9']);
});

test('mergeCloudIntoLocal: удалил на устройстве A — привычка не возрождается из снимка', () => {
  const local = baseLocal();
  // A удалила h9: в списке её нет, надгробие написано
  local.tombstones = { h9: DELETE_TS };
  const cloud = baseCloud();
  // Сервер ещё видел только старую правку раздела habits
  cloud.sectionTs.habits = CLOUD_TS;
  cloud.habits = [habit(), habit({ id: 'h9' })];
  const merged = merge(local, cloud);
  assert.deepEqual(merged.habits.map(function (h) { return h.id; }), ['h1'],
    'удалённая привычка воскресла с сервера');
  assert.deepEqual(merged.tombstones, { h9: DELETE_TS });
});

test('mergeCloudIntoLocal: sectionTs новее надгробия — привычка возрождается', () => {
  const local = baseLocal();
  local.tombstones = { h9: DELETE_TS };
  const cloud = baseCloud();
  // Чужая правка раздела habits случилась ПОСЛЕ удаления: она победила
  cloud.sectionTs.habits = DELETE_TS + 1;
  cloud.habits = [habit(), habit({ id: 'h9' })];
  const merged = merge(local, cloud);
  assert.deepEqual(merged.habits.map(function (h) { return h.id; }), ['h1', 'h9']);
});

test('mergeCloudIntoLocal: надгробия сливаются по max(ts), снимок без раздела их не трогает', () => {
  const local = baseLocal();
  local.tombstones = { h9: DELETE_TS, hx: 100 };
  const cloud = baseCloud();
  cloud.tombstones = { h9: DELETE_TS - 500, hy: 4000 };
  const merged = merge(local, cloud);
  assert.deepEqual(merged.tombstones, { h9: DELETE_TS, hx: 100, hy: 4000 });

  // Старый снимок без раздела tombstones: надгробия локальные сохраняются,
  // слияние привычек работает как раньше
  const oldCloud = baseCloud();
  delete oldCloud.tombstones;
  const mergedOld = merge(local, oldCloud);
  assert.deepEqual(mergedOld.tombstones, { h9: DELETE_TS, hx: 100 });
  assert.deepEqual(mergedOld.habits.map(function (h) { return h.id; }), ['h1']);
  assert.equal(sectionTsOf(oldCloud, 'habits', CLOUD_TS), CLOUD_TS);
});

// ── Интеграция: removeHabit, PUT, приём снимка, бэкап ───────────────────────

// Сеет список из двух привычек и по записи у каждой
function seedTwoHabits(sandbox) {
  sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([
    habit({ id: 'h1' }), habit({ id: 'h2', name: 'Зухр' }),
  ]));
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify({
    '2026-10-20': { h1: true, h2: 3 },
    '2026-10-21': { h2: 1 },
  }));
}

test('removeHabit пишет надгробие, удаляет привычку и её записи', () => {
  const app = loadApp();
  seedTwoHabits(app.sandbox);

  assert.equal(app.context.removeHabit('h2'), true);

  assert.equal(JSON.parse(app.sandbox.localStorage.getItem('youplanner.habits')).length, 1,
    'привычка не удалена из списка');
  const tombstones = JSON.parse(app.sandbox.localStorage.getItem('youplanner.tombstones'));
  assert.equal(tombstones.h2, app.context.loadTombstones().h2);
  assert.ok(Number.isFinite(tombstones.h2) && tombstones.h2 > 0, 'надгробие без метки времени');
  const records = JSON.parse(app.sandbox.localStorage.getItem('youplanner.records'));
  assert.deepEqual(records['2026-10-20'], { h1: true }, 'записи удалённой привычки не вычищены');
  assert.equal(records['2026-10-21'], undefined, 'пустой день не удалён');
});

test('removeHabit при сбое записи откатывает список и снимает надгробие', () => {
  const app = loadApp();
  seedTwoHabits(app.sandbox);
  // Отказ на 2-м setItem: надгробие успевает записаться, список привычек — нет
  const original = app.sandbox.localStorage.setItem;
  let calls = 0;
  app.sandbox.localStorage.setItem = function (key, value) {
    calls += 1;
    if (calls === 2) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(key, value);
  };

  assert.equal(app.context.removeHabit('h2'), false);
  assert.deepEqual(JSON.parse(app.sandbox.localStorage.getItem('youplanner.habits')).map(function (h) { return h.id; }),
    ['h1', 'h2'], 'список привычек не восстановлен');
  assert.equal(app.sandbox.localStorage.getItem('youplanner.tombstones'), null,
    'надгробие осталось при несостоявшемся удалении');
});

test('syncBody несёт раздел tombstones и его метку в sectionTs', async () => {
  const calls = [];
  const fetchImpl = function (url, opts) {
    const options = opts || {};
    calls.push({ url: String(url), method: options.method || 'GET' });
    if ((options.method || 'GET') === 'GET' && String(url).includes('backups')) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve([]); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  };
  const app = loadApp({ fetchImpl: fetchImpl });
  seedTwoHabits(app.sandbox);
  app.sandbox.localStorage.setItem('youplanner.tombstones', JSON.stringify({ h9: 4321 }));

  await app.context.syncToCloudNow();

  const put = calls.find(function (c) {
    return c.method === 'PUT' && c.url.includes('firebaseio.com') && !c.url.includes('backups');
  });
  assert.ok(put, 'PUT не состоялся');
  // Тело пишется в момент вызова fetch, вытащить его можно из заглушки вызова
});

test('syncToCloudNow: тело PUT содержит tombstones и sectionTs.tombstones', async () => {
  let lastBody = null;
  const fetchImpl = function (url, opts) {
    const options = opts || {};
    if (options.method === 'PUT' && String(url).includes('firebaseio.com') && !String(url).includes('backups')) {
      lastBody = options.body;
    }
    if ((options.method || 'GET') === 'GET' && String(url).includes('backups')) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve([]); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  };
  const app = loadApp({ fetchImpl: fetchImpl });
  seedTwoHabits(app.sandbox);
  app.sandbox.localStorage.setItem('youplanner.tombstones', JSON.stringify({ h9: 4321 }));

  await app.context.syncToCloudNow();

  assert.ok(lastBody, 'PUT не состоялся');
  const body = JSON.parse(lastBody);
  assert.deepEqual(body.tombstones, { h9: 4321 }, 'надгробия не уехали в снимок');
  assert.ok(body.sectionTs && body.sectionTs.tombstones === body.updatedAt,
    'метка раздела tombstones не проставлена');
});

test('syncFromCloud: снимок с tombstones применяется, вернувшиеся привычки снимают надгробия', async () => {
  const snapshot = {
    updatedAt: CLOUD_TS + 6000,
    sectionTs: {
      habits: CLOUD_TS + 6000, records: CLOUD_TS + 6000, qaza: CLOUD_TS, prayer: CLOUD_TS,
      fast: CLOUD_TS, qazaLog: CLOUD_TS, sleep: CLOUD_TS, schedule: CLOUD_TS,
    },
    habits: [habit(), habit({ id: 'h9' })],
    tombstones: { h9: DELETE_TS },
  };
  const fetchImpl = function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(snapshot); } });
  };
  const app = loadApp({ fetchImpl: fetchImpl });
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([habit()]));
  app.sandbox.localStorage.setItem('youplanner.sync.ts', String(LOCAL_TS));
  app.sandbox.localStorage.setItem('youplanner.tombstones', JSON.stringify({ h9: DELETE_TS }));

  const result = await app.context.syncFromCloud();

  assert.equal(result.reachable, true);
  assert.deepEqual(
    JSON.parse(app.sandbox.localStorage.getItem('youplanner.habits')).map(function (h) { return h.id; }),
    ['h1', 'h9'],
    'снимок с меткой новее сверки не применён');
  // h9 вернулась в списке — надгробие больше не нужно (пустой набор
  // выражается отсутствием ключа)
  assert.equal(app.sandbox.localStorage.getItem('youplanner.tombstones'), null);
});

test('syncFromCloud: старый снимок без раздела tombstones применяется как раньше', async () => {
  const snapshot = {
    updatedAt: CLOUD_TS + 6000,
    sectionTs: {
      habits: CLOUD_TS + 6000, records: CLOUD_TS + 6000, qaza: CLOUD_TS, prayer: CLOUD_TS,
      fast: CLOUD_TS, qazaLog: CLOUD_TS, sleep: CLOUD_TS, schedule: CLOUD_TS,
    },
    habits: [habit()],
    records: { '2026-10-25': { h1: true } },
  };
  const fetchImpl = function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(snapshot); } });
  };
  const app = loadApp({ fetchImpl: fetchImpl });
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([habit({ id: 'h2' })]));
  app.sandbox.localStorage.setItem('youplanner.sync.ts', String(LOCAL_TS));

  const result = await app.context.syncFromCloud();

  assert.equal(result.reachable, true);
  assert.deepEqual(
    JSON.parse(app.sandbox.localStorage.getItem('youplanner.habits')).map(function (h) { return h.id; }),
    ['h1'], 'снимок без tombstones перестал применяться');
  assert.equal(app.sandbox.localStorage.getItem('youplanner.tombstones'), null,
    'пустой раздел tombstones записан старым снимком');
});

test('buildBackup не включает tombstones — версия формата файла не растёт', () => {
  const app = loadApp();
  seedTwoHabits(app.sandbox);
  app.sandbox.localStorage.setItem('youplanner.tombstones', JSON.stringify({ h2: 4321 }));

  const backup = app.context.buildBackup();

  assert.equal(backup.version, 11);
  assert.equal('tombstones' in backup, false,
    'надгробия попали в файловую копию — разбор старых версий сломается');
});
