// Контроллер approvals по сценариям U5.9.1 (ТЗ U5.6, P2.4). Тесты идут
// ПЕРЕД реализацией (RED) — js/harness/approvals.js ещё нет.
//
// Адаптер Firebase подменяется фейком: никаких сети и RTDB здесь нет
// (U5.8: «Модули проектируй с инъекцией firebase-адаптера — тесты на
// фейке, не на сети»). DOM подменяется заглушками-объектами.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeTimers } from './helpers/fake-timers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROLLER_PATH = join(ROOT, 'js', 'harness', 'approvals.js');

assert.ok(existsSync(CONTROLLER_PATH),
  'js/harness/approvals.js не существует — реализация не начата (ожидаются RED)');

const { createApprovalController } = await import('file://' + CONTROLLER_PATH);

/* --- Заглушки --------------------------------------------------------------- */

function stubElement(extra = {}) {
  return Object.assign({
    textContent: '',
    hidden: true,
    disabled: false,
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() {},
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
  }, extra);
}

function stubElements() {
  return {
    dialog: stubElement(),
    title: stubElement(),
    counter: stubElement(),
    summary: stubElement(),
    facts: stubElement(),
    arguments: stubElement(),
    stateLine: stubElement(),
    approveBtn: stubElement({ hidden: false, disabled: false }),
    rejectBtn: stubElement({ hidden: false, disabled: false }),
    collapseBtn: stubElement({ hidden: false }),
  };
}

function approvalItem(overrides = {}) {
  return Object.assign({
    approvalId: 'apr-1',
    commandId: 'cmd-1',
    actionId: 'step-3-rm-cache',
    attemptId: 'att-1',
    deviceId: 'pc-main-01',
    tool: 'fs_delete',
    params: { path: 'D:/work/repo/.cache' },
    digest: 'a'.repeat(64),
    schemaVersion: 1,
    createdAt: 1000,
    expiresAt: 61000,
  }, overrides);
}

// Фейковый адаптер approvals: read/decide управляются тестом.
function fakeAdapter() {
  const calls = { read: [], decide: [] };
  let readImpl = () => ({ ok: false, error: 'нет данных' });
  let decideImpl = () => ({ ok: true });
  return {
    calls,
    setRead(fn) { readImpl = fn; },
    setDecide(fn) { decideImpl = fn; },
    async read(approvalId) {
      calls.read.push(approvalId);
      return readImpl(approvalId);
    },
    async decide(args) {
      calls.decide.push(args);
      return decideImpl(args);
    },
  };
}

/* --- Фабрика контроллера ------------------------------------------------------ */

function makeController({ adapter = fakeAdapter(), elements = stubElements(),
  timers = makeFakeTimers(), isVisible = () => true } = {}) {
  let now = 1000;
  const queueEvents = [];
  const ctrl = createApprovalController({
    elements,
    deps: {
      read: (id) => adapter.read(id),
      decide: (args) => adapter.decide(args),
      serverNow: () => now,
      timers: { setTimeout: timers.schedule, clearTimeout: timers.cancel },
      isVisible,
      onQueueChanged: (n) => queueEvents.push(n),
    },
  });
  return {
    ctrl, elements, timers, adapter, queueEvents,
    setNow(v) { now = v; },
  };
}

/* --- Помощник: прокрутить очередь микрозадач (read → decide → render) -------- */

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/* --- Очередь ---------------------------------------------------------------- */

test('очередь упорядочена по server createdAt, затем approvalId', () => {
  const h = makeController();
  h.ctrl.applySnapshot([
    approvalItem({ approvalId: 'apr-b', createdAt: 2000 }),
    approvalItem({ approvalId: 'apr-a', createdAt: 1000 }),
  ]);
  assert.equal(h.ctrl.currentId(), 'apr-a',
    'первым открывается ранний по createdAt');
  assert.equal(h.ctrl.queueSize(), 2);
});

