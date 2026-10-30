// Регрессия кнопки «Выполнено» на вкладке каза.
//
// Быстрый двойной клик/тап не должен списывать два намаза: первый клик
// перерисовывает план, и второй клик прилетает уже в новую кнопку на том же
// месте. Проверяем поведение обработчика, а не внутренний флаг: два вызова
// подряд обязаны дать ровно одно списание.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

test('«Выполнено»: двойной клик/тап списывает ровно один намаз', async () => {
  const app = loadApp();
  const qaza = app.context.loadQaza(true);
  app.context.setQazaState(qaza);

  const beforeTotal = app.context.qazaTotalRemaining(qaza);
  const beforeHistory = qaza.history.length;

  // Минимальный target: обработчику нужен только closest('#qaza-done').
  const event = {
    target: {
      closest(selector) {
        return selector === '#qaza-done' ? {} : null;
      },
    },
  };

  app.context.onQazaDone(event);
  // Второй клик приходит до снятия блокировки — это и есть двойной тап.
  app.context.onQazaDone(event);

  const after = app.context.getQazaState();
  assert.equal(app.context.qazaTotalRemaining(after), beforeTotal - 1,
    'двойной клик списал больше одного намаза');
  assert.equal(after.history.length, beforeHistory + 1,
    'двойной клик добавил больше одной записи в историю');
});

// Юнит-сценарии чистой арифметики qazaDayCounts (js/data/qaza.js): источник
// за день — «журнал с since, до него поле h6» — теперь живёт в data-слое,
// и правило проверяется здесь, а не на экране статистики. Функция чистая,
// поэтому лог и снимок записей собираются руками: каким был h6 и что лежит
// в журнале, решает тест, а не loadQazaLog
const qazaDayCountsCases = [
  {
    name: 'qazaDayCounts: since покрывает весь период — все дни из журнала, h6 игнорируется',
    run: (context) => {
      const records = {
        '2026-01-01': { h6: 9 },
        '2026-01-03': { h6: 9 },
      };
      const log = {
        version: 1,
        since: '2026-01-01',
        entries: [
          { date: '2026-01-01', namaz: 'fajr', source: 'done' },
          // Ручное добавление пропуска — не выполнение: намаз вспомнен
          { date: '2026-01-02', namaz: 'zuhr', source: 'manual' },
          { date: '2026-01-03', namaz: 'asr', source: 'done' },
          { date: '2026-01-03', namaz: 'maghrib', source: 'done' },
        ],
      };
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
      const result = context.qazaDayCounts(records, log, dates);

      assert.deepEqual(Array.from(result.values), [1, 0, 2]);
      assert.equal(result.total, 3);
    },
  },
  {
    name: 'qazaDayCounts: день до since — из записей, с since включительно — из журнала',
    run: (context) => {
      const records = {
        '2026-01-01': { h6: 4 },
        // Дни с since и позже h6 не подмешивают, даже если он больше
        '2026-01-02': { h6: 7 },
        '2026-01-03': { h6: 9 },
      };
      const log = {
        version: 1,
        since: '2026-01-02',
        entries: [
          { date: '2026-01-02', namaz: 'fajr', source: 'done' },
          { date: '2026-01-03', namaz: 'zuhr', source: 'done' },
        ],
      };
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
      const result = context.qazaDayCounts(records, log, dates);

      assert.deepEqual(Array.from(result.values), [4, 1, 1]);
      assert.equal(result.total, 6);
    },
  },
  {
    name: 'qazaDayCounts: журнала нет — все дни читаются из h6 записей',
    run: (context) => {
      const records = {
        '2026-01-01': { h6: 2 },
        // Ноль и пустой день — тоже ноль, а не «—»: qazaDoneOn отвечает числом
        '2026-01-02': { h6: 0 },
        '2026-01-03': {},
      };
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
      const result = context.qazaDayCounts(records, null, dates);

      assert.deepEqual(Array.from(result.values), [2, 0, 0]);
      assert.equal(result.total, 2);
    },
  },
  {
    name: 'qazaDayCounts: журнал без since — все дни «до since», то есть из записей',
    run: (context) => {
      // В хранилище такой лог не выживает (loadQazaLog его отбрасывает),
      // но функция чистая, и правило то же: без since ни один день не «наступил»,
      // поэтому все дни читаются из h6 — сравнение с undefined всегда ложно
      const records = {
        '2026-01-01': { h6: 5 },
        '2026-01-02': { h6: 1 },
      };
      const log = {
        version: 1,
        entries: [
          { date: '2026-01-01', namaz: 'fajr', source: 'done' },
          { date: '2026-01-01', namaz: 'zuhr', source: 'done' },
          { date: '2026-01-01', namaz: 'asr', source: 'done' },
        ],
      };
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
      const result = context.qazaDayCounts(records, log, dates);

      assert.deepEqual(Array.from(result.values), [5, 1, 0]);
      assert.equal(result.total, 6);
    },
  },
  {
    name: 'qazaDayCounts: журнал заведён, но пуст — дни с since дают ноль, а не h6',
    run: (context) => {
      const records = {
        '2026-01-01': { h6: 3 },
        '2026-01-02': { h6: 3 },
        '2026-01-03': { h6: 3 },
      };
      const log = { version: 1, since: '2026-01-01', entries: [] };
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
      const result = context.qazaDayCounts(records, log, dates);

      // Журнал — свидетель с since: пустота журнала означает «не выполнял»,
      // а не «вернуться к полю h6»
      assert.deepEqual(Array.from(result.values), [0, 0, 0]);
      assert.equal(result.total, 0);
    },
  },
  {
    name: 'qazaDayCounts: dates не массив — значений нет вовсе',
    run: (context) => {
      const result = context.qazaDayCounts({}, null, null);

      assert.deepEqual(Array.from(result.values), []);
      assert.equal(result.total, 0);
    },
  },
];

for (const scenario of qazaDayCountsCases) {
  test(scenario.name, () => {
    const { context } = loadApp();
    scenario.run(context);
  });
}
