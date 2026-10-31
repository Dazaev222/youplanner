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

// ── PDF-скан: страницы как изображения (фолбэк js/ui/assistant-pdf.js) ──────
// У скана текстового слоя нет, поэтому assistant-pdf.js рендерит первые
// страницы в картинки и кладёт их в pdfPageImages. Контракт: они уходят к
// модели ТЕМ ЖЕ путём, что и фото, — одним vision-массивом в последнюю
// user-реплику, рядом с пользовательскими снимками.

test('buildMessages: страницы PDF-скана уходят тем же vision-путём, что и фото', async () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.assistant_history', JSON.stringify([
    { role: 'user', content: 'Что в документе?' },
  ]));
  app.run('imageContext = [{ dataUrl: "data:image/jpeg;base64,QQ==", name: "снимок.jpg", bytes: 1024 }];');
  app.run('pdfPageImages = ['
    + '{ dataUrl: "data:image/jpeg;base64,Qg==", name: "скан.pdf — стр. 1", bytes: 2048 },'
    + '{ dataUrl: "data:image/jpeg;base64,Qw==", name: "скан.pdf — стр. 2", bytes: 2048 }];');

  const messages = app.context.buildMessages();
  const system = messages[0].content;
  assert.ok(system.indexOf('скан без текстового слоя') !== -1,
    'в системном промпте нет пометки про скан: ' + system.slice(0, 200));
  assert.ok(system.indexOf('приложил к вопросу фото (1 шт.)') !== -1,
    'фото-пометка потерялась, когда рядом страницы скана');
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content), 'скан-страницы не развернуты в vision-массив');
  const urls = last.content.filter((p) => p.type === 'image_url');
  assert.equal(urls.length, 3, 'должны уйти и фото, и обе страницы скана');
  assert.equal(urls[0].image_url.url, 'data:image/jpeg;base64,QQ==', 'порядок: сначала фото');
  assert.equal(urls[1].image_url.url, 'data:image/jpeg;base64,Qg==', 'потом страницы скана');
  assert.equal(urls[2].image_url.url, 'data:image/jpeg;base64,Qw==');
});

test('buildMessages: только скан без фото — payload тоже vision-массив', async () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.assistant_history', JSON.stringify([
    { role: 'user', content: 'Что в документе?' },
  ]));
  app.run('pdfPageImages = [{ dataUrl: "data:image/jpeg;base64,Qg==", '
    + 'name: "скан.pdf — стр. 1", bytes: 2048 }];');

  const messages = app.context.buildMessages();
  const last = messages[messages.length - 1];
  assert.ok(Array.isArray(last.content), 'страницы скана не попали в запрос');
  assert.equal(last.content.filter((p) => p.type === 'image_url').length, 1);
});

test('onAssistantSubmit: страницы скана при модели без зрения отсекаются, как фото', async () => {
  const fetchCalls = [];
  const app = loadApp({
    fetchImpl: (url, opts) => { fetchCalls.push({ url, opts }); return Promise.resolve(okReply('ответ')); },
  });
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  app.sandbox.localStorage.setItem('youplanner.assistant_model', 'gpt-oss-120b');
  app.run('pdfPageImages = [{ dataUrl: "data:image/jpeg;base64,QQ==", '
    + 'name: "скан.pdf — стр. 1", bytes: 2048 }];');

  assert.equal(app.context.onAssistantSubmit('Что в документе?'), false,
    'скан при модели без зрения не должен уходить в API');
  assert.equal(fetchCalls.length, 0, 'заблокированный запрос ушёл в сеть');
  assert.equal(app.run('readHistory().length'), 0, 'вопрос осел в истории при отказе');
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

// ═════════════════════════════════════════════════════════════════════════════
// Аудит adversarial 2026-10-31: телефон/большая память/офлайн.
//
// Песочница loadApp без canvas: для лестницы сжатия (js/data/image.js)
// подменяются примитивы браузера — createImageBitmap, document.createElement
// ('canvas'), URL, Image, FileReader. Подмены ставятся ПОСЛЕ loadApp:
// vm-код резолвит их через глобал в момент вызова. compressImage звать можно
// и напрямую (context.compressImage), и через compressChatImages.
// ═════════════════════════════════════════════════════════════════════════════

// ── Хелперы песочницы ───────────────────────────────────────────────────────

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const makeFile = (name, size, type) => ({
  name,
  size: size || 2 * 1024 * 1024,
  type: type || 'image/jpeg',
});

const okReply = (content) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ choices: [{ message: { content } }] }),
});

