// Архив обычных привычек: данные и обратимые операции.
//
// Контракт: привычка остаётся в полном массиве youplanner.habits; архив —
// неделимая пара {isArchived, archiveVersion {counter, actorId}}. Отсутствие
// полей — legacy-активное состояние. Невалидная пара нормализуется на границе
// без потери самой привычки. Архивация не трогает records и tombstones,
// повтор действия — no-op без роста версии, неизвестный id — явная ошибка.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const HABITS_KEY = 'youplanner.habits';
const RECORDS_KEY = 'youplanner.records';
const ACTOR_KEY = 'youplanner.habit.archive.actor';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const H1 = { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null };
const H2 = { id: 'h2', name: 'Зухр', type: 'boolean', unit: '', goal: null };

function seed(app, extra) {
  app.sandbox.localStorage.setItem(HABITS_KEY, JSON.stringify([H1, H2, ...(extra || [])]));
  app.sandbox.localStorage.setItem(RECORDS_KEY, JSON.stringify({
    '2026-11-17': { h1: true, h2: false },
    2026: 'не дата',
  }));
}

function stored(app) {
  return JSON.parse(app.sandbox.localStorage.getItem(HABITS_KEY));
}

function context(app) {
  return app.context;
}

test('legacy-привычка без полей считается активной', () => {
  const app = loadApp();
  seed(app);

  const habits = context(app).loadHabits();
  assert.deepEqual(plain(context(app).selectActiveHabits(habits).map(h => h.id)), ['h1', 'h2']);
  assert.deepEqual(plain(context(app).selectArchivedHabits(habits)), []);
  assert.equal(context(app).readHabitArchive(habits[0]).kind, 'legacy');
});

test('архивация создаёт пару counter=1, стабильный actor и событие data:changed', () => {
  const app = loadApp();
  seed(app);
  let events = 0;
  app.run('bus.on("data:changed", function () { globalThis.__archiveEvents = (globalThis.__archiveEvents || 0) + 1; })');

  const result = context(app).setHabitArchived('h1', true);

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const habit = stored(app)[0];
  assert.equal(habit.id, 'h1');
  assert.equal(habit.name, 'Фаджр');
  assert.equal(habit.isArchived, true);
  assert.deepEqual(habit.archiveVersion.counter, 1);
  assert.equal(typeof habit.archiveVersion.actorId, 'string');
  assert.ok(habit.archiveVersion.actorId.length > 0 && habit.archiveVersion.actorId.length <= 128);
  assert.equal(app.sandbox.localStorage.getItem(ACTOR_KEY), habit.archiveVersion.actorId,
    'actorId стабилен и хранится локально');
  assert.equal(context(app).selectArchivedHabits(context(app).loadHabits()).length, 1);
  assert.equal(app.run('globalThis.__archiveEvents'), 1 + events);
});

test('возврат из архива: counter растёт, порядок и записи не меняются', () => {
  const app = loadApp();
  seed(app);
  const recordsBefore = app.sandbox.localStorage.getItem(RECORDS_KEY);

  assert.equal(context(app).setHabitArchived('h1', true).ok, true);
  const restored = context(app).setHabitArchived('h1', false);

  assert.equal(restored.ok, true);
  assert.equal(restored.changed, true);
  const habits = stored(app);
  assert.deepEqual(habits.map(h => h.id), ['h1', 'h2']);
  assert.equal(habits[0].isArchived, false);
  assert.equal(habits[0].archiveVersion.counter, 2);
  assert.deepEqual(habits[1], H2, 'соседняя привычка не изменилась');
  assert.equal(app.sandbox.localStorage.getItem(RECORDS_KEY), recordsBefore,
    'архив не трогает отметки');
});

test('повтор архивации — no-op без роста версии и без записи', () => {
  const app = loadApp();
  seed(app);
  context(app).setHabitArchived('h1', true);
  const before = app.sandbox.localStorage.getItem(HABITS_KEY);

  const again = context(app).setHabitArchived('h1', true);

  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(app.sandbox.localStorage.getItem(HABITS_KEY), before,
    'лишнего сохранения нет');
});

test('неизвестный id — явная ошибка, состояние не меняется', () => {
  const app = loadApp();
  seed(app);
  const before = app.sandbox.localStorage.getItem(HABITS_KEY);

  const result = context(app).setHabitArchived('нет-такой', true);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown-habit');
  assert.equal(app.sandbox.localStorage.getItem(HABITS_KEY), before);
});

test('отказ хранилища не выглядит успехом и не двигает версию', () => {
  const app = loadApp();
  seed(app);
  context(app).setHabitArchived('h1', true);
  const before = app.sandbox.localStorage.getItem(HABITS_KEY);
  const original = app.sandbox.localStorage.setItem;
  app.sandbox.localStorage.setItem = function (key, value) {
    if (key === HABITS_KEY) throw new Error('quota');
    return original.call(this, key, value);
  };

  const result = context(app).setHabitArchived('h1', false);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'save-failed');
  assert.equal(app.sandbox.localStorage.getItem(HABITS_KEY), before);
});

