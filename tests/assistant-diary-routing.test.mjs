// Маршрутизация «общий анализ Дневника в чат ассистента» (мастер-ТЗ §5.3.5):
// submitDiaryAnalysis принимает типизированный dataset, проверяет состояние
// (отмена/офлайн/занято/невалидные данные/ключ), показывает реплику в ленте,
// уходит в сеть ровно один раз, пишет ответ в историю с contextKind 'diary' и
// НЕ отправляет PDF/фото/контекст привычек. Отмена и очистка истории
// инвалидируют запоздалый ответ.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const VALID_DATASET = {
  sourceFingerprint: 'sha256:abcdef0123456789',
  asOfMs: 1731900000000,
  timeZone: 'Europe/Moscow',
  completeness: { status: 'complete', pendingEventIds: [], syncComplete: true },
  coveredEventIds: ['e1', 'e2'],
  events: [
    { eventId: 'e1', occurredAtMs: 1731800000000, reason: 'стресс на работе', triggerId: 't1' },
    { eventId: 'e2', occurredAtMs: 1731850000000, reason: 'проснулся ночью', triggerId: 't2' },
  ],
  triggers: [{ triggerId: 't1', name: 'Тревога' }, { triggerId: 't2', name: 'Ночной телефон' }],
  statistics: { schemaVersion: 1, relapseCount: 2 },
};

function stubFetch(app, handler) {
  // fetch в песочнице живёт на объекте sandbox (vm-контекст): глобальный
  // this.fetch в тестовом модуле приложением не является — стаб ставится сюда.
  const previous = app.sandbox.fetch;
  app.sandbox.fetch = handler;
  return () => { app.sandbox.fetch = previous; };
}

function okReply(text) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('отмена до отправки: submitDiaryAnalysis не ходит в сеть', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  let calls = 0;
  const restore = stubFetch(app, () => { calls++; return okReply('x'); });

  const result = await app.context.submitDiaryAnalysis({
    dataset: VALID_DATASET,
    signal: { aborted: true, addEventListener() {}, removeEventListener() {} },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DIARY_CANCELLED');
  assert.equal(calls, 0);
  restore();
});

test('офлайн: анализ не отправляется, код DIARY_OFFLINE', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = false;
  let calls = 0;
  const restore = stubFetch(app, () => { calls++; return okReply('x'); });

  const result = await app.context.submitDiaryAnalysis({ dataset: VALID_DATASET });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DIARY_OFFLINE');
  assert.equal(calls, 0);
  restore();
});

test('занято: submitDiaryAnalysis отдаёт DIARY_BUSY, без сети', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.context.setAssistantBusy(true);
  let calls = 0;
  const restore = stubFetch(app, () => { calls++; return okReply('x'); });

  const result = await app.context.submitDiaryAnalysis({ dataset: VALID_DATASET });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DIARY_BUSY');
  assert.equal(calls, 0);
  app.context.setAssistantBusy(false);
  restore();
});

test('невалидный датасет: отказ с кодом INVALID_DATA без сети', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  let calls = 0;
  const restore = stubFetch(app, () => { calls++; return okReply('x'); });

  const result = await app.context.submitDiaryAnalysis({ dataset: { eventCount: 3 } });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_DATA');
  assert.equal(calls, 0);
  restore();
});

test('бюджет: превышение лимита — ANALYSIS_TOO_LARGE, без сети', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  const events = [];
  for (let i = 0; i < 9; i++) events.push({ eventId: 'e' + i, occurredAtMs: i });
  let calls = 0;
  const restore = stubFetch(app, () => { calls++; return okReply('x'); });

  const result = await app.context.submitDiaryAnalysis({
    dataset: { ...VALID_DATASET, events, coveredEventIds: events.map((e) => e.eventId) },
    maxEventsPerChunk: 2,
    maxChunks: 2,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ANALYSIS_TOO_LARGE');
  assert.equal(calls, 0);
  restore();
});

test('нет ключа: PROVIDER_KEY_MISSING до сети, история не пишется', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  let calls = 0;
  const restore = stubFetch(app, () => { calls++; return okReply('x'); });

  const result = await app.context.submitDiaryAnalysis({ dataset: VALID_DATASET });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_KEY_MISSING');
  assert.equal(calls, 0);
  assert.equal(app.run('readHistory()').length, 0, 'запрос без ключа не попадает в историю');
  restore();
});

