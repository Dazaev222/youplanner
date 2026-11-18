// Архив привычек в резервных копиях: экспорт, разбор, импорт, восстановление.
// Копия сохраняет пару и отметки, старые копии читаются, повреждённая пара
// нормализуется без потери привычки, архивный список не засевается дефолтами.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const HABITS_KEY = 'youplanner.habits';
const RECORDS_KEY = 'youplanner.records';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function archivedHabit(id, counter, actorId) {
  return {
    id, name: 'Привычка ' + id, type: 'boolean', unit: '', goal: null,
    isArchived: true, archiveVersion: { counter, actorId },
  };
}

test('round-trip: экспорт и импорт сохраняют архив, версии и отметки', () => {
  const app = loadApp();
  const records = { '2026-11-18': { h1: true } };
  app.sandbox.localStorage.setItem(HABITS_KEY, JSON.stringify([archivedHabit('h1', 3, 'dev')]));
  app.sandbox.localStorage.setItem(RECORDS_KEY, JSON.stringify(records));

  const backup = app.context.buildBackup();
  assert.deepEqual(plain(backup.habits[0].archiveVersion), { counter: 3, actorId: 'dev' });

  const parsed = app.context.parseBackup(JSON.stringify(backup));
  assert.ok(parsed, 'собственная копия отвергнута');
  assert.equal(app.context.applyBackup(parsed), true);

  const stored = JSON.parse(app.sandbox.localStorage.getItem(HABITS_KEY));
  assert.deepEqual(stored[0].archiveVersion, { counter: 3, actorId: 'dev' });
  assert.equal(stored[0].isArchived, true);
  assert.deepEqual(JSON.parse(app.sandbox.localStorage.getItem(RECORDS_KEY)), records,
    'отметки архивной привычки не потеряны');
});

test('старая копия без полей архива читается и остаётся активной', () => {
  const app = loadApp();
  const backup = app.context.buildBackup();
  backup.habits = [{ id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null }];

  const parsed = app.context.parseBackup(JSON.stringify(backup));
  assert.ok(parsed);
  assert.equal(parsed.habits[0].isArchived, undefined);

  assert.equal(app.context.applyBackup(parsed), true);
  const stored = JSON.parse(app.sandbox.localStorage.getItem(HABITS_KEY));
  assert.equal(stored[0].isArchived, undefined);
  assert.equal(app.context.selectActiveHabits(app.context.loadHabits()).length, 1);
});

test('повреждённая пара при импорте снимается, привычка остаётся', () => {
  const app = loadApp();
  const backup = app.context.buildBackup();
  backup.habits = [
    { id: 'h1', name: 'Флаг без версии', type: 'boolean', isArchived: true },
    { id: 'h2', name: 'Версия без флага', type: 'boolean',
      archiveVersion: { counter: 3, actorId: 'dev' } },
    archivedHabit('h3', 2, 'dev'),
  ];

  const parsed = app.context.parseBackup(JSON.stringify(backup));
  assert.ok(parsed, 'повреждённая пара не должна ронять весь файл');
  assert.deepEqual(plain(parsed.habits.map(h => h.id)), ['h1', 'h2', 'h3']);
  assert.equal(parsed.habits[0].isArchived, undefined);
  assert.equal(parsed.habits[0].archiveVersion, undefined);
  assert.equal(parsed.habits[1].archiveVersion, undefined);
  assert.deepEqual(plain(parsed.habits[2].archiveVersion), { counter: 2, actorId: 'dev' });
});

test('все привычки в архиве: импорт не сеет дефолты и не считает список пустым', () => {
  const app = loadApp();
  const backup = app.context.buildBackup();
  backup.habits = [archivedHabit('h1', 1, 'a'), archivedHabit('h2', 1, 'a')];
  backup.records = {};

  const parsed = app.context.parseBackup(JSON.stringify(backup));
  assert.equal(app.context.applyBackup(parsed), true);
  app.context.settleHabitsAfterSync({ reachable: true, serverEmpty: true });

  const habits = app.context.loadHabits();
  const active = app.context.selectActiveHabits(habits);
  // Миграция «Пресс» — отдельное правило и может добавить h12; запрещено
  // именно повторное засевание полного набора дефолтов из «пустого» списка.
  assert.ok(active.every(h => h.id === 'h12'), 'дефолты не должны засеваться');
  assert.equal(habits.filter(h => h.id === 'h1' || h.id === 'h2').length, 2);
  assert.ok(habits.length < 12, 'полный набор дефолтов не должен появиться');
});

test('копия с архивной привычкой сохраняет порядок полного списка', () => {
  const app = loadApp();
  const backup = app.context.buildBackup();
  backup.habits = [
    { id: 'h1', name: 'Первая', type: 'boolean' },
    archivedHabit('h2', 1, 'a'),
    { id: 'h3', name: 'Третья', type: 'boolean' },
  ];

  const parsed = app.context.parseBackup(JSON.stringify(backup));
  assert.equal(app.context.applyBackup(parsed), true);
  assert.deepEqual(JSON.parse(app.sandbox.localStorage.getItem(HABITS_KEY)).map(h => h.id),
    ['h1', 'h2', 'h3']);
});
