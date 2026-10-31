// Тесты слияния снимков (js/sync/merge.js) — гонка бэкапов двух устройств,
// аудит 2026-10-31.
//
// Контракт: mergeCloudIntoLocal возвращает слитый снимок или null (сервер
// не новее последней сверки — сливать нечего). Коллекции с ключами (привычки
// по id, записи по дате, дни сна, тройки журнала каза) сливаются аддитивно;
// цельные разделы (qaza/prayer/fast/schedule, скаляры сна) применяются
// с сервера только при метке раздела строго новее локальной сверки и только
// без pending. При pending слияние консервативно: только «заполнение дыр».
// Интеграционная часть проверяет syncToCloudNow: перед PUT снимок сервера
// сливается и применяется локально, наверх уходит объединение.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCloudIntoLocal, mergeHabitsById, mergeQazaLogEntries,
  mergeRecordsByDay, mergeSleepHistories, sectionTsOf,
} from '../js/sync/merge.js';
import { loadApp } from './helpers/load-app.mjs';
import { habit } from './helpers/fixtures.mjs';

const LOCAL_TS = 1000;
const CLOUD_TS = 5000;

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

// ── Сервер не новее: слияния нет ────────────────────────────────────────────

test('сервер не новее последней сверки — слияния нет', () => {
  assert.equal(merge(baseLocal(), baseCloud(), { localTs: CLOUD_TS }), null);
  assert.equal(merge(baseLocal(), { updatedAt: LOCAL_TS }), null);
  assert.equal(merge(baseLocal(), null), null);
});

// ── Записи по дням ──────────────────────────────────────────────────────────

test('записи: чужие дни приезжают, локальные остаются', () => {
  const merged = merge(baseLocal(), baseCloud());
  assert.deepEqual(Object.keys(merged.records).sort(), ['2026-10-20', '2026-10-25']);
  assert.deepEqual(merged.records['2026-10-20'], { h2: true });
  assert.deepEqual(merged.records['2026-10-25'], { h1: true });
});

test('записи: разошедшееся поле дня уходит серверу, локальные-only поля живут', () => {
  const local = baseLocal();
  local.records['2026-10-25'] = { h2: true, h8: { value: 3, level: 2 } };
  const cloud = baseCloud();
  cloud.records['2026-10-25'] = { h2: false };
  const merged = merge(local, cloud);
  assert.deepEqual(merged.records['2026-10-25'], { h2: false, h8: { value: 3, level: 2 } });
});

test('записи при pending: существующий день не трогается, новый приезжает', () => {
  const local = baseLocal();
  local.records['2026-10-25'] = { h2: false };
  const merged = merge(local, baseCloud(), { pending: true });
  assert.deepEqual(merged.records['2026-10-25'], { h2: false }, 'pending-правку затёрло сервером');
  assert.deepEqual(merged.records['2026-10-20'], { h2: true });
});

// ── Привычки ────────────────────────────────────────────────────────────────

test('привычки: чужая дописывается в конец, порядок локального сохранён', () => {
  const local = baseLocal();
  local.habits = [habit({ id: 'h1' }), habit({ id: 'h2' })];
  const cloud = baseCloud();
  cloud.habits = [habit({ id: 'h3' }), habit({ id: 'h1', name: 'Серверное имя' })];
  const merged = merge(local, cloud);
  assert.deepEqual(merged.habits.map(function (h) { return h.id; }), ['h1', 'h2', 'h3']);
  assert.equal(merged.habits[0].name, 'Серверное имя', 'разошедшийся id должен уйти серверу без pending');
});

test('привычки при pending: совпадающий id остаётся локальным, чужой приезжает', () => {
  const local = baseLocal();
  local.habits = [habit({ id: 'h1', name: 'Локальное имя' })];
  const cloud = baseCloud();
  cloud.habits = [habit({ id: 'h1', name: 'Серверное имя' }), habit({ id: 'h9' })];
  const merged = merge(local, cloud, { pending: true });
  assert.equal(merged.habits[0].name, 'Локальное имя');
  assert.deepEqual(merged.habits.map(function (h) { return h.id; }), ['h1', 'h9']);
});

// ── Цельные разделы: LWW по метке раздела ───────────────────────────────────

test('цельные разделы применяются, когда метка раздела строго новее', () => {
  const merged = merge(baseLocal(), baseCloud());
  assert.equal(merged.qaza.cursor, 0, 'qaza не взят с сервера');
  assert.equal(merged.prayer.madhhab, 'shafi', 'prayer не взят с сервера');
  assert.equal(merged.fast.remaining, 9, 'fast не взят с сервера');
  assert.equal(merged.sleep.realSleepMin, 345, 'скаляры сна не взяты с сервера');
});