// Фейковые DOM-элементы по id (индикатор, тост, чат): это то, что читают
// assistant-media.js и core/dom.js. createElement пишется в список created —
// так тест находит пузырь «Печатает…»/ошибки в ленте.
// getAttribute/querySelectorAll нужны модалке настроек (openAssistantKeyModal
// заполняет слайдеры персонализации и переключает табы): открывается она и из
// заблокированных путей onAssistantSubmit — без стандартных методов узла
// песочница падала бы TypeError'ом там, где живой DOM проходит насквозь.
function bindVisionDom(sandbox) {
  const els = {};
  const created = [];
  const makeEl = () => ({
    textContent: '', hidden: true, disabled: false, value: '',
    className: '', alt: '', style: {}, options: [],
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    appendChild(c) { return c; },
    scrollIntoView() {},
    focus() {},
    getAttribute: () => null,
    querySelectorAll: () => [],
  });
  sandbox.document.createElement = () => { const el = makeEl(); created.push(el); return el; };
  sandbox.document.createTextNode = (t) => ({ text: t });
  sandbox.document.getElementById = (id) => (els[id] = els[id] || makeEl());
  return { els, created };
}

// Подмена canvas-примитивов для compressImage. enc(type, quality) → Blob-стуб
// ({ type, size }) или null («iOS не хватило памяти»).
function bindCanvasStub(sandbox, enc) {
  const log = { toBlobCalls: [], drawn: [], bitmapsClosed: 0, revoked: [], opts: [] };
  const makeCanvas = () => ({
    width: 0,
    height: 0,
    getContext() {
      return { drawImage(_src, _x, _y, w, h) { log.drawn.push([w, h]); } };
    },
    toBlob(cb, type, quality) {
      log.toBlobCalls.push({ type, quality, width: this.width, height: this.height });
      cb(enc ? enc(type, quality) : { type, size: 100 * 1024 });
    },
  });
  sandbox.document.createElement = (tag) => (tag === 'canvas'
    ? makeCanvas()
    : { innerHTML: '', content: null });
  sandbox.createImageBitmap = async (file, opts) => {
    log.opts.push(opts);
    return { width: file.__w, height: file.__h, close() { log.bitmapsClosed++; } };
  };
  sandbox.URL = {
    createObjectURL() { return 'blob:тест'; },
    revokeObjectURL(u) { log.revoked.push(u); },
  };
  return log;
}

// <img>-путь старых Safari: экземпляр читает naturalWidth из dims.
function bindImageStub(sandbox, mode, dims) {
  sandbox.Image = class ImageStub {
    constructor() {
      this.naturalWidth = dims ? dims[0] : 100;
      this.naturalHeight = dims ? dims[1] : 100;
    }
    set src(_v) {
      queueMicrotask(() => (mode === 'ok' ? this.onload() : this.onerror(new Error('декодер отказал'))));
    }
  };
}

// FileReader для blobToDataURL; dataUrl берётся из blob.__dataUrl.
const makeFileReader = () => class FileReaderStub {
  readAsDataURL(blob) {
    const self = this;
    queueMicrotask(() => {
      self.result = blob && blob.__dataUrl
        ? blob.__dataUrl
        : 'data:image/jpeg;base64,QUFB';
      self.onload();
    });
  }
};

// Стаб compressImage для тестов уровня чата: dataUrl выводится из имени файла.
const bindFastCompress = (sandbox) => {
  sandbox.compressImage = async (file) => ({
    blob: {
      type: 'image/jpeg',
      size: 100 * 1024,
      __dataUrl: 'data:image/jpeg;base64,' + encodeURIComponent(file.name),
    },
    width: 100,
    height: 100,
  });
};

