// Тесты HTTP-клиента ассистента (js/ui/assistant-api.js) — adversarial-аудит
// 2026-10-31. Два слоя:
//
// 1. Прямой ESM-импорт в node: реальный AbortSignal.timeout (современная ветка
//    guard), fetch подменяется на глобале — тексты ошибок и чтение ответа.
// 2. Песочница loadApp: там AbortSignal НЕТ — включается ручная ветка
//    timeoutGuard (AbortController + setTimeout), ровно как на старых Safari.
//    Таймеры подменяются на запись в Map: видно и создание (ms), и снятие.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postAssistantChat } from '../js/ui/assistant-api.js';
import { loadApp } from './helpers/load-app.mjs';

const PAYLOAD = { model: 'qwen3.6-35b-a3b', messages: [{ role: 'user', content: 'привет' }] };

const okReply = (content) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ choices: [{ message: { content } }] }),
});

const notOk = (status, body) => ({
  ok: false,
  status,
  text: () => Promise.resolve(body || 'ошибка'),
});

// Подмена глобального fetch с гарантированным восстановлением.
async function withFetchStub(stub, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

// ── Успех и тексты ошибок (современная ветка, прямой импорт) ────────────────

test('успех: ответ обрезается по пробелам и возвращается строкой', async () => {
  await withFetchStub(() => Promise.resolve(okReply('  ответ модели  ')), async () => {
    assert.equal(await postAssistantChat(PAYLOAD, 'ключ'), 'ответ модели');
  });
});

test('заголовки: Bearer-ключ и JSON уходят в fetch', async () => {
  let seen = null;
  await withFetchStub((url, opts) => {
    seen = { url, opts };
    return Promise.resolve(okReply('ок'));
  }, async () => {
    await postAssistantChat(PAYLOAD, 'секрет');
  });
  assert.ok(seen.url.indexOf('chat/completions') !== -1, 'эндпоинт потерян');
  assert.equal(seen.opts.headers.Authorization, 'Bearer секрет');
  assert.deepEqual(JSON.parse(seen.opts.body), PAYLOAD);
});

test('401/403: понятный текст про ключ (ассистент поднимет модалку)', async () => {
  await withFetchStub(() => Promise.resolve(notOk(401)), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'плохой'), /Ключ не принят.*401/s);
  });
  await withFetchStub(() => Promise.resolve(notOk(403)), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'плохой'), /Ключ не принят.*403/s);
  });
});

test('429: текст про «слишком много запросов»', async () => {
  await withFetchStub(() => Promise.resolve(notOk(429)), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /слишком много запросов/);
  });
});

test('5xx: текст про недоступность сервиса', async () => {
  await withFetchStub(() => Promise.resolve(notOk(500)), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /недоступен.*500/s);
  });
});

test('404: нейтральный текст про неожиданный ответ', async () => {
  await withFetchStub(() => Promise.resolve(notOk(404)), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /неожиданный ответ.*404/s);
  });
});

test('тело HTTP-ошибки не читается — friendlyError всё равно работает', async () => {
  await withFetchStub(() => Promise.resolve({
    ok: false, status: 503, text: () => Promise.reject(new Error('тело не читается')),
  }), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /недоступен.*503/s);
  });
});

test('пустой choices: «Сервис ответил пустым сообщением»', async () => {
  await withFetchStub(() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ choices: [] }),
  }), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /пустым сообщением/);
  });
});

test('битый JSON (SyntaxError): «ответ не в формате JSON»', async () => {
  await withFetchStub(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
  }), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /не в формате JSON/);
  });
});

test('обрыв сети посреди чтения тела (TypeError): НЕ маскируется под «не в формате JSON»', async () => {
  // Реальный fetch роняет чтение тела TypeError'ом при разрыве соединения;
  // SyntaxError остаётся признаком именно невалидного JSON.
  await withFetchStub(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.reject(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' })),
  }), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /Связь прервалась/);
  });
});

test('fetch отвергся (нет сети): «Нет связи с сервисом нейросети»', async () => {
  await withFetchStub(() => Promise.reject(new TypeError('fetch failed')), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /Нет связи с сервисом нейросети/);
  });
});