test('новый запрос в очереди не подменяет открытый ID', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem({ approvalId: 'apr-1', createdAt: 1000 })]);
  assert.equal(h.elements.dialog.open, true, 'первый запрос открывается сам на видимом экране');
  h.ctrl.applySnapshot([
    approvalItem({ approvalId: 'apr-1', createdAt: 1000 }),
    approvalItem({ approvalId: 'apr-2', createdAt: 5000 }),
  ]);
  assert.equal(h.ctrl.currentId(), 'apr-1', 'открытый ID не сменился');
  assert.equal(h.ctrl.queueSize(), 2);
  assert.equal(h.elements.counter.textContent, 'Запрос 1 из 2 · осталось 1:00');
});

test('счётчик очереди уходит в плашку (onQueueChanged)', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.ctrl.applySnapshot([approvalItem(), approvalItem({ approvalId: 'apr-2', createdAt: 2000 })]);
  assert.deepEqual(h.queueEvents, [1, 2]);
});

test('один dialog на все запросы — стопки окон нет', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem(), approvalItem({ approvalId: 'apr-2', createdAt: 2000 })]);
  assert.equal(h.elements.dialog.open, true);
  // После решения показывается итог текущего запроса: диалог не закрывается
  // сам и не перескакивает на следующий без действия владельца.
  h.ctrl.showNextAfterOutcome();
  assert.equal(h.ctrl.currentId(), 'apr-2', 'переход к следующему — явным действием');
});

/* --- Двойной тап -------------------------------------------------------------- */

test('двойной тап: decide уходит один раз (синхронный флаг до await)', async () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  // Перед условной записью контроллер читает свежую версию записи.
  h.adapter.setRead(() => ({ ok: true, data: approvalItem(), etag: 'etag-v1' }));
  let release;
  const gate = new Promise((res) => { release = res; });
  h.adapter.setDecide(() => gate.then(() => ({ ok: true })));
  const first = h.ctrl.decide('approved');
  await flush();
  const second = h.ctrl.decide('approved');   // второй тап, пока первый в полёте
  assert.equal(h.adapter.calls.decide.length, 1,
    'второе нажатие не должно создавать вторую запись решения');
  release();
  await first;
  await second;
});

test('в submitting обе кнопки заблокированы и надпись «Сохраняем решение…»', async () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.adapter.setRead(() => ({ ok: true, data: approvalItem(), etag: 'etag-v1' }));
  let release;
  const gate = new Promise((res) => { release = res; });
  h.adapter.setDecide(() => gate.then(() => ({ ok: true })));
  const pending = h.ctrl.decide('rejected');
  assert.equal(h.ctrl.viewState(), 'submitting');
  assert.equal(h.elements.approveBtn.disabled, true);
  assert.equal(h.elements.rejectBtn.disabled, true);
  assert.equal(h.elements.stateLine.textContent, 'Сохраняем решение…');
  release();
  await pending;
});

test('условная запись решения несёт etag последнего чтения', async () => {
  const h = makeController();
  h.adapter.setRead(() => ({ ok: true, data: approvalItem(), etag: 'etag-v1' }));
  h.ctrl.applySnapshot([approvalItem()]);
  await h.ctrl.decide('approved');
  assert.equal(h.adapter.calls.decide[0].etag, 'etag-v1',
    'decision обязан быть условной записью с версией записи');
  assert.equal(h.adapter.calls.decide[0].approvalId, 'apr-1');
  assert.equal(h.adapter.calls.decide[0].decision, 'approved');
});

/* --- 412: конфликт двух вкладок ------------------------------------------------ */

