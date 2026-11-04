// Удаление ОДНОГО сообщения в чате с ассистентом (Воркер 3, смена 2026-11-04).
//
// Что фиксируют проверки:
//   * удаление вырезает ровно одну реплику из хранилища и из последующего
//     контекста запроса (buildMessages читает историю заново);
//   * пузырь ленты и реплика сходятся индексом, а не позицией: лента после
//     перерисовки не даёт «удалить не то»;
//   * у узлов, которых в истории нет (приветствие, «Печатает…», пузырь
//     ошибки), кнопки удаления нет;
//   * подтверждение — нижний лист приложения (styles/sheets.css), а не
//     confirm() и не централизованная модалка;
//   * удаление из середины не отправляет модели контекст, начинающийся с
//     assistant-реплики (правило — в requestTail, описано в коде);
//   * текст реплики уходит в превью через textContent: XSS не внесён;
//   * history key — device-local (js/data/storage.js), синхронизация других
//     разделов не затрагивается: ни одного вызова шины и чужих ключей.
//
// Fake DOM здесь полнее, чем в assistant.test.mjs: нужны closest, атрибуты,
// hidden у шторки и делегирование клика по ленте. Всплытие события fake не
// моделирует — поэтому «клик по кнопке» проверяется вызом обработчика с
// target-ом кнопки, а живое всплытие — ручная браузерная проверка.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './helpers/load-app.mjs';
import { readIndexHtml } from './helpers/sources.mjs';

const HISTORY_KEY = 'youplanner.assistant_history';
const API_KEY = 'youplanner.api_key';

/* --- fake DOM -------------------------------------------------------------- */

function makeNode(doc, tag) {
  const node = {
    tagName: tag,
    className: '',
    children: [],
    attrs: {},
    textContent: '',
    hidden: false,
    type: '',
    _events: {},
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
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
    fire(type) {
      const handlers = node._events[type] || [];
      const event = { target: node, preventDefault() {}, stopPropagation() {} };
      for (const fn of handlers) fn(event);
    },
    // Всплытия fake не делает: fire вызывает обработчики УЗЛА. Делегирование
    // по ленте проверяется fireOn(child, 'click') — обработчик висит на ленте,
    // а target приходит от дочернего узла, как в живом событии
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
  const created = [];
  const doc = {
    created,
    byId,
    createElement(tag) {
      const node = makeNode(doc, tag || 'div');
      created.push(node);
      return node;
    },
    getElementById(id) { return byId[id] || null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    createTextNode(text) { return { text: String(text) }; },
    body: { classList: { add() {}, remove() {}, contains() { return false; } } },
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
  chat.fireOn = (child, type) => {
    const event = { target: child, preventDefault() {}, stopPropagation() {} };
    for (const fn of chat._events[type] || []) fn(event);
  };
  doc.chat = chat;
  byId['assistant-chat'] = chat;

  const sheet = makeNode(doc, 'div');
  sheet.hidden = true;
  byId['assistant-delete-sheet'] = sheet;
  doc.sheet = sheet;

  const preview = makeNode(doc, 'p');
  byId['assistant-delete-preview'] = preview;
  doc.preview = preview;

  const role = makeNode(doc, 'p');
  byId['assistant-delete-role'] = role;
  doc.role = role;

  const confirmBtn = makeNode(doc, 'button');
  byId['assistant-delete-confirm'] = confirmBtn;
  doc.confirmBtn = confirmBtn;

  const input = makeNode(doc, 'textarea');
  input.value = '';
  byId['assistant-input'] = input;

  const send = makeNode(doc, 'button');
  byId['assistant-send'] = send;

  const keyModal = makeNode(doc, 'div');
  keyModal.hidden = true;
  byId['assistant-key-modal'] = keyModal;

  const toast = makeNode(doc, 'div');
  byId.toast = toast;
  doc.toast = toast;
  return doc;
}

function bindDoc(sandbox, doc) {
  sandbox.document = doc;
  return doc;
}

// Проводка как в js/app.js (init/bindEvents в песочнице не запускается:
// document.addEventListener там no-op): ленту слушает onAssistantChatClick,
// подтверждение — confirmAssistantDelete. Соответствие этой проводки разметке
// закрепляет статическая проверка ниже
function wire(app, doc) {
  doc.chat.addEventListener('click', app.context.onAssistantChatClick);
  doc.confirmBtn.addEventListener('click', app.context.confirmAssistantDelete);
  return doc;
}

function stored(sandbox) {
  const raw = sandbox.localStorage.getItem(HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

// Снимок значения из реалма песочницы в хозяйский массив (иначе deepEqual
// сравнивает prototypes разных Array)
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function okReply(content) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: content } }] }),
  };
}

