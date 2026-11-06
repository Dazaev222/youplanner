// Круг прогресса главной таблицы: «М: N%» обязан показывать тот же месяц,
// что и раздел «Статистика → Месяц» — текущий, с 1-го числа по сегодня.
//
// monthPercent (js/ui/main-table.js) считал окно от месяца ОТОБРАЖАЕМОЙ
// недели (appState.weekStart): в дни, когда понедельник недели выпадает в
// предыдущий месяц, круг и статистика показывали два разных месячных
// процента для одной привычки и одного дня. Недели при этом навигируют
// стрелками (weekStart двигается на ±7 дней), поэтому окно «плавало».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { addDays, getWeekStart, toISODate } from '../js/core/dates.js';

function habit(id) {
  return { id: id, name: 'Тест', unit: '', type: 'boolean', goal: null };
}

test('месячный процент круга — текущий месяц, даже когда неделя ушла в прошлый', () => {
  const app = loadApp();
  const now = new Date();
  const firstOfCurrent = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthLast = addDays(firstOfCurrent, -1);

  // Привычка, отмеченная ВЕСЬ прошлый месяц: прошломесячное окно даёт 100%,
  // текущий месяц пуст — 0%. Окна обязаны различаться в любой день года.
  const records = {};
  for (let day = 1; day <= prevMonthLast.getDate(); day++) {
    records[toISODate(new Date(prevMonthLast.getFullYear(), prevMonthLast.getMonth(), day))] = { h1: true };
  }
  app.sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([habit('h1')]));

  // Неделя, отображаемая в таблице, — внутри ПРОШЛОГО месяца (10-е число),
  // как после навигации стрелками назад (main-table.js двигает weekStart).
  app.run('appState.weekStart = new Date(' + prevMonthLast.getFullYear() + ', ' +
    prevMonthLast.getMonth() + ', 10)');
  app.run('appState.habits = loadHabits()');

  const percent = app.run('monthPercent(findHabit("h1"))');
  assert.equal(percent, 0,
    'в текущем месяце отметок нет: круг «М:» показывает 0%, а не прошломесячные 100%');
});

test('недельный процент круга по-прежнему следует за отображаемой неделей', () => {
  const app = loadApp();
  const now = new Date();
  const firstOfCurrent = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthLast = addDays(firstOfCurrent, -1);
  // Понедельник недели, целиком живущей в прошлом месяце: 10-е число + его
  // неделя — максимум 16-е, месяц не пересекают
  const weekStart = getWeekStart(
    new Date(prevMonthLast.getFullYear(), prevMonthLast.getMonth(), 10));

  const records = {};
  for (let i = 0; i < 7; i++) {
    records[toISODate(addDays(weekStart, i))] = { h1: true };
  }
  app.sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([habit('h1')]));

  app.run('appState.weekStart = new Date(' + weekStart.getFullYear() + ', ' +
    weekStart.getMonth() + ', ' + weekStart.getDate() + ')');
  app.run('appState.habits = loadHabits()');

  const percent = app.run('weekPercent(findHabit("h1"))');
  assert.equal(percent, 100,
    'недельный круг считается по отображаемой неделе — на ней все дни отмечены');
});
