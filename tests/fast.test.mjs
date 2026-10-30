// Юнит-тесты статистики уразы (js/data/fast.js).
//
// fastPeriodStats — чистая арифметика периода: значения done-событий по дням,
// суммы «Возмещено» и «Добавлено» и начало истории. Функция не пишет и не
// читает хранилище, поэтому история собирается руками: какие события в каком
// дне лежат, решает тест. Источники — строками 'done'/'add'/'set': это
// значения FAST_SOURCE_* из модуля, а сами константы в песочнице живут
// в глобальной лексической области и на context их не вынести

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const fastCases = [
  {
    name: 'fastPeriodStats: done-события попадают в свой день, add и set — не в значения',
    run: (context) => {
      const fast = {
        version: 1,
        remaining: 3,
        // История лежит, как пишется: даты не обязаны идти по возрастанию
        history: [
          { date: '2026-01-02', count: 5, source: 'add' },
          { date: '2026-01-01', count: 1, source: 'done' },
          { date: '2026-01-03', count: 1, source: 'done' },
          { date: '2026-01-02', count: 1, source: 'done' },
          { date: '2026-01-03', count: 7, source: 'set' },
        ],
      };
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
      const result = context.fastPeriodStats(fast, dates);

      // done-события дня складываются в значение дня; add растит остаток
      // и идёт только в added, set — перезапись счётчика, графику чужая
      assert.deepEqual(Array.from(result.values), [1, 1, 1]);
      assert.equal(result.done, 3);
      assert.equal(result.added, 5);
    },
  },
  {
    name: 'fastPeriodStats: since — минимум по всей истории, не по периоду',
    run: (context) => {
      const fast = {
        version: 1,
        remaining: 2,
        history: [
          // Самая ранняя дата лежит вне периода и после неё в истории
          // есть более свежие: начало всё равно она
          { date: '2026-02-10', count: 1, source: 'done' },
          { date: '2025-12-31', count: 10, source: 'set' },
          { date: '2026-01-01', count: 1, source: 'done' },
          { date: '2025-11-15', count: 4, source: 'add' },
        ],
      };
      const dates = ['2026-01-01', '2026-01-02'];
      const result = context.fastPeriodStats(fast, dates);

      // «История копится с» не меняется от выбранного окна
      assert.equal(result.since, '2025-11-15');

      // События вне периода ни в значения, ни в суммы не попадают
      assert.deepEqual(Array.from(result.values), [1, 0]);
      assert.equal(result.done, 1);
      assert.equal(result.added, 0);
    },
  },
  {
    name: 'fastPeriodStats: пустая история — нули и since null',
    run: (context) => {
      const dates = ['2026-01-01', '2026-01-02'];
      const result = context.fastPeriodStats({ version: 1, remaining: 0, history: [] }, dates);

      assert.deepEqual(Array.from(result.values), [0, 0]);
      assert.equal(result.done, 0);
      assert.equal(result.added, 0);
      assert.equal(result.since, null);
    },
  },
  {
    name: 'fastPeriodStats: счётчика и истории нет вовсе — нули, период не падает',
    run: (context) => {
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];

      // Счётчик не заведён — readFast() вернул бы null, функция получает null
      const noFast = context.fastPeriodStats(null, dates);
      assert.deepEqual(Array.from(noFast.values), [0, 0, 0]);
      assert.equal(noFast.done, 0);
      assert.equal(noFast.added, 0);
      assert.equal(noFast.since, null);

      // История не массив — читать нечего, но длины периода держат форму
      const badHistory = context.fastPeriodStats({ history: 'не массив' }, dates);
      assert.deepEqual(Array.from(badHistory.values), [0, 0, 0]);
      assert.equal(badHistory.since, null);

      // dates не массив — значений нет вовсе
      const noDates = context.fastPeriodStats(
        { history: [{ date: '2026-01-01', count: 1, source: 'done' }] },
        null,
      );
      assert.deepEqual(Array.from(noDates.values), []);
      assert.equal(noDates.done, 0);
      assert.equal(noDates.added, 0);
      assert.equal(noDates.since, null);
    },
  },
];

for (const scenario of fastCases) {
  test(scenario.name, () => {
    const { context } = loadApp();
    scenario.run(context);
  });
}