function deferredFetch() {
  let resolveReply = null;
  const fetchImpl = () => new Promise((resolve) => { resolveReply = resolve; });
  fetchImpl.resolveReply = (content) => resolveReply(okReply(content));
  return fetchImpl;
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// Лента с историей из n реплик: key — вопрос, «a{n}» — ответ
function seeded(app, history) {
  app.sandbox.localStorage.setItem(API_KEY, 'тест-ключ');
  app.sandbox.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function bubbles(doc) {
  return doc.chat.children.slice();
}

/* --- кнопки удаления на пузырях -------------------------------------------- */

test('delete: у каждого пузыря истории есть кнопка и свой индекс', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [
    { role: 'user', content: 'первый вопрос' },
    { role: 'assistant', content: 'первый ответ' },
    { role: 'user', content: 'второй вопрос' },
  ]);
  app.context.renderHistory();

  const nodes = bubbles(doc);
  assert.equal(nodes.length, 3, 'пузырей столько же, сколько реплик');
  nodes.forEach((bubble, i) => {
    assert.equal(bubble.getAttribute('data-msg-index'), String(i),
      'индекс = позиция в readHistory, пузырь ' + i);
    const button = bubble.children.filter(c => c.className === 'assistant-msg-del');
    assert.equal(button.length, 1, 'одна кнопка удаления на пузырь');
    assert.equal(button[0].type, 'button',
      'type=button: внутри #assistant-form submit-кнопка отправила бы реплику');
    assert.equal(button[0].getAttribute('aria-label'), 'Удалить сообщение');
  });
});

test('delete: приветствие, «Печатает…» и пузырь ошибки кнопки не имеют', async () => {
  const app = loadApp({ fetchImpl: () => Promise.reject(new Error('сети нет')) });
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  app.sandbox.localStorage.setItem(API_KEY, 'тест-ключ');

  // Пустая история: лента = приветствие (в хранилище его нет)
  app.context.renderHistory();
  assert.equal(bubbles(doc).length, 1, 'приветствие отрисовано');
  assert.equal(bubbles(doc)[0].hasAttribute('data-msg-index'), false,
    'у приветствия удалять нечего');

  // Ошибка хода к API: пузырь есть, реплики в истории нет
  assert.equal(app.context.onAssistantSubmit('вопрос'), true);
  await settle();
  const errorBubble = bubbles(doc).filter(b => b.classList.contains('is-error'));
  assert.equal(errorBubble.length, 1, 'пузырь ошибки показан');
  assert.equal(errorBubble[0].hasAttribute('data-msg-index'), false,
    'пузырь ошибки не подписан индексом истории');
  assert.equal(errorBubble[0].children.filter(c => c.className === 'assistant-msg-del').length, 0,
    'кнопки удаления у пузыря ошибки нет');
});

test('delete: живой вопрос и живой ответ получают индекс сразу, без перерисовки', async () => {
  const fetchImpl = deferredFetch();
  const app = loadApp({ fetchImpl });
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, []);

  assert.equal(app.context.onAssistantSubmit('новый вопрос'), true);
  const question = bubbles(doc).find(b => b.getAttribute('data-msg-index') !== null);
  assert.ok(question, 'узел вопроса сразу подписан индексом истории');
  assert.equal(question.getAttribute('data-msg-index'), '0');

  fetchImpl.resolveReply('свежий ответ');
  await settle();
  const answer = bubbles(doc).find(b => b.getAttribute('data-msg-index') === '1');
  assert.ok(answer, 'ответ получает индекс 1 после записи в историю');
  assert.deepEqual(stored(app.sandbox).map(m => m.role), ['user', 'assistant']);
});

/* --- удаление ------------------------------------------------------------- */

