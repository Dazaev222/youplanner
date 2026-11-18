// Согласие перед общим анализом Дневника в чате ассистента (мастер-ТЗ §5.2).
//
// Кнопка «Общий анализ в чате» сначала локально собирает датасет
// (service.getSnapshot + buildAnalysisDataset — сеть провайдера запрещена),
// показывает сводку (модель, число событий и диапазон, причины/триггеры,
// полнота, предупреждения) и только после явного одноразового согласия
// вызывает onSubmitDiaryAnalysis. Отмена ничего не отправляет; после ошибки
// согласие сбрасывается; изменившийся снимок инвалидирует согласие.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { renderAnalysis } from '../js/harness/diary-ui/analysis.js';
import { hashSnapshot } from '../js/harness/diary/canonical.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const DAY = 86400000;

function makeSnapshot() {
  return {
    initialization: {
      schemaVersion: 1,
      journalId: 'journal-consent',
      startedAtMs: T0,
      initialDurationMs: 0,
      timeZone: 'Europe/Moscow',
      createdAtMs: T0,
      deviceId: 'device-a',
      acceptedAtMs: { '.sv': 'timestamp' },
    },
    events: {
      'event-1': {
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAtMs: T0 + 1 * DAY,
        reason: 'Стресс',
        triggerId: 'trigger-stress',
        deviceId: 'device-a',
        createdAtMs: T0 + DAY,
        acceptedAtMs: { '.sv': 'timestamp' },
      },
      'event-2': {
        schemaVersion: 1,
        eventId: 'event-2',
        occurredAtMs: T0 + 5 * DAY,
        reason: 'Усталость',
        deviceId: 'device-a',
        createdAtMs: T0 + 5 * DAY,
        acceptedAtMs: { '.sv': 'timestamp' },
      },
    },
    triggerCreations: {
      'trigger-stress': {
        schemaVersion: 1,
        triggerId: 'trigger-stress',
        name: 'Стресс',
        createdAtMs: T0,
        deviceId: 'device-a',
        acceptedAtMs: { '.sv': 'timestamp' },
      },
    },
    mutations: {},
    analyses: {},
    outbox: [],
    receipts: [],
  };
}

function makeFakeNode(tag) {
  const listeners = {};
  const children = [];
  const node = {
    tagName: tag,
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    type: '',
    value: '',
    checked: false,
    className: '',
    style: {},
    listeners,
    children,
    append(...items) { for (const it of items) children.push(it); },
    appendChild(child) { children.push(child); return child; },
    replaceChildren(...items) { children.length = 0; for (const it of items) children.push(it); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    scrollIntoView() {},
  };
  return node;
}

function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (const child of node.children || []) walk(child, fn);
}

function findButton(root, text) {
  let found = null;
  walk(root, (n) => {
    if (!found && n.tagName === 'button' && n.textContent === text) found = n;
  });
  return found;
}

function findCheckbox(root) {
  let found = null;
  walk(root, (n) => {
    if (!found && n.tagName === 'input' && n.type === 'checkbox') found = n;
  });
  return found;
}

function allText(root) {
  let out = '';
  walk(root, (n) => { if (n.textContent) out += n.textContent + '\n'; });
  return out;
}

