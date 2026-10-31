// Тесты архивации историй (js/data/archive.js) — аудит 2026-10-31.
//
// Контракт: детальная история хранится с 1-го числа месяца, наступившего
// 12 месяцев назад; всё старше — в месячные сводки youplanner.archive.
// Граница — начало месяца: сводка месяца всегда пересчитывается по полному
// месяцу, повторный проход не удваивает суммы. Проход идемпотентен: нечего
// срезать — ни записей, ни data:changed. since журнала каза не двигается
// (правило «журнал с since, до него h6»), начало истории уразы читается
// из архива (fastHistorySince).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveCutoffISO, archiveFastMonths, archiveQazaLogMonths,
  archiveRecordsMonths, archiveSleepMonths,
} from '../js/data/archive.js';
import { loadApp } from './helpers/load-app.mjs';

// ── Граница ─────────────────────────────────────────────────────────────────

test('граница детализации — первое число месяца, открывающего 12-месячное окно', () => {
  assert.equal(archiveCutoffISO(new Date(2026, 9, 31)), '2025-11-01');
  assert.equal(archiveCutoffISO(new Date(2026, 0, 5)), '2025-02-01');
  assert.equal(archiveCutoffISO(new Date(2026, 2, 1)), '2025-04-01');
});

// ── Агрегаторы ──────────────────────────────────────────────────────────────

test('агрегатор сна: дни, минуты по realSleepMin ?? sleepMin, исключённые', () => {
  const months = archiveSleepMonths([
    { date: '2024-09-05', sleepMin: 400, realSleepMin: 380 },
    { date: '2024-09-06', sleepMin: 410 },
    { date: '2024-09-07', sleepMin: 390, excluded: true },
    { date: '2024-10-01', sleepMin: 400 },
  ]);
  assert.deepEqual(months['2024-09'], { days: 3, totalMin: 1180, excluded: 1 });
  assert.deepEqual(months['2024-10'], { days: 1, totalMin: 400, excluded: 0 });
});

test('агрегатор уразы: done и added по источникам, set не считается', () => {
  const months = archiveFastMonths([
    { date: '2024-09-05', count: 3, source: 'done' },
    { date: '2024-09-06', count: 2, source: 'add' },
    { date: '2024-09-07', count: 30, source: 'set' },
  ]);
  assert.deepEqual(months, { '2024-09': { done: 3, added: 2 } });
});

test('агрегатор журнала каза: выполненные и ручные по месяцам', () => {
  const months = archiveQazaLogMonths([
    { date: '2024-09-05', namaz: 'fajr', source: 'done' },
    { date: '2024-09-06', namaz: 'zuhr', source: 'done' },
    { date: '2024-09-06', namaz: 'asr', source: 'manual' },
  ]);
  assert.deepEqual(months, { '2024-09': { done: 2, manual: 1 } });
});

test('агрегатор записей: булевы, числа и объектные значения по привычкам', () => {
  const months = archiveRecordsMonths({
    '2024-09-05': { h1: true, h6: 2, h8: { value: 5, level: 1 } },
    '2024-09-06': { h1: true, h6: 1 },
    '2024-09-07': { h1: false, h8: { value: 2, level: 1 } },
  }, ['2024-09-05', '2024-09-06', '2024-09-07']);
  assert.deepEqual(months['2024-09'].days, 3);
  assert.deepEqual(months['2024-09'].habits.h1, { t: 2, s: 0, c: 0 });
  assert.deepEqual(months['2024-09'].habits.h6, { t: 0, s: 3, c: 2 });
  assert.deepEqual(months['2024-09'].habits.h8, { t: 0, s: 7, c: 2 });
});

// ── Проход архивации (песочница с хранилищем) ──────────────────────────────

// Дата «сейчас» в тестах песочницы: граница — 2025-11-01.
const NOW = new Date(2026, 9, 31);