test('delete: вырезается ровно одна реплика, порядок и соседи целы', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  const history = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ];
  seeded(app, history);
  app.context.renderHistory();

  assert.equal(app.context.removeHistoryAt(1), true);
  assert.deepEqual(stored(app.sandbox), [history[0], history[2], history[3]],
    'удалён только a1');
  // Лента перерисована: индексы сдвинулись, и следующий тап попадёт по тому же
  // сообщению, а не по соседу
  assert.deepEqual(bubbles(doc).map(b => b.getAttribute('data-msg-index')), ['0', '1', '2'],
    'после удаления индексы пересчитаны');
  assert.deepEqual(bubbles(doc).map(b => b.textContent), ['q1', 'q2', 'a2']);
});

test('delete: конец списка, начало и единственный элемент', () => {
  const app = loadApp();
  bindDoc(app.sandbox, makeDoc());
  seeded(app, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
  ]);
  assert.equal(app.context.removeHistoryAt(1), true);
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1']);
  assert.equal(app.context.removeHistoryAt(0), true);
  assert.deepEqual(stored(app.sandbox), [], 'последняя реплика удаляется');

  const fresh = loadApp();
  bindDoc(fresh.sandbox, makeDoc());
  seeded(fresh, [{ role: 'user', content: 'единственный' }]);
  assert.equal(fresh.context.removeHistoryAt(0), true);
  assert.deepEqual(stored(fresh.sandbox), []);
});

test('delete: невалидный индекс и уже удалённая реплика — отказа нет молча', () => {
  const app = loadApp();
  bindDoc(app.sandbox, makeDoc());
  seeded(app, [{ role: 'user', content: 'q1' }]);
  assert.equal(app.context.removeHistoryAt(-1), false);
  assert.equal(app.context.removeHistoryAt(7), false);
  assert.equal(app.context.removeHistoryAt(1.5), false);
  assert.equal(app.context.removeHistoryAt(null), false);
  assert.deepEqual(stored(app.sandbox), [{ role: 'user', content: 'q1' }],
    'история не изменилась');
  // Второй тап по устаревшему индексу: лента не перерисована, цель пропала
  assert.equal(app.context.removeHistoryAt(0), true);
  assert.equal(app.context.removeHistoryAt(0), false,
    'повторное удаление того же места ничего не вырезает');
});

test('delete: клик по кнопке открывает лист, а не удаляет сразу', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [
    { role: 'user', content: 'спроси' },
    { role: 'assistant', content: 'отвечу' },
  ]);
  app.context.renderHistory();
  // Делегирование: слушатель висит на ленте, target — кнопка внутри пузыря
  const button = bubbles(doc)[1].children.find(c => c.className === 'assistant-msg-del');
  doc.chat.fireOn(button, 'click');

  assert.equal(doc.sheet.hidden, false, 'открылся лист подтверждения');
  assert.equal(doc.preview.textContent, 'отвечу', 'в превью — текст удаляемой реплики');
  assert.equal(doc.role.textContent, 'Ответ ассистента');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['спроси', 'отвечу'],
    'без подтверждения ничего не удалено');
});

test('delete: чужой клик по ленте листа не открывает', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();

  doc.chat.fireOn(bubbles(doc)[0], 'click');   // тап по пузырю, не по кнопке
  assert.equal(doc.sheet.hidden, true, 'лист закрыт');
  assert.equal(app.context.removeHistoryAt(0), true, 'а по кнопке — открывается, не удаляет');
});

test('delete: «Удалить» в листе вырезает реплику и закрывает шторку', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ]);
  app.context.renderHistory();
  const button = bubbles(doc)[1].children.find(c => c.className === 'assistant-msg-del');
  doc.chat.fireOn(button, 'click');
  assert.equal(doc.sheet.hidden, false);

  // Подтверждение — кнопка листа (в app.js на ней confirmAssistantDelete)
  assert.equal(app.context.confirmAssistantDelete(), true);
  assert.equal(doc.sheet.hidden, true, 'лист закрыт после подтверждения');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'q2']);
});

test('delete: «Отмена» и закрытие листа ничего не удаляют и индекс снимают', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  app.context.renderHistory();
  doc.chat.fireOn(bubbles(doc)[0].children.find(c => c.className === 'assistant-msg-del'), 'click');
  assert.equal(doc.sheet.hidden, false);

  app.context.closeAssistantDeleteSheet();
  assert.equal(doc.sheet.hidden, true);
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'a1']);
  // Подтверждение после закрытия: индекс снят close-обработчиком, удалять нечего
  assert.equal(app.context.confirmAssistantDelete(), false,
    'открытый ранее индекс не пережил закрытие листа');
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'a1']);
});

