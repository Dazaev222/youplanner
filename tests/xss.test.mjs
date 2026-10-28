// Регрессия YP-05: пользовательские строки (название и единица привычки,
// пункт расписания) не должны становиться разметкой ни в одном рендерере.
// Песочница та же, что у core.test.mjs: модули исполняются одним скриптом,
// DOM подменён приёмником innerHTML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const PAYLOAD = '<img src=x onerror="alert(1)">';
const ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';

// Элементы с id из ids получают innerHTML-приёмник, остальные — null:
// рендерер не должен спотыкаться о служебные узлы, которых в тесте нет.
function capture(app, ids) {
  const nodes = {};
  ids.forEach((id) => {
    nodes[id] = { innerHTML: '', textContent: '', hidden: false };
  });
  app.sandbox.document.getElementById = (id) => nodes[id] || null;
  app.sandbox.document.querySelector = () => null;
  app.sandbox.document.querySelectorAll = () => [];
  return nodes;
}

function assertNoMarkup(html) {
  assert.ok(html.includes(ESCAPED), 'ожидалось экранирование: ' + html);
  assert.ok(!html.includes('<img'), 'payload попал в разметку: ' + html);
}

function addHostileHabit(app) {
  const habit = app.context.addHabit({
    name: PAYLOAD,
    type: 'number',
    unit: PAYLOAD,
    goal: 1,
  });
  assert.ok(habit, 'привычка не сохранилась');
  return habit;
}

test('renderHabitList экранирует название и единицу', () => {
  const app = loadApp();
  addHostileHabit(app);
  const nodes = capture(app, ['habit-list']);
  app.context.openModal();
  assertNoMarkup(nodes['habit-list'].innerHTML);
});

test('renderHabitsEditList экранирует название и единицу', () => {
  const app = loadApp();
  addHostileHabit(app);
  const nodes = capture(app, ['habits-edit-list']);
  app.run('appState.habits = loadHabits(); renderHabitsEditList();');
  assertNoMarkup(nodes['habits-edit-list'].innerHTML);
});

test('renderDayCards экранирует название и единицу', () => {
  const app = loadApp();
  addHostileHabit(app);
  const nodes = capture(app, ['day-cards']);
  app.run('appState.habits = loadHabits(); renderDayCards();');
  assertNoMarkup(nodes['day-cards'].innerHTML);
});

test('renderTable экранирует название и единицу', () => {
  const app = loadApp();
  addHostileHabit(app);

  const templates = [];
  app.sandbox.document.createElement = () => {
    const node = { content: {} };
    let html = '';
    Object.defineProperty(node, 'innerHTML', {
      get() { return html; },
      set(value) { html = value; templates.push(value); },
    });
    return node;
  };
  app.run('appState.habits = loadHabits(); appState.weekStart = getWeekStart(new Date()); renderTable();');
  assertNoMarkup(templates.join(''));
});

test('renderScheduleView экранирует текст пункта', () => {
  const app = loadApp();
  app.run(
    'var s = loadSchedule(); s.weekday = ' +
    JSON.stringify([{ time: '09:00', text: PAYLOAD }]) +
    '; localStorage.setItem(STORAGE_KEYS.schedule, JSON.stringify(s));'
  );
  const nodes = capture(app, ['schedule-list']);
  app.context.renderScheduleView();
  assertNoMarkup(nodes['schedule-list'].innerHTML);
});

test('renderStatsHabitsView экранирует название привычки', () => {
  const app = loadApp();
  addHostileHabit(app);
  const nodes = capture(app, ['stats-habits-list']);
  app.context.renderStatsHabitsView();
  assertNoMarkup(nodes['stats-habits-list'].innerHTML);
});