test('412: перечитывается тот же ID и показывается победившее решение', async () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.adapter.setDecide(() => {
    const err = new Error('Precondition Failed');
    err.code = 'conflict';
    err.status = 412;
    throw err;
  });
  // Чтений два: (1) свежая версия перед условной записью, (2) перечитка
  // после 412 — ОБА того же approvalId. Другая вкладка успела одобрить:
  // сервер отвечает записью с decision. Второе чтение под гейтом, чтобы
  // поймать промежуточное состояние сверки.
  let readCount = 0;
  let releaseRead;
  const readGate = new Promise((res) => { releaseRead = res; });
  h.adapter.setRead(() => {
    readCount += 1;
    if (readCount === 1) {
      return Promise.resolve({ ok: true, etag: 'etag-v1', data: approvalItem() });
    }
    return readGate.then(() => ({
      ok: true,
      etag: 'etag-v2',
      data: approvalItem({ decision: 'approved', decidedAt: 5000 }),
    }));
  });
  const pending = h.ctrl.decide('approved');
  await Promise.resolve();
  assert.equal(h.elements.approveBtn.disabled, true,
    'после 412 кнопки заблокированы, пока не сверимся с сервером');
  releaseRead();
  await pending;
  assert.ok(h.adapter.calls.read.length >= 2 &&
      h.adapter.calls.read.every((id) => id === 'apr-1'),
    'и версионное чтение, и перечитка после 412 бьют в ТОТ ЖЕ approvalId');
  assert.equal(h.adapter.calls.decide.length, 1,
    'конфликтующая запись была отправлена и отклонена сервером');
  assert.equal(h.ctrl.viewState(), 'approved');
  assert.equal(h.elements.stateLine.textContent, 'Разрешено · ожидает выполнения');
  assert.equal(h.elements.approveBtn.hidden, true, 'кнопки решения у непending скрыты');
  assert.equal(h.elements.rejectBtn.hidden, true);
});

test('412 при rejected: показывается «Отклонено», не локальный approve', async () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.adapter.setDecide(() => {
    const err = new Error('Precondition Failed');
    err.code = 'conflict';
    throw err;
  });
  let readCount = 0;
  h.adapter.setRead(() => {
    readCount += 1;
    if (readCount === 1) {
      return Promise.resolve({ ok: true, etag: 'etag-v1', data: approvalItem() });
    }
    return Promise.resolve({
      ok: true,
      etag: 'etag-v2',
      data: approvalItem({ decision: 'rejected', decidedAt: 5000 }),
    });
  });
  await h.ctrl.decide('approved');
  assert.equal(h.ctrl.viewState(), 'rejected',
    'локальный approve не выдаётся за состоявшееся разрешение');
  assert.equal(h.elements.stateLine.textContent, 'Отклонено');
});

/* --- Потерянный ответ ------------------------------------------------------------ */

test('timeout: исход неизвестен, кнопки заблокированы до сверки чтением', async () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.adapter.setDecide(() => {
    const err = new Error('ответ не получен');
    err.code = 'timeout';
    throw err;
  });
  // Чтений два: (1) свежая версия перед записью, (2) сверка после таймаута.
  // Второе под гейтом: между сбоем записи и сверкой решение недоступно.
  let readCount = 0;
  let releaseRead;
  const readGate = new Promise((res) => { releaseRead = res; });
  h.adapter.setRead(() => {
    readCount += 1;
    if (readCount === 1) {
      return Promise.resolve({ ok: true, etag: 'etag-v1', data: approvalItem() });
    }
    return readGate.then(() => ({
      ok: true, etag: 'etag-v3', data: approvalItem(),
    }));
  });
  const pending = h.ctrl.decide('approved');
  await flush();
  assert.equal(h.ctrl.viewState(), 'reconciling');
  assert.equal(h.elements.approveBtn.disabled, true);
  assert.equal(h.elements.rejectBtn.disabled, true);
  assert.ok(h.adapter.calls.read.length >= 2 &&
      h.adapter.calls.read.every((id) => id === 'apr-1'),
    'сверка читает ТОТ ЖЕ approvalId, новый ID не создаётся');
  releaseRead();
  await pending;
  assert.equal(h.ctrl.viewState(), 'pending',
    'запись всё ещё без решения — владелец может решить заново');
  assert.equal(h.elements.approveBtn.disabled, false);
});