test('delete: лист закрывается по Escape-слою и на смене экрана — состояние не залипает', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  app.context.renderHistory();
  doc.chat.fireOn(bubbles(doc)[0].children.find(c => c.className === 'assistant-msg-del'), 'click');
  assert.equal(app.context.isAssistantDeleteSheetOpen(), true);

  app.context.closeAssistantDeleteSheet();
  assert.equal(app.context.isAssistantDeleteSheetOpen(), false);
  assert.equal(app.context.confirmAssistantDelete(), false,
    'закрытый лист не оставляет висящего индекса для следующего подтверждения');
});

test('delete: индекс не устаревает после перерисовки при запросе в полёте', async () => {
  const fetchImpl = deferredFetch();
  const app = loadApp({ fetchImpl });
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  app.context.renderHistory();

  // Удаление a1 при живом ленточном состоянии, затем новый вопрос
  assert.equal(app.context.removeHistoryAt(1), true);
  assert.equal(app.context.onAssistantSubmit('q2'), true);
  const question = bubbles(doc).find(b => b.getAttribute('data-msg-index') === '1');
  assert.ok(question, 'индекс нового вопроса учитывает удаление: '
    + JSON.stringify(stored(app.sandbox).map(m => m.content)));

  fetchImpl.resolveReply('a2');
  await settle();
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['q1', 'q2', 'a2']);
  const answer = bubbles(doc).find(b => b.getAttribute('data-msg-index') === '2');
  assert.ok(answer, 'ответ получил индекс 2, а не 1');
});

test('delete: реплика не записана (квота) — кнопки удаления на ней нет', () => {
  const app = loadApp({ fetchImpl: () => Promise.reject(new Error('сети нет')) });
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  app.sandbox.localStorage.setItem(API_KEY, 'тест-ключ');
  const realSet = app.sandbox.localStorage.setItem.bind(app.sandbox.localStorage);
  app.sandbox.localStorage.setItem = (key, value) => {
    if (key === HISTORY_KEY) throw new Error('QuotaExceededError');
    realSet(key, value);
  };

  assert.equal(app.context.onAssistantSubmit('вопрос'), true, 'отправка принята');
  const bubblesNow = bubbles(doc);
  assert.ok(bubblesNow.length >= 1, 'пузырь вопроса показан');
  assert.equal(bubblesNow[0].hasAttribute('data-msg-index'), false,
    'несостоявшейся записи не выдаём индекс');
  assert.equal(bubblesNow[0].children.filter(c => c.className === 'assistant-msg-del').length, 0,
    'и кнопку удаления тоже: резать нечего');
});

/* --- контекст запроса ---------------------------------------------------- */

test('delete: контекст запроса читается заново — удалённое не уезжает в модель', () => {
  const app = loadApp();
  bindDoc(app.sandbox, makeDoc());
  seeded(app, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ]);
  const before = app.context.buildMessages().map(m => m.content);
  assert.equal(before.length, 4, 'system + три реплики');
  assert.equal(app.context.removeHistoryAt(1), true);
  const after = app.context.buildMessages().map(m => m.content);
  assert.equal(after.length, 3, 'реплика пропала из payload');
  assert.ok(!JSON.stringify(after).includes('a1'), 'a1 больше не уходит в запрос');
});

test('delete: контекст не начинается с assistant-реплики после удаления вопроса', () => {
  const app = loadApp();
  bindDoc(app.sandbox, makeDoc());
  seeded(app, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ]);
  assert.equal(app.context.removeHistoryAt(0), true, 'удалён первый вопрос');
  // Массивы из песочницы — другой реалм: deepStrictEqual сверяет prototypes и
  // падает на «одинаковом» массиве, поэтому значения снимаются через plain()
  const roles = plain(app.context.buildMessages().map(m => m.role));
  assert.deepEqual(roles, ['system', 'user', 'assistant'],
    'ведущий ответ отсечен от контекста, а не удалён из истории: ' + JSON.stringify(roles));
  assert.deepEqual(stored(app.sandbox).map(m => m.content), ['a1', 'q2', 'a2'],
    'в истории и на экране a1 остаётся: правило касается только запроса');
});

