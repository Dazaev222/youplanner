// Регрессия отмены последнего выполнения каза (§6.4).
//
// Аудит 2026-11-04 требует проверить три вещи на одном экране:
//  1. откат возвращает ПРЕЖНЕЕ значение очереди (остаток, курсор, история)
//     и счётчика дня h6;
//  2. экран ПЕРЕРИСОВЫВАЕТСЯ: сводка и кнопка «Отменить» отражают откат;
//  3. при отказе записи в хранилище состояние НЕ ТЕРЯЕТСЯ: очередь в памяти
//     остаётся прежней, функция возвращает false, экран не перерисовывается
//     (иначе показали бы отменённое, которого в хранилище нет).
//
// Песочница node:vm: лексические let (qazaState) читаются через run('...'),
// DOM подменяется заглушкой getElementById, как в tests/schedule.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const QAZA_KEY = 'youplanner.qaza';

// Узел-заглушка: нужные рендеру свойства — textContent, innerHTML, hidden,
// disabled; querySelector* пустые, чтобы точечные пути их просто пропускали.
function fakeNode(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    addEventListener() {},
  };
}

// Ставим минимальный DOM: каждый id получает узел по требованию.
function mountDom(app) {
  const nodes = Object.create(null);
  app.sandbox.document.getElementById = (id) =>
    nodes[id] || (nodes[id] = fakeNode(id));
  return nodes;
}

// Один клик «Выполнено» через делегат: обработчику нужен только closest.
function clickDone(app) {
  app.context.onQazaDone({ target: { closest: (s) => (s === '#qaza-done' ? {} : null) } });
}

test('отмена возвращает прежнее значение очереди и счётчика дня', () => {
  const app = loadApp();
  mountDom(app);
  const qaza = app.context.loadQaza(true);
  app.context.setQazaState(qaza);
  const day = app.context.kazaDayFor(new Date());

  // одно выполнение — промежуточное состояние; сравниваем откат именно с ним,
  // чтобы проверка «возвращает прежнее значение» не упиралась в семантику
  // «нет записи» до первого выполнения (§7: ноль — значимое значение)
  assert.equal(app.context.markQazaDone(qaza, day), true, 'первое выполнение не зачлось');
  const before = {
    remaining: JSON.parse(JSON.stringify(qaza.remaining)),
    cursor: qaza.cursor,
    history: qaza.history.slice(),
    record: app.context.getRecord(day, 'h6'),
  };

  // второе выполнение сдвигает очередь и счётчик дня — есть что откатывать
  assert.equal(app.context.markQazaDone(qaza, day), true, 'второе выполнение не зачлось');
  assert.notEqual(app.context.qazaTotalRemaining(qaza),
    Object.values(before.remaining).reduce((a, b) => a + b, 0),
    'второе выполнение не изменило очередь — тест был бы тавтологией');

  assert.equal(app.context.undoQazaDone(qaza, day), true, 'отмена не сработала');
  // сравнение через JSON.stringify: объекты очереди живут в realm песочницы
  // (node:vm) и deepStrictEqual с хостовым снимком отбраковывает их по прототипу
  assert.equal(JSON.stringify(qaza.remaining), JSON.stringify(before.remaining),
    'откат не вернул прежние остатки');
  assert.equal(qaza.cursor, before.cursor, 'откат не вернул прежний курсор');
  assert.equal(JSON.stringify(qaza.history), JSON.stringify(before.history),
    'откат не вернул прежнюю историю');
  assert.equal(app.context.getRecord(day, 'h6'), before.record,
    'откат не вернул прежний счётчик дня h6');
});

test('отмена перерисовывает сводку и гасит кнопку «Отменить» на пустой истории', () => {
  const app = loadApp();
  const nodes = mountDom(app);
  const qaza = app.context.loadQaza(true);
  app.context.setQazaState(qaza);
  const day = app.context.kazaDayFor(new Date());

  clickDone(app);
  app.context.renderQazaView();
  const afterDone = app.context.qazaTotalRemaining(qaza);
  assert.match(nodes['qaza-summary'].textContent, new RegExp(afterDone),
    'сводка не показала остаток после выполнения');
  assert.equal(nodes['qaza-undo'].disabled, false,
    'кнопка «Отменить» должна быть активна, когда есть что отменить');

  app.context.onQazaUndo();
  assert.notEqual(app.context.qazaTotalRemaining(qaza), afterDone,
    'отмена не изменила очередь');
  assert.match(nodes['qaza-summary'].textContent,
    new RegExp(app.context.qazaTotalRemaining(qaza)),
    'экран не перерисовался после отмены — сводка устарела');
  assert.equal(nodes['qaza-undo'].disabled, true,
    'после отмены последней записи кнопка «Отменить» должна погаснуть');
});

test('отказ записи в хранилище: отмена возвращает false, состояние не теряется, экран цел', () => {
  const app = loadApp();
  const nodes = mountDom(app);
  const qaza = app.context.loadQaza(true);
  app.context.setQazaState(qaza);
  const day = app.context.kazaDayFor(new Date());

  // выполняем и рисуем, фиксируем снимок состояния и экрана
  assert.equal(app.context.markQazaDone(qaza, day), true);
  app.context.renderQazaView();
  const snapRemaining = JSON.parse(JSON.stringify(qaza.remaining));
  const snapCursor = qaza.cursor;
  const snapHistory = qaza.history.slice();
  const snapTotal = app.context.qazaTotalRemaining(qaza);
  const snapSummary = nodes['qaza-summary'].textContent;

  // storage падает только на ключе очереди — остальное пишется
  const realSet = app.sandbox.localStorage.setItem.bind(app.sandbox.localStorage);
  app.sandbox.localStorage.setItem = (k, v) => {
    if (k === QAZA_KEY) throw new Error('quota exceeded');
    realSet(k, v);
  };

  const ok = app.context.undoQazaDone(qaza, day);
  assert.equal(ok, false, 'отмена при отказе хранилища не должна притворяться удачной');
  assert.equal(JSON.stringify(qaza.remaining), JSON.stringify(snapRemaining),
    'отказ записи потерял остатки очереди в памяти');
  assert.equal(qaza.cursor, snapCursor, 'отказ записи сдвинул курсор');
  assert.equal(JSON.stringify(qaza.history), JSON.stringify(snapHistory),
    'отказ записи потерял историю');

  // экран не перерисовывается после неудачи: onQazaUndo выходит раньше renderQazaView.
  // Хранилище всё ещё падает, поэтому повторная попытка тоже неудачна и сводка цела.
  app.context.onQazaUndo();
  app.sandbox.localStorage.setItem = realSet;
  assert.equal(nodes['qaza-summary'].textContent, snapSummary,
    'неудачная отмена не должна менять сводку');
  assert.equal(app.context.qazaTotalRemaining(qaza), snapTotal,
    'неудачная отмена изменила очередь в памяти');
});