test('TimeoutError (AbortSignal.timeout сработал): «не ответил за 60 секунд»', async () => {
  await withFetchStub(() => Promise.reject(
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  ), async () => {
    await assert.rejects(() => postAssistantChat(PAYLOAD, 'ключ'), /не ответил за 60 секунд/);
  });
});

// ── Ручная ветка guard (старые Safari) — песочница без AbortSignal ──────────

// Таймеры песочницы: созданные пишутся в created (id, fn, ms), активные — в
// active. Реального времени нет: тест стреляет в таймер вручную.
function wrapTimers(sandbox, active, created) {
  let nextId = 1;
  sandbox.setTimeout = (fn, ms) => {
    const id = nextId++;
    created.push({ id, fn, ms });
    active.set(id, fn);
    return id;
  };
  sandbox.clearTimeout = (id) => { active.delete(id); };
}

test('успех: 60-секундный таймер снят (нет утечки setTimeout на минуту)', async () => {
  const { sandbox, context } = loadApp({ fetchImpl: () => Promise.resolve(okReply('ок')) });
  const active = new Map();
  const created = [];
  wrapTimers(sandbox, active, created);

  const reply = await context.postAssistantChat(PAYLOAD, 'ключ');

  assert.equal(reply, 'ок');
  assert.equal(created.length, 1, 'guard не поставил таймер');
  assert.equal(created[0].ms, 60000, 'таймаут не 60 секунд');
  assert.equal(active.size, 0, 'таймер остался жить после успешного ответа');
});

test('таймаут: guard прерывает AbortController, текст «не ответил за 60 секунд», таймер снят', async () => {
  let rejectFetch = null;
  let seenSignal = null;
  const { sandbox, context } = loadApp({
    fetchImpl: (_url, opts) => new Promise((_resolve, reject) => {
      rejectFetch = reject;
      seenSignal = opts.signal;
    }),
  });
  const active = new Map();
  const created = [];
  wrapTimers(sandbox, active, created);

  const pending = assert.rejects(
    () => context.postAssistantChat(PAYLOAD, 'ключ'),
    /не ответил за 60 секунд/,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(created.length, 1, 'guard не поставил таймер');

  created[0].fn();   // «истекло 60 секунд»
  assert.equal(seenSignal.aborted, true, 'AbortController не прерван по таймауту');
  // fetch на abort отвергается AbortError (не TimeoutError) — текст всё равно
  // должен быть про таймаут, а не про «нет связи»
  rejectFetch(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  await pending;
  assert.equal(active.size, 0, 'таймер не снят после таймаута');
});

test('сетевая ошибка в ручной ветке: таймер снят, текст «Нет связи»', async () => {
  const { sandbox, context } = loadApp({
    fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
  });
  const active = new Map();
  const created = [];
  wrapTimers(sandbox, active, created);

  await assert.rejects(() => context.postAssistantChat(PAYLOAD, 'ключ'), /Нет связи с сервисом нейросети/);
  assert.equal(created.length, 1);
  assert.equal(active.size, 0, 'таймер остался после сетевой ошибки');
});

test('современные браузеры: сигнал AbortSignal.timeout уходит в fetch, ручной таймер не создаётся', async () => {
  let seenOpts = null;
  const { sandbox, context } = loadApp({
    fetchImpl: (_url, opts) => { seenOpts = opts; return Promise.resolve(okReply('ок')); },
  });
  const active = new Map();
  const created = [];
  wrapTimers(sandbox, active, created);
  const fakeSignal = { aborted: false };
  let timeoutMs = null;
  sandbox.AbortSignal = { timeout: (ms) => { timeoutMs = ms; return fakeSignal; } };

  await context.postAssistantChat(PAYLOAD, 'ключ');

  assert.equal(timeoutMs, 60000);
  assert.equal(seenOpts.signal, fakeSignal, 'сигнал guard не доходит до fetch');
  assert.equal(created.length, 0, 'ручной таймер создан при живом AbortSignal.timeout');
});