function seedHistories(sandbox) {
  const seed = {
    'youplanner.sleep': JSON.stringify({
      version: 4, bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00',
      sleepMin: 375, realWake: null, realSleepMin: null, excluded: false,
      history: [
        { date: '2024-09-05', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375, realWake: '05:30', realSleepMin: 345 },
        { date: '2025-11-05', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375 },
        { date: '2026-10-20', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375 },
      ],
    }),
    'youplanner.qaza.fast': JSON.stringify({
      version: 1, remaining: 2,
      history: [
        { date: '2024-09-05', count: 3, source: 'done' },
        { date: '2026-10-01', count: 1, source: 'done' },
      ],
    }),
    'youplanner.qaza.log': JSON.stringify({
      version: 1, since: '2024-08-01',
      entries: [
        { date: '2024-09-05', namaz: 'fajr', source: 'done' },
        { date: '2026-10-02', namaz: 'isha', source: 'done' },
      ],
    }),
    'youplanner.records': JSON.stringify({
      '2024-09-05': { h1: true, h6: 2 },
      '2025-11-05': { h1: true },
      '2026-10-20': { h2: true },
      'мусор': { h1: true },
    }),
  };
  const keys = Object.keys(seed);
  for (let i = 0; i < keys.length; i++) sandbox.localStorage.setItem(keys[i], seed[keys[i]]);
}

test('проход архивации: детализация срезана, своды записаны, один data:changed', () => {
  const app = loadApp();
  seedHistories(app.sandbox);
  app.run("globalThis.__changed = 0;");
  app.run("bus.on('data:changed', function () { globalThis.__changed++; });");

  const changed = app.context.archiveHistories(NOW);

  assert.equal(changed, true, 'проход не нашёл работу на подготовленных данных');

  const sleep = JSON.parse(app.sandbox.localStorage.getItem('youplanner.sleep'));
  assert.deepEqual(sleep.history.map(function (e) { return e.date; }), ['2025-11-05', '2026-10-20']);
  assert.equal(sleep.bed, '23:30', 'ядро записи сна не должно пострадать');

  const fast = JSON.parse(app.sandbox.localStorage.getItem('youplanner.qaza.fast'));
  assert.deepEqual(fast.history.map(function (e) { return e.date; }), ['2026-10-01']);
  assert.equal(fast.remaining, 2, 'остаток счётчика не должен пострадать');

  const log = JSON.parse(app.sandbox.localStorage.getItem('youplanner.qaza.log'));
  assert.deepEqual(log.entries.map(function (e) { return e.date; }), ['2026-10-02']);
  assert.equal(log.since, '2024-08-01', 'since журнала каза не должен двигаться');

  const records = JSON.parse(app.sandbox.localStorage.getItem('youplanner.records'));
  assert.deepEqual(Object.keys(records).sort(), ['2025-11-05', '2026-10-20', 'мусор'].sort(),
    'мусорные ключи должны остаться, старые даты — уйти');

  const archive = JSON.parse(app.sandbox.localStorage.getItem('youplanner.archive'));
  assert.deepEqual(archive.sleep.months['2024-09'], { days: 1, totalMin: 345, excluded: 0 });
  assert.deepEqual(archive.fast.months['2024-09'], { done: 3, added: 0 });
  assert.equal(archive.fast.since, '2024-09-05');
  assert.deepEqual(archive.qaza.months['2024-09'], { done: 1, manual: 0 });
  assert.deepEqual(archive.records.months['2024-09'].days, 1);
  assert.deepEqual(archive.records.months['2024-09'].habits.h1, { t: 1, s: 0, c: 0 });

  assert.equal(app.run('globalThis.__changed'), 1, 'data:changed должен эмититься один раз');
});

test('проход архивации идемпотентен: второй проход — ни записей, ни событий', () => {
  const app = loadApp();
  seedHistories(app.sandbox);
  app.context.archiveHistories(NOW);
  const before = app.sandbox.localStorage._dump();
  app.run("globalThis.__changed = 0;");
  app.run("bus.on('data:changed', function () { globalThis.__changed++; });");

  const changed = app.context.archiveHistories(NOW);

  assert.equal(changed, false);
  assert.deepEqual(app.sandbox.localStorage._dump(), before);
  assert.equal(app.run('globalThis.__changed'), 0);
});