test('обычное редактирование не стирает архивную пару и не меняет её через patch', () => {
  const app = loadApp();
  seed(app);
  context(app).setHabitArchived('h1', true);

  const renamed = context(app).updateHabit('h1', {
    name: 'Фаджр 2',
    isArchived: false,
    archiveVersion: { counter: 99, actorId: 'чужой' },
  });

  assert.equal(renamed.name, 'Фаджр 2');
  assert.equal(renamed.isArchived, true);
  assert.equal(renamed.archiveVersion.counter, 1);
  assert.equal(renamed.archiveVersion.actorId,
    app.sandbox.localStorage.getItem(ACTOR_KEY), 'actorId — тот же, что в локальном ключе');
});

test('выборки используют строго isArchived === true и не портят полный список', () => {
  const app = loadApp();
  seed(app, [
    { id: 'h3', name: 'Строка', type: 'boolean', isArchived: 'true' },
    { id: 'h4', name: 'Битый флаг', type: 'boolean', isArchived: 1 },
  ]);

  const habits = context(app).loadHabits();
  assert.deepEqual(plain(context(app).selectActiveHabits(habits).map(h => h.id)),
    ['h1', 'h2', 'h3', 'h4']);
  assert.deepEqual(plain(context(app).selectArchivedHabits(habits)), []);
  assert.equal(stored(app)[2].isArchived, 'true', 'loadHabits не пишет в хранилище');
});

test('невалидные пары нормализуются, привычка не теряется', () => {
  const app = loadApp();
  seed(app, [
    { id: 'h3', name: 'Флаг без версии', type: 'boolean', isArchived: true },
    { id: 'h4', name: 'Версия без флага', type: 'boolean',
      archiveVersion: { counter: 5, actorId: 'a' } },
    { id: 'h5', name: 'Нулевой counter', type: 'boolean', isArchived: true,
      archiveVersion: { counter: 0, actorId: 'a' } },
    { id: 'h6', name: 'Длинный actor', type: 'boolean', isArchived: true,
      archiveVersion: { counter: 1, actorId: 'x'.repeat(129) } },
    { id: 'h7', name: 'Мусор в версии', type: 'boolean', isArchived: true,
      archiveVersion: ['counter', 1] },
    { id: 'h8', name: 'Валидная', type: 'boolean', isArchived: true,
      archiveVersion: { counter: 3, actorId: 'dev' } },
  ]);

  const habits = context(app).loadHabits();

  assert.deepEqual(plain(habits.map(h => h.id)),
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
  for (const id of ['h3', 'h4', 'h5', 'h6', 'h7']) {
    const habit = habits.find(h => h.id === id);
    assert.equal(habit.isArchived, undefined, id + ': повреждённая пара снята');
    assert.equal(habit.archiveVersion, undefined, id + ': версия снята');
  }
  const valid = context(app).selectArchivedHabits(habits);
  assert.deepEqual(plain(valid.map(h => h.id)), ['h8']);
  assert.deepEqual(plain(valid[0].archiveVersion), { counter: 3, actorId: 'dev' });
});

test('normalizeHabitArchive не мутирует вход и отбрасывает лишние ключи версии', () => {
  const app = loadApp();
  const source = {
    id: 'h1', name: 'A', type: 'boolean', isArchived: true,
    archiveVersion: { counter: 2, actorId: 'dev', uid: 'секрет' },
  };
  const copy = JSON.parse(JSON.stringify(source));

  const normalized = context(app).normalizeHabitArchive(source);

  assert.deepEqual(plain(source), copy, 'вход не изменён');
  assert.deepEqual(plain(normalized.archiveVersion), { counter: 2, actorId: 'dev' });
});

test('nextHabitArchiveVersion: legacy → 1, затем max+1, предел счётчика', () => {
  const app = loadApp();
  assert.deepEqual(plain(context(app).nextHabitArchiveVersion(null, 'dev')),
    { counter: 1, actorId: 'dev' });
  assert.deepEqual(plain(context(app).nextHabitArchiveVersion(
    { counter: 7, actorId: 'старый' }, 'dev')), { counter: 8, actorId: 'dev' });
  assert.equal(context(app).nextHabitArchiveVersion(
    { counter: Number.MAX_SAFE_INTEGER, actorId: 'dev' }, 'dev'), null);
  assert.equal(context(app).nextHabitArchiveVersion(null, ''), null);
  assert.equal(context(app).nextHabitArchiveVersion(null, 'x'.repeat(129)), null);
});

test('actorId не содержит uid и генерируется один раз', () => {
  const app = loadApp();
  const first = context(app).loadHabitArchiveActor();
  const second = context(app).loadHabitArchiveActor();
  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9._:-]{1,128}$/);
  assert.equal(app.sandbox.localStorage.getItem(ACTOR_KEY), first);
});

test('пустой полный список и список только из архива — не повод засевать дефолты', () => {
  const app = loadApp();
  seed(app);
  context(app).setHabitArchived('h1', true);
  context(app).setHabitArchived('h2', true);

  const habits = context(app).loadHabits();
  assert.equal(habits.length, 2);
  assert.equal(context(app).selectActiveHabits(habits).length, 0);
  assert.equal(context(app).selectArchivedHabits(habits).length, 2);
});