test('timeout: если сверка не удалась — решение остаётся заблокированным', async () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.adapter.setDecide(() => {
    const err = new Error('нет связи');
    err.code = 'timeout';
    throw err;
  });
  h.adapter.setRead(() => ({ ok: false, error: 'нет связи' }));
  await h.ctrl.decide('approved');
  assert.equal(h.ctrl.viewState(), 'error');
  assert.equal(h.elements.approveBtn.disabled, true,
    'отсутствие ответа не считается отказом записи — и не разрешает повтор вслепую');
});

/* --- Таймер ----------------------------------------------------------------- */

test('таймер считается от серверного времени, а не декрементом', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem({ createdAt: 1000, expiresAt: 61000 })]);
  // Локальные тики прошли, но серверное время улетело на 2 минуты вперёд:
  // настоящий декремент показал бы «осталось», контроллер обязан показать истёкший срок
  h.setNow(1000 + 120000);
  h.timers.advance(1000);
  assert.equal(h.ctrl.viewState(), 'expired');
  assert.equal(h.elements.stateLine.textContent, 'Срок подтверждения истёк');
  assert.equal(h.elements.approveBtn.disabled, true);
  assert.equal(h.elements.rejectBtn.disabled, true);
});

test('на нуле решения отключаются и сервер перечитывается', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.adapter.setRead(() => ({ ok: true, etag: 'etag-x', data: approvalItem() }));
  h.setNow(61000);
  h.timers.advance(1000);
  assert.deepEqual(h.adapter.calls.read, ['apr-1'],
    'истечение срока должно перепроверяться свежим чтением');
  assert.equal(h.elements.approveBtn.disabled, true);
});

test('осталось показывает M:SS из expiresAt − serverNow', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem({ expiresAt: 61000 })]);
  assert.match(h.elements.counter.textContent, /осталось 1:00$/);
  h.setNow(61000 - 42000);
  h.timers.advance(1000);
  assert.match(h.elements.counter.textContent, /осталось 0:42$/);
});

test('destroy чистит таймеры без хвостов', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  assert.ok(h.timers.pendingCount() > 0, 'countdown активен до destroy');
  h.ctrl.destroy();
  assert.equal(h.timers.pendingCount(), 0, 'после destroy таймеров быть не должно');
  assert.equal(h.elements.dialog.open, false, 'dialog закрыт');
});

test('destroy: applySnapshot больше не открывает dialog', () => {
  const h = makeController();
  h.ctrl.destroy();
  h.ctrl.applySnapshot([approvalItem()]);
  assert.equal(h.elements.dialog.open, false);
  assert.equal(h.ctrl.queueSize(), 0);
});

/* --- Сворачивание без записи ---------------------------------------------------- */

test('свернуть без решения: записи нет, плашка остаётся', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.ctrl.collapse();
  assert.equal(h.adapter.calls.decide.length, 0, 'сворачивание не пишет rejected/approved');
  assert.equal(h.elements.dialog.open, false);
  assert.deepEqual(h.queueEvents[h.queueEvents.length - 1], 1,
    'запрос всё ещё ждёт решения — плашка не гаснет');
});

test('после ручного сворачивания тот же ID не открывается на каждом snapshot', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.ctrl.collapse();
  h.ctrl.applySnapshot([approvalItem()]);
  assert.equal(h.elements.dialog.open, false,
    'повторный snapshot не должен перехватывать экран');
  // Новый ДРУГОЙ запрос открывается: это не тот же ID
  h.ctrl.applySnapshot([approvalItem(), approvalItem({ approvalId: 'apr-9', createdAt: 9000 })]);
  assert.equal(h.elements.dialog.open, true, 'новый запрос открывается автоматически');
  assert.equal(h.ctrl.currentId(), 'apr-9');
});

/* --- Offline / auth-expired ------------------------------------------------------- */

test('offline: обе кнопки недоступны, текст «Нет связи — подтвердить нельзя»', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.ctrl.setConnection('offline');
  assert.equal(h.ctrl.viewState(), 'offline');
  assert.equal(h.elements.stateLine.textContent, 'Нет связи — подтвердить нельзя');
  assert.equal(h.elements.approveBtn.disabled, true);
  assert.equal(h.elements.rejectBtn.disabled, true);
});