// ── Атака 1: большое фото с телефона и лестница сжатия ──────────────────────
// Документированный потолок canvas iOS — 16.7M пикселей (старые устройства
// ещё ниже, ~5M): canvas должен строиться уже уменьшенным, а не «рисовать
// оригинал целиком». Порог в коде: maxSide (vision: 1568, фон: ≤2048),
// масштаб = min(1, maxSide/длинная сторона) в js/data/image.js.

test('фото 12 МБ 8000×6000: canvas 1568×1176 — далеко под потолком canvas iOS', async () => {
  const { sandbox, context } = loadApp();
  const log = bindCanvasStub(sandbox, (type) => ({ type, size: 100 * 1024 }));
  const file = makeFile('камера.jpg', 12 * 1024 * 1024);
  file.__w = 8000;
  file.__h = 6000;

  const result = await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.equal(log.toBlobCalls[0].width, 1568, 'длинная сторона не зажата до maxSide');
  assert.equal(log.toBlobCalls[0].height, 1176, 'пропорции искажены');
  assert.ok(log.toBlobCalls[0].width * log.toBlobCalls[0].height <= 16.7e6,
    'canvas превышает документированный лимит iOS 16.7M пикселей');
  assert.equal(log.drawn[0][0], 1568, 'в canvas рисуется оригинал без ресайза');
  assert.equal(log.bitmapsClosed, 1, 'декодированный bitmap не закрыт');
  assert.equal(result.width, 1568);
  assert.equal(result.height, 1176);
});

test('панорама 12000×3000: длинная сторона зажата, пропорции сохранены', async () => {
  const { sandbox, context } = loadApp();
  const log = bindCanvasStub(sandbox, (type) => ({ type, size: 100 * 1024 }));
  const file = makeFile('панорама.jpg');
  file.__w = 12000;
  file.__h = 3000;

  await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.equal(log.toBlobCalls[0].width, 1568);
  assert.equal(log.toBlobCalls[0].height, 392, 'панорама не должна молча портиться');
});

test('маленькое фото не растягивается до maxSide (апскейла нет)', async () => {
  const { sandbox, context } = loadApp();
  const log = bindCanvasStub(sandbox, (type) => ({ type, size: 100 * 1024 }));
  const file = makeFile('мини.jpg');
  file.__w = 800;
  file.__h = 600;

  await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.equal(log.toBlobCalls[0].width, 800);
  assert.equal(log.toBlobCalls[0].height, 600);
});

test('лестница: влезающий WebP останавливает спуск, EXIF-опция передана', async () => {
  const { sandbox, context } = loadApp();
  const log = bindCanvasStub(sandbox, (type) => ({ type, size: 100 * 1024 }));
  const file = makeFile('обычное.jpg');
  file.__w = 4000;
  file.__h = 3000;

  await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.equal(log.opts[0] && log.opts[0].imageOrientation, 'from-image',
    'EXIF-поворот должен запрашиваться опцией from-image');
  assert.equal(log.toBlobCalls.length, 1, 'лишние кодирования после влезшего шага');
  assert.equal(log.toBlobCalls[0].type, 'image/webp');
  assert.equal(log.toBlobCalls[0].quality, 0.8);
});

test('лестница: WebP мимо потолка — спуск в JPEG 0.7, влезающий шаг останавливает', async () => {
  const { sandbox, context } = loadApp();
  const log = bindCanvasStub(sandbox, (type) => (
    type === 'image/webp'
      ? { type: 'image/webp', size: 900 * 1024 }
      : { type, size: 300 * 1024 }
  ));
  const file = makeFile('тяжёлое.jpg');
  file.__w = 3000;
  file.__h = 2000;

  const result = await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.equal(log.toBlobCalls.length, 2, 'шагов лестницы: ' + JSON.stringify(log.toBlobCalls));
  assert.equal(result.blob.type, 'image/jpeg');
  assert.equal(result.blob.size, 300 * 1024);
});

