// Регрессия YP-06/YP-07: в fallback-ветке без AbortSignal.timeout таймер
// запроса обязан сниматься при любом исходе. Проверяются оба места с fetch:
// синхронизация (js/sync/sync.js) и ассистент (js/ui/assistant-view.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Подменяет таймеры и Abort API так, чтобы включилась fallback-ветка:
// AbortSignal есть, но без timeout; контроллер — свой, с событием abort.
function installFallbackTimers(app) {
  const timers = new Map();
  let nextId = 1;

  app.sandbox.setTimeout = (fn) => {
    const id = nextId++;
    timers.set(id, fn);
    return id;
  };
  app.sandbox.clearTimeout = (id) => {
    timers.delete(id);
  };

  class FakeController {
    constructor() {
      this.signal = {
        aborted: false,
        listeners: [],
        addEventListener(type, fn) {
          if (type === 'abort') this.listeners.push(fn);
        },
      };
    }
    abort() {
      this.signal.aborted = true;
      this.signal.listeners.forEach((fn) => fn());
    }
  }

  app.sandbox.AbortController = FakeController;
  app.sandbox.AbortSignal = {};   // без .timeout — только ручной контроллер
  return timers;
}

const fallbackTimerCases = [
  {
    name: 'sync: успешный обмен снимает fallback-таймер',
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    run: (app) => app.context.syncFromCloud(),
    verify: (result, timers) => {
      assert.equal(result.reachable, true);
      assert.equal(timers.size, 0, 'таймер остался после успешного обмена');
    },
  },
  {
    name: 'sync: ошибка сети снимает fallback-таймер',
    fetchImpl: () => Promise.reject(new Error('нет сети')),
    run: (app) => app.context.syncFromCloud(),
    verify: (result, timers) => {
      assert.equal(result.reachable, false);
      assert.equal(timers.size, 0, 'таймер остался после ошибки обмена');
    },
  },
  {
    name: 'assistant: успешный ответ снимает fallback-таймер',
    fetchImpl: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '  ответ  ' } }] }),
    }),
    run: (app) => app.context.requestAssistantReply(),
    verify: (reply, timers) => {
      assert.equal(reply, 'ответ');
      assert.equal(timers.size, 0, 'таймер остался после ответа ассистента');
    },
  },
  {
    name: 'assistant: ошибка запроса снимает fallback-таймер',
    fetchImpl: () => Promise.reject(new TypeError('нет связи')),
    run: (app) => assert.rejects(() => app.context.requestAssistantReply(), /Нет связи/),
    verify: (_result, timers) => {
      assert.equal(timers.size, 0, 'таймер остался после ошибки ассистента');
    },
  },
];

for (const scenario of fallbackTimerCases) {
  test(scenario.name, async () => {
    const app = loadApp({ fetchImpl: scenario.fetchImpl });
    const timers = installFallbackTimers(app);
    const result = await scenario.run(app);
    scenario.verify(result, timers);
  });
}

test('sync: таймаут по-прежнему прерывает зависший запрос', async () => {
  let seenSignal = null;
  const app = loadApp({
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      seenSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        const error = new Error('прервано таймаутом');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  const timers = installFallbackTimers(app);

  const pending = app.context.syncFromCloud();
  assert.equal(timers.size, 1, 'таймер не был создан');

  Array.from(timers.values()).forEach((fn) => fn());   // срабатывание таймаута

  const result = await pending;
  assert.equal(seenSignal.aborted, true, 'сигнал не был прерван');
  assert.equal(result.reachable, false);
  assert.equal(timers.size, 0, 'таймер остался после прерывания');
});
