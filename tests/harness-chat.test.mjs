// Модуль ленты/composer (U5.7, U5.8): тесты бизнес-состояний отдельно от
// DOM — js/harness/chat.js получает элементы и действия аргументами.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_PATH = join(ROOT, 'js', 'harness', 'chat.js');

assert.ok(existsSync(CHAT_PATH), 'js/harness/chat.js не существует (ожидаются RED)');

const { createChat, statusFor } = await import('file://' + CHAT_PATH);

function stubElement(extra = {}) {
  return Object.assign({
    textContent: '',
    value: '',
    hidden: true,
    disabled: false,
    scrollHeight: 44,
    clientHeight: 400,
    scrollTop: 0,
    style: {},
    children: [],
    appendChild(node) { this.children.push(node); return node; },
    removeChild(node) {
      const i = this.children.indexOf(node);
      if (i !== -1) this.children.splice(i, 1);
      return node;
    },
    contains() { return false; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    scrollTo() {},
    setAttribute() {},
    getAttribute() { return null; },
  }, extra);
}

function stubChatElements() {
  return {
    list: stubElement({ hidden: false }),
    scroller: stubElement({ hidden: false, scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }),
    input: stubElement({ hidden: false }),
    send: stubElement({ hidden: false }),
    newMessages: stubElement(),
    feedback: stubElement(),
    announcer: stubElement(),
  };
}

function makeChat({ elements = stubChatElements(), onSend } = {}) {
  const sends = [];
  const drafts = {};
  const chat = createChat({
    elements,
    deps: {
      onSend: onSend || (async (text) => { sends.push(text); }),
      draftStore: {
        get(deviceId) { return drafts[deviceId] || ''; },
        set(deviceId, value) { drafts[deviceId] = value; },
      },
      deviceId: 'pc-main-01',
    },
  });
  return { chat, elements, sends, drafts };
}

/* --- Отправка --------------------------------------------------------------- */

test('пустое и пробельное сообщение не отправляется', () => {
  const h = makeChat();
  h.elements.input.value = '';
  assert.equal(h.chat.trySend(), false);
  h.elements.input.value = '   \n  ';
  assert.equal(h.chat.trySend(), false);
  assert.equal(h.sends.length, 0, 'onSend не звался ни разу');
});

test('успешная отправка: текст уходит, поле чистится, кнопка гаснет на время полёта', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const sent = [];
  const h = makeChat({
    onSend: (text) => { sent.push(text); return gate; },
  });
  h.elements.input.value = 'Собери отчёт по привычкам';
  const flight = h.chat.trySend();
  // пока запись ходит: кнопка заблокирована (анти-дубль)
  assert.equal(h.elements.send.disabled, true, 'анти-дубль на время отправки');
  release();
  await flight;
  assert.deepEqual(sent, ['Собери отчёт по привычкам']);
  assert.equal(h.elements.input.value, '', 'черновик снят после подтверждённой записи');
  assert.equal(h.elements.send.disabled, false);
});

test('ошибка отправки: черновик остаётся, причина видна словами', async () => {
  const h = makeChat();
  const failing = makeChat({
    onSend: () => Promise.reject(new Error('не удалось записать команду')),
  });
  failing.elements.input.value = 'Черновик задачи';
  await failing.chat.trySend();
  assert.equal(failing.elements.input.value, 'Черновик задачи',
    'текст сохраняется до подтверждённой записи');
  assert.ok(failing.elements.feedback.textContent.includes('не удалось'),
    'адресная ошибка показана в feedback');
});

test('черновики разделены по устройству', () => {
  const h = makeChat();
  h.elements.input.value = 'задача для первого ПК';
  h.chat.saveDraft();
  assert.equal(h.drafts['pc-main-01'], 'задача для первого ПК');
  assert.equal(h.drafts['pc-other'], undefined, 'черновик не течёт в другие deviceId');
});

test('Ctrl/Cmd+Enter отправляет с preventDefault, plain Enter не отправляет', () => {
  const h = makeChat();
  h.elements.input.value = 'задача с клавиатуры';
  const ctrlEnter = { key: 'Enter', ctrlKey: true, isComposing: false, prevented: false,
    preventDefault() { this.prevented = true; } };
  assert.equal(h.chat.onKeydown(ctrlEnter), true, 'Ctrl+Enter инициировал отправку');
  assert.equal(ctrlEnter.prevented, true, 'перенос строки при отправке подавлен');
  const plainEnter = { key: 'Enter', isComposing: false, prevented: false,
    preventDefault() { this.prevented = true; } };
  assert.equal(h.chat.onKeydown(plainEnter), false,
    'plain Enter не отправляет (на телефоне вставляет строку)');
  assert.equal(plainEnter.prevented, false);
  assert.deepEqual(h.sends, ['задача с клавиатуры']);
});