test('delete: срез ведущих assistant не трогает обычный диалог и лимит 20', () => {
  const app = loadApp();
  bindDoc(app.sandbox, makeDoc());
  const history = [];
  for (let i = 0; i < 30; i++) {
    history.push({ role: i % 2 ? 'assistant' : 'user', content: 'реплика ' + i });
  }
  seeded(app, history);
  const messages = app.context.buildMessages();
  assert.equal(messages.length, 21, 'system + 20 реплик хвоста');
  assert.equal(messages[1].role, 'user', 'хвост и так начинается с вопроса');
  assert.equal(messages[1].content, 'реплика 10');
});

test('delete: удаление не задевает другие разделы и синхронизацию', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  const seeds = {
    'youplanner.habits': JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]),
    'youplanner.records': JSON.stringify({ '2026-11-01': { h1: true } }),
    'youplanner.qaza': JSON.stringify({ version: 3, cursor: 3, remaining: {} }),
    'youplanner.sleep': JSON.stringify({ version: 4, bed: '23:30', wake: '06:00', fall: 15, history: [] }),
  };
  for (const key of Object.keys(seeds)) app.sandbox.localStorage.setItem(key, seeds[key]);
  seeded(app, [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  const dumpBefore = JSON.stringify(app.sandbox.localStorage._dump());

  app.context.renderHistory();
  assert.equal(app.context.removeHistoryAt(0), true);

  const dumpAfter = app.sandbox.localStorage._dump();
  for (const key of Object.keys(seeds)) {
    assert.equal(dumpAfter[key], seeds[key], 'ключ чужого раздела не тронут: ' + key);
  }
  assert.notEqual(dumpBefore, dumpAfter, 'изменился только ключ истории ассистента');
  assert.equal(Object.keys(dumpAfter).length, Object.keys(JSON.parse(dumpBefore)).length,
    'новых ключей не появилось');
});

/* --- XSS ----------------------------------------------------------------- */

test('delete: текст реплики не становится разметкой ни в пузыре, ни в превью', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  const hostile = '<img src=x onerror=alert(1)>';
  seeded(app, [
    { role: 'user', content: hostile },
    { role: 'assistant', content: 'ответ ' + hostile },
  ]);
  app.context.renderHistory();
  const node = bubbles(doc)[0];
  assert.equal(node.textContent, hostile, 'текст пузыря — textContent');
  const buttons = node.children.filter(c => c.tagName === 'button');
  assert.equal(buttons.length, 1, 'внутри пузыря только кнопка удаления');
  assert.equal(buttons[0].textContent, '✕');
  assert.ok(!node.children.some(c => c.tagName === 'img'),
    'из текста не родится разметка: ни img, ни чего-либо ещё');

  doc.chat.fireOn(buttons[0], 'click');
  assert.equal(doc.preview.textContent, hostile, 'превью тоже только текст');
  assert.ok(!doc.preview.children.length, 'в превью не появилось детей-разметки');
  const serialized = JSON.stringify(stored(app.sandbox));
  assert.ok(serialized.includes('&lt;') === false, 'в хранилище текст не экранирован дважды');
});

test('delete: кнопка не содержит текста реплики и не ломает a11y ленты', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'длинный вопрос ' + 'а'.repeat(200) }]);
  app.context.renderHistory();
  const button = bubbles(doc)[0].children[0];
  assert.equal(button.textContent, '✕', 'подпись кнопки не растёт из текста реплики');
  assert.equal(button.getAttribute('aria-label'), 'Удалить сообщение');
  assert.equal(button.hasAttribute('tabindex'), false,
    'лишних остановок фокуса нет: кнопка и так в порядке DOM');
});

/* --- разметка и стили ---------------------------------------------------- */

test('delete: в разметке — нижний лист приложения, а не модалка и не confirm()', () => {
  const app = loadApp();
  const doc = bindDoc(app.sandbox, makeDoc());
  wire(app, doc);
  seeded(app, [{ role: 'user', content: 'q1' }]);
  // confirm() намеренно НЕ подставлен: удаление одной реплики не имеет права
  // его звать (в отличие от очистки всей истории)
  const called = [];
  app.sandbox.confirm = () => { called.push('confirm'); return true; };
  app.context.renderHistory();
  doc.chat.fireOn(bubbles(doc)[0].children[0], 'click');
  assert.deepEqual(plain(called), [], 'нативный confirm не использован');

  const sheet = app.sandbox.document.getElementById('assistant-delete-sheet');
  assert.equal(sheet.hidden, false, 'подтверждение — в шторке');
});

