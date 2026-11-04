// ТЗ Б5 «Доставка»: in-app уведомление с заголовком задачи, временем и
// действиями «Открыть»/«Закрыть», в доступном живом регионе и очередью.
//
// Отдельный модуль (js/ui/matrix-notices.js) проверяется без всего приложения:
// ему подаётся fake-документ, и видно ровно то, что он обязан гарантировать —
// текст уходит через textContent (не разметка), #toast не перезаписывается,
// очередь ограничена.
//
// RED на нынешнем состоянии: модуля нет вообще.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MATRIX_NOTICE_MAX, createNoticeCenter } from '../js/ui/matrix-notices.js';

function makeNode(tag, doc) {
  const node = {
    tagName: tag,
    className: '',
    children: [],
    dataset: {},
    attrs: {},
    _doc: doc,
    _events: {},
    addEventListener(type, fn) {
      (node._events[type] || (node._events[type] = [])).push(fn);
    },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name] === undefined ? null : String(node.attrs[name]); },
    appendChild(child) {
      if (!child) return child;
      child._parent = node;
      node.children.push(child);
      return child;
    },
    append(...list) { for (const child of list) if (child) node.appendChild(child); },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child._parent = null;
      return child;
    },
    remove() { if (node._parent) node._parent.removeChild(node); },
    fire(type) {
      const detail = { preventDefault() {}, target: node };
      for (const fn of node._events[type] || []) fn(detail);
    },
  };
  node.classList = {
    add(name) { if (node.className.indexOf(name) < 0) node.className += (node.className ? ' ' : '') + name; },
    contains(name) { return node.className.split(/\s+/).indexOf(name) >= 0; },
  };
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => (node.children.length ? node.children.map(c => c.textContent).join('') : text),
    set: (value) => {
      text = value === null || value === undefined ? '' : String(value);
      if (text === '') node.children.length = 0;
    },
  });
  return node;
}

function makeDoc() {
  const byId = {};
  const body = makeNode('body');
  const toast = makeNode('div');
  toast.textContent = 'Не удалось сохранить: память браузера занята';
  byId.toast = toast;
  const doc = {
    body,
    toast,
    createElement: (tag) => makeNode(tag, doc),
    getElementById: (id) => byId[id] || null,
  };
  return doc;
}

function walk(node, out) {
  for (const child of node.children || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function byClass(root, className) {
  return walk(root, []).filter(node => node.className.split(/\s+/).indexOf(className) >= 0);
}

function center(doc) {
  return createNoticeCenter({ doc: doc, onOpen: () => { doc.opened = true; } });
}

test('Б5 доставка: уведомление с заголовком, временем и двумя действиями', (t) => {
  const doc = makeDoc();
  const out = center(doc);

  out.show({ id: 'n1', title: 'Полоскать рот', at: '2026-11-04T09:00:00' });

  const stack = doc.body.children[0];
  assert.ok(stack, 'стек уведомлений добавлен в body');
  assert.equal(stack.getAttribute('aria-live'), 'polite', 'регион объявляет новые уведомления');
  assert.equal(stack.getAttribute('role'), 'region');
  assert.match(stack.getAttribute('aria-label'), /Напоминания/);

  const notice = byClass(stack, 'matrix-reminder-notice')[0];
  assert.ok(notice, 'уведомление отрисовано');
  assert.match(byClass(notice, 'matrix-reminder-notice-title')[0].textContent, /Полоскать рот/);
  assert.ok(byClass(notice, 'matrix-reminder-notice-time')[0].textContent.length > 0,
    'время названо');
  const actions = byClass(notice, 'matrix-reminder-notice-open')
    .concat(byClass(notice, 'matrix-reminder-notice-close'));
  assert.equal(actions.length, 2, '«Открыть» и «Закрыть»');
  assert.ok(!doc.toast.textContent.includes('Полоскать'),
    'тост ошибки не перезаписывается уведомлением');
});

test('Б5 «Закрыть» снимает одно уведомление, «Открыть» зовёт обработчик', (t) => {
  const doc = makeDoc();
  const out = center(doc);
  out.show({ id: 'n1', title: 'Первое', at: '2026-11-04T09:00:00' });
  out.show({ id: 'n2', title: 'Второе', at: '2026-11-04T09:30:00' });
  const stack = doc.body.children[0];
  assert.equal(byClass(stack, 'matrix-reminder-notice').length, 2, 'очередь держит оба');

  byClass(stack, 'matrix-reminder-notice-close')[0].fire('click');
  assert.equal(byClass(stack, 'matrix-reminder-notice').length, 1, 'снято ровно одно');
  assert.match(byClass(stack, 'matrix-reminder-notice')[0].textContent, /Второе/);

  byClass(stack, 'matrix-reminder-notice-open')[0].fire('click');
  assert.equal(doc.opened, true, '«Открыть» ведёт в Матрицу');
  assert.equal(byClass(stack, 'matrix-reminder-notice').length, 0,
    'после «Открыть» уведомление больше не мешает');
});

test('Б5 очередь ограничена: лишние не плодятся, дубль одного id не повторяется', (t) => {
  const doc = makeDoc();
  const out = center(doc);
  for (let i = 1; i <= 9; i++) out.show({ id: 'n' + i, title: 'Задача ' + i, at: '2026-11-04T10:00:00' });
  const stack = doc.body.children[0];
  const live = byClass(stack, 'matrix-reminder-notice');
  assert.ok(live.length <= MATRIX_NOTICE_MAX,
    'на экране не больше ' + MATRIX_NOTICE_MAX + ' уведомлений, есть ' + live.length);
  assert.match(stack.textContent, /Задача 9/, 'последнее показano');

  out.show({ id: 'n9', title: 'Задача 9', at: '2026-11-04T10:00:00' });
  assert.equal(byClass(stack, 'matrix-reminder-notice').length, live.length,
    'повтор того же id не добавляет вторую карточку');
});

test('Б5 пользовательский текст остаётся текстом', (t) => {
  const doc = makeDoc();
  const out = center(doc);
  const evil = '<img src=x onerror=alert(1)>';
  out.show({ id: 'n1', title: evil, at: '2026-11-04T09:00:00' });
  const stack = doc.body.children[0];
  const title = byClass(stack, 'matrix-reminder-notice-title')[0];
  assert.equal(title.textContent, evil, 'заголовок читается буквально');
  assert.equal(title.children.length, 0, 'из заголовка разметку не строить');
});

test('Б5 clear убирает все уведомления (выход из аккаунта, смена данных)', (t) => {
  const doc = makeDoc();
  const out = center(doc);
  out.show({ id: 'n1', title: 'Одно', at: '2026-11-04T09:00:00' });
  out.show({ id: 'n2', title: 'Другое', at: '2026-11-04T09:10:00' });
  out.clear();
  const stack = doc.body.children[0];
  assert.equal(byClass(stack, 'matrix-reminder-notice').length, 0);
  assert.equal(out.count(), 0);
});
