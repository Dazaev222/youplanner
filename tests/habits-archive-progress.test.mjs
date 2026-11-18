// Архив привычек: потребители ежедневного прогресса.
//
// Контракт: полный список привычек остаётся в appState/localStorage, а все
// видимые агрегаты — карточки дня, таблица недели, снимок главного экрана,
// статистика и контекст ассистента — читают только активные привычки
// (isArchived !== true). Архивная привычка исчезает с главного экрана и из
// средних процентов, но её записи не удаляются: после возврата из архива
// сегодняшняя отметка снова видна.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const HABITS_KEY = 'youplanner.habits';
const RECORDS_KEY = 'youplanner.records';

const ACTIVE_1 = { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null };
const ACTIVE_2 = { id: 'h3', name: 'Вода', type: 'number', unit: 'ст.', goal: 8 };
const ARCHIVED = {
  id: 'h2', name: 'Архивная', type: 'boolean', unit: '', goal: null,
  isArchived: true, archiveVersion: { counter: 1, actorId: 'dev' },
};

function seed(app, habits, records) {
  app.sandbox.localStorage.setItem(HABITS_KEY, JSON.stringify(habits));
  app.sandbox.localStorage.setItem(RECORDS_KEY, JSON.stringify(records || {}));
}

function today(app) {
  return app.context.toISODate(new Date());
}

function storedHabits(app) {
  return JSON.parse(app.sandbox.localStorage.getItem(HABITS_KEY));
}

// Фейковый документ только для отрисовки: реальные рендереры пишут строки в
// innerHTML/template, а тест читает разметку.
function installDom(app, nodes) {
  app.sandbox.document = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => ({ innerHTML: '', content: null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };
}

function nameList(html, className) {
  const re = new RegExp('class="' + className + '"[^>]*>([^<]*)', 'g');
  return Array.from(html.matchAll(re), (m) => m[1]);
}

function dayCards(app) {
  const node = { innerHTML: '' };
  installDom(app, { 'day-cards': node });
  app.run('appState.habits = loadHabits(); renderDayCards();');
  return node.innerHTML;
}

test('карточки дня: архивной привычки нет, порядок активных сохранён', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED, ACTIVE_2], {
    [today(app)]: { h1: true, h2: true, h3: 8 },
  });

  const html = dayCards(app);

  assert.deepEqual(nameList(html, 'day-card-name'), ['Фаджр', 'Вода'],
    'карточки обязаны идти в порядке полного списка, но без архива');
  assert.ok(!html.includes('Архивная'), 'архивная привычка попала на главный экран');
});

test('таблица недели: строки только для активных привычек', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED, ACTIVE_2], {
    [today(app)]: { h1: true, h2: true, h3: 8 },
  });

  const templates = [];
  app.sandbox.document = {
    getElementById: () => null,
    createElement: () => {
      const node = { content: {} };
      let html = '';
      Object.defineProperty(node, 'innerHTML', {
        get() { return html; },
        set(value) { html = value; templates.push(value); },
      });
      return node;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };
  app.run('appState.habits = loadHabits(); appState.weekStart = getWeekStart(new Date()); renderTable();');

  const body = templates[1] || '';
  assert.ok(templates.length >= 2, 'renderTable обязан собрать шапку и тело');
  assert.deepEqual(nameList(body, 'habit-name'), ['Фаджр', 'Вода']);
  assert.ok(!body.includes('Архивная'));
  assert.ok(!body.includes('data-habit-id="h2"'), 'строка архивной привычки осталась в таблице');
});

test('снимок главного экрана не содержит архивных ячеек и кругов', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED, ACTIVE_2], {
    [today(app)]: { h1: true, h2: true, h3: 8 },
  });

  const snapshot = app.run(
    'appState.habits = loadHabits(); appState.weekStart = getWeekStart(new Date());' +
    'captureMainSnapshot()'
  );

  assert.ok(Object.keys(snapshot.cells).every((key) => !key.endsWith('|h2')),
    'снимок хранит ячейки архивной привычки');
  assert.deepEqual(Object.keys(snapshot.circles), ['h1', 'h3']);
  assert.ok(!String(snapshot.habitsSig).includes('h2'),
    'сигнатура списка привычек учитывает архивную привычку');
});

test('пустой активный список: главный экран объясняет, где вернуть привычки', () => {
  const app = loadApp();
  seed(app, [
    { ...ACTIVE_1, isArchived: true, archiveVersion: { counter: 1, actorId: 'dev' } },
    { ...ACTIVE_2, isArchived: true, archiveVersion: { counter: 1, actorId: 'dev' } },
  ], { [today(app)]: { h1: true } });

  const cards = { innerHTML: '' };
  const emptyNote = { hidden: true, textContent: '' };
  installDom(app, { 'day-cards': cards, 'habits-empty-note': emptyNote });

  app.run('appState.habits = loadHabits(); appState.weekStart = getWeekStart(new Date()); renderMainView();');

  assert.equal(emptyNote.hidden, false, 'без активных привычек экран обязан сказать, где они');
  assert.ok(!cards.innerHTML.includes('Фаджр'), 'архивная привычка отрисована как активная');
});