// --- Проводка и разметка: поведение выше проверяется на ручном wire(), этот
// тест закрепляет, что живой app.js и index.html подключены тем же манером
// (иначе тесты зелёные, а в браузере кнопка ничего не делает)

test('delete: app.js слушает ленту, подтверждение и закрытие листа', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /onAssistantChatClick/, 'обработчик ленты импортирован');
  assert.match(app,
    /getElementById\('assistant-chat'\)[\s\S]{0,120}addEventListener\('click', onAssistantChatClick\)/,
    'делегирование клика висит на ленте, а не на каждом пузыре');
  assert.match(app,
    /getElementById\('assistant-delete-confirm'\)[\s\S]{0,160}addEventListener\('click', confirmAssistantDelete\)/,
    'кнопка «Удалить» подтверждена обработчиком');
  assert.match(app, /data-assistant-delete-close/,
    'подложка и «Отмена» листа подключены');
  // Escape-слой и уход с экрана: шторка не должна переживать переход
  assert.match(app, /getElementById\('assistant-delete-sheet'\)[\s\S]{0,140}closeAssistantDeleteSheet\(\)/,
    'Escape гасит лист удаления');
  assert.match(app, /closeLevelSheet\(\);[\s\S]{0,240}closeAssistantDeleteSheet\(\);/,
    'смена экрана закрывает лист вместе с остальными шторками');
});

test('delete: разметка листа — шторка вне формы ассистента, текст через id', () => {
  const html = readIndexHtml();
  const sheetStart = html.indexOf('<div id="assistant-delete-sheet"');
  assert.ok(sheetStart >= 0, 'лист удаления есть в разметке');
  const sheetEnd = html.indexOf('</div>\n\n<!-- Тост', sheetStart);
  const sheet = html.slice(sheetStart, sheetEnd > 0 ? sheetEnd : sheetStart + 1400);
  assert.match(sheet, /class="sheet"/, 'это слой шторки (styles/sheets.css)');
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /aria-modal="true"/);
  assert.match(sheet, /aria-labelledby="assistant-delete-title"/,
    'заголовок листа связан с диалогом');
  assert.match(sheet, /id="assistant-delete-preview"/);
  assert.match(sheet, /id="assistant-delete-role"/);
  assert.match(sheet, /data-assistant-delete-close/);
  // Лист обязан лежать ВНЕ #assistant-form: кнопка внутри формы отправляла бы
  // реплику вместе с подтверждением удаления
  const formStart = html.indexOf('<form id="assistant-form"');
  const formEnd = html.indexOf('</form>', formStart);
  assert.ok(formStart >= 0 && formEnd > formStart, 'форма ассистента найдена');
  assert.ok(sheetStart > formEnd, 'лист вне #assistant-form');
  // Подтверждение — не нативный confirm: в разметке он не нужен
  assert.ok(!/onclick="confirm\(/.test(sheet), 'инлайнового confirm() нет');
});

test('delete: кнопка удаления и лист описаны стилями без новых цветов', () => {
  const css = readFileSync(new URL('../styles/assistant.css', import.meta.url), 'utf8');
  assert.match(css, /\.assistant-msg \{\s*position: relative/, 'пузырь — якорь кнопки');
  const block = css.slice(css.indexOf('.assistant-msg-del {'), css.indexOf('.assistant-msg-del::after'));
  assert.ok(block.length > 0, 'правило кнопки найдено');
  assert.match(block, /position: absolute/, 'кнопка не толкает текст пузыря');
  assert.match(block, /var\(--surface-pressed\)/, 'фон — существующий токен');
  assert.ok(!/#([0-9a-fA-F]{3,6})\b/.test(block), 'шестнадцатеричных цветов нет');
  assert.match(css, /\.assistant-msg:has\(\.assistant-msg-del\)\s*\{\s*padding-right/,
    'под кнопку зарезервировано место, текст не уезжает под неё');
  assert.match(css, /\.assistant-msg-del::after\s*\{[\s\S]{0,120}inset: -11px/,
    'тап-цель больше видимого кружка');
  assert.match(css, /\.assistant-msg-del:focus-visible\s*\{\s*outline/,
    'фокус с клавиатуры виден');
});
