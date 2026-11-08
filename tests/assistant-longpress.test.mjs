// Долгое нажатие на пузырь чата ассистента вместо крестика (задача 3.1,
// смена 2026-11-06). Крестик «✕» убран из пузырей: на телефоне он съедал
// тап-цель и замусоривал ленту. Удаление — жест: удержание пузыря 450 мс
// открывает подтверждение. Смена 2026-11-07: вместо нижней шторки —
// КОМПАКТНЫЙ ПОПАП возле пузыря (шторка выезжала «красной полосой» на весь
// низ и перекрывала таб-бар), внутри одна кнопка «Удалить», удаление зовёт
// ту же removeHistoryAt. Позиционирование и подложка —
// tests/assistant-popup.test.mjs.
//
// Что фиксируют проверки:
//   * createLongPressDetector — чистая логика с инъекцией таймеров и событий:
//     удержание 450 мс открывает, сдвиг больше 10px отменяет (скролл),
//     ранний отпуск отменяет (тап), мышь ведётся тем же детектором;
//   * проводка на ленте (bindAssistantChatLongPress): долгое нажатие по
//     пузырю с индексом открывает попап, а «Удалить» в попапе вырезает ту
//     самую реплику — существующей функцией, с тем же id;
//   * пузыри без индекса (приветствие, «Печатает…», пузырь ошибки) молчат;
//   * contextmenu в пузырях гасится: системное меню не перехватывает жест;
//   * крестика и шторки больше нет нигде: ни в js, ни в CSS, ни в разметке.
//
// Fake DOM — по образцу assistant-delete.test.mjs: всплытие не моделируется,
// fireOn(child, type) зовёт слушателей ленты с target-ом дочернего узла,
// как в живом событии. Время — фейковые часы из helpers/fake-timers.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './helpers/load-app.mjs';
import { makeFakeTimers } from './helpers/fake-timers.mjs';
import { readIndexHtml } from './helpers/sources.mjs';

const HISTORY_KEY = 'youplanner.assistant_history';
const API_KEY = 'youplanner.api_key';
const PRESS_MS = 450;      // порог из требований задачи 3.1
const CANCEL_PX = 10;      // порог отмены движением, «~10px»

/* --- события-подобные объекты ----------------------------------------------- */

// touchstart/touchmove несут точку касания в touches[0]
function touch(x, y) {
  return { touches: [{ clientX: x, clientY: y }] };
}

// mouse-события несут точку прямо на событии
function mouse(x, y) {
  return { clientX: x, clientY: y };
}

/* --- чистый детектор --------------------------------------------------------- */

function makeDetector(app, timers, fired, extraOptions) {
  return app.context.createLongPressDetector(
    { onLongPress: () => fired.push(timers.now()) },
    Object.assign(
      { scheduleTimer: timers.schedule, cancelTimer: timers.cancel },
      extraOptions || {},
    ));
}

test('longpress: детектор и проводка экспортированы из assistant-view.js', () => {
  const app = loadApp();
  assert.equal(typeof app.context.createLongPressDetector, 'function',
    'чистая логика жеста доступна тестам');
  assert.equal(typeof app.context.bindAssistantChatLongPress, 'function',
    'проводка жеста на ленту доступна app.js');
});

test('longpress: удержание 450мс открывает, и ровно один раз', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  detector.press(touch(10, 10));
  timers.advance(PRESS_MS - 1);
  assert.deepEqual(fired, [], 'за миллисекунду до порога — ещё рано');
  timers.advance(1);
  assert.deepEqual(fired, [PRESS_MS], 'на пороге сработало один раз');
  timers.advance(1000);
  assert.deepEqual(fired, [PRESS_MS],
    'таймер одноразовый: удержание дольше порога не открывает второй раз');
  assert.equal(timers.pendingCount(), 0, 'висящих таймеров не осталось');
});

test('longpress: сдвиг больше 10px отменяет — скролл ленты не открывает лист', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  detector.press(touch(0, 0));
  timers.advance(100);
  detector.move(touch(11, 0));
  assert.equal(timers.pendingCount(), 0, 'таймер снят сразу при выходе за порог');
  timers.advance(1000);
  assert.deepEqual(fired, [], 'после отмены открытий нет');
});

test('longpress: дрожание пальца в пределах 10px отменой не считается', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  detector.press(touch(0, 0));
  detector.move(touch(9, 0));   // 9px < 10px
  timers.advance(PRESS_MS);
  assert.deepEqual(fired, [PRESS_MS], 'микросдвиг пальца не мешает жесту');
});

