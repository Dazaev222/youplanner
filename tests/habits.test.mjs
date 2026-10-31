// Тесты чтения списка привычек (loadHabits) — политика битых элементов.
//
// Контракт: раздел не роняется битым элементом. Отсутствие ключа, пустой
// список и битый JSON — «привычек нет» (как было); битый элемент ВНУТРИ
// списка (null, мусор, привычка без id или с неизвестным типом) молча
// отбрасывается, годные соседи остаются. Правила минимальны — ровно поля,
// которых требует рендер (id, name, type), как в validCloudHabits
// (js/sync/validators.js); проверка продублирована в habits.js, потому что
// data не импортирует sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const HABITS_KEY = 'youplanner.habits';

function seedHabits(sandbox, habits) {
  sandbox.localStorage.setItem(HABITS_KEY, JSON.stringify(habits));
}

// Результат из песочницы несёт прототипы её реалма: прогон через JSON
// возвращает обычные объекты этого реалма, и deepEqual сравнивает честно.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('список с null и битыми элементами: мусор отфильтрован, годные остались', () => {
  const app = loadApp();
  seedHabits(app.sandbox, [
    null,
    { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
    42,
    { id: '', name: 'Без id', type: 'boolean' },
    { id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 },
    { id: 'h9', name: 'Работа с текстами', type: 'какой-то-мусор' },
    'строка вместо привычки',
    { name: 'Без id вообще' },
    [],
  ]);

  const habits = app.context.loadHabits();

  assert.deepEqual(plain(habits), [
    { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
    { id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 },
  ], 'должны остаться только привычки с id, name и известным типом');
});

test('годные элементы не теряют поля, ключ не перезаписывается', () => {
  const app = loadApp();
  const stored = [
    { id: 'h12', name: 'Пресс', type: 'choice', unit: '', goal: null, time: null },
    { id: 'битый', name: 7, type: 'choice' },
  ];
  seedHabits(app.sandbox, stored);

  const habits = app.context.loadHabits();

  assert.deepEqual(plain(habits), [
    { id: 'h12', name: 'Пресс', type: 'choice', unit: '', goal: null, time: null },
  ], 'годный элемент должен вернуться как был');
  assert.deepEqual(JSON.parse(app.sandbox.localStorage.getItem(HABITS_KEY)), stored,
    'loadHabits не пишет в хранилище — чистка только в памяти');
});

test('края: пустой список, не-массив и битый JSON — по-прежнему «привычек нет»', () => {
  const app = loadApp();
  seedHabits(app.sandbox, []);
  assert.deepEqual(plain(app.context.loadHabits()), []);

  seedHabits(app.sandbox, { id: 'h1' });
  assert.deepEqual(plain(app.context.loadHabits()), []);

  app.sandbox.localStorage.setItem(HABITS_KEY, '{битый json');
  assert.deepEqual(plain(app.context.loadHabits()), []);
});