test('устаревший по метке раздел остаётся локальным', () => {
  const cloud = baseCloud();
  cloud.sectionTs.qaza = LOCAL_TS;
  cloud.sectionTs.prayer = LOCAL_TS - 1;
  const merged = merge(baseLocal(), cloud);
  assert.equal(merged.qaza.cursor, 3, 'qaza с равной меткой должен остаться локальным');
  assert.equal(merged.prayer.madhhab, 'hanafi', 'prayer со старой меткой должен остаться локальным');
});

test('без sectionTs меткой раздела считается updatedAt снимка', () => {
  const cloud = baseCloud();
  delete cloud.sectionTs;
  const merged = merge(baseLocal(), cloud);
  assert.equal(merged.qaza.cursor, 0);
  assert.equal(sectionTsOf(cloud, 'qaza', CLOUD_TS), CLOUD_TS);
  assert.equal(sectionTsOf({}, 'qaza', CLOUD_TS), CLOUD_TS);
});

test('цельные разделы при pending не трогаются вовсе', () => {
  const merged = merge(baseLocal(), baseCloud(), { pending: true });
  assert.equal(merged.qaza.cursor, 3);
  assert.equal(merged.prayer.madhhab, 'hanafi');
  assert.equal(merged.fast.remaining, 2);
  assert.equal(merged.sleep.realSleepMin, null, 'скаляры сна затёрты при pending');
});

// ── Сон: история ────────────────────────────────────────────────────────────

test('история сна: дни объединяются, разошедшийся день уходит серверу, сортировка по дате', () => {
  const cloud = baseCloud();
  cloud.sleep.history = [
    { date: '2026-10-20', bed: '22:00', fall: 10, wake: '05:00', actualWake: '05:00', sleepMin: 410 },
    { date: '2026-10-25', bed: '23:00', fall: 15, wake: '06:30', actualWake: '06:30', sleepMin: 435 },
  ];
  const merged = merge(baseLocal(), cloud);
  assert.deepEqual(merged.sleep.history.map(function (e) { return e.date; }), ['2026-10-20', '2026-10-25']);
  assert.equal(merged.sleep.history[0].bed, '22:00', 'разошедшийся день должен уйти серверу');
});

test('история сна при pending: только заполнение дыр', () => {
  const cloud = baseCloud();
  cloud.sleep.history = [
    { date: '2026-10-20', bed: '22:00', fall: 10, wake: '05:00', actualWake: '05:00', sleepMin: 410 },
    { date: '2026-10-25', bed: '23:00', fall: 15, wake: '06:30', actualWake: '06:30', sleepMin: 435 },
  ];
  const merged = merge(baseLocal(), cloud, { pending: true });
  assert.equal(merged.sleep.history[0].bed, '23:30', 'существующий день затёрт при pending');
  assert.equal(merged.sleep.history.length, 2, 'недостающий день не приехал');
});

// ── Журнал каза ─────────────────────────────────────────────────────────────

test('журнал каза: записи объединяются, дубликаты не плодятся, since не переезжает', () => {
  const local = baseLocal();
  local.qazaLog.entries = [
    { date: '2026-10-02', namaz: 'fajr', source: 'done' },
    { date: '2026-10-03', namaz: 'zuhr', source: 'manual' },
  ];
  const cloud = baseCloud();
  cloud.qazaLog.entries = [
    { date: '2026-10-02', namaz: 'fajr', source: 'done' }, // тот же — уже есть
    { date: '2026-10-06', namaz: 'isha', source: 'done' },
  ];
  const merged = merge(local, cloud);
  assert.deepEqual(merged.qazaLog.entries, [
    { date: '2026-10-02', namaz: 'fajr', source: 'done' },
    { date: '2026-10-03', namaz: 'zuhr', source: 'manual' },
    { date: '2026-10-06', namaz: 'isha', source: 'done' },
  ]);
  assert.equal(merged.qazaLog.since, '2026-10-01', 'окно журнала переехало');
});

test('журнал каза при pending не трогается, без локального журнала — берётся серверный', () => {
  const merged = merge(baseLocal(), baseCloud(), { pending: true });
  assert.deepEqual(merged.qazaLog.entries, [{ date: '2026-10-02', namaz: 'fajr', source: 'done' }]);

  const local = baseLocal();
  local.qazaLog = null;
  const adopted = merge(local, baseCloud());
  assert.equal(adopted.qazaLog.since, '2026-10-05');
});

