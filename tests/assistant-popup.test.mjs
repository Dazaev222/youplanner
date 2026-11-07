// Попап удаления одной реплики в чате ассистента (смена 2026-11-07).
// Прежнее подтверждение — нижняя шторка #assistant-delete-sheet — по
// баг-репорту владельца выезжала «красной полосой» на весь низ экрана и
// перекрывала таб-бар. Теперь долгое нажатие открывает КОМПАКТНУЮ карточку
// возле пузыря сообщения:
//   * computePopupPosition — ЧИСТАЯ функция позиционирования (юнит-тесты
//     здесь): по умолчанию попап НАД пузырём (низ попапа = rect.top - 8),
//     сверху нет места — ПОД пузырём, по горизонтали центр пузыря с зажимом
//     в [8, viewport - ширина - 8];
//   * открытие: пузырь и попап сходятся через getBoundingClientRect,
//     размеры попапа меряются ПОСЛЕ вставки в DOM;
//   * закрытие: прозрачная подложка на весь экран ловит клик/тап; попап
//     лежит ВЫШЕ подложки (клик по «Удалить» доходит); скролл и ресайз
//     тоже закрывают — попап не должен отрываться от пузыря;
//   * «Удалить» зовёт ту же цепочку: confirmAssistantDelete →
//     removeHistoryAt, данные не тронуты;
//   * шторки #assistant-delete-sheet больше нет нигде: ни в разметке,
//     ни в CSS, ни в js.
//
// Fake DOM — по образцу assistant-delete.test.mjs, плюс body (appendChild/
// removeChild), style, getBoundingClientRect и запись слушателей документа:
// попап создаётся из JS динамически и позиционируется координатами.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './helpers/load-app.mjs';
import { makeFakeTimers } from './helpers/fake-timers.mjs';
import { readIndexHtml } from './helpers/sources.mjs';

const HISTORY_KEY = 'youplanner.assistant_history';
const API_KEY = 'youplanner.api_key';
const PRESS_MS = 450;   // порог долгого нажатия (жест — tests/assistant-longpress.test.mjs)

/* --- computePopupPosition: чистое позиционирование -------------------------- */

test('popup: пузырь в середине — попап НАД пузырём, top = rect.top - h - 8', () => {
  const app = loadApp();
  const pos = app.context.computePopupPosition(
    { top: 300, left: 100, width: 200, height: 40 },
    { width: 120, height: 48 },
    { width: 390, height: 844 });
  assert.equal(pos.placement, 'above', 'места сверху достаточно — попап сверху');
  assert.equal(pos.top, 300 - 48 - 8, 'низ попапа = верх пузыря минус 8px зазор');
  assert.equal(pos.left, 100 + 200 / 2 - 120 / 2, 'горизонтально — центр пузыря');
});

test('popup: пузырь у верха (rect.top < высота + 8) — попап ПОД пузырём', () => {
  const app = loadApp();
  const pos = app.context.computePopupPosition(
    { top: 30, left: 20, width: 200, height: 40 },
    { width: 120, height: 48 },
    { width: 390, height: 844 });
  assert.equal(pos.placement, 'below', 'сверху меньше высоты попапа + 8 — снизу');
  assert.equal(pos.top, 30 + 40 + 8, 'верх попапа = низ пузыря плюс 8px зазор');
});

test('popup: граница ровно rect.top = h + 8 — ещё above (место впритык есть)', () => {
  const app = loadApp();
  // 48 + 8 = 56: попап станет вплотную к краю вьюпорта, но не за ним
  const pos = app.context.computePopupPosition(
    { top: 56, left: 0, width: 200, height: 40 },
    { width: 120, height: 48 },
    { width: 390, height: 844 });
  assert.equal(pos.placement, 'above');
  assert.equal(pos.top, 0);
});

test('popup: пузырь у правого края — left зажат в вьюпорт с зазором 8px', () => {
  const app = loadApp();
  const pos = app.context.computePopupPosition(
    { top: 300, left: 350, width: 30, height: 40 },
    { width: 120, height: 48 },
    { width: 390, height: 844 });
  assert.equal(pos.placement, 'above');
  // по центру пузыря вышло бы 305, а влезает максимум 390 - 120 - 8 = 262
  assert.equal(pos.left, 390 - 120 - 8, 'правый зажим: viewport - ширина - 8');
});

test('popup: пузырь у левого края — left зажат в 8px', () => {
  const app = loadApp();
  const pos = app.context.computePopupPosition(
    { top: 300, left: -100, width: 40, height: 40 },
    { width: 120, height: 48 },
    { width: 390, height: 844 });
  assert.equal(pos.left, 8, 'левый зажим: margin');
});

test('popup: свой margin перекрывает дефолтные 8px', () => {
  const app = loadApp();
  const pos = app.context.computePopupPosition(
    { top: 300, left: 100, width: 200, height: 40 },
    { width: 120, height: 48 },
    { width: 390, height: 844 },
    12);
  assert.equal(pos.top, 300 - 48 - 12, 'зазор = margin');
  assert.equal(pos.left, 100 + 200 / 2 - 120 / 2);
});