test('лестница: тихий PNG Safari, влезающий в потолок, не заменяется бо́льшим шагом', async () => {
  // Safari без кодировщика WebP молча отдаёт PNG (задокументировано в
  // js/data/image.js): 350 КБ влезает в 400, а JPEG-шаги дают 420 —
  // результат не должен превысить maxBytes, когда влезание уже было.
  const { sandbox, context } = loadApp();
  bindCanvasStub(sandbox, (type) => (
    type === 'image/webp'
      ? { type: 'image/png', size: 350 * 1024 }
      : { type, size: 420 * 1024 }
  ));
  const file = makeFile('сафари.jpg');
  file.__w = 2000;
  file.__h = 1500;

  const result = await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.ok(result.blob.size <= 400 * 1024,
    'потолок maxBytes нарушен: ' + result.blob.size + ' Б');
  assert.equal(result.blob.type, 'image/png');
});

test('лестница: toBlob всё время null — фолбэк PNG, затем исходник ≤ 6 МБ', async () => {
  const { sandbox, context } = loadApp();
  const log = bindCanvasStub(sandbox, () => null);
  const file = makeFile('упрямый.jpg', 2 * 1024 * 1024);
  file.__w = 3000;
  file.__h = 2000;

  const result = await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.equal(log.toBlobCalls.length, 4, '3 шага лестницы + PNG-фолбэк');
  assert.equal(log.toBlobCalls[3].type, 'image/png');
  assert.equal(result.blob, file, 'исходник — последний шанс, но он должен работать');
});

test('лестница: исходник > 6 МБ и все кодирования null — честная ошибка', async () => {
  const { sandbox, context } = loadApp();
  bindCanvasStub(sandbox, () => null);
  const file = makeFile('гигант.jpg', 7 * 1024 * 1024);
  file.__w = 6000;
  file.__h = 4000;

  await assert.rejects(
    () => context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 }),
    /не смог сжать/,
  );
});

// ── Атака 2: HEIC и нестандартные форматы ───────────────────────────────────

test('HEIC: оба декодера отказали — понятная ошибка, objectURL закрыт', async () => {
  const { sandbox, context } = loadApp();
  bindCanvasStub(sandbox, null);
  sandbox.createImageBitmap = () => Promise.reject(new TypeError('unsupported'));
  const revoked = [];
  sandbox.URL = {
    createObjectURL() { return 'blob:heic'; },
    revokeObjectURL(u) { revoked.push(u); },
  };
  bindImageStub(sandbox, 'fail');
  const file = makeFile('фото.heic', 3 * 1024 * 1024, 'image/heic');
  file.__w = 0;
  file.__h = 0;

  await assert.rejects(
    () => context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 }),
    /не смог декодировать/,
  );
  assert.deepEqual(revoked, ['blob:heic'], 'objectURL не освобождён — утечка');
});

test('HEIC в чате: тост об ошибке, чип и флаг сжатия чисты (нет зависшего индикатора)', async () => {
  const { sandbox, context } = loadApp();
  const { els } = bindVisionDom(sandbox);
  bindCanvasStub(sandbox, null);
  sandbox.createImageBitmap = () => Promise.reject(new TypeError('unsupported'));
  sandbox.URL = {
    createObjectURL() { return 'blob:heic'; },
    revokeObjectURL() {},
  };
  bindImageStub(sandbox, 'fail');
  sandbox.FileReader = makeFileReader();

  const file = makeFile('фото.heic', 3 * 1024 * 1024, 'image/heic');
  await context.compressChatImages([file], () => {});

  assert.equal(context.getImageContext(), null, 'битое фото не должно прикрепиться');
  assert.equal(context.isImageCompressing(), false, 'флаг сжатия залип');
  assert.equal(els['assistant-image-indicator'].hidden, true, 'индикатор «Сжимаю…» завис');
  assert.ok(els.toast.textContent.indexOf('Не удалось обработать') !== -1
    && els.toast.textContent.indexOf('не изображение') !== -1,
    'нет тоста с понятной причиной: «' + els.toast.textContent + '»');
});