test('валидный запрос: payload — system+user с данными дневника, без PDF и привычек', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  let sent = null;
  const restore = stubFetch(app, (url, opts) => {
    sent = { url, opts };
    return okReply('Анализ готов.');
  });

  const result = await app.context.submitDiaryAnalysis({ dataset: VALID_DATASET });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Анализ готов.');
  assert.ok(sent, 'запрос в сеть не ушёл');
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.messages.length, 2, 'ровно system и user, без истории чата');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  const userText = body.messages[1].content;
  assert.ok(userText.includes('стресс на работе'), 'причины событий уходят в запрос');
  assert.ok(userText.includes('Ночной телефон'), 'имена триггеров уходят в запрос');
  assert.ok(!userText.includes('outbox'), 'технические квитанции не уходят в запрос');
  assert.ok(typeof body.model === 'string' && body.model.length > 0);
  restore();
});

test('валидный запрос: реплики пишутся в историю с contextKind diary и общим requestId', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  const restore = stubFetch(app, () => okReply('Анализ готов.'));

  const result = await app.context.submitDiaryAnalysis({ dataset: VALID_DATASET, requestId: 'req-42' });

  assert.equal(result.ok, true);
  const history = app.run('readHistory()');
  assert.equal(history.length, 2, 'user-подпись и ответ модели');
  const user = history[0];
  const assistant = history[1];
  assert.equal(user.contextKind, 'diary');
  assert.equal(user.requestId, 'req-42');
  assert.equal(assistant.contextKind, 'diary');
  assert.equal(assistant.requestId, 'req-42');
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, 'Анализ готов.');
  // Сырой датасет в историю не попадает: только краткая подпись запроса
  assert.ok(!user.content.includes('coveredEventIds'), 'raw dataset не сохраняется в историю');
  assert.ok(user.content.includes('Дневника'), 'подпись запроса читаема');
  restore();
});

test('после запроса diary-контекст сброшен: общий ответ не наследует метки Дневника', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  const restore = stubFetch(app, () => okReply('Анализ готов.'));

  await app.context.submitDiaryAnalysis({ dataset: VALID_DATASET, requestId: 'req-42' });

  const history = app.run('readHistory()');
  assert.equal(history[1].contextKind, 'diary');
  // Поколение и контекст должны быть чисты для следующих общих ходов:
  // эмулируем общий ход через onAssistantSubmit с заглушкой сети
  const restore2 = stubFetch(app, () => okReply('Обычный ответ.'));
  app.run('onAssistantSubmit("обычный вопрос")');
  await flush();
  const after = app.run('readHistory()');
  const last = after[after.length - 1];
  assert.equal(last.role, 'assistant');
  assert.ok(!last.contextKind, 'общий ответ не должен нести contextKind diary');
  restore2();
  restore();
});

test('поздний ответ после очистки истории не пишется в историю', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  let resolveFetch;
  const restore = stubFetch(app, () => new Promise((resolve) => { resolveFetch = resolve; }));

  const pending = app.context.submitDiaryAnalysis({ dataset: VALID_DATASET });
  await flush();
  assert.ok(resolveFetch, 'запрос в полёте');
  // Очистка истории во время полёта сдвигает поколение сессии
  app.run('assistantGeneration += 1');
  resolveFetch(okReply('запоздалый ответ'));
  const result = await pending;

  assert.equal(result.ok, true);
  const history = app.run('readHistory()');
  const last = history[history.length - 1];
  assert.equal(last.role, 'user', 'ответ после очистки в историю не пишется');
  restore();
});

test('abort в полёте: DIARY_CANCELLED, ответ в историю не пишется', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  let resolveFetch;
  const restore = stubFetch(app, (url, opts) => new Promise((resolve, reject) => {
    resolveFetch = () => {
      if (opts.signal && opts.signal.aborted) {
        const e = new Error('аборт'); e.name = 'AbortError'; reject(e);
      } else {
        resolve(okReply('Анализ готов.'));
      }
    };
  }));

  const signal = {
    aborted: false,
    addEventListener(type, fn) { this._onAbort = fn; },
    removeEventListener() {},
  };
  const pending = app.context.submitDiaryAnalysis({ dataset: VALID_DATASET, signal });
  await flush();
  signal.aborted = true;
  signal._onAbort();
  resolveFetch();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DIARY_CANCELLED');
  const history = app.run('readHistory()');
  assert.equal(history.filter((m) => m.role === 'assistant').length, 0,
    'отменённый ответ не попадает в историю');
  restore();
});
