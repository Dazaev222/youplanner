// Тесты миграций (js/data/migrations.js).
//
// Контракт: сначала действие, потом пометка. Сбой записи пометки (квота)
// не должен отменять сделанное действие навсегда — повторный прогон после
// сбоя обязана проходить без дублей результата: migrateDropTasks безопасен
// сам по себе (removeItem повторобезопасен), у migratePressHabit повторный
// прогон спасает проверка «привычка с таким id уже есть».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const HABITS_KEY = 'youplanner.habits';
const TASKS_KEY = 'youplanner.tasks';
const MIGRATIONS_KEY = 'youplanner.migrations';

function seedHabits(sandbox, habits) {
  sandbox.localStorage.setItem(HABITS_KEY, JSON.stringify(habits));
}

function readHabits(sandbox) {
  const raw = sandbox.localStorage.getItem(HABITS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function pressCount(sandbox) {
  return readHabits(sandbox).filter(function (h) { return h.id === 'h12'; }).length;
}

// Обёртка setItem: бросает на записи конкретного ключа (симуляция отказа
// квоты), остальные уходят в оригинальный Map-стаб. Возвращает восстановление.
function failSetItemFor(storage, key) {
  const original = storage.setItem;
  storage.setItem = function (k, v) {
    if (k === key) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(k, v);
  };
  return function restore() { storage.setItem = original; };
}

test('сбой записи пометки: «Пресс» добавлена, повторный прогон без дублей', () => {
  const app = loadApp();
  // Сложившийся список без «Пресс» (h12)
  seedHabits(app.sandbox, [
    { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
    { id: 'h7', name: 'Спорт', type: 'choice', unit: '', goal: null, time: null },
  ]);
  const restore = failSetItemFor(app.sandbox.localStorage, MIGRATIONS_KEY);

  app.context.migratePressHabit();

  // Действие прошло, пометка не записалась: следующий запуск обязан
  // повторить миграцию, а не считать её сделанной
  assert.equal(pressCount(app.sandbox), 1, 'первый прогон должен добавить «Пресс»');
  assert.equal(app.sandbox.localStorage.getItem(MIGRATIONS_KEY), null,
    'пометка при отказе записи не должна была сохраниться');

  restore();
  app.context.migratePressHabit();

  assert.equal(pressCount(app.sandbox), 1, 'повторный прогон не должен дублировать «Пресс»');
  const migrations = JSON.parse(app.sandbox.localStorage.getItem(MIGRATIONS_KEY));
  assert.equal(migrations.press, true, 'миграция должна быть помечена после удавшегося повтора');
});

test('«Пресс» уже в списке: пометка ставится, удалённая после — не возвращается', () => {
  const app = loadApp();
  // Список уже содержит «Пресс» (например, с устройства, где она была изначально)
  seedHabits(app.sandbox, [
    { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
    { id: 'h12', name: 'Пресс', type: 'choice', unit: '', goal: null, time: null },
  ]);

  // Первый прогон: привычка уже есть — только пометка, список не меняется
  app.context.migratePressHabit();
  assert.equal(pressCount(app.sandbox), 1);
  let migrations = JSON.parse(app.sandbox.localStorage.getItem(MIGRATIONS_KEY));
  assert.equal(migrations.press, true, 'прогон по списку с «Пресс» должен поставить пометку');

  // Человек удалил «Пресс»: помеченная миграция больше не добавляет её
  seedHabits(app.sandbox, [{ id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null }]);
  app.context.migratePressHabit();
  assert.equal(pressCount(app.sandbox), 0,
    'удалённый «Пресс» не должен возвращаться после пометки миграции');
});

test('сбой записи пометки: migrateDropTasks стирает задачи, повтор доводит пометку', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem(TASKS_KEY, JSON.stringify([{ text: 'дело' }]));
  const restore = failSetItemFor(app.sandbox.localStorage, MIGRATIONS_KEY);

  app.context.migrateDropTasks();

  assert.equal(app.sandbox.localStorage.getItem(TASKS_KEY), null,
    'раздел задач должен быть стёрт уже первым прогоном');

  restore();
  app.context.migrateDropTasks();

  const migrations = JSON.parse(app.sandbox.localStorage.getItem(MIGRATIONS_KEY));
  assert.equal(migrations['drop-tasks'], true, 'повторный прогон должен поставить пометку');
  assert.equal(app.sandbox.localStorage.getItem(TASKS_KEY), null);
});
