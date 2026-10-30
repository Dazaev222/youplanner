// Тесты шины событий (Фаза 3.0): слои общаются только через события,
// прямых вызовов save* → scheduleSync, sync → render* и safeSetItem →
// showToast больше нет. Каждый тест подписывается изнутри контекста —
// const-переменные (bus, syncPending) живут в глобальной лексической
// области и снаружи не видны.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { habit } from './helpers/fixtures.mjs';

test('правка данных эмитит data:changed и взводит syncPending', () => {
  const app = loadApp();
  app.run("bus.on('data:changed', () => { globalThis.__changed = (globalThis.__changed || 0) + 1; })");

  const ok = app.context.saveHabits([habit()]);
  assert.equal(ok, true);
  assert.equal(app.run('globalThis.__changed'), 1,
    'событие data:changed не дошло до подписчика');
  // подписка взводит syncPending через scheduleSync: правка дороже снимка
  assert.equal(app.run('syncPending'), true);
});

test('safeSetItem при отказе хранилища эмитит storage:error', () => {
  const app = loadApp();
  app.run("bus.on('storage:error', () => { globalThis.__seen = true; })");
  app.sandbox.localStorage.setItem = () => {
    throw new Error('QuotaExceededError');
  };

  const ok = app.context.safeSetItem('youplanner.habits', '{}');
  assert.equal(ok, false);
  assert.equal(app.run('globalThis.__seen'), true,
    'событие storage:error не дошло до подписчика');
});

test('syncFromCloud применяет снимок и эмитит sync:applied', async () => {
  const snapshot = {
    habits: [habit()],
    records: {},
    updatedAt: 1000,
  };
  const fetchImpl = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(snapshot),
  });
  const app = loadApp({ fetchImpl });
  app.run("bus.on('sync:applied', () => { globalThis.__applied = (globalThis.__applied || 0) + 1; })");

  const result = await app.context.syncFromCloud();
  // объект из vm-контекста — другой реалм, deepEqual по прототипу не пройдёт
  assert.equal(result.reachable, true);
  assert.equal(result.serverEmpty, false);
  assert.equal(app.run('globalThis.__applied'), 1,
    'событие sync:applied не дошло до подписчика');
  assert.equal(app.run('appState.habits.length'), 1,
    'снимок не применён к appState');
});

test('шина переживает отписку прямо из обработчика', () => {
  const app = loadApp();
  app.run(`
    globalThis.__count = 0;
    const off = bus.on('data:changed', () => { globalThis.__count++; off(); });
  `);
  app.context.saveHabits([habit()]);
  app.context.saveHabits([habit()]);
  assert.equal(app.run('globalThis.__count'), 1,
    'обработчик сработал после собственной отписки (или не сработал вовсе)');
});

// Ошибка одного подписчика гасится внутри emit (аудит 2026-10-31): раньше
// исключение обрывало forEach — последующие подписчики того же события
// не получали ничего, а эмиттер (например, saveHabits) падал вместе с ними.
// Падение рендера одного экрана не должно ронять сохранение данных.
test('падение одного подписчика не мешает остальным и не роняет emit', () => {
  const app = loadApp();
  const errors = [];
  app.sandbox.console = { error: (...args) => errors.push(args) };
  app.run(`
    globalThis.__first = 0;
    globalThis.__second = 0;
    bus.on('data:changed', () => { globalThis.__first++; throw new Error('битый рендер'); });
    bus.on('data:changed', () => { globalThis.__second++; });
  `);

  assert.doesNotThrow(() => app.context.saveHabits([habit()]),
    'ошибка подписчика вышла наружу из emit');
  assert.equal(app.run('globalThis.__first'), 1);
  assert.equal(app.run('globalThis.__second'), 1,
    'второй подписчик не получил событие после падения первого');
  assert.equal(errors.length, 1, 'ошибка подписчика не попала в console.error');
});
