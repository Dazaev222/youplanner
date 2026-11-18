// Архив привычек: экран, вход/выход и действия.
//
// Контракт: архив открывается строкой из Настроек, «Назад» возвращает в
// Настройки. «В архив» на экране правки спрашивает подтверждение и переносит
// привычку без удаления записей; «Вернуть» в архиве делает её активной снова.
// Ошибка записи видна человеку и не меняет состояние. Повторный клик не
// создаёт вторую запись. Имена экранируются. Слушатели навешиваются один раз
// на статичный контейнер — перерисовки их не дублируют.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const HABITS_KEY = 'youplanner.habits';
const RECORDS_KEY = 'youplanner.records';

const ACTIVE = { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null };
const ARCHIVED = {
  id: 'h2', name: 'Бег', type: 'boolean', unit: '', goal: null,
  isArchived: true, archiveVersion: { counter: 1, actorId: 'dev' },
};

function node(extra) {
  const listeners = {};
  return Object.assign({
    innerHTML: '',
    hidden: false,
    textContent: '',
    disabled: false,
    listeners,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  }, extra || {});
}

function storedHabits(app) {
  return JSON.parse(app.sandbox.localStorage.getItem(HABITS_KEY));
}

function setup(habits) {
  const app = loadApp();
  app.sandbox.requestAnimationFrame = (fn) => { fn(); return 1; };
  app.sandbox.cancelAnimationFrame = () => {};
  app.sandbox.localStorage.setItem(HABITS_KEY, JSON.stringify(habits));
  app.sandbox.localStorage.setItem(RECORDS_KEY, '{}');

  const nodes = {
    'habits-edit-list': node(),
    'habits-archive-list': node(),
    'habits-archive-empty': node({ hidden: true }),
    'habits-archive-error': node(),
    'settings-habits-archive': node(),
    'habits-archive-back': node(),
    'day-cards': node(),
  };

  app.sandbox.document = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => ({ innerHTML: '', content: null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };

  app.run('appState.habits = loadHabits();');
  return { app, nodes };
}

function click(target, event) {
  const list = target.listeners.click || [];
  for (const fn of list) fn(event);
}

// Событие клика по кнопке внутри строки привычки. target.closest повторяет
// разбор делегированного обработчика: сначала заголовок аккордеона, затем
// строка li[data-habit-id], затем конкретная кнопка.
function actionEvent(habitId, selector) {
  const item = {
    getAttribute: (name) => (name === 'data-habit-id' ? habitId : null),
    querySelector: () => null,
    classList: { contains: () => false },
  };
  const action = { getAttribute: () => null };
  return {
    item,
    target: {
      closest(sel) {
        if (sel === '.habit-row-head') return null;
        if (sel === 'li[data-habit-id]') return item;
        if (sel === selector) return action;
        return null;
      },
      classList: { contains: () => false },
    },
  };
}

test('вход из Настроек открывает архив: только архивные привычки, активных нет', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();

  assert.equal((nodes['settings-habits-archive'].listeners.click || []).length, 1,
    'строка «Архив привычек» в Настройках не подключена');

  click(nodes['settings-habits-archive'], { target: null });

  assert.equal(app.run('currentView'), 'habits-archive');
  assert.ok(nodes['habits-archive-list'].innerHTML.includes('Бег'));
  assert.ok(!nodes['habits-archive-list'].innerHTML.includes('Фаджр'),
    'активная привычка попала в архив');
});

test('«Назад» из архива возвращает в Настройки', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();

  assert.equal((nodes['habits-archive-back'].listeners.click || []).length, 1,
    'кнопка «Назад» архива не подключена');
  click(nodes['habits-archive-back'], { target: null });

  assert.equal(app.run('currentView'), 'settings');
});

test('«В архив»: отмена подтверждения не меняет привычку', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();

  let confirmations = 0;
  app.sandbox.window.confirm = function () { confirmations++; return false; };

  click(nodes['habits-edit-list'], actionEvent('h1', '.edit-archive'));

  assert.equal(confirmations, 1, 'без вопроса человек не должен терять привычку с экрана');
  assert.equal(storedHabits(app).find((h) => h.id === 'h1').isArchived, undefined,
    'при отмене привычка осталась активной');
});

