// Закрытие модалки привычек: узел скрывается, а не пересобирается, и фокус
// возвращается туда, откуда модалку открыли (находка 3).
//
// why: замер в Chromium показал — закрытие крестиком после прохода по полям
// модалки выбрасывало активный элемент в <body>, схлопывало раскрытую строку
// экрана «Привычки» вместе с её несохранённым черновиком и сдвигало прокрутку.
// Причина: closeModal безусловно переливал innerHTML всего списка и не
// возвращал фокус. Вызывается он и на каждом переходе между экранами, где
// пересборка вообще не нужна.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Фейковый документ: узлы по id + счётчик перезаписей innerHTML у списка
// экрана и трек активного элемента.
function setup() {
  const app = loadApp();
  const writes = { edit: 0 };

  const node = (id, extra) => Object.assign({
    id: id,
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() { doc.activeElement = this; },
  }, extra || {});

  const nodes = {
    'habit-modal': node('habit-modal', { hidden: true }),
    'habit-list': node('habit-list'),
    'habits-edit-list': node('habits-edit-list'),
    'form-error': node('form-error'),
    'habits-edit-add': node('habits-edit-add'),
  };

  Object.defineProperty(nodes['habits-edit-list'], 'innerHTML', {
    get() { return this._html || ''; },
    set(value) { this._html = value; writes.edit++; },
  });

  const doc = {
    activeElement: null,
    nodes: nodes,
    getElementById: (id) => nodes[id] || null,
    createElement: () => ({ innerHTML: '', content: null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };

  app.sandbox.document = doc;
  // Список экрана нарисован ровно тем состоянием, которое увидит модалка
  app.run('appState.habits = loadHabits(); renderHabitsEditList();');
  writes.edit = 0;

  return { app, doc, nodes, writes };
}

test('закрытие скрывает существующий узел и возвращает фокус кнопке', () => {
  const { app, doc, nodes } = setup();

  doc.activeElement = nodes['habits-edit-add'];
  app.run('openModal();');
  assert.equal(nodes['habit-modal'].hidden, false, 'модалка открыта');

  // фокус ушёл внутрь модалки
  doc.activeElement = nodes['form-error'];
  app.run('closeModal();');

  assert.equal(nodes['habit-modal'].hidden, true, 'модалка скрыта тем же узлом');
  assert.equal(doc.activeElement, nodes['habits-edit-add'],
    'фокус вернулся к кнопке, открывшей модалку');
});

test('закрытие без правок не пересобирает список экрана', () => {
  const { app, doc, writes } = setup();

  doc.activeElement = doc.nodes['habits-edit-add'];
  app.run('openModal();');
  app.run('closeModal();');

  assert.equal(writes.edit, 0, 'данные не менялись — innerHTML списка не тронут');
});

test('закрытие после добавления привычку список пересобирает', () => {
  const { app, doc, writes, nodes } = setup();

  doc.activeElement = doc.nodes['habits-edit-add'];
  app.run('openModal();');
  app.run('addHabit({ name: "Прогулка", type: "boolean", unit: "", goal: null });');
  app.run('appState.habits = loadHabits();');
  app.run('closeModal();');

  assert.equal(writes.edit, 1, 'список разошёлся с данными — закрытие его пересобрало');
  assert.match(nodes['habits-edit-list'].innerHTML, /Прогулка/);
});

test('уже скрытая модалка: closeModal не делает ничего', () => {
  const { app, writes } = setup();

  // так вызывает switchAppView на каждом переходе
  app.run('closeModal();');
  app.run('closeModal();');

  assert.equal(writes.edit, 0, 'холостой вызов не стоит пересборки списка');
});
