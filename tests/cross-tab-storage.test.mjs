// Межвкладочные storage-события (слушатель window 'storage' в js/app.js init).
//
// Событие storage приходит только из ДРУГИХ вкладок, и обе вкладки живут над
// одним localStorage. qaza-разделы ('youplanner.qaza', 'youplanner.qaza.log')
// слушатель не обрабатывал: чужая запись не попадала в память вкладки, и
// следующий локальный saveQaza перезаписывал её LWW-конвертом со свежим
// временем — правка другой вкладки терялась молча. Сценарий — две vm-песочницы
// (схема tests/settings-owner.test.mjs) над общим localStorage-стабом.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const QAZA_KEY = 'youplanner.qaza';

// Общее хранилище двух вкладок: тот же интерфейс, что у стаба в loadApp
function sharedStorage() {
  const storage = new Map();
  return {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
    clear: () => storage.clear(),
    get length() { return storage.size; },
    key: (i) => {
      const keys = Array.from(storage.keys());
      return Number.isInteger(i) && i >= 0 && i < keys.length ? keys[i] : null;
    },
    _dump: () => Object.fromEntries(storage),
  };
}

// Вкладка: общее хранилище, без живых таймеров (напоминания и дебаунс синка
// не планируются — иначе процесс теста не завершится) и с перехватом
// window-слушателей, чтобы тест мог вручную доставить storage-событие.
function loadTab(storage) {
  const app = loadApp();
  app.sandbox.localStorage = storage;
  app.sandbox.setInterval = () => 0;
  app.sandbox.setTimeout = () => 0;
  app.sandbox.requestAnimationFrame = () => 0;
  const handlers = {};
  app.sandbox.window.addEventListener = (type, fn) => {
    (handlers[type] = handlers[type] || []).push(fn);
  };
  return { app: app, handlers: handlers };
}

test('storage-событие перезагружает qazaState: undo в B не затирает правку A', () => {
  const storage = sharedStorage();

  // Вкладка A: состояние каза загружено из общего хранилища
  const a = loadTab(storage);
  a.app.run('setQazaState(loadQaza())');

  // Вкладка B: init регистрирует storage-слушатель и грузит то же дефолтное
  // состояние (очередь на магрибе: cursor 3, maghrib 305)
  const b = loadTab(storage);
  b.app.context.init();
  assert.equal(b.app.run('getQazaState().remaining.maghrib'), 305);
  assert.ok(Array.isArray(b.handlers.storage) && b.handlers.storage.length > 0,
    'storage-слушатель не зарегистрирован при init');

  // A выполняет каза: maghrib 304, курсор уехал на ишу, история живёт
  a.app.context.onQazaDone({ target: { closest: () => ({ disabled: false }) } });
  const afterA = JSON.parse(storage.getItem(QAZA_KEY));
  assert.equal(afterA.remaining.maghrib, 304, 'отметка A не легла в хранилище');

  // Событие storage из вкладки A долетает до B — как в настоящем браузере
  b.handlers.storage.forEach((fn) => fn({ key: QAZA_KEY, newValue: null }));

  // Память B перечитала хранилище: чужая запись попала в состояние
  assert.equal(b.app.run('getQazaState().remaining.maghrib'), 304,
    'чужая запись qaza не попала в память вкладки B');

  // Отмена в B работает ПОВЕРХ правки A: снимает её честно (остаток, курсор
  // и история возвращаются к дефолту), а не вслепую пишет устаревшее
  // состояние B, затирая отметку A без следа
  b.app.context.onQazaUndo();
  assert.deepEqual(JSON.parse(storage.getItem(QAZA_KEY)), {
    version: 3,
    cursor: 3,
    remaining: { fajr: 305, zuhr: 306, asr: 306, maghrib: 305, isha: 305 },
    history: [],
  });
});

// Очистка хранилища (event.key === null) тоже перезагружает состояние каза
test('storage-событие без ключа (очистка) перезагружает qazaState', () => {
  const storage = sharedStorage();
  const b = loadTab(storage);
  b.app.context.init();

  // Чужая вкладка перезаписала раздел и диспетчеризовала очистку/полное
  // событие: B обязан перечитать хранилище, а не держать дефолт в памяти
  storage.setItem(QAZA_KEY, JSON.stringify({
    version: 3, cursor: 1,
    remaining: { fajr: 100, zuhr: 306, asr: 306, maghrib: 305, isha: 305 },
    history: [],
  }));
  b.handlers.storage.forEach((fn) => fn({ key: null, newValue: null }));

  assert.equal(b.app.run('getQazaState().remaining.fajr'), 100,
    'состояние каза не перезагружено на событии без ключа');
});
