// Тесты Vision в ассистенте (фото в чате) — план NIGHT_REPORT §4, фаза 2.
//
// Контракт: модели каталога помечены флагом vision; withVisionAttachments
// разворачивает ПОСЛЕДНЮЮ user-реплику в OpenAI-vision content-массив
// (text + image_url с dataURL), не трогая системный промпт и чужие реплики;
// больше трёх фото не прикрепляется. Фото при модели без зрения не
// отправляются вовсе. buildMessages при приложенных фото тоже уходит
// в запрос content-массивом (история остаётся текстовой).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Модуль импортируется напрямую: он чистый ESM без DOM на верхнем уровне.
// Часть контекста (imageContext) живёт в песочнице — через loadApp.
const vision = await import('../js/ui/assistant-view.js');

// ── Каталог моделей ─────────────────────────────────────────────────────────

test('флаг vision: всё семейство qwen, gpt-oss и чужие id — без зрения', () => {
  assert.equal(vision.assistantModelSupportsVision('qwen3.8-27b'), true);
  assert.equal(vision.assistantModelSupportsVision('qwen3.6-35b-a3b'), true);
  // Модель владельца из баг-репорта iPhone (2026-10-31): qwen-семейство
  // распознаётся по префиксу даже вне каталога
  assert.equal(vision.assistantModelSupportsVision('qwen3.6f.p'), true);
  assert.equal(vision.assistantModelSupportsVision('gpt-oss-120b'), false);
  assert.equal(vision.assistantModelSupportsVision('нет-такой'), false);
  assert.equal(vision.assistantModelSupportsVision(undefined), false);
});

// ── snapshotPickedFiles: файлы снимаются ДО сброса input.value ─────────────

test('snapshotPickedFiles снимает массивоподобный FileList в массив', () => {
  // Живой FileList после input.value = '' опустошается на месте (спека,
  // SameObject) — именно поэтому камера «молчала»; контракт: обработчик
  // работает со снимком, а не со ссылкой на список
  const fake = { 0: 'файл-1', 1: 'файл-2', length: 2 };
  const snapshot = vision.snapshotPickedFiles(fake);
  assert.deepEqual(snapshot, ['файл-1', 'файл-2']);
  fake[0] = 'изменён-после-снимка';
  assert.equal(snapshot[0], 'файл-1', 'снимок не должен быть живой ссылкой');
});

test('snapshotPickedFiles: пустой и отсутствующий список — пустой массив', () => {
  assert.deepEqual(vision.snapshotPickedFiles({ length: 0 }), []);
  assert.deepEqual(vision.snapshotPickedFiles(null), []);
  assert.deepEqual(vision.snapshotPickedFiles(undefined), []);
});

// ── withVisionAttachments ───────────────────────────────────────────────────

const TEXT_MESSAGE = { role: 'user', content: 'Что на фото?' };

test('фото нет — массив сообщений возвращается как был', () => {
  const base = [{ role: 'system', content: 's' }, TEXT_MESSAGE];
  assert.equal(vision.withVisionAttachments(base, null), base);
  assert.equal(vision.withVisionAttachments(base, []), base);
});

test('последняя user-реплика разворачивается в content-массив с image_url', () => {
  const base = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'первый вопрос' },
    { role: 'assistant', content: 'ответ' },
    { role: 'user', content: 'Что на фото?' },
  ];
  const images = [
    { dataUrl: 'data:image/jpeg;base64,AAA', name: 'a.jpg', bytes: 3 },
    { dataUrl: 'data:image/webp;base64,BBB', name: 'b.webp', bytes: 3 },
  ];
  const merged = vision.withVisionAttachments(base, images);
  // чужие реплики не тронуты
  assert.equal(merged[0].content, 'system');
  assert.equal(merged[1].content, 'первый вопрос');
  assert.equal(merged[2].content, 'ответ');
  // последняя user-реплика — vision-массив
  assert.deepEqual(merged[3], {
    role: 'user',
    content: [
      { type: 'text', text: 'Что на фото?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,BBB' } },
    ],
  });
});

test('битые элементы images пропускаются, без user-реплики массив цел', () => {
  const system = [{ role: 'system', content: 's' }];
  const merged = vision.withVisionAttachments(system, [
    null,
    { name: 'без dataUrl' },
    { dataUrl: 'data:image/jpeg;base64,AAA', name: 'a.jpg', bytes: 3 },
  ]);
  assert.deepEqual(merged, system, 'user-реплики нет — вложения деваться некуда');

  const withUser = vision.withVisionAttachments(
    [{ role: 'system', content: 's' }, { role: 'user', content: '?' }],
    [null, { name: 'мусор' }, { dataUrl: 'data:image/jpeg;base64,AAA', name: 'a.jpg', bytes: 3 }]
  );
  assert.deepEqual(withUser[1].content, [
    { type: 'text', text: '?' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
  ]);
});

// ── buildMessages: интеграция в payload ─────────────────────────────────────

test('buildMessages: фото уходят в последний user-реплику, в истории — текст с маркером', async () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.assistant_history', JSON.stringify([
    { role: 'user', content: 'Что на фото?\n[фото: снимок.jpg]' },
  ]));
  app.run('imageContext = [{ dataUrl: "data:image/jpeg;base64,AAA", name: "снимок.jpg", bytes: 1024 }];');

  const messages = app.context.buildMessages();
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.indexOf('приложил к вопросу фото (1 шт.)') !== -1,
    'в системном промпте нет пометки про фото');
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content), 'user-реплика не развернута в vision-массив');
  assert.equal(last.content[0].type, 'text');
  assert.ok(last.content[0].text.indexOf('[фото: снимок.jpg]') !== -1);
  assert.equal(last.content[1].type, 'image_url');
  assert.equal(last.content[1].image_url.url, 'data:image/jpeg;base64,AAA');
});

test('buildMessages: без фото payload остаётся текстовым', async () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.assistant_history', JSON.stringify([
    { role: 'user', content: 'Привет' },
  ]));
  const messages = app.context.buildMessages();
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, 'Привет');
});

// ── Гейтинг: фото при модели без зрения не отпускаются ────────────────────

test('onAssistantSubmit: фото + модель без зрения — отправка не состоялась', async () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  // gpt-oss-120b — единственная в каталоге модель без зрения (qwen-семейство
  // принято со зрением, баг-репорт iPhone 2026-10-31)
  app.sandbox.localStorage.setItem('youplanner.assistant_model', 'gpt-oss-120b');
  app.run('imageContext = [{ dataUrl: "data:image/jpeg;base64,AAA", name: "a.jpg", bytes: 1024 }];');

  const accepted = app.context.onAssistantSubmit('Что на фото?');

  assert.equal(accepted, false, 'отправка при модели без зрения должна отсекаться');
  assert.equal(app.run('readHistory().length'), 0, 'вопрос осел в истории');
});

test('onAssistantSubmit: фото + модель со зрением (qwen3.6) уходит как текстовый вопрос', async () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  app.sandbox.localStorage.setItem('youplanner.assistant_model', 'qwen3.6-35b-a3b');

  const accepted = app.context.onAssistantSubmit('Что на фото?');

  assert.equal(accepted, true, 'qwen-модели со зрением не должны отсекаться');
  assert.equal(app.run('readHistory().length'), 1);
});

test('onAssistantSubmit: текст без фото уходит как раньше', async () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');

  const accepted = app.context.onAssistantSubmit('Привет');
  assert.equal(accepted, true);
  assert.equal(app.run('readHistory().length'), 1);
});
