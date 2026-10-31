// Регрессионные тесты разбора резервной копии (parseBackup).
//
// Отправная точка — баг, найденный аудитом 2026-10-23: внутри ветки
// realWake/realSleepMin parseBackup звал sleepDurationMinutes с двумя
// аргументами вместо трёх (fall и realWake вместо bed, fall, realWake),
// поэтому функция всегда возвращала null и ЛЮБАЯ копия версии 11 с парой
// realWake/realSleepMin отвергалась при импорте.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { defaultBackup } from './helpers/fixtures.mjs';

test('копия v11 с парой realWake/realSleepMin разбирается', () => {
  const { context } = loadApp();
  const data = context.parseBackup(JSON.stringify(defaultBackup()));
  assert.ok(data, 'валидная копия отвергнута');
  assert.equal(data.sleep.realSleepMin, 345);
});

test('копия v11 с actualWake/realWake из null (встал по плану) разбирается', () => {
  const { context } = loadApp();
  const backup = defaultBackup();
  backup.sleep.realWake = null;
  backup.sleep.realSleepMin = null;
  const data = context.parseBackup(JSON.stringify(backup));
  assert.ok(data, 'копия «встал по плану» отвергнута');
});

const invalidBackups = [
  {
    name: 'рассинхрон realWake и realSleepMin',
    mutate: (backup) => {
      // 400 минут не сходится с bed/fall/realWake — охрана должна сработать
      backup.sleep.realSleepMin = 400;
    },
    message: 'битая пара прошла разбор',
  },
  {
    name: 'половина пары realWake/realSleepMin',
    mutate: (backup) => { backup.sleep.realSleepMin = null; },
    message: 'половинчатая пара прошла разбор',
  },
  {
    name: 'копия чужой версии (10)',
    mutate: (backup) => { backup.version = 10; },
    message: 'копия версии 10 прошла разбор',
  },
  {
    name: 'не-время в actualWake',
    mutate: (backup) => { backup.sleep.actualWake = '25:99'; },
    message: 'битый actualWake прошёл разбор',
  },
  {
    name: 'не-целое sleepMin',
    mutate: (backup) => { backup.sleep.sleepMin = 1.5; },
    message: 'битый sleepMin прошёл разбор',
  },
];

for (const scenario of invalidBackups) {
  test(`${scenario.name} отвергается`, () => {
    const { context } = loadApp();
    const backup = defaultBackup();
    scenario.mutate(backup);
    const data = context.parseBackup(JSON.stringify(backup));
    assert.equal(data, null, scenario.message);
  });
}

// ── «Всё или ничего» при квоте хранилища (applyBackup) ──────────────────────
// Аудит 2026-10-31: QuotaExceededError посреди записи копии раньше оставлял
// смесь данных файла и устройства. parseBackup проверяет файл целиком ДО
// applyBackup, поэтому здесь проверяется только применение: инъекция ошибки
// в k-й setItem и побитовое сравнение хранилища до/после.
// Объект ошибки создаётся в реалме теста — applyBackup ловит любую ошибку
// записи, поэтому реалм не важен. Патчится сам sandbox.localStorage —
// тот же объект, чей Map-стаб читает _dump(), поэтому успешные записи
// через оригинальный setItem остаются видимыми.

// Прежние данные устройства: значения отличаются от defaultBackup, поэтому
// побитовое сравнение _dump ловит и полуприменённую копию, и потерю ключей
function seedDeviceStorage(sandbox) {
  const seed = {
    'youplanner.habits': [{ id: 'h2', name: 'Чтение Корана', type: 'boolean', unit: '', goal: null }],
    'youplanner.records': { '2026-10-20': { h2: true } },
    'youplanner.qaza': {
      version: 3,
      cursor: 0,
      remaining: { fajr: 2, zuhr: 2, asr: 2, maghrib: 2, isha: 2 },
      history: [],
    },
    'youplanner.prayer': { lat: 40.5, lng: 50.5, madhhab: 'hanafi', method: 'astro' },
    'youplanner.qaza.fast': { version: 1, remaining: 2, history: [] },
    'youplanner.qaza.log': { version: 1, since: '2026-10-02', entries: [] },
    'youplanner.sleep': {
      version: 4,
      bed: '23:30',
      fall: 15,
      wake: '06:00',
      actualWake: '06:00',
      sleepMin: 375,
      realWake: '06:00',
      realSleepMin: 375,
      excluded: false,
      history: [],
    },
    'youplanner.schedule': {
      weekday: [{ time: '07:00', text: 'Зарядка' }],
      weekend: [],
      fasting: [],
      physical: [],
    },
  };
  const keys = Object.keys(seed);
  for (let i = 0; i < keys.length; i++) {
    sandbox.localStorage.setItem(keys[i], JSON.stringify(seed[keys[i]]));
  }
}

// Обёртка setItem: k-й вызов бросает QuotaExceededError, остальные
// уходят в оригинальный Map-стаб
function failOnNthSetItem(storage, n) {
  const original = storage.setItem;
  const state = { calls: 0 };
  storage.setItem = function (key, value) {
    state.calls += 1;
    if (state.calls === n) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(key, value);
  };
  return state;
}

test('квота посреди импорта: откат всех ключей, события замены не эмитятся', () => {
  const app = loadApp();
  seedDeviceStorage(app.sandbox);
  const before = app.sandbox.localStorage._dump();
  // Отказ на 5-м setItem: habits, records, qaza и prayer успевают
  // записаться, fast — нет; откат обязан вернуть все четыре
  const patch = failOnNthSetItem(app.sandbox.localStorage, 5);
  app.run(`
    globalThis.__changed = 0;
    globalThis.__replaced = 0;
    globalThis.__storageError = 0;
    bus.on('data:changed', () => { globalThis.__changed++; });
    bus.on('data:replaced', () => { globalThis.__replaced++; });
    bus.on('storage:error', () => { globalThis.__storageError++; });
  `);

  const data = app.context.parseBackup(JSON.stringify(defaultBackup()));
  assert.ok(data, 'валидная копия должна разбираться до инъекции ошибки');

  const result = app.context.applyBackup(data);

  assert.equal(result, false, 'импорт при отказе хранилища должен вернуть false');
  assert.ok(patch.calls >= 5, 'инъекция не сработала — откат не проверяется');
  assert.deepEqual(app.sandbox.localStorage._dump(), before,
    'после отката не все ключи равны прежним побитово');
  assert.equal(app.run('globalThis.__changed'), 0,
    'data:changed эмитился на неприменившейся копии');
  assert.equal(app.run('globalThis.__replaced'), 0,
    'data:replaced эмитился на неприменившейся копии');
  assert.equal(app.run('globalThis.__storageError'), 1,
    'о квоте не сообщено через storage:error');
});
