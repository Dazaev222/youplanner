// Юнит-тесты математики сна (js/data/sleep.js).
//
// Функции чистые: часы, циклы, средние и длительности считаются без DOM.
// Границы 0/120 и переход через полночь — самые дорогие ошибки здесь:
// именно они превращают «поспал 90 минут» в «поспал 23 часа».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Годная запись дневника сна: bed '23:00', засыпание 0, подъём '07:00' —
// плановые 480 минут (сходится по sleepDurationMinutes), факт «встал
// по плану». Overrides добавляют то, что отличает конкретный день
function dayEntry(date, overrides) {
  return Object.assign({
    date: date,
    bed: '23:00',
    fall: 0,
    wake: '07:00',
    actualWake: '07:00',
    sleepMin: 480,
  }, overrides || {});
}

const sleepCases = [
  {
    name: 'sleepCycleTimes: шесть циклов и два соседних будильника',
    run: (context) => {
      const result = context.sleepCycleTimes('23:30', 15, '06:00');

      assert.equal(result.cycles.length, 6);
      assert.deepEqual(Array.from(result.cycles, (cycle) => cycle.time),
        ['01:15', '02:45', '04:15', '05:45', '07:15', '08:45']);
      assert.deepEqual(Array.from(result.recommended, (cycle) => cycle.time),
        ['05:45', '07:15']);
    },
  },
  {
    name: 'sleepCycleTimes: будильник ровно на конце цикла — один вариант',
    run: (context) => {
      // 23:30 + 15 минут засыпания + 3 цикла по 90 = 04:15
      const result = context.sleepCycleTimes('23:30', 15, '04:15');

      assert.equal(result.recommended.length, 1);
      assert.equal(result.recommended[0].time, '04:15');
      assert.equal(result.recommended[0].cycles, 3);
    },
  },
  {
    name: 'sleepCycleTimes: границы засыпания 0 и 120 минут',
    run: (context) => {
      const zero = context.sleepCycleTimes('23:30', 0, '01:00');
      assert.ok(zero, 'засыпание 0 минут отвергнуто');
      assert.equal(zero.cycles[0].time, '01:00');

      const max = context.sleepCycleTimes('23:30', 120, '06:00');
      assert.ok(max, 'засыпание 120 минут отвергнуто');
      assert.equal(max.cycles[0].time, '03:00');

      assert.equal(context.sleepCycleTimes('23:30', -1, '06:00'), null);
      assert.equal(context.sleepCycleTimes('23:30', 121, '06:00'), null);
      assert.equal(context.sleepCycleTimes('23:30', 1.5, '06:00'), null);
    },
  },
  {
    name: 'sleepAverageMinutes: среднее время суток не врёт через полночь',
    run: (context) => {
      // 23:30 и 00:30 — это полночь, а не 12:00
      assert.equal(context.sleepAverageMinutes([1410, 30]), 0);
      assert.equal(context.sleepTimeLabel(context.sleepAverageMinutes([1410, 30])), '00:00');

      // Пустые и нечисловые данные — отсутствие среднего
      assert.equal(context.sleepAverageMinutes([]), null);
      assert.equal(context.sleepAverageMinutes([null, NaN, '23:30']), null);
      assert.equal(context.sleepAverageMinutes(null), null);
    },
  },
  {
    name: 'sleepDurationMinutes: переход через полночь и пример 23:30 → 01:00',
    run: (context) => {
      assert.equal(context.sleepDurationMinutes('23:30', 0, '01:00'), 90);
      assert.equal(context.sleepDurationMinutes('23:30', 15, '01:00'), 75);
      assert.equal(context.sleepDurationMinutes('23:30', 15, '06:00'), 375);

      // Некорректные часы или засыпание — null, а не отрицательная длина
      assert.equal(context.sleepDurationMinutes('7:30', 0, '06:00'), null);
      assert.equal(context.sleepDurationMinutes('23:30', -1, '06:00'), null);
      assert.equal(context.sleepDurationMinutes('23:30', 121, '06:00'), null);
    },
  },
  {
    name: 'nearestSleepCycle: ближайший конец цикла, при равенстве — поздний',
    run: (context) => {
      // 06:00 ближе к 05:45, чем к 07:15
      assert.equal(
        context.nearestSleepCycle(context.sleepAnchors('23:30', 15, '06:00')),
        1785,
      );

      // 06:30 равноудалён от 05:45 и 07:15 — выбирается поздний, 07:15
      assert.equal(
        context.nearestSleepCycle(context.sleepAnchors('23:30', 15, '06:30')),
        1875,
      );
    },
  },
  {
    name: 'sleepEntriesInPeriod: excluded и чужие даты не проходят, порядок хранится',
    run: (context) => {
      const history = [
        dayEntry('2026-01-02'),
        dayEntry('2025-12-25'), // день вне периода
        dayEntry('2026-01-01', { realWake: '06:00', realSleepMin: 420 }),
        dayEntry('2026-01-03', { excluded: true }), // «не считать этот день»
      ];
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
      const result = context.sleepEntriesInPeriod(history, dates);

      // Порядок истории сохраняется: 2026-01-02 идёт раньше 2026-01-01
      assert.deepEqual(
        Array.from(result, (entry) => entry.date),
        ['2026-01-02', '2026-01-01'],
      );

      // Возвращается новый массив, сама история не тронута
      assert.equal(history.length, 4);
      assert.notEqual(result, history);

      // history не массив — пустой результат, а не падение
      assert.deepEqual(Array.from(context.sleepEntriesInPeriod(null, dates)), []);
      assert.deepEqual(Array.from(context.sleepEntriesInPeriod(undefined, dates)), []);
      assert.deepEqual(Array.from(context.sleepEntriesInPeriod('не массив', dates)), []);

      // dates не массив или пустой — выбирать не из чего
      assert.deepEqual(Array.from(context.sleepEntriesInPeriod(history, null)), []);
      assert.deepEqual(Array.from(context.sleepEntriesInPeriod(history, [])), []);
    },
  },
  {
    name: 'sleepMinutesByDay: две записи дня складываются, realSleepMin сильнее sleepMin',
    run: (context) => {
      const history = [
        // Две записи одного дня складываются в значение дня, а не затирают
        dayEntry('2026-01-01'),
        dayEntry('2026-01-01', { wake: '07:30', sleepMin: 510 }),
        // realSleepMin задан — в сумму идёт факт, а не план
        dayEntry('2026-01-02', { realWake: '06:00', realSleepMin: 420 }),
        // realSleepMin null — «встал по плану», берётся sleepMin
        dayEntry('2026-01-03', { realWake: null, realSleepMin: null }),
        // excluded — день не попадает в суммы вовсе
        dayEntry('2026-01-04', { excluded: true }),
      ];
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
      const result = context.sleepMinutesByDay(history, dates);

      assert.deepEqual(Array.from(result), [990, 420, 480, 0]);
      // Длина результата равна длине dates: у каждого дня периода своя ячейка
      assert.equal(result.length, dates.length);

      // Дни вне периода — нули, а не обрезанный массив
      assert.deepEqual(
        Array.from(context.sleepMinutesByDay(history, ['2026-02-01', '2026-02-02'])),
        [0, 0],
      );

      // history не массив — все дни периода по нулю
      assert.deepEqual(Array.from(context.sleepMinutesByDay('не массив', dates)), [0, 0, 0, 0]);

      // dates не массив — результата нет вовсе
      assert.deepEqual(Array.from(context.sleepMinutesByDay(history, null)), []);
    },
  },
  {
    name: 'sleepAverageDurationMin: среднее по фактам и планам, пустое — null',
    run: (context) => {
      const entries = [
        dayEntry('2026-01-01', { realWake: '06:00', realSleepMin: 420 }),
        dayEntry('2026-01-02'),
        dayEntry('2026-01-03', { realWake: null, realSleepMin: null }),
      ];
      // 420 (факт) + 480 (план) + 480 (план при null realSleepMin) = 1380 / 3
      assert.equal(context.sleepAverageDurationMin(entries), 460);

      // Округление до целой минуты: (350 + 351) / 2 = 350.5 → 351
      assert.equal(context.sleepAverageDurationMin([
        dayEntry('2026-01-01', { wake: '04:50', sleepMin: 350 }),
        dayEntry('2026-01-02', { wake: '04:51', sleepMin: 351 }),
      ]), 351);

      // Пустой и не-массив — среднего нет
      assert.equal(context.sleepAverageDurationMin([]), null);
      assert.equal(context.sleepAverageDurationMin(null), null);
      assert.equal(context.sleepAverageDurationMin(undefined), null);
      assert.equal(context.sleepAverageDurationMin('не массив'), null);
    },
  },
];

for (const scenario of sleepCases) {
  test(scenario.name, () => {
    const { context } = loadApp();
    scenario.run(context);
  });
}