test('longpress: диагональный сдвиг считается по расстоянию, а не по осям', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  detector.press(touch(0, 0));
  // 8px по каждой оси — это ~11.3px расстояния: больше порога, отмена
  detector.move(touch(8, 8));
  timers.advance(PRESS_MS);
  assert.deepEqual(fired, [], 'сравнение в квадрате ловит и диагональ');
});

test('longpress: ранний отпуск отменяет — обычный тап не открывает лист', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  detector.press(touch(0, 0));
  timers.advance(PRESS_MS - 1);
  detector.release();
  assert.equal(timers.pendingCount(), 0, 'отпускание сняло таймер');
  timers.advance(1000);
  assert.deepEqual(fired, []);
});

test('longpress: mouseleave и повторное нажатие после срабатывания', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  // Мышь ушла с пузыря при зажатой кнопке — жест снят
  detector.press(mouse(0, 0));
  timers.advance(200);
  detector.leave();
  timers.advance(1000);
  assert.deepEqual(fired, [], 'mouseleave отменяет');

  // Детектор переиспользуем: после отмены следующее удержание работает
  // (часы стоят на 200 + 1000 = 1200, порог истекает на 1650-й)
  detector.press(mouse(0, 0));
  timers.advance(PRESS_MS);
  assert.deepEqual(fired, [1650], 'второе нажатие сработало на своих 450мс');
});

test('longpress: мышь — тот же детектор, точка в clientX/clientY', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  detector.press(mouse(5, 5));
  detector.move(mouse(40, 5));   // зажатой мышью уехали на 35px — это drag
  timers.advance(PRESS_MS);
  assert.deepEqual(fired, [], 'перетаскивание мышью отменяет, как и скролл');
});

test('longpress: нажатие без координат таймер не ставит', () => {
  const app = loadApp();
  const timers = makeFakeTimers();
  const fired = [];
  const detector = makeDetector(app, timers, fired, { delayMs: PRESS_MS });

  detector.press(null);
  detector.move(touch(3, 3));   // move без нажатия — тоже без последствий
  timers.advance(PRESS_MS * 2);
  assert.deepEqual(fired, [], 'ни press(null), ни move вхолостую не открывают');
  assert.equal(timers.pendingCount(), 0);
});

/* --- fake DOM: проводка на ленте --------------------------------------------- */