test('старый Safari без createImageBitmap: путь через <img> работает, objectURL закрыт', async () => {
  const { sandbox, context } = loadApp();
  const log = bindCanvasStub(sandbox, (type) => ({ type, size: 100 * 1024 }));
  sandbox.createImageBitmap = undefined;
  const revoked = [];
  sandbox.URL = {
    createObjectURL() { return 'blob:old'; },
    revokeObjectURL(u) { revoked.push(u); },
  };
  bindImageStub(sandbox, 'ok', [4032, 3024]);
  const file = makeFile('айфон.jpg');
  file.__w = 0;
  file.__h = 0;

  await context.compressImage(file, { maxSide: 1568, maxBytes: 400 * 1024 });

  assert.equal(log.toBlobCalls[0].width, 1568, 'ресайз по <img> не сработал');
  assert.equal(log.toBlobCalls[0].height, 1176);
  assert.deepEqual(revoked, ['blob:old'], 'objectURL не освобождён');
});

// ── Атака 3: флаг imageCompressing не должен залипать ───────────────────────

test('сжатие: сбой колбэка контролов не залипает флаг imageCompressing', async () => {
  const { sandbox, context } = loadApp();
  bindVisionDom(sandbox);
  sandbox.FileReader = makeFileReader();
  bindFastCompress(sandbox);
  let calls = 0;
  const boom = () => {
    calls++;
    if (calls === 1) throw new Error('контролы упали');
  };

  await assert.rejects(
    () => context.compressChatImages([makeFile('a.jpg')], boom),
    /контролы упали/,
  );
  assert.equal(context.isImageCompressing(), false,
    'флаг залип: выбор фото и отправка заблокированы навсегда');
  assert.equal(calls, 2, 'finally не восстановил контролы');
});

// ── Атака 4: lifecycle imageContext (вкладки, очистка, отправка) ────────────

test('lifecycle: чип переживает перерисовку вкладки, сжатие блокирует очистку, очистка работает', async () => {
  const { sandbox, context } = loadApp();
  const { els } = bindVisionDom(sandbox);
  sandbox.FileReader = makeFileReader();
  let release = null;
  sandbox.compressImage = (file) => (file.name === 'медленный.jpg'
    ? new Promise((resolve) => {
      release = () => resolve({
        blob: { type: 'image/jpeg', size: 100 * 1024, __dataUrl: 'data:image/jpeg;base64,RA==' },
        width: 10, height: 10,
      });
    })
    : Promise.resolve({
      blob: { type: 'image/jpeg', size: 100 * 1024, __dataUrl: 'data:image/jpeg;base64,MQ==' },
      width: 10, height: 10,
    }));

  await context.compressChatImages([makeFile('первый.jpg')], () => {});
  context.renderAssistantView();   // уход с вкладки и обратно
  assert.ok(els['assistant-image-indicator'].textContent.indexOf('первый.jpg') !== -1,
    'чип потерян после перерисовки вкладки');

  // очистка во время сжатия — отказ (второе фото ещё летит)
  const second = context.compressChatImages([makeFile('медленный.jpg')], () => {});
  assert.equal(context.isImageCompressing(), true);
  context.onAssistantImageClear();
  release();
  await second;
  assert.equal(context.getImageContext().length, 2,
    'очистка посреди сжатия сломала прикрепление или отказ не сработал');

  // чистая очистка
  context.onAssistantImageClear();
  assert.equal(context.getImageContext(), null);
  assert.equal(els['assistant-image-indicator'].hidden, true, 'чип не погашен после очистки');
});

