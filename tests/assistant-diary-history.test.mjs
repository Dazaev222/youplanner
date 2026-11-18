// История сообщений ассистента (мастер-ТЗ §5.4): контекстные реплики анализа
// Дневника несут contextKind и requestId, видны в общей ленте, но НЕ уходят
// в исходящий history обычных запросов. Сырой датасет в историю не пишется.
// Legacy-реплики без contextKind читаются как general.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const ASSISTANT_HISTORY_KEY = 'youplanner.assistant_history';

function seedHistory(app, entries) {
  app.sandbox.localStorage.setItem(ASSISTANT_HISTORY_KEY, JSON.stringify(entries));
}

test('legacy general читается: реплика без contextKind остаётся валидной', () => {
  const app = loadApp();
  seedHistory(app, [{ role: 'user', content: 'обычный вопрос' }]);

  const history = app.run('readHistory()');
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'user');
  assert.ok(!history[0].contextKind, 'legacy-реплика без contextKind');
});

test('контекстная реплика дневника: user-ветка несёт contextKind и requestId', () => {
  const app = loadApp();
  const index = app.run(
    'pushHistory("user", "прошу общий анализ Дневника", ' +
    '{ contextKind: "diary", contextFingerprint: "sha256:abcdef", requestId: "req-7" })'
  );

  const history = app.run('readHistory()');
  const last = history[history.length - 1];
  assert.equal(last.contextKind, 'diary');
  assert.equal(last.contextFingerprint, 'sha256:abcdef');
  assert.equal(last.requestId, 'req-7');
  assert.equal(last.role, 'user');
  assert.ok(index >= 0);
});

test('контекстная реплика дневника: assistant-ветка тоже несёт контекст', () => {
  const app = loadApp();
  app.run('pushHistory("assistant", "Анализ готов.", ' +
    '{ contextKind: "diary", contextFingerprint: "sha256:abcdef", requestId: "req-7" })');

  const history = app.run('readHistory()');
  const last = history[history.length - 1];
  assert.equal(last.contextKind, 'diary');
  assert.equal(last.requestId, 'req-7');
});

test('типизация переживает перезагрузку (чтение из localStorage)', () => {
  const app = loadApp();
  seedHistory(app, [
    { role: 'user', content: 'обычный вопрос' },
    { role: 'user', content: 'прошу общий анализ Дневника', contextKind: 'diary', requestId: 'req-7' },
    { role: 'assistant', content: 'Анализ готов.', contextKind: 'diary', requestId: 'req-7' },
  ]);

  const history = app.run('readHistory()');
  assert.equal(history.length, 3, 'диарные реплики читаются из хранилища');
  assert.equal(history[1].contextKind, 'diary');
  assert.equal(history[2].contextKind, 'diary');
});

test('обычный запрос не отправляет diary-историю (проверка buildMessages)', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  seedHistory(app, [
    { role: 'user', content: 'ОБЫЧНЫЙ_ВОПРОС_МАРКЕР' },
    { role: 'user', content: 'СЕКРЕТНАЯ_ИСТОРИЯ_ДНЕВНИКА', contextKind: 'diary', requestId: 'req-7' },
    { role: 'assistant', content: 'СЕКРЕТНЫЙ_ОТВЕТ_ДНЕВНИКА', contextKind: 'diary', requestId: 'req-7' },
    { role: 'user', content: 'новый обычный вопрос' },
  ]);

  const messages = app.run('buildMessages()');
  const all = messages.map((m) => m.content).join('\n');
  assert.ok(all.includes('ОБЫЧНЫЙ_ВОПРОС_МАРКЕР'), 'general-реплики уходят как раньше');
  assert.ok(!all.includes('СЕКРЕТНАЯ_ИСТОРИЯ_ДНЕВНИКА'), 'diary-вопрос ушёл в общий запрос');
  assert.ok(!all.includes('СЕКРЕТНЫЙ_ОТВЕТ_ДНЕВНИКА'), 'diary-ответ ушёл в общий запрос');
});

test('диарные реплики видны в общей ленте (renderHistory не отфильтровывает их)', () => {
  const app = loadApp();
  seedHistory(app, [
    { role: 'user', content: 'СЕКРЕТНАЯ_ИСТОРИЯ_ДНЕВНИКА', contextKind: 'diary', requestId: 'req-7' },
  ]);
  // Фейковый узел ленты: appendMessage пишет в #assistant-chat
  const bubbles = [];
  const chat = {
    textContent: '',
    appendChild(node) { bubbles.push(node); },
    scrollTop: 0,
    scrollHeight: 0,
  };
  const previousGet = app.sandbox.document.getElementById;
  app.sandbox.document.getElementById = (id) => (id === 'assistant-chat' ? chat : previousGet(id));

  app.run('renderHistory()');
  assert.equal(bubbles.length, 1, 'диарная реплика рисуется в ленте');
  assert.equal(bubbles[0].textContent, 'СЕКРЕТНАЯ_ИСТОРИЯ_ДНЕВНИКА');
  app.sandbox.document.getElementById = previousGet;
});

test('сырой датасет не сохраняется в историю после submitDiaryAnalysis', async () => {
  const app = loadApp();
  app.sandbox.navigator.onLine = true;
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  const previousFetch = app.sandbox.fetch;
  app.sandbox.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'Анализ готов.' } }] }),
  });

  const dataset = {
    sourceFingerprint: 'sha256:abc',
    asOfMs: 1731900000000,
    completeness: { status: 'complete', pendingEventIds: [], syncComplete: true },
    coveredEventIds: ['e1'],
    events: [{ eventId: 'e1', occurredAtMs: 1, reason: 'ПРИЧИНА_СОБЫТИЯ_МАРКЕР' }],
    triggers: [{ triggerId: 't1', name: 'ТРИГГЕР_МАРКЕР' }],
    statistics: { schemaVersion: 1 },
  };
  const result = await app.context.submitDiaryAnalysis({ dataset });
  assert.equal(result.ok, true);
  app.sandbox.fetch = previousFetch;

  const history = app.run('readHistory()');
  assert.ok(history.length >= 2);
  for (const entry of history) {
    assert.ok(!entry.content.includes('coveredEventIds'), 'ключ датасета в истории');
    assert.ok(!entry.content.includes('ПРИЧИНА_СОБЫТИЯ_МАРКЕР'), 'сырая причина в истории');
    assert.ok(!entry.content.includes('ТРИГГЕР_МАРКЕР'), 'сырой триггер в истории');
  }
});

test('удаление diary-реплики по индексу не задевает соседей', () => {
  const app = loadApp();
  seedHistory(app, [
    { role: 'user', content: 'до' },
    { role: 'user', content: 'СЕКРЕТНАЯ_ИСТОРИЯ_ДНЕВНИКА', contextKind: 'diary', requestId: 'req-7' },
    { role: 'user', content: 'после' },
  ]);

  const ok = app.run('removeHistoryAt(1)');
  assert.equal(ok, true);
  const history = app.run('readHistory()');
  // deepEqual через границу vm-контекста сравнивает прототипы: сверяем
  // содержимое строкой
  assert.equal(history.map((m) => m.content).join('|'), 'до|после');
});