test('offline: decide() не уходит в сеть (нет фоновой очереди решений)', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.ctrl.setConnection('offline');
  h.ctrl.decide('approved');
  assert.equal(h.adapter.calls.decide.length, 0);
});

test('auth-expired: текст «Войдите снова», решения недоступны', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.ctrl.setConnection('auth-expired');
  assert.equal(h.ctrl.viewState(), 'auth-expired');
  assert.equal(h.elements.stateLine.textContent, 'Войдите снова');
  assert.equal(h.elements.approveBtn.disabled, true);
});

test('возврат связи требует свежего чтения до разблокировки', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  h.ctrl.setConnection('offline');
  h.ctrl.setConnection('online');
  assert.notEqual(h.ctrl.viewState(), 'pending',
    'после reconnect решение не разблокируется без свежих данных');
  h.ctrl.applySnapshot([approvalItem()]);
  assert.equal(h.ctrl.viewState(), 'pending');
  assert.equal(h.elements.approveBtn.disabled, false);
});

/* --- Итоги решений -------------------------------------------------------------- */

test('consumed: «Разрешение использовано · ожидаем результат»', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem({
    decision: 'approved', decidedAt: 5000, consumedAt: 6000, consumedBy: 'pc-main-01',
  })]);
  assert.equal(h.ctrl.viewState(), 'consumed');
  assert.equal(h.elements.stateLine.textContent,
    'Разрешение использовано · ожидаем результат');
});

test('ни одно состояние не называется «Выполнено»', () => {
  const h = makeController();
  for (const overrides of [
    { decision: 'approved', decidedAt: 5000 },
    { decision: 'approved', decidedAt: 5000, consumedAt: 6000 },
    { decision: 'rejected', decidedAt: 5000 },
    {},
  ]) {
    h.ctrl.applySnapshot([approvalItem(overrides)]);
    assert.doesNotMatch(h.elements.stateLine.textContent, /Выполнено/i);
  }
});

test('отменённый запрос: «Запрос отменён»', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem({ cancelledAt: 5000 })]);
  assert.equal(h.ctrl.viewState(), 'cancelled');
  assert.equal(h.elements.stateLine.textContent, 'Запрос отменён');
});

/* --- Точные параметры и защита ------------------------------------------------------ */

test('карточка показывает точные tool/параметры/привязки, не пересказ', () => {
  const h = makeController();
  h.ctrl.applySnapshot([approvalItem()]);
  const facts = h.elements.facts.textContent;
  for (const needle of ['fs_delete', 'pc-main-01', 'cmd-1', 'step-3-rm-cache', 'att-1']) {
    assert.ok(facts.includes(needle), 'в фактах нет ' + needle);
  }
  assert.match(h.elements.arguments.textContent, /D:\/work\/repo\/\.cache/,
    'канонические параметры выводятся целиком');
});

test('неполные существенные поля блокируют approve и показывают ошибку', () => {
  const h = makeController();
  const bad = approvalItem();
  delete bad.digest;
  h.ctrl.applySnapshot([bad]);
  assert.equal(h.ctrl.viewState(), 'error');
  assert.equal(h.elements.approveBtn.disabled, true);
  assert.ok(h.elements.stateLine.textContent.length > 10,
    'ошибка объяснена словами, не только цветом');
});

test('без showModal подтверждения недоступны (безопасное сообщение)', () => {
  const elements = stubElements();
  delete elements.dialog.showModal;
  const h = makeController({ elements });
  h.ctrl.applySnapshot([approvalItem()]);
  assert.equal(elements.dialog.open, false,
    'немодальный fallback запрещён — открывания быть не должно');
  assert.ok(h.elements.stateLine.textContent.includes('Подтверждения недоступны'),
    'владельцу объясняют, почему кнопок нет');
});