test('после успешной отправки фото остаются прикреплёнными (уточняющие вопросы)', async () => {
  const bodies = [];
  const { sandbox, context } = loadApp({
    fetchImpl: (_url, opts) => { bodies.push(opts.body); return Promise.resolve(okReply('ответ')); },
  });
  bindVisionDom(sandbox);
  sandbox.FileReader = makeFileReader();
  bindFastCompress(sandbox);
  sandbox.localStorage.setItem('youplanner.api_key', 'ключ');

  await context.compressChatImages([makeFile('снимок.jpg')], () => {});
  assert.equal(context.onAssistantSubmit('Что на фото?'), true);
  await settle();
  assert.equal(context.getImageContext().length, 1,
    'фото потеряны после отправки — уточняющий вопрос их не увидит');

  assert.equal(context.onAssistantSubmit('А теперь поверни?'), true);
  await settle();
  assert.equal(bodies.length, 2);
  const messages = JSON.parse(bodies[1]).messages;
  const last = messages[messages.length - 1];
  assert.ok(Array.isArray(last.content), 'повторный ход ушёл без фото');
  assert.equal(last.content.filter((p) => p.type === 'image_url').length, 1);
});

// ── Атака 5: модель без зрения — все пути ───────────────────────────────────

test('модель без зрения выбрана ДО прикрепления: фото вешаются, отправка отсекается, fetch молчит', async () => {
  const fetchCalls = [];
  const { sandbox, context } = loadApp({
    fetchImpl: (url, opts) => { fetchCalls.push({ url, opts }); return Promise.resolve(okReply('ответ')); },
  });
  const { els } = bindVisionDom(sandbox);
  sandbox.FileReader = makeFileReader();
  bindFastCompress(sandbox);
  sandbox.localStorage.setItem('youplanner.api_key', 'ключ');
  sandbox.localStorage.setItem('youplanner.assistant_model', 'gpt-oss-120b');

  await context.compressChatImages([makeFile('a.jpg')], () => {});
  assert.equal(context.getImageContext().length, 1,
    'фото должны прикрепляться и при модели без зрения');

  assert.equal(context.onAssistantSubmit('Что на фото?'), false,
    'отправка с фото при модели без зрения должна отсекаться');
  assert.equal(fetchCalls.length, 0, 'payload с фото ушёл в API без vision-модели');
  assert.ok(els.toast.textContent.indexOf('не принимает изображения') !== -1,
    'нет объяснения пользователю: «' + els.toast.textContent + '»');
  assert.equal(context.readHistory().length, 0, 'вопрос осел в истории при отказе');

  context.onAssistantImageClear();
  assert.equal(context.onAssistantSubmit('Текст без фото'), true, 'после снятия фото текст должен уйти');
  await settle();
  assert.equal(fetchCalls.length, 1, 'заблокированная отправка не должна была звать API');
});

test('модель-кэш вне каталога (qwen3.6f.p): зрение по префиксу, отправка проходит', async () => {
  const bodies = [];
  const { sandbox, context } = loadApp({
    fetchImpl: (_url, opts) => { bodies.push(opts.body); return Promise.resolve(okReply('ответ')); },
  });
  bindVisionDom(sandbox);
  sandbox.FileReader = makeFileReader();
  bindFastCompress(sandbox);
  sandbox.localStorage.setItem('youplanner.api_key', 'ключ');
  sandbox.localStorage.setItem('youplanner.assistant_model', 'qwen3.6f.p');

  await context.compressChatImages([makeFile('a.jpg')], () => {});
  assert.equal(context.onAssistantSubmit('Что тут?'), true);
  await settle();
  assert.equal(bodies.length, 1, 'qwen-модель вне каталога не должна отсекать фото');
  const messages = JSON.parse(bodies[0]).messages;
  const last = messages[messages.length - 1];
  assert.ok(Array.isArray(last.content), 'фото не развёрнуты в vision-массив');
});

// ── Атака 7: сжатие и отправка без сети ─────────────────────────────────────

