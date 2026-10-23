// Загружает инлайн-скрипт index.html в песочницу node:vm — без браузера.
// Функции, объявленные на верхнем уровне скрипта, становятся свойствами
// contextify-глобала, поэтому тест может звать их напрямую: ctx.parseBackup,
// ctx.syncToCloud и так далее. Сеть по умолчанию недоступна: fetch отклоняет
// вызов, как при офлайне; тест может подсунуть свою реализацию.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function extractInlineScript() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error('в index.html нет встроенного скрипта');
  return match[1];
}

export function loadApp({ fetchImpl } = {}) {
  const storage = new Map();

  const sandbox = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => storage.clear(),
      _dump: () => Object.fromEntries(storage),
    },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { innerHTML: '', content: null }; },
      body: {
        classList: { toggle() {}, add() {}, remove() {} },
        appendChild() {}, removeChild() {},
      },
      documentElement: { style: { setProperty() {} } },
    },
    window: {
      addEventListener() {},
      matchMedia() { return { matches: false }; },
      scrollTo() {},
      innerWidth: 1200,
      innerHeight: 800,
    },
    navigator: {},
    MutationObserver: class MutationObserverStub {
      observe() {}
      disconnect() {}
    },
    fetch: fetchImpl || (() => Promise.reject(new Error('нет сети (тест)'))),
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.window.window = sandbox.window;

  const context = vm.createContext(sandbox);
  vm.runInContext(extractInlineScript(), context, { filename: 'index.html-inline.js' });
  return { sandbox, context };
}