function makeNode(doc, tag) {
  const node = {
    tagName: tag,
    className: '',
    children: [],
    attrs: {},
    textContent: '',
    hidden: false,
    type: '',
    // Попап позиционируется инлайн-стилями: top/left ставит JS
    style: {},
    // Размер/позиция узла: попап меряется после вставки в DOM
    rect: { top: 0, left: 0, width: 120, height: 44 },
    getBoundingClientRect() { return node.rect; },
    _events: {},
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
      return child;
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
    },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name); },
    addEventListener(type, fn) {
      (node._events[type] || (node._events[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = node._events[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire(type) {
      const handlers = node._events[type] || [];
      const event = { target: node, preventDefault() {}, stopPropagation() {} };
      for (const fn of handlers) fn(event);
    },
    // Всплытия fake не делает: fireOn зовёт слушателей ЛЕНТЫ, а target —
    // дочерний узел, как в живом событии. extra докладывает в событие
    // координаты/касания; preventDefault записывается, чтобы тест видел,
    // что системное меню по долгому нажатию подавлено
    scrollIntoView() {},
    classList: null,
  };
  const set = new Set();
  node.classList = {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toggle(c, on) { if (on) set.add(c); else set.delete(c); },
  };
  node.closest = (selector) => doc.closestFrom(node, selector);
  return node;
}

function makeDoc() {
  const byId = {};
  const doc = {
    byId,
    createElement(tag) {
      const node = makeNode(doc, tag || 'div');
      return node;
    },
    getElementById(id) { return byId[id] || null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    removeEventListener() {},
    createTextNode(text) { return { text: String(text) }; },
    // closest по классу: идём по цепочке родителей, как живой Element.closest
    closestFrom(node, selector) {
      const cls = String(selector || '').replace(/^\./, '');
      for (let cur = node; cur; cur = cur.parentNode) {
        if (String(cur.className || '').split(/\s+/).indexOf(cls) >= 0) return cur;
      }
      return null;
    },
  };
  const chat = makeNode(doc, 'div');
  chat.parentNode = null;
  Object.defineProperty(chat, 'textContent', {
    get() { return ''; },
    set() { chat.children.length = 0; for (const child of chat.children) child.parentNode = null; },
  });
  chat.fireOn = (child, type, extra) => {
    const calls = [];
    const event = Object.assign({
      target: child,
      preventDefault() { calls.push('preventDefault'); },
      stopPropagation() {},
    }, extra || {});
    event.preventDefaultCalls = calls;
    for (const fn of chat._events[type] || []) fn(event);
    return event;
  };
  doc.chat = chat;
  byId['assistant-chat'] = chat;

  const input = makeNode(doc, 'textarea');
  input.value = '';
  byId['assistant-input'] = input;

  const send = makeNode(doc, 'button');
  byId['assistant-send'] = send;

  const toast = makeNode(doc, 'div');
  byId.toast = toast;
  doc.toast = toast;

  // Попап и его подложка создаются из JS и вставляются в body
  doc.body = makeNode(doc, 'body');
  return doc;
}

// Узлы попапа в fake-body (смена 2026-11-07: шторки больше нет)
function popupOf(doc) {
  return doc.body.children.find((n) => n.className === 'assistant-delete-popup') || null;
}

function backdropOf(doc) {
  return doc.body.children.find((n) => n.className === 'assistant-delete-backdrop') || null;
}

// Проводка как в js/app.js: жест на ленте с фейковыми часами. Кнопку «Удалить»
// попапа вручную НЕ подключаем: слушатель confirmAssistantDelete вешает сам
// модуль при создании попапа. Живая проводка app.js закрепляется статической
// проверкой ниже
function wire(app, doc, timers) {
  app.sandbox.document = doc;   // приложение должно видеть fake DOM, а не дефолт
  app.context.bindAssistantChatLongPress(doc.chat, {
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
  });
  return doc;
}

// Долгое нажатие по пузырю в fake-ленте: touchstart + порог фейковых часов
function longPressOn(doc, bubble) {
  doc.chat.fireOn(bubble, 'touchstart', touch(5, 5));
  doc.timers.advance(PRESS_MS);
}

function stored(sandbox) {
  const raw = sandbox.localStorage.getItem(HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

function seeded(app, history) {
  app.sandbox.localStorage.setItem(API_KEY, 'тест-ключ');
  app.sandbox.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function bubbles(doc) {
  return doc.chat.children.slice();
}

test('longpress: удержание пузыря открывает попап, ничего не удаляя', () => {
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  seeded(app, [
    { role: 'user', content: 'спроси' },
    { role: 'assistant', content: 'отвечу' },
  ]);
  app.context.renderHistory();

  longPressOn(doc, bubbles(doc)[1]);
  assert.ok(popupOf(doc), 'попап открыт долгим нажатием');
  assert.equal(app.context.isAssistantDeletePopupOpen(), true);
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['спроси', 'отвечу'],
    'до подтверждения история целая');
});

test('longpress: «Удалить» в попапе зовёт существующую функцию с тем же id', () => {
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  seeded(app, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ]);
  app.context.renderHistory();

  // Жест по ВТОРОМУ пузырю (индекс 1, реплика «a1»)
  longPressOn(doc, bubbles(doc)[1]);
  const popup = popupOf(doc);
  assert.ok(popup);
  const confirmBtn = popup.children.find((c) => c.tagName === 'button');
  assert.ok(confirmBtn, 'внутри кнопка «Удалить»');
  confirmBtn.fire('click');   // слушатель на ней вешает сам модуль

  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'q2'],
    'вырезана именно a1 — пузырь и реплика сошлись индексом');
  assert.equal(popupOf(doc), null, 'попап закрыт после удаления');
});

test('longpress: пузыри без индекса (приветствие) жест игнорируют', () => {
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  app.sandbox.localStorage.setItem(API_KEY, 'тест-ключ');
  app.context.renderHistory();   // пустая история → приветствие

  assert.equal(bubbles(doc).length, 1);
  longPressOn(doc, bubbles(doc)[0]);
  assert.equal(popupOf(doc), null, 'удалять нечего — попап не открыт');
  assert.equal(doc.timers.pendingCount(), 0, 'и таймер не ставился');
});

test('longpress: быстрый тап по пузырю не открывает попап', () => {
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();

  doc.chat.fireOn(bubbles(doc)[0], 'touchstart', touch(5, 5));
  doc.timers.advance(PRESS_MS - 1);
  doc.chat.fireOn(bubbles(doc)[0], 'touchend');
  doc.timers.advance(200);
  assert.equal(popupOf(doc), null, 'тап — не жест удаления');
  assert.equal(doc.timers.pendingCount(), 0, 'таймер снят отпуском');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1'],
    'история целая');
});

test('longpress: скролл (сдвиг больше порога) отменяет открытие', () => {
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();

  doc.chat.fireOn(bubbles(doc)[0], 'touchstart', touch(0, 0));
  doc.timers.advance(100);
  doc.chat.fireOn(bubbles(doc)[0], 'touchmove', touch(0, 40));  // палец уехал
  doc.timers.advance(PRESS_MS);
  assert.equal(popupOf(doc), null, 'прокрутка не открывает попап');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1']);
});

test('longpress: мышь по пузырю тоже открывает попап', () => {
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  seeded(app, [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  app.context.renderHistory();

  doc.chat.fireOn(bubbles(doc)[0], 'mousedown', mouse(3, 3));
  doc.timers.advance(PRESS_MS);
  assert.ok(popupOf(doc), 'долгое нажатие мышью работает');
});

test('longpress: contextmenu в пузыре гасится, вне пузыря — живёт', () => {
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();

  const inBubble = doc.chat.fireOn(bubbles(doc)[0], 'contextmenu');
  assert.deepEqual(inBubble.preventDefaultCalls, ['preventDefault'],
    'системное меню по долгому нажатию подавлено');
  const outside = doc.chat.fireOn(doc.byId.toast, 'contextmenu');
  assert.deepEqual(outside.preventDefaultCalls, [],
    'вне пузырей браузерное меню не трогаем');
});

/* --- статические проверки кода и стилей --------------------------------------- */

test('longpress: крестика больше нигде нет — ни кнопки в коде, ни стилей', () => {
  const view = readFileSync(new URL('../js/ui/assistant-view.js', import.meta.url), 'utf8');
  assert.ok(!view.includes('assistant-msg-del'), 'класс кнопки-крестика вычищен из кода');
  assert.ok(!view.includes('✕'), 'символ крестика вычищен из кода');
  assert.ok(!view.includes('onAssistantChatClick'), 'клик-делегирование крестика убрано');

  const css = readFileSync(new URL('../styles/assistant.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('.assistant-msg-del'), 'стили крестика вычищены');
});

test('longpress: пузыри защищены от перехвата жеста системой (CSS)', () => {
  const css = readFileSync(new URL('../styles/assistant.css', import.meta.url), 'utf8');
  const rule = css.match(/\.assistant-msg\s*\{[^}]*\}/);
  assert.ok(rule, 'правило пузыря найдено');
  assert.match(rule[0], /-webkit-user-select:\s*none/, 'Safari: без выделения текста');
  assert.match(rule[0], /user-select:\s*none/, 'выделение текста не съедает жест');
  assert.match(rule[0], /-webkit-touch-callout:\s*none/, 'iOS: без системной плашки «копировать»');
});

test('longpress: проводка вешает жест на ленту, а не на каждый пузырь', () => {
  // Проводка жеста переехала из app.js в js/events/screens-events.js
  // (пилот Фабрики 2026-11-08); инвариант тот же
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const screens = readFileSync(new URL('../js/events/screens-events.js', import.meta.url), 'utf8');
  assert.match(screens, /bindAssistantChatLongPress/, 'проводка жеста импортирована');
  assert.match(screens,
    /getElementById\('assistant-chat'\)[\s\S]{0,120}bindAssistantChatLongPress\(assistantChat\)/,
    'жест делегирован ленте');
  assert.ok(!app.includes('onAssistantChatClick'), 'обработчик крестика убран из app.js');
  // Кнопку «Удалить» подключает сам модуль при создании попапа — проводки
  // прежнего листа (getElementById + data-assistant-delete-close) вычищены
  assert.ok(!app.includes('assistant-delete-confirm'),
    'app.js не подключает кнопку попапа — она создаётся из JS');
  assert.ok(!app.includes('data-assistant-delete-close'),
    'закрывателей шторки в app.js больше нет');
});

test('longpress: шторки в разметке нет, попап создаёт JS с одной кнопкой', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('assistant-delete-sheet'),
    'шторка #assistant-delete-sheet вычищена из index.html');
  assert.ok(!html.includes('data-assistant-delete-close'),
    'закрыватели шторки вычищены из index.html');

  // Единственная кнопка попапа рождается в JS: долгое нажатие → попап с
  // ровно одной «Удалить» (никаких полос на весь экран)
  const app = loadApp();
  const doc = makeDoc();
  doc.timers = makeFakeTimers();
  wire(app, doc, doc.timers);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();
  longPressOn(doc, bubbles(doc)[0]);
  const popup = popupOf(doc);
  assert.ok(popup, 'попап открыт жестом');
  const buttons = popup.children.filter((c) => c.tagName === 'button');
  assert.equal(buttons.length, 1, 'внутри ровно одна кнопка');
  assert.equal(buttons[0].textContent, 'Удалить');
  assert.equal(popup.children.length, 1,
    'других узлов нет: закрытие — клик по подложке, «Отмены» не нужно');
});
