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

  // Узел #toast: showToast/showErrorToast пишут в него через getElementById.
  // Тесты читают textContent, чтобы проверить текст тоста (например, тост
  // «Сессия истекла, войдите заново» при sync:auth-expired). addEventListener
  // обязателен: bindToastGestures вешает жесты на живой элемент.
  const toastNode = {
    textContent: '',
    hidden: true,
    addEventListener() {},
  };

  const sandbox = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => storage.clear(),
      // Перебор ключей — как в настоящем DOM Storage: код приложения (зачистка
      // сессии в firebase-auth.js) ходит по length/key(i) и обязан работать
      // одинаково в браузере и в песочнице. key(i) вне диапазона — null.
      get length() { return storage.size; },
      key: (i) => {
        const keys = Array.from(storage.keys());
        return Number.isInteger(i) && i >= 0 && i < keys.length ? keys[i] : null;
      },
      _dump: () => Object.fromEntries(storage),
    },
    document: {
      addEventListener() {},
      removeEventListener() {},
      getElementById(id) { return id === 'toast' ? toastNode : null; },
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
      removeEventListener() {},
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
    // Заглушка для timeoutGuard (assistant-view, firebase-auth, sync): в
    // песочнице нет ни AbortSignal, ни AbortController, и реальный guard
    // падал бы ReferenceError до вызова fetch — сетевые тесты не доходили
    // бы до своей заглушки
    AbortController: class AbortControllerStub {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
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
    toastNode,
    // выполнить код в том же контексте (доступ к глобальным лексическим
    // const — например bus или syncPending — возможен только изнутри)
    run(code) {
      return vm.runInContext(code, context);
    },
  };
}