test('mergeQazaLogEntries: одинаковые записи одной стороны не схлопываются', () => {
  const entry = { date: '2026-10-02', namaz: 'fajr', source: 'manual' };
  const merged = mergeQazaLogEntries([entry, entry], []);
  assert.equal(merged.length, 2, 'два ручных добавления — законная история');
});

// ── Архив ───────────────────────────────────────────────────────────────────

test('архив: месяцы объединяются, since уразы берётся минимум', () => {
  const local = baseLocal();
  local.archive = {
    version: 1,
    sleep: { months: { '2024-09': { days: 30, totalMin: 13000, excluded: 1 } } },
    fast: { months: { '2024-09': { done: 12, added: 3 } }, since: '2024-09-05' },
    qaza: { months: {} },
    records: { months: { '2024-09': { days: 28, habits: {} } } },
  };
  const cloud = baseCloud();
  cloud.archive = {
    version: 1,
    sleep: { months: {} },
    fast: { months: { '2024-10': { done: 5, added: 0 } }, since: '2024-10-01' },
    qaza: { months: { '2024-09': { done: 90, manual: 2 } } },
    records: { months: {} },
  };
  const merged = merge(local, cloud);
  assert.deepEqual(Object.keys(merged.archive.sleep.months), ['2024-09']);
  assert.deepEqual(Object.keys(merged.archive.fast.months).sort(), ['2024-09', '2024-10']);
  assert.equal(merged.archive.fast.since, '2024-09-05');
  assert.deepEqual(Object.keys(merged.archive.qaza.months), ['2024-09']);
  assert.deepEqual(Object.keys(merged.archive.records.months), ['2024-09']);
});

// ── Чистые помощники ────────────────────────────────────────────────────────

test('mergeRecordsByDay: битый день снимка пропускается', () => {
  const merged = mergeRecordsByDay({ '2026-10-20': { h2: true } }, { '2026-10-25': null }, true);
  assert.deepEqual(merged, { '2026-10-20': { h2: true } });
});

test('mergeHabitsById: битые элементы и дубликаты id пропускаются', () => {
  const merged = mergeHabitsById(
    [habit({ id: 'h1' }), null, habit({ id: 'h1', name: 'дубль' })],
    [habit({ id: 'h2' }), null, { id: null }],
    false
  );
  assert.deepEqual(merged.map(function (h) { return h.id; }), ['h1', 'h2']);
});

// ── Интеграция: syncToCloudNow сливает перед PUT ────────────────────────────

function makeMergeFetch(previousSnapshot) {
  const calls = [];
  const fetchImpl = function (url, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    calls.push({ url: String(url), method: method, body: options.body });
    if (method === 'GET' && String(url).includes('backups')) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve([]); } });
    }
    if (method === 'GET') {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(previousSnapshot); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  };
  fetchImpl.calls = calls;
  fetchImpl.mainPut = function () {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (call.method === 'PUT' && call.url.includes('firebaseio.com') && !call.url.includes('backups')) return call;
    }
    return null;
  };
  return fetchImpl;
}

test('syncToCloudNow: снимок сервера новее — PUT уезжает объединением, локальное обновлено', async () => {
  const previous = baseCloud();
  const fetchImpl = makeMergeFetch(previous);
  const app = loadApp({ fetchImpl: fetchImpl });

  // Локальное состояние и метка последней сверки старше снимка
  const seed = baseLocal();
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify(seed.habits));
  app.sandbox.localStorage.setItem('youplanner.records', JSON.stringify(seed.records));
  app.sandbox.localStorage.setItem('youplanner.sync.ts', String(LOCAL_TS));
  app.run("globalThis.__applied = 0;");
  app.run("bus.on('sync:applied', function () { globalThis.__applied++; });");

  await app.context.syncToCloudNow();

  const put = fetchImpl.mainPut();
  assert.ok(put, 'PUT не состоялся');
  const body = JSON.parse(put.body);
  assert.deepEqual(Object.keys(body.records).sort(), ['2026-10-20', '2026-10-25'],
    'PUT должен нести объединение записей, а не перезапись');
  assert.ok(body.sectionTs && body.sectionTs.records === body.updatedAt,
    'PUT без меток свежести разделов');
  assert.deepEqual(body.archive, previous.archive,
    'слитый архив (локального не было) должен уехать в PUT');
  // Слияние применено локально: чужой день уже в хранилище
  const localRecords = JSON.parse(app.sandbox.localStorage.getItem('youplanner.records'));
  assert.deepEqual(Object.keys(localRecords).sort(), ['2026-10-20', '2026-10-25']);
  // Метка сверки сдвинулась на время отправки
  assert.ok(Number(app.sandbox.localStorage.getItem('youplanner.sync.ts')) > LOCAL_TS,
    'SYNC_TS не записан после PUT');
  assert.equal(app.run('globalThis.__applied'), 1, 'sync:applied не эмитился на слиянии');
});