test('«В архив»: подтверждение переносит привычку и убирает её из списка правки', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();
  app.sandbox.window.confirm = () => true;

  click(nodes['habits-edit-list'], actionEvent('h1', '.edit-archive'));

  const habit = storedHabits(app).find((h) => h.id === 'h1');
  assert.equal(habit.isArchived, true);
  assert.ok(habit.archiveVersion, 'у архивной привычки должна быть версия');
  assert.ok(!nodes['habits-edit-list'].innerHTML.includes('Фаджр'),
    'архивная привычка осталась в списке правки');
});

test('«Вернуть»: привычка снова активна, пустое состояние архива показано', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();

  click(nodes['habits-archive-list'], actionEvent('h2', '.archive-restore'));

  const habit = storedHabits(app).find((h) => h.id === 'h2');
  assert.equal(habit.isArchived, false);
  assert.ok(!nodes['habits-archive-list'].innerHTML.includes('Бег'),
    'возвращённая привычка осталась в архиве');
  assert.equal(nodes['habits-archive-empty'].hidden, false,
    'пустой архив обязан показать пустое состояние');
});

test('ошибка записи видна и не выдаёт себя за успех', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();
  // Экран уже показан: список содержит строку, которую отказ не должен убрать
  assert.equal((nodes['settings-habits-archive'].listeners.click || []).length, 1);
  click(nodes['settings-habits-archive'], { target: null });

  const original = app.sandbox.localStorage.setItem;
  app.sandbox.localStorage.setItem = function (key, value) {
    if (key === HABITS_KEY) throw new Error('quota');
    return original.call(this, key, value);
  };

  click(nodes['habits-archive-list'], actionEvent('h2', '.archive-restore'));

  assert.ok(nodes['habits-archive-error'].textContent.length > 0,
    'отказ хранилища прошёл молча');
  assert.equal(storedHabits(app).find((h) => h.id === 'h2').isArchived, true,
    'при ошибке привычка не должна покидать архив');
  assert.ok(nodes['habits-archive-list'].innerHTML.includes('Бег'),
    'список перерисован как будто возврат удался');
});

test('двойной клик по «Вернуть» записывает изменение один раз', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();
  app.run('globalThis.__archiveChanges = 0;' +
    'bus.on("data:changed", function () { globalThis.__archiveChanges++; });');
  app.sandbox.window.confirm = () => true;

  const event = actionEvent('h2', '.archive-restore');
  click(nodes['habits-archive-list'], event);
  click(nodes['habits-archive-list'], event);

  assert.equal(app.run('globalThis.__archiveChanges'), 1,
    'повторный клик сделал вторую запись');
  assert.equal(storedHabits(app).find((h) => h.id === 'h2').isArchived, false);
});

test('название привычки в архиве экранируется', () => {
  const { app, nodes } = setup([ACTIVE, {
    ...ARCHIVED,
    name: '<img src=x onerror="alert(1)">',
  }]);
  app.context.bindNavEvents();

  click(nodes['settings-habits-archive'], { target: null });

  const html = nodes['habits-archive-list'].innerHTML;
  assert.ok(html.includes('&lt;img'), 'имя не экранировано: ' + html);
  assert.ok(!html.includes('<img'), 'payload попал в разметку: ' + html);
});

test('перерисовки архива не дублируют слушатели', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();

  assert.equal((nodes['habits-archive-list'].listeners.click || []).length, 1,
    'слушатель списка архива должен навешиваться один раз');

  app.context.switchAppView('habits-archive');
  app.context.switchAppView('main');
  app.context.switchAppView('habits-archive');

  assert.equal((nodes['habits-archive-list'].listeners.click || []).length, 1,
    'перерисовка экрана добавила второй слушатель');
});

test('архивация из списка правки сразу убирает привычку с главного экрана', () => {
  const { app, nodes } = setup([ACTIVE, ARCHIVED]);
  app.context.bindNavEvents();
  app.sandbox.window.confirm = () => true;
  app.run('globalThis.__archiveActions = 0;' +
    'bus.on("data:changed", function () { globalThis.__archiveActions++; });');

  click(nodes['habits-edit-list'], actionEvent('h1', '.edit-archive'));

  assert.equal(app.run('globalThis.__archiveActions'), 1, 'изменение не дошло до данных');
  app.run('appState.habits = loadHabits(); renderDayCards();');
  assert.ok(!nodes['day-cards'].innerHTML.includes('Фаджр'),
    'архивная привычка осталась в видимом прогрессе');
});
