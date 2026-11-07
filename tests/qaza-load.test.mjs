// Тесты чтения состояния каза (loadQaza) — политика битого JSON.
//
// Контракт выровнен с loadFast (js/data/fast.js, «ничего не пишет»):
// отсутствие ключа — первый запуск, дефолт пишется (init обязан положить
// стартовую очередь до первого показа, пустой сервер заполняется своей
// копией); БИТЫЙ JSON — другое дело: свежий дефолт возвращается как
// ВРЕМЕННОЕ состояние, хранилище не перезаписывается и data:changed
// не эмитится. Иначе запись цементировала бы дефолт и сбрасывала счётчик
// лет накоплений (1530 каза → стартовые 1527). Валидный раздел с облака
// при следующей сверке перезаписывает битый ключ (applyCloudData) —
// проверяется последним тестом.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const QAZA_KEY = 'youplanner.qaza';
const QAZA_LOG_KEY = 'youplanner.qaza.log'; // QAZA_LOG_KEY (js/data/qaza.js:49)

// Стартовая очередь: 305+306+306+305+305 (см. DEFAULT_QAZA в qaza.js)
const DEFAULT_TOTAL = 1527;

function cloudQaza() {
  return {
    version: 3,
    cursor: 2,
    remaining: { fajr: 200, zuhr: 200, asr: 200, maghrib: 200, isha: 200 },
    history: [],
  };
}

test('битый JSON: дефолт возвращается, хранилище не перезаписывается, эмитов нет', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem(QAZA_KEY, '{битый json');
  app.run(`
    globalThis.__changes = 0;
    bus.on('data:changed', function () { globalThis.__changes++; });
  `);

  const qaza = app.context.loadQaza();

  assert.equal(app.context.qazaTotalRemaining(qaza), DEFAULT_TOTAL,
    'битые данные должны заменяться свежим дефолтом в памяти, чтобы UI работал');
  assert.equal(app.sandbox.localStorage.getItem(QAZA_KEY), '{битый json',
    'loadQaza перезаписал битый JSON дефолтом — счётчик лет накоплений сброшен');
  assert.equal(app.run('globalThis.__changes'), 0,
    'временный дефолт не должен эмитить data:changed');
});

test('повторный loadQaza при битом JSON не цементирует дефолт', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem(QAZA_KEY, 'не json');

  app.context.loadQaza();
  app.context.loadQaza();
  app.context.loadQaza(true);

  assert.equal(app.sandbox.localStorage.getItem(QAZA_KEY), 'не json',
    'дефолт записался в хранилище при повторном чтении');
});

test('первый запуск (ключа нет) по-прежнему пишет стартовую очередь', () => {
  const app = loadApp();

  const qaza = app.context.loadQaza();

  assert.equal(app.context.qazaTotalRemaining(qaza), DEFAULT_TOTAL);
  assert.ok(app.sandbox.localStorage.getItem(QAZA_KEY),
    'дефолт первого запуска должен записаться в хранилище');
});

test('битый JSON не мешает облачному снимку перезаписать раздел', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem(QAZA_KEY, '{битый json');

  const result = app.context.applyCloudData({ qaza: cloudQaza() }, 1000);

  assert.equal(result, true, 'валидный облачный раздел обязан примениться');
  assert.deepEqual(JSON.parse(app.sandbox.localStorage.getItem(QAZA_KEY)), cloudQaza(),
    'облачный раздел не перезаписал битый локальный JSON');
  const qaza = app.context.loadQaza(true);
  assert.equal(app.context.qazaTotalRemaining(qaza), 1000,
    'после применения читаются облачные данные, а не временный дефолт');
});

/* --- loadQazaLog: битое поле журнала не сбрасывает сам журнал -------------- */

/* Журнал растёт годами (§5). Битый since не должен выглядеть как «журнала
   нет»: append тогда молча пересоздаёт журнал с сегодняшним since и год
   статистики каза стирается. Восстановление — как при заводе журнала первой
   отметкой (appendQazaLog, js/data/qaza.js:251-259): since = самая ранняя
   валидная запись. Порченые entries при валидном since — журнал с пустым
   entries. null остаётся только для нет ключа / битого JSON / не-объекта. */

// QAZA_LOG_VERSION (js/data/qaza.js:51). const из vm-песочницы не виден как
// свойство контекста, поэтому литерал с комментарием-источником
const LOG_VERSION = 1;

test('битый since не сбрасывает журнал: записи сохраняются, since восстановлен', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem(QAZA_LOG_KEY, JSON.stringify({
    version: LOG_VERSION,
    since: 'garbage',
    entries: [{ date: '2026-11-01', namaz: 'fajr', source: 'done' }],
  }));

  // Чтение само по себе не теряет журнал: since восстановлен по записи
  const log = app.context.loadQazaLog();
  assert.notEqual(log, null, 'битый since не должен выглядеть как «журнала нет»');
  // Круг через JSON обязателен: объект из vm-песочницы чужой для deepEqual
  assert.deepEqual(JSON.parse(JSON.stringify(log)), {
    version: LOG_VERSION,
    since: '2026-11-01',
    entries: [{ date: '2026-11-01', namaz: 'fajr', source: 'done' }],
  });

  // Раньше append после битого since пересоздавал журнал с сегодняшним
  // since и стирал прежние записи; теперь они на месте
  assert.equal(app.context.appendQazaLog('zuhr', '2026-11-07', 'done'), true);
  assert.deepEqual(JSON.parse(app.sandbox.localStorage.getItem(QAZA_LOG_KEY)), {
    version: LOG_VERSION,
    since: '2026-11-01',
    entries: [
      { date: '2026-11-01', namaz: 'fajr', source: 'done' },
      { date: '2026-11-07', namaz: 'zuhr', source: 'done' },
    ],
  });
});

test('порченые entries при валидном since: журнал читается с пустым entries', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem(QAZA_LOG_KEY, JSON.stringify({
    version: LOG_VERSION,
    since: '2026-01-01',
    entries: 'не массив',
  }));

  const log = app.context.loadQazaLog();
  assert.notEqual(log, null, 'валидный since не должен выглядеть как «журнала нет»');
  assert.deepEqual(JSON.parse(JSON.stringify(log)), {
    version: LOG_VERSION,
    since: '2026-01-01',
    entries: [],
  });
});
