// Загружает JS приложения в песочницу node:vm — без браузера.
// Источники — из tests/helpers/sources.mjs: файлы js/data/*.js по порядку
// подключения, затем инлайн-скрипт. Функции, объявленные на верхнем уровне,
// становятся свойствами contextify-глобала, поэтому тест может звать их
// напрямую: ctx.parseBackup, ctx.syncToCloud и так далее. Сеть по умолчанию
// недоступна: fetch отклоняет вызов, как при офлайне; тест может подсунуть
// свою реализацию.

import vm from 'node:vm';
import { getAppJs } from './sources.mjs';

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
  vm.runInContext(getAppJs(), context, { filename: 'youplanner-app.js' });
  // Ключ Firebase из исходника не должен доходить до тестов: песочница
  // стартует в состоянии «аутентификация не настроена», и сетевые заглушки
  // (timers, sync) не получают лишних identitytoolkit-вызовов. Тесты,
  // которым нужен токен, подставляют свой ключ setFirebaseApiKey() явно.
  if (typeof context.setFirebaseApiKey === 'function') {
    context.setFirebaseApiKey('');
  }
  return {
    sandbox,
    context,
    // выполнить код в том же контексте (доступ к глобальным лексическим
    // const — например bus или syncPending — возможен только изнутри)
    run(code) {
      return vm.runInContext(code, context);
    },
  };
}