function setup(options = {}) {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  globalThis.navigator.onLine = true;
  const doc = {
    getElementById: () => null,
    createElement: (tag) => makeFakeNode(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };
  globalThis.document = doc;
  app.sandbox.document = doc;

  const snapshot = options.snapshot || makeSnapshot();
  const fingerprint = options.fingerprint;
  const calls = { submitted: 0, payload: null };

  const ctx = {
    dirty: false,
    refresh: async () => {},
    synchronize: async () => ({ ok: true, value: null }),
    version: '',
    onBack: () => {},
    open() {}, replace() {},
    service: {
      getSnapshot: async () => snapshot,
      getFingerprint: async () => (fingerprint !== undefined ? fingerprint : hashSnapshot(snapshot)),
      requestAnalysis: async () => ({ ok: true, value: { draft: null } }),
    },
    onSubmitDiaryAnalysis: async (payload) => {
      calls.submitted++;
      calls.payload = payload;
      if (options.submitResult) return options.submitResult;
      return { ok: true };
    },
    projection: { triggers: {} },
  };

  const root = renderAnalysis(ctx);
  const summary = findButton(root, 'Общий анализ в чате');
  // Узел ошибки ищем по классу: createElement возвращает свежие фейковые
  // узлы, ссылку изнутри модуля снаружи не достать
  let err = null;
  walk(root, (n) => { if (!err && n.className === 'diary-error') err = n; });
  return { app, ctx, root, error: err, summary, calls };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('клик по «Общий анализ в чате»: сводка построена, согласие не предустановлено, запроса нет', async () => {
  const { root, summary, calls } = setup();
  summary.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  const text = allText(root);
  assert.ok(text.includes('модель') || text.includes('Модель'), 'модель в сводке');
  assert.ok(text.includes('2'), 'число событий в сводке');
  assert.ok(text.includes('2026-01-02'), 'диапазон дат в сводке');
  assert.ok(text.includes('Стресс') || text.includes('причин'), 'причины/триггеры упомянуты');
  const checkbox = findCheckbox(root);
  assert.ok(checkbox, 'чекбокс согласия показан');
  assert.equal(checkbox.checked, false, 'согласие не предустановлено');
  assert.equal(calls.submitted, 0, 'до согласия запрос не отправлялся');
});

test('отмена: ничего не отправляется и сводка убирается', async () => {
  const { root, summary, calls } = setup();
  summary.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  const cancel = findButton(root, 'Отмена');
  assert.ok(cancel, 'кнопка отмены показана');
  cancel.listeners.click[0]({ preventDefault() {} });
  await flush();

  assert.equal(calls.submitted, 0);
  assert.equal(findCheckbox(root), null, 'сводка и согласие убраны');
});

test('подтверждение без отметки согласия: ошибка, запроса нет', async () => {
  const { root, summary, error, calls } = setup();
  summary.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  const confirm = findButton(root, 'Передать и проанализировать');
  assert.ok(confirm, 'кнопка передачи показана');
  confirm.listeners.click[0]({ preventDefault() {} });
  await flush();

  assert.ok(error.textContent.length > 0, 'нужно пояснение');
  assert.equal(calls.submitted, 0);
});

test('подтверждение с согласием: один вызов onSubmitDiaryAnalysis с датасетом', async () => {
  const { root, summary, error, calls } = setup();
  summary.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  const checkbox = findCheckbox(root);
  checkbox.checked = true;
  const confirm = findButton(root, 'Передать и проанализировать');
  confirm.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  assert.equal(error.textContent.includes('Подтвердите'), false, error.textContent);
  assert.equal(calls.submitted, 1);
  assert.ok(calls.payload && calls.payload.dataset, 'в запрос передан датасет');
  assert.equal(calls.payload.dataset.sourceFingerprint, await hashSnapshot(makeSnapshot()));
  assert.equal(calls.payload.dataset.events.length, 2);
});

test('снимок изменился: согласие инвалидировано, запроса нет', async () => {
  const { root, summary, error, calls } = setup({ fingerprint: 'sha256:другой' });
  summary.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  findCheckbox(root).checked = true;
  findButton(root, 'Передать и проанализировать').listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  assert.equal(calls.submitted, 0, 'устаревший снимок не отправляется');
  assert.ok(error.textContent.includes('изменил'), 'причина повторного согласия показана: '
    + error.textContent);
});

test('ошибка отправки: согласие сброшено, повтор требует нового подтверждения', async () => {
  const { root, summary, error, calls } = setup({
    submitResult: { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'сбой сервиса' } },
  });
  summary.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  findCheckbox(root).checked = true;
  findButton(root, 'Передать и проанализировать').listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  assert.equal(calls.submitted, 1);
  assert.ok(error.textContent.includes('сбой сервиса'), 'ошибка видна: ' + error.textContent);

  const checkbox = findCheckbox(root);
  if (checkbox) assert.equal(checkbox.checked, false, 'согласие одноразовое — сброшено');
  findButton(root, 'Передать и проанализировать').listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  assert.equal(calls.submitted, 1, 'повтор без нового согласия не отправляет');
  assert.ok(error.textContent.includes('Подтвердите'), 'требуется новое согласие');
});

test('ключ не настроен: PROVIDER_KEY_MISSING открывает путь к настройкам и пишет подсказку', async () => {
  const { root, summary, error, calls } = setup({
    submitResult: { ok: false, error: { code: 'PROVIDER_KEY_MISSING', message: 'Ключ ИИ не настроен' } },
  });
  summary.listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  findCheckbox(root).checked = true;
  findButton(root, 'Передать и проанализировать').listeners.click[0]({ preventDefault() {} });
  await flush();
  await flush();

  assert.equal(calls.submitted, 1);
  assert.ok(error.textContent.includes('Ключ'), 'подсказка про ключ: ' + error.textContent);
});