test('возврат из архива: сегодняшняя отметка снова видна в карточке', () => {
  const app = loadApp();
  seed(app, [
    { ...ACTIVE_1, isArchived: true, archiveVersion: { counter: 1, actorId: 'dev' } },
    ARCHIVED,
  ], { [today(app)]: { h1: true } });

  assert.ok(!dayCards(app).includes('data-habit-id="h1"'),
    'архивная привычка не должна рисоваться до возврата');

  assert.equal(app.context.setHabitArchived('h1', false).ok, true);
  const html = dayCards(app);

  assert.ok(html.includes('data-habit-id="h1"'), 'привычка не вернулась на главный экран');
  assert.ok(/data-habit-id="h1"[^>]*checked/.test(html), 'сегодняшняя отметка потерялась');
});

test('статистика: средний процент считается только по активным привычкам', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED], { [today(app)]: { h1: true } });

  const values = {};
  app.sandbox.document = {
    getElementById: () => null,
    createElement: () => ({ innerHTML: '', content: null }),
    querySelector: (selector) => ({
      get textContent() { return values[selector] || ''; },
      set textContent(value) { values[selector] = value; },
    }),
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };

  app.context.renderStatsView();

  assert.equal(values['#stats-list [data-stat="habits"] .stats-row-value'], '100%',
    'архивная привычка с нулём размыла средний процент');
});

test('статистика: список привычек не показывает архивные', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED, ACTIVE_2], { [today(app)]: { h1: true } });

  const list = { innerHTML: '' };
  installDom(app, { 'stats-habits-list': list });
  app.context.renderStatsHabitsView();

  assert.ok(list.innerHTML.includes('Фаджр'));
  assert.ok(list.innerHTML.includes('Вода'));
  assert.ok(!list.innerHTML.includes('Архивная'), 'архив попал в список статистики');
});

test('анализ привычек в чате не называет архивную привычку', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED], { [today(app)]: { h1: true, h2: true } });

  const snapshot = app.context.buildHabitsAnalysisSnapshot(new Date());

  assert.ok(snapshot.includes('Фаджр'));
  assert.ok(!snapshot.includes('Архивная'), 'архивная привычка попала в анализ');
});

test('контекст ассистента не содержит архивных привычек и их записей', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED], { [today(app)]: { h1: true, h2: true } });

  const system = app.context.buildMessages()[0].content;

  assert.ok(!system.includes('Архивная'), 'архивная привычка попала в контекст трекера');
  assert.ok(!system.includes('"h2"'), 'записи архивной привычки попали в контекст трекера');
  assert.ok(system.includes('Фаджр'));
});

test('архивация не переписывает записи привычки', () => {
  const app = loadApp();
  seed(app, [ACTIVE_1, ARCHIVED], { [today(app)]: { h1: true, h2: true } });
  const before = app.sandbox.localStorage.getItem(RECORDS_KEY);

  app.context.setHabitArchived('h1', true);

  assert.equal(app.sandbox.localStorage.getItem(RECORDS_KEY), before);
  assert.equal(storedHabits(app).find((h) => h.id === 'h1').archiveVersion.counter, 1);
});

test('устаревшие DOM-события архивного id не создают отметок', () => {
  const app = loadApp();
  const date = today(app);
  seed(app, [ACTIVE_1, ARCHIVED], { [date]: { h1: true, h2: true } });
  app.run('appState.habits = loadHabits();');
  const before = app.sandbox.localStorage.getItem(RECORDS_KEY);

  const attrs = { 'data-habit-id': 'h2', 'data-date': date };
  const cell = { getAttribute: (n) => attrs[n] || null, querySelector: () => null };

  // Снятие галочки в строке, которой больше нет на экране (событие ушло
  // до перерисовки после архивации)
  const checkTarget = {
    classList: { contains: (c) => c === 'cell-check' },
    closest: (sel) => (sel === 'td.cell' || sel === '.day-card-controls' ? cell : null),
    checked: false,
  };
  app.sandbox.__evtCheck = checkTarget;
  app.run('onTableChange({ target: __evtCheck })');

  // Клик по «✗» той же скрытой строки
  const crossTarget = {
    closest: (sel) => (sel === '.cell-x'
      ? crossTarget
      : (sel === 'td.cell' || sel === '.day-card-controls' ? cell : null)),
    getAttribute: (n) => attrs[n] || null,
  };
  app.sandbox.__evtCross = crossTarget;
  app.run('onTableClick({ target: __evtCross })');

  assert.equal(app.sandbox.localStorage.getItem(RECORDS_KEY), before,
    'событие архивной строки изменило записи');
});
