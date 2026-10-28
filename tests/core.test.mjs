// Юнит-тесты ядра (Фаза 3.1): js/core/{dates,storage,dom}.js — чистые
// утилиты без доменной логики, поэтому проверяются напрямую через песочницу.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

test('toISODate собирает дату из локальных компонентов', () => {
  const { context } = loadApp();
  assert.equal(context.toISODate(new Date(2026, 9, 5)), '2026-10-05');
  assert.equal(context.toISODate(new Date(2026, 0, 1)), '2026-01-01');
});

test('parseISODate/addDays ходят по календарю через границу месяца', () => {
  const { context } = loadApp();
  const d = context.parseISODate('2026-10-31');
  assert.equal(d.getMonth(), 9);
  const next = context.addDays(d, 1);
  assert.equal(context.toISODate(next), '2026-11-01');
  assert.equal(context.toISODate(context.addDays(d, -1)), '2026-10-30');
});

test('getWeekStart возвращает понедельник недели', () => {
  const { context } = loadApp();
  // 2026-10-24 — суббота; понедельник той недели — 2026-10-19
  assert.equal(context.toISODate(context.getWeekStart(new Date(2026, 9, 24))), '2026-10-19');
  // сам понедельник остаётся собой
  assert.equal(context.toISODate(context.getWeekStart(new Date(2026, 9, 19))), '2026-10-19');
});

test('getMonthDatesToToday обрезает будущий месяц и отдаёт прошлый целиком', () => {
  const { context } = loadApp();
  const app = loadApp(); // отдельный контекст: «сегодня» внутри — реальная дата
  const now = new Date();
  // прошлый месяц: все его дни, включая последние
  const past = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const dates = app.context.getMonthDatesToToday(past.getFullYear(), past.getMonth());
  const lastDay = new Date(past.getFullYear(), past.getMonth() + 1, 0).getDate();
  assert.equal(dates.length, lastDay);
  assert.equal(dates[0], context.toISODate(new Date(past.getFullYear(), past.getMonth(), 1)));
});

test('escapeHtml экранирует все пять опасных символов', () => {
  const { context } = loadApp();
  assert.equal(context.escapeHtml('<img src=x onerror="a">&\''),
    '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  assert.equal(context.escapeHtml(null), '');
  assert.equal(context.escapeHtml(undefined), '');
});

test('pad2 дополняет до двух знаков', () => {
  const { context } = loadApp();
  assert.equal(context.pad2(7), '07');
  assert.equal(context.pad2(42), '42');
});

test('cssEscape обезвреживает кавычки и слэши для селектора', () => {
  const { context } = loadApp();
  // в песочнице нет CSS.escape — работает fallback-ветка: кавычка и слэш
  // получают бэкслэш, разомкнуть селектор ими нельзя
  assert.equal(context.cssEscape('a"b\\c'), 'a\\"b\\\\c');
});

test('handleNetworkError: единый текст и подменяемый показ', () => {
  const { context } = loadApp();
  const shown = [];
  const message = context.handleNetworkError(null, {
    display: (text) => shown.push(text),
  });
  assert.equal(message,
    'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
  assert.deepEqual(shown, [message]);

  const silent = [];
  const custom = context.handleNetworkError(null, {
    silent: true,
    message: 'свой текст',
    display: (text) => silent.push(text),
  });
  assert.equal(custom, 'свой текст');
  assert.deepEqual(silent, []);
});