test('IME-композиция: Enter подтверждает ввод, но не отправляет', () => {
  const h = makeChat();
  h.elements.input.value = 'りんご';
  const ime = { key: 'Enter', ctrlKey: true, isComposing: true, preventDefault() {} };
  assert.equal(h.chat.onKeydown(ime), false, 'IME Enter не отправляет');
  assert.equal(h.sends.length, 0);
});

/* --- Статусы (U5.7) ------------------------------------------------------------ */

test('статусы выводятся последовательно по источнику', () => {
  const cases = [
    [{ phase: 'sending' }, 'Отправляется'],
    [{ command: true, execution: null }, 'Записано в облако'],
    [{ command: true, execution: { state: 'queued' } }, 'Принято ПК'],
    [{ command: true, execution: { state: 'claimed' } }, 'Принято ПК'],
    [{ command: true, execution: { state: 'running' } }, 'Выполняется'],
    [{ command: true, execution: { state: 'running', waitingApproval: true } }, 'Ожидает подтверждения'],
    [{ command: true, execution: { state: 'succeeded' } }, null, /Готово|выполнено/i],
  ];
  for (const [item, exact, re] of cases) {
    const status = statusFor(item);
    if (exact !== null) {
      assert.equal(status.text, exact, JSON.stringify(item));
    } else if (re) {
      assert.match(status.text, re, JSON.stringify(item));
    }
  }
});

test('outcome_unknown объясняется словами без ложного успеха', () => {
  const status = statusFor({ command: true, execution: { state: 'outcome_unknown' } });
  assert.equal(status.text, 'Возможно, действие уже выполнено. Автоматического повтора не будет');
  assert.doesNotMatch(status.text, /выполнено успешно/i);
});

test('истечение команды показывается отдельно', () => {
  const status = statusFor({ command: true, execution: { state: 'expired' } });
  assert.equal(status.text, 'Срок команды истёк');
});

/* --- Прокрутка и пагинация --------------------------------------------------------- */

test('якорь: не дальше 80px от низа — прокрутить к концу', () => {
  const h = makeChat();
  // scrollHeight 1000, clientHeight 400, scrollTop 560 → зазор 40 ≤ 80
  assert.equal(h.chat.isNearBottom(), true);
  h.elements.scroller.scrollTop = 100;  // зазор 500 > 80
  assert.equal(h.chat.isNearBottom(), false);
});

test('новое сообщение вне якоря показывает «Новые сообщения», не прокручивая', () => {
  const h = makeChat();
  h.elements.scroller.scrollTop = 100;
  h.chat.appendMessage({ role: 'agent', text: 'Ответ агента', at: 1000 });
  assert.equal(h.elements.newMessages.hidden, false,
    'плашка «Новые сообщения» видна вне якоря');
});

test('начальная страница ленты — 50 сообщений, старые догружаются по 50', () => {
  const h = makeChat();
  const items = [];
  for (let i = 0; i < 120; i++) {
    items.push({ role: 'owner', text: 'сообщение ' + i, at: i, id: 'm' + i });
  }
  h.chat.setMessages(items);
  assert.equal(h.elements.list.children.length, 50,
    'начальная страница ограничена 50 сообщениями');
  h.chat.loadOlder();
  assert.equal(h.elements.list.children.length, 100);
  h.chat.loadOlder();
  assert.equal(h.elements.list.children.length, 120);
  h.chat.loadOlder();
  assert.equal(h.elements.list.children.length, 120, 'дальше загружать нечего');
});

/* --- Рост поля ---------------------------------------------------------------- */

test('textarea растёт по scrollHeight до 126px и дальше прокручивается', () => {
  const h = makeChat();
  h.elements.input.scrollHeight = 44;
  h.chat.autosize();
  assert.equal(h.elements.input.style.height, '44px');
  h.elements.input.scrollHeight = 300;
  h.chat.autosize();
  assert.equal(h.elements.input.style.height, '126px',
    'выше пяти строк поле не растёт — включается собственная прокрутка');
  h.elements.input.scrollHeight = 21;
  h.chat.autosize();
  assert.equal(h.elements.input.style.height, '44px',
    'минимальная высота поля — 44px (тач-цель)');
});
