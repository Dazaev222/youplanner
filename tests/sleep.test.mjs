// Юнит-тесты математики сна (js/data/sleep.js).
//
// Функции чистые: часы, циклы, средние и длительности считаются без DOM.
// Границы 0/120 и переход через полночь — самые дорогие ошибки здесь:
// именно они превращают «поспал 90 минут» в «поспал 23 часа».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

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
];

for (const scenario of sleepCases) {
  test(scenario.name, () => {
    const { context } = loadApp();
    scenario.run(context);
  });
}
