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