// ── B.2: повторный GET непосредственно перед PUT ────────────────────────────
// Гонка двух устройств: между первым GET (внутри backupCloudSnapshot) и PUT
// другое устройство успевает отправить свой снимок — PUT без повторной сверки
// затирает его безвозвратно. Ожидание: перед PUT ещё один GET; если снимок
// изменился, слияние повторяется со свежим снимком, и наверх уезжает уже
// объединение с чужой правкой.

test('syncToCloudNow: снимок изменился после первого GET — слияние повторяется, PUT несёт свежее', async () => {
  const oldSnapshot = baseCloud();
  const freshSnapshot = baseCloud();
  // Чужой PUT успел между нашими двумя GET: метка свежее, раздел records
  // получил день, которого не было в первом снимке
  const freshTs = CLOUD_TS + 1000;
  freshSnapshot.updatedAt = freshTs;
  Object.keys(freshSnapshot.sectionTs).forEach(function (key) {
    freshSnapshot.sectionTs[key] = freshTs;
  });
  freshSnapshot.records['2026-10-26'] = { h3: true };

  const calls = [];
  let mainGetIndex = 0;
  const fetchImpl = function (url, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    calls.push({ url: String(url), method, body: options.body });
    if (method === 'GET' && String(url).includes('backups')) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve([]); } });
    }
    if (method === 'GET') {
      mainGetIndex += 1;
      const snapshot = mainGetIndex === 1 ? oldSnapshot : freshSnapshot;
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(snapshot); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  };
  fetchImpl.mainPut = function () {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (call.method === 'PUT' && call.url.includes('firebaseio.com') && !call.url.includes('backups')) return call;
    }
    return null;
  };
  fetchImpl.mainGetCount = function () {
    return calls.filter(function (c) {
      return c.method === 'GET' && c.url.includes('firebaseio.com') && !c.url.includes('backups');
    }).length;
  };

  const app = loadApp({ fetchImpl: fetchImpl });
  const seed = baseLocal();
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify(seed.habits));
  app.sandbox.localStorage.setItem('youplanner.records', JSON.stringify(seed.records));
  app.sandbox.localStorage.setItem('youplanner.sync.ts', String(LOCAL_TS));

  await app.context.syncToCloudNow();

  assert.equal(fetchImpl.mainGetCount(), 2, 'повторный GET перед PUT не состоялся');
  const put = fetchImpl.mainPut();
  assert.ok(put, 'PUT не состоялся');
  const body = JSON.parse(put.body);
  assert.deepEqual(Object.keys(body.records).sort(),
    ['2026-10-20', '2026-10-25', '2026-10-26'],
    'PUT должен нести слияние со свежим снимком: день 2026-10-26 приехал вторым GET и не должен быть затёрт');
});

test('syncToCloudNow: сервер не новее — слияния нет, PUT уходит как раньше', async () => {
  const previous = baseCloud();
  previous.updatedAt = LOCAL_TS;
  delete previous.sectionTs;
  const fetchImpl = makeMergeFetch(previous);
  const app = loadApp({ fetchImpl: fetchImpl });

  const seed = baseLocal();
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify(seed.habits));
  app.sandbox.localStorage.setItem('youplanner.records', JSON.stringify(seed.records));
  app.sandbox.localStorage.setItem('youplanner.sync.ts', String(LOCAL_TS));
  app.run("globalThis.__applied = 0;");
  app.run("bus.on('sync:applied', function () { globalThis.__applied++; });");

  await app.context.syncToCloudNow();

  const put = fetchImpl.mainPut();
  assert.ok(put, 'PUT не состоялся');
  const body = JSON.parse(put.body);
  assert.deepEqual(Object.keys(body.records), ['2026-10-20']);
  assert.equal(app.run('globalThis.__applied'), 0, 'sync:applied без слияния');
});