/* --- fake DOM: динамический попап ------------------------------------------- */

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
    // Позиция/размер по умолчанию: как у компактного попапа. Тест
    // переопределяет node.rect у пузырей и у будущего попапа
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
    docEvents: {},   // слушатели самого документа (scroll с capture)
    createElement(tag) {
      const node = makeNode(doc, tag || 'div');
      return node;
    },
    getElementById(id) { return byId[id] || null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(type, fn) {
      (doc.docEvents[type] || (doc.docEvents[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = doc.docEvents[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
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
    const event = Object.assign(
      { target: child, preventDefault() {}, stopPropagation() {} },
      extra || {});
    for (const fn of chat._events[type] || []) fn(event);
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

  doc.body = makeNode(doc, 'body');
  return doc;
}

// Слушатели window (resize): песочница loadApp живёт с no-op, тест
// подменяет на запись — как document.docEvents для scroll
function spyWindow(app) {
  const events = {};
  app.sandbox.window.addEventListener = (type, fn) => {
    (events[type] || (events[type] = [])).push(fn);
  };
  app.sandbox.window.removeEventListener = (type, fn) => {
    const list = events[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  return events;
}

function bindDoc(sandbox, doc) {
  sandbox.document = doc;
  return doc;
}

// Проводка как в js/app.js: жест на ленте с фейковыми часами. Кнопку попапа
// НЕ подключаем вручную: слушатель confirmAssistantDelete вешает сам модуль
// при создании попапа — это и есть проверка живой цепочки
function wire(app, doc) {
  doc.timers = makeFakeTimers();
  app.context.bindAssistantChatLongPress(doc.chat, {
    scheduleTimer: doc.timers.schedule,
    cancelTimer: doc.timers.cancel,
  });
  return doc;
}

function longPressOn(doc, bubble) {
  doc.chat.fireOn(bubble, 'touchstart', { touches: [{ clientX: 5, clientY: 5 }] });
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

function bodyByClass(doc, className) {
  return doc.body.children.find((n) => n.className === className) || null;
}

function popupOf(doc) {
  return bodyByClass(doc, 'assistant-delete-popup');
}

function backdropOf(doc) {
  return bodyByClass(doc, 'assistant-delete-backdrop');
}

/* --- открытие попапа у пузыря ----------------------------------------------- */

test('popup: долгое нажатие открывает карточку возле пузыря, а не шторку', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [
    { role: 'user', content: 'спроси' },
    { role: 'assistant', content: 'отвечу' },
  ]);
  app.context.renderHistory();

  // Пузырь ответа в середине экрана: попап обязан встать НАД ним
  const bubble = bubbles(doc)[1];
  bubble.rect = { top: 300, left: 100, width: 200, height: 40 };
  spyWindow(app);

  longPressOn(doc, bubble);

  const popup = popupOf(doc);
  assert.ok(popup, 'попап вставлен в body');
  assert.ok(backdropOf(doc), 'прозрачная подложка тоже в body');
  assert.equal(app.context.isAssistantDeletePopupOpen(), true);
  assert.ok(doc.body.children.indexOf(popup) > doc.body.children.indexOf(backdropOf(doc)),
    'попап в DOM ПОСЛЕ подложки — лежит выше');
  assert.equal(popup.children[0].tagName, 'button', 'внутри кнопка');
  assert.equal(popup.children[0].textContent, 'Удалить');

  // Позиция: та же математика, что в чистой функции
  const expected = app.context.computePopupPosition(
    bubble.rect, popup.rect,
    { width: app.sandbox.window.innerWidth, height: app.sandbox.window.innerHeight });
  assert.equal(popup.style.top, expected.top + 'px', 'top из computePopupPosition');
  assert.equal(popup.style.left, expected.left + 'px', 'left из computePopupPosition');
  assert.equal(popup.style.top, (300 - 44 - 8) + 'px', 'над пузырём: rect.top - 44 - 8');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['спроси', 'отвечу'],
    'открытие ничего не удаляет');
});

test('popup: «Удалить» в попапе вырезает ту же реплику и закрывает попап', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ]);
  app.context.renderHistory();
  const bubble = bubbles(doc)[1];
  bubble.rect = { top: 300, left: 100, width: 200, height: 40 };
  spyWindow(app);

  longPressOn(doc, bubble);   // жест по ВТОРОМУ пузырю (реплика a1)
  const popup = popupOf(doc);
  assert.ok(popup);

  popup.children[0].fire('click');   // кнопка «Удалить», слушатель вешает модуль

  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'q2'],
    'вырезана именно a1 — та же removeHistoryAt, что у прежнего листа');
  assert.equal(app.context.isAssistantDeletePopupOpen(), false);
  assert.equal(popupOf(doc), null, 'попап снят с body');
  assert.equal(backdropOf(doc), null, 'подложка снята с body');
});

