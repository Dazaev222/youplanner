// Проверка модульного графа под НАСТОЯЩЕЙ ES-семантикой: Node исполняет
// js/app.js со всеми импортами (резолв спецификаторов, циклы, живые
// binding'и — как в браузере), с заглушками браузерных глобалов.
//
// Зачем: конкатенация для песочницы снимает import-строки и прячет ошибки
// связывания — неправильный спецификатор или пропущенный import видны
// только при настоящем исполнении модулей. Поймал реальный баг 3.3
// (bare-спецификатор 'sync/sync.js' без './').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storage = new Map();

globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
globalThis.document = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { innerHTML: '', content: null }; },
  body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
  documentElement: { style: { setProperty() {} } },
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

test('модульный граф исполняется целиком (ES-семантика)', async () => {
  await assert.doesNotReject(
    () => import(pathToFileURL(join(root, 'js/app.js')).href),
    /не удалось связать модули/,
  );
});