test('офлайн: фото прикрепляется, отправка даёт «Нет связи», чип и фото остаются', async () => {
  const { sandbox, context } = loadApp();   // fetch по умолчанию отвергает вызов
  const { els, created } = bindVisionDom(sandbox);
  sandbox.FileReader = makeFileReader();
  bindFastCompress(sandbox);
  sandbox.localStorage.setItem('youplanner.api_key', 'ключ');

  await context.compressChatImages([makeFile('снимок.jpg')], () => {});
  assert.ok(els['assistant-image-indicator'].textContent.indexOf('снимок.jpg') !== -1,
    'офлайн-сжатие не должно зависеть от сети');

  assert.equal(context.onAssistantSubmit('Что тут?'), true);
  await settle();

  const netText = 'Нет связи с сервисом нейросети. Подробности — в консоли браузера (F12).';
  assert.ok(created.some((el) => el.textContent === netText),
    'текст сетевого сбоя не показан в ленте');
  assert.equal(context.getImageContext().length, 1, 'фото потеряны при сетевом сбое');
  assert.ok(els['assistant-image-indicator'].textContent.indexOf('снимок.jpg') !== -1,
    'чип погас после сетевого сбоя — фото «исчезло» молча');
});

// ── Атака 8: 10 фото подряд — память и лимиты ───────────────────────────────

test('10 фото за раз: прикрепляются первые 3, повтор сверх лимита отсекается без сжатия', async () => {
  const { sandbox, context } = loadApp();
  const { els } = bindVisionDom(sandbox);
  sandbox.FileReader = makeFileReader();
  bindFastCompress(sandbox);

  const files = [];
  for (let i = 0; i < 10; i++) files.push(makeFile('фото-' + i + '.jpg'));
  await context.compressChatImages(files, () => {});

  const ctx = context.getImageContext();
  assert.equal(ctx.length, 3, 'прикрепилось фото: ' + ctx.length);
  const dataUrls = new Set([...ctx].map((i) => i.dataUrl));
  assert.equal(dataUrls.size, 3, 'дубликаты dataUrl — старые кадры не заменяются');
  assert.ok(els.toast.textContent.indexOf('Взяты первые 3') !== -1,
    'нет объяснения про пропуск: «' + els.toast.textContent + '»');
  assert.ok(els['assistant-image-indicator'].textContent.indexOf('фото-2') !== -1
    && els['assistant-image-indicator'].textContent.indexOf('фото-9') === -1,
    'в чипе не те фото');

  const before = [...ctx].map((i) => i.name);
  await context.compressChatImages([makeFile('новый.jpg')], () => {});
  assert.equal(context.getImageContext().length, 3, 'лимит перевален');
  assert.deepEqual([...context.getImageContext()].map((i) => i.name), before,
    'список изменился при переполнении');
  assert.equal(context.isImageCompressing(), false, 'флаг сжатия тронут при раннем выходе');
  assert.ok(els.toast.textContent.indexOf('Не больше 3') !== -1,
    'нет тоста про лимит: «' + els.toast.textContent + '»');
});

test('onAssistantSubmit: реплика во время сжатия фото уходит сразу после него (баг 1)', async () => {
  const fetchCalls = [];
  const app = loadApp({
    fetchImpl: (url, opts) => { fetchCalls.push({ url, opts }); return Promise.resolve(okReply('ответ')); },
  });
  app.sandbox.localStorage.setItem('youplanner.api_key', 'test-key');
  app.sandbox.localStorage.setItem('youplanner.assistant_model', 'qwen3.6-35b-a3b');
  app.run('imageContext = [{ dataUrl: "data:image/jpeg;base64,AAA", name: "a.jpg", bytes: 1024 }];');
  app.run('imageCompressing = true;');

  const accepted = app.context.onAssistantSubmit('Что на фото?');

  assert.equal(accepted, true, 'реплика принимается в очередь, а не отбивается ошибкой');
  assert.equal(fetchCalls.length, 0, 'запрос не уходит, пока фото сжимается');

  app.run('imageCompressing = false;');   // сжатие закончилось
  app.run('updateAssistantControls();');  // …контролы обновились — flush очереди
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fetchCalls.length, 1, 'отложенная реплика ушла после сжатия');
  assert.equal(app.run('readHistory().length'), 2,
    'в истории вопрос и ответ: реплика ушла один раз, без дубля');
});