test('отказ квоты при записи срезов: changed не выставляется, свод не уходит', () => {
  const app = loadApp();
  // Только ураза и журнал каза: сон и записи делить нечего, так что итог
  // прохода целиком зависит от проверки результата записи срезов
  const seed = {
    'youplanner.qaza.fast': JSON.stringify({
      version: 1, remaining: 2,
      history: [
        { date: '2024-09-05', count: 3, source: 'done' },
        { date: '2026-10-01', count: 1, source: 'done' },
      ],
    }),
    'youplanner.qaza.log': JSON.stringify({
      version: 1, since: '2024-08-01',
      entries: [
        { date: '2024-09-05', namaz: 'fajr', source: 'done' },
        { date: '2026-10-02', namaz: 'isha', source: 'done' },
      ],
    }),
  };
  const keys = Object.keys(seed);
  for (let i = 0; i < keys.length; i++) app.sandbox.localStorage.setItem(keys[i], seed[keys[i]]);
  app.run("globalThis.__changed = 0;");
  app.run("bus.on('data:changed', function () { globalThis.__changed++; });");

  // Оба среза (FAST_KEY и QAZA_LOG_KEY) записаться не могут: квота
  const original = app.sandbox.localStorage.setItem;
  app.sandbox.localStorage.setItem = function (key, value) {
    if (key === 'youplanner.qaza.fast' || key === 'youplanner.qaza.log') {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(key, value);
  };

  const changed = app.context.archiveHistories(NOW);

  assert.equal(changed, false, 'несостоявшаяся архивация не должна выставлять changed');
  assert.equal(app.sandbox.localStorage.getItem('youplanner.archive'), null,
    'свод не должен уходить в хранилище при отказе записи детализации');
  assert.equal(app.run('globalThis.__changed'), 0, 'data:changed эмитился на несостоявшейся архивации');

  // Детализация осталась целиком: ничего не срезано «в никуда»
  const fast = JSON.parse(app.sandbox.localStorage.getItem('youplanner.qaza.fast'));
  assert.deepEqual(fast.history.map(function (e) { return e.date; }), ['2024-09-05', '2026-10-01']);
  const log = JSON.parse(app.sandbox.localStorage.getItem('youplanner.qaza.log'));
  assert.deepEqual(log.entries.map(function (e) { return e.date; }), ['2024-09-05', '2026-10-02']);
});

test('вернувшийся полный месяц пересчитывает сводку, а не удваивает', () => {
  const app = loadApp();
  seedHistories(app.sandbox);
  app.context.archiveHistories(NOW);
  const archiveBefore = JSON.parse(app.sandbox.localStorage.getItem('youplanner.archive'));
  assert.deepEqual(archiveBefore.sleep.months['2024-09'], { days: 1, totalMin: 345, excluded: 0 });

  // Устройство со старой версией (без архивации) вернуло детализацию месяца
  // целиком: проход снова срезает его и ПЕРЕсчитывает сводку 2024-09 по
  // полному набору записей — без удвоения первого дня
  const sleep = JSON.parse(app.sandbox.localStorage.getItem('youplanner.sleep'));
  sleep.history.push(
    { date: '2024-09-05', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375, realWake: '05:30', realSleepMin: 345 },
    { date: '2024-09-06', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375 }
  );
  app.sandbox.localStorage.setItem('youplanner.sleep', JSON.stringify(sleep));

  app.context.archiveHistories(NOW);
  const archiveAfter = JSON.parse(app.sandbox.localStorage.getItem('youplanner.archive'));

  assert.deepEqual(archiveAfter.sleep.months['2024-09'], { days: 2, totalMin: 720, excluded: 0 });
});

test('fastHistorySince: минимум детализации и архива', () => {
  const app = loadApp();
  seedHistories(app.sandbox);
  app.context.archiveHistories(NOW);

  const fast = JSON.parse(app.sandbox.localStorage.getItem('youplanner.qaza.fast'));
  assert.equal(app.context.fastHistorySince(fast), '2024-09-05');

  // Архива нет — начало по оставшейся детализации
  const app2 = loadApp();
  const since = app2.context.fastHistorySince({
    version: 1, remaining: 1,
    history: [{ date: '2026-05-01', count: 1, source: 'done' }],
  });
  assert.equal(since, '2026-05-01');
  assert.equal(app2.context.fastHistorySince(null), null);
});