test('popup: клик по подложке закрывает попап и ничего не удаляет', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  app.context.renderHistory();
  const bubble = bubbles(doc)[0];
  bubble.rect = { top: 300, left: 100, width: 200, height: 40 };
  spyWindow(app);

  longPressOn(doc, bubble);
  assert.ok(popupOf(doc));
  backdropOf(doc).fire('click');   // тап мимо попапа

  assert.equal(app.context.isAssistantDeletePopupOpen(), false, 'попап закрыт');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'a1'],
    'история целая');
  assert.equal(app.context.confirmAssistantDelete(), false,
    'закрытый попап не оставляет висящего индекса');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'a1']);
});

test('popup: скролл и ресайз закрывают попап — он не отрывается от пузыря', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();
  const bubble = bubbles(doc)[0];
  bubble.rect = { top: 300, left: 100, width: 200, height: 40 };
  const winEvents = spyWindow(app);

  // Скролл ленты: capture-слушатель документа гасит попап
  longPressOn(doc, bubble);
  assert.ok(popupOf(doc));
  const scrollHandlers = doc.docEvents.scroll || [];
  assert.ok(scrollHandlers.length >= 1, 'scroll-слушатель документа установлен');
  scrollHandlers[0]({});
  assert.equal(app.context.isAssistantDeletePopupOpen(), false, 'скролл закрыл попап');
  assert.deepEqual(doc.docEvents.scroll, [], 'слушатель снят при закрытии');

  // Ресайз окна: слушатель window
  longPressOn(doc, bubble);
  assert.ok(popupOf(doc));
  const resizeHandlers = winEvents.resize || [];
  assert.ok(resizeHandlers.length >= 1, 'resize-слушатель окна установлен');
  resizeHandlers[0]({});
  assert.equal(app.context.isAssistantDeletePopupOpen(), false, 'ресайз закрыл попап');
  assert.deepEqual(winEvents.resize, [], 'слушатель снят при закрытии');
});

test('popup: пузырь без координат (странная среда) попап не открывает', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();
  bubbles(doc)[0].rect = undefined;   // getBoundingClientRect вернёт undefined
  spyWindow(app);

  longPressOn(doc, bubbles(doc)[0]);
  assert.equal(popupOf(doc), null, 'без якоря позиционировать нечего — не открываем');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1'],
    'и ничего не удаляет');
});

/* --- стили и разметка -------------------------------------------------------- */

test('popup: в разметке и CSS шторки #assistant-delete-sheet больше нет', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('assistant-delete-sheet'),
    'блок шторки вычищен из index.html');
  assert.ok(!html.includes('data-assistant-delete-close'),
    'закрыватели шторки вычищены из index.html');

  const css = readFileSync(new URL('../styles/assistant.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('#assistant-delete-sheet'),
    'CSS-остатки шторки вычищены');
  assert.ok(!css.includes('assistant-delete-sheet'),
    'никаких упоминаний шторки в стилях экрана');
});

test('popup: карточка описана токенами проекта, деструктив — --danger', () => {
  const css = readFileSync(new URL('../styles/assistant.css', import.meta.url), 'utf8');
  const popupRule = css.match(/\.assistant-delete-popup\s*\{[^}]*\}/);
  assert.ok(popupRule, 'правило карточки попапа найдено');
  assert.match(popupRule[0], /position:\s*fixed/, 'позиция fixed — координаты ставит JS');
  assert.match(popupRule[0], /max-width:\s*240px/, 'компактная: потолок ширины 240px');
  assert.match(popupRule[0], /var\(--surface-card\)/, 'фон — светлый токен карточек');
  assert.match(popupRule[0], /var\(--radius-md\)/, 'радиус ~12px — токен шкалы');
  assert.match(popupRule[0], /var\(--shadow\)/, 'тень как у существующих листов');

  const backdropRule = css.match(/\.assistant-delete-backdrop\s*\{[^}]*\}/);
  assert.ok(backdropRule, 'правило подложки найдено');
  assert.match(backdropRule[0], /position:\s*fixed/);
  assert.match(backdropRule[0], /inset:\s*0/, 'подложка на весь экран');

  const btnRule = css.match(/\.assistant-delete-confirm\s*\{[^}]*\}/);
  assert.ok(btnRule, 'правило кнопки «Удалить» найдено');
  assert.match(btnRule[0], /var\(--danger\)/, 'деструктивный токен проекта');
  assert.match(btnRule[0], /min-height:\s*44px/, 'тап-цель как у кнопок проекта');

  // Попап обязан лежать ВЫШЕ подложки, иначе клик по кнопке не дойдёт
  const zIndex = (rule) => Number((rule[0].match(/z-index:\s*(\d+)/) || [])[1]);
  const popupZ = zIndex(popupRule);
  const backdropZ = zIndex(backdropRule);
  assert.ok(Number.isFinite(popupZ) && Number.isFinite(backdropZ),
    'у слоя и карточки задан z-index');
  assert.ok(popupZ > backdropZ, 'попап выше подложки: ' + popupZ + ' > ' + backdropZ);
  // Подложка накрывает и таб-бар (1000 в mobile.css): клик мимо попапа
  // ловится везде, но сама карточка — компактная, таб-бар не перекрывает
  assert.ok(backdropZ > 1000, 'подложка выше таб-бара');
});
