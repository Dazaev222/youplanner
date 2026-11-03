// Матрица Эйзенхауэра: квадрант — функция от данных, а не хранимое поле.
//
// Контракт (план `_orchestra_tasks/ARCH_PLANS.md` §1):
//   * срочность даёт срок, важность — приоритет; «квадрант» в данных нет,
//     поэтому завтрашняя задача сегодня становится срочной САМА, без правки
//     человеком, и через неделю не врёт;
//   * перенос карточки меняет ПРИЧИНУ (срок/приоритет), а не метку;
//   * санитайзер не пропускает ни мусор полей, ни переносы в заголовке;
//   * раздел живёт на устройстве, ключ один, битый JSON не роняет экран.
//
// `today` везде передаётся аргументом: тест не зависит от часов машины.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const KEY = 'youplanner.matrix.tasks';
const TODAY = new Date(2026, 10, 3);   // 3 ноября 2026, вторник

function iso(daysFromToday) {
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + daysFromToday);
  // Только по ЛОКАЛЬНЫМ компонентам: toISOString() в зоне +0300 уводит
  // полуночь в предыдущий день, и вся матрица проверялась бы на сутки раньше.
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + month + '-' + day;
}

function task(ctx, over) {
  return Object.assign({
    id: 't1', title: 'Задача', notes: '', due: null, doDate: null,
    priority: 0, done: false, doneAt: null,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    order: 1, archived: false,
  }, over || {});
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('квадрант считается из срока и приоритета', (t) => {
  const { context: ctx } = loadApp();
  assert.equal(ctx.quadrantOf(task(ctx, { priority: 3, due: iso(0) }), TODAY), 'q1');
  assert.equal(ctx.quadrantOf(task(ctx, { priority: 3, due: null }), TODAY), 'q2');
  assert.equal(ctx.quadrantOf(task(ctx, { priority: 1, due: iso(1) }), TODAY), 'q3');
  assert.equal(ctx.quadrantOf(task(ctx, { priority: 0, due: null }), TODAY), 'q4');
  assert.equal(ctx.quadrantOf(task(ctx, { priority: 0, due: iso(30) }), TODAY), 'q4');
});

test('срочность — окно в 48 часов, граница включительно', (t) => {
  const { context: ctx } = loadApp();
  assert.equal(ctx.isUrgent(task(ctx, { due: iso(2) }), TODAY), true, 'через 2 дня ещё срочно');
  assert.equal(ctx.isUrgent(task(ctx, { due: iso(3) }), TODAY), false, 'через 3 дня — нет');
  assert.equal(ctx.isUrgent(task(ctx, { due: iso(-1) }), TODAY), true, 'просрочено — срочно');
  assert.equal(ctx.isUrgent(task(ctx, { due: null }), TODAY), false);
});

test('просроченное считается только у незавершённой задачи', (t) => {
  const { context: ctx } = loadApp();
  assert.equal(ctx.isOverdue(task(ctx, { due: iso(-5) }), TODAY), true);
  assert.equal(ctx.isOverdue(task(ctx, { due: iso(-5), done: true }), TODAY), false);
  assert.equal(ctx.isOverdue(task(ctx, { due: iso(0) }), TODAY), false, 'сегодня — не просрочено');
});

test('перенос в квадрант меняет причину, а не метку', (t) => {
  const { context: ctx } = loadApp();
  const plainTask = task(ctx, { priority: 0, due: null });

  const toQ1 = ctx.applyQuadrantMove(plainTask, 'q1', TODAY);
  assert.equal(toQ1.priority, 2, 'в «сделать сразу» важность не ниже средней');
  assert.equal(toQ1.due, iso(0), 'срок ставится на сегодня');
  assert.equal(ctx.quadrantOf(toQ1, TODAY), 'q1');

  const toQ2 = ctx.applyQuadrantMove(task(ctx, { priority: 3, due: iso(0) }), 'q2', TODAY);
  assert.equal(toQ2.due, null, 'в «запланировать» срок снимается');
  assert.equal(ctx.quadrantOf(toQ2, TODAY), 'q2');

  const toQ3 = ctx.applyQuadrantMove(plainTask, 'q3', TODAY);
  assert.equal(toQ3.priority, 0, 'важность не выдумывается: «нет» остаётся «нет»');
  assert.equal(toQ3.due, iso(1), 'горящий срок берется завтрашним');
  assert.equal(ctx.quadrantOf(toQ3, TODAY), 'q3');

  const toQ4 = ctx.applyQuadrantMove(task(ctx, { priority: 3, due: iso(0) }), 'q4', TODAY);
  assert.equal(toQ4.archived, false,
    'перенос в «не срочно и не важно» не прячет задачу: архив — отдельное действие');
  assert.equal(ctx.quadrantOf(toQ4, TODAY), 'q4');

  assert.equal(ctx.applyQuadrantMove(plainTask, 'q99', TODAY), null,
    'несуществующий квадрант не должен молча портить задачу');
});

// Класс дефекта, из-за которого drag выглядит поломанным: карточка уехала в
// квадрант по анимации, а на первой перерисовке вернулась — потому что
// перенос поменял приоритет, но не тронул срок, который сам по себе рисовал
// другой квадрант.
test('перенос всегда долетает до целевого квадранта', (t) => {
  const { context: ctx } = loadApp();
  const moves = [
    ['q1', task(ctx, { priority: 3, due: iso(30) })],
    ['q1', task(ctx, { priority: 3, due: null })],
    ['q2', task(ctx, { priority: 3, due: iso(-4) })],
    ['q3', task(ctx, { priority: 1, due: iso(90) })],
    ['q3', task(ctx, { priority: 3, due: null })],
    ['q4', task(ctx, { priority: 2, due: iso(2) })],
  ];
  for (const [quadrant, source] of moves) {
    const moved = ctx.applyQuadrantMove(source, quadrant, TODAY);
    assert.notEqual(moved, null);
    assert.equal(moved.archived, false, 'перенос не прячет задачу в архив');
    assert.equal(ctx.quadrantOf(moved, TODAY), quadrant,
      `перенос ${quadrant} из ${JSON.stringify({ p: source.priority, d: source.due })} не долетел`);
  }
});

test('санитайзер: мусор полей, переносы и запятые в заголовке', (t) => {
  const { context: ctx } = loadApp();
  assert.equal(ctx.sanitizeTask(null), null);
  assert.equal(ctx.sanitizeTask([]), null);
  assert.equal(ctx.sanitizeTask({ title: 'без id' }), null);
  assert.equal(ctx.sanitizeTask({ id: 't', title: '   ' }), null, 'пустой заголовок — не задача');

  const cleaned = ctx.sanitizeTask({
    id: 't9', title: '  первая строка\nвторая\tтабуляция  ', notes: 'a'.repeat(5000),
    priority: 99, due: 'не-дата', doDate: '2026-11-05', createdAt: 42, хвост: 'мусор',
  });
  assert.equal(cleaned.title, 'первая строка вторая табуляция');
  assert.equal(cleaned.notes.length, 2000, 'заметка обрезается по потолку');
  assert.equal(cleaned.priority, 0, 'неизвестный приоритет — «нет»');
  assert.equal(cleaned.due, null, 'битая дата не уезжает в модель');
  assert.equal(ctx.sanitizeTask({ id: 't9', title: 'x', due: '2026-13-45' }).due, null,
    'несуществующий день не должен молча превратиться в февраль');
  assert.equal(cleaned.doDate, '2026-11-05');
  assert.equal(cleaned.хвост, undefined, 'неизвестное поле не проходит');
  assert.equal(typeof cleaned.createdAt, 'string');
});

test('заголовок длиннее потолка обрезается, а не отбрасывается', (t) => {
  const { context: ctx } = loadApp();
  const long = ctx.sanitizeTask({ id: 't', title: 'д'.repeat(400) });
  assert.equal(long.title.length, 200);
});

test('хранение: roundtrip, дубликаты id и битый JSON', (t) => {
  const app = loadApp();
  const ctx = app.context;
  assert.deepEqual(plain(ctx.loadTasks()), [], 'без ключа — пустой список');

  app.sandbox.localStorage.setItem(KEY, '{это не json');
  assert.deepEqual(plain(ctx.loadTasks()), [], 'битая строка не должна ронять раздел');

  app.sandbox.localStorage.setItem(KEY, JSON.stringify([
    task(ctx, { id: 'a' }), task(ctx, { id: 'a' }), task(ctx, { id: 'b' }), null, 7,
  ]));
  const loaded = ctx.loadTasks();
  assert.deepEqual(plain(loaded.map(x => x.id)), ['a', 'b'], 'дубликат и мусор отсеяны');

  assert.equal(ctx.saveTasks([task(ctx, { id: 'c' })]), true);
  const stored = JSON.parse(app.sandbox.localStorage.getItem(KEY));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, 'c');
});

test('группировка: пустые квадранты есть, сделанные и архивные — нет', (t) => {
  const { context: ctx } = loadApp();
  const groups = ctx.groupByQuadrant([
    task(ctx, { id: 'a', priority: 3, due: iso(0) }),
    task(ctx, { id: 'b', priority: 3, due: iso(0), done: true }),
    task(ctx, { id: 'c', priority: 3, due: iso(0), archived: true }),
  ], TODAY);
  assert.deepEqual(Object.keys(groups).sort(), ['q1', 'q2', 'q3', 'q4']);
  assert.deepEqual(plain(groups.q1.map(x => x.id)), ['a']);
  assert.equal(groups.q2.length, 0);
});

test('порядок внутри квадранта: просроченное, затем приоритет, затем срок', (t) => {
  const { context: ctx } = loadApp();
  const groups = ctx.groupByQuadrant([
    task(ctx, { id: 'спокойная', priority: 3, due: iso(1) }),
    task(ctx, { id: 'просроченная', priority: 2, due: iso(-2) }),
    task(ctx, { id: 'ранняя', priority: 3, due: iso(-1) }),
  ], TODAY);
  assert.deepEqual(plain(groups.q1.map(x => x.id)), ['ранняя', 'просроченная', 'спокойная'],
    'сначала то, что уже горит, внутри — по важности, затем по сроку');
});

test('markDone ставит и снимает отметку вместе с updatedAt', (t) => {
  const { context: ctx } = loadApp();
  const done = ctx.markDone(task(ctx), true);
  assert.equal(done.done, true);
  assert.equal(typeof done.doneAt, 'string');
  const undone = ctx.markDone(done, false);
  assert.equal(undone.done, false);
  assert.equal(undone.doneAt, null, 'у снятой отметки времени быть не должно');
});

test('createTask даёт годную задачу с id в стиле привычек', (t) => {
  const { context: ctx } = loadApp();
  const created = ctx.createTask({ title: 'Новая', priority: 2, due: iso(4) });
  assert.match(created.id, /^t[0-9a-z]+$/, 'префикс + основание в base36');
  assert.equal(created.done, false);
  assert.equal(created.priority, 2);
  assert.equal(created.due, iso(4), 'срок доживает до модели');
  assert.ok(!created.archived);
  assert.equal(ctx.createTask({ title: '' }), null);
});

test('статистика квадранта считает и просрочки', (t) => {
  const { context: ctx } = loadApp();
  const stats = ctx.quadrantStats([
    task(ctx, { id: 'a', priority: 3, due: iso(-1) }),
    task(ctx, { id: 'b', priority: 3, due: iso(0) }),
  ], TODAY);
  assert.equal(stats.q1.total, 2);
  assert.equal(stats.q1.overdue, 1);
  assert.equal(stats.q4.total, 0);
});

// Лист переноса — единственное место экрана, где решение о смысле, а не про
// то, оно вынесено в чистую функцию и проверяется здесь (остальной matrix-view
// это DOM, недоступный песочнице).
test('лист переноса не предлагает текущий квадрант', (t) => {
  const { context: ctx } = loadApp();
  const ids = (over) => plain(ctx.moveOptions(task(ctx, over), TODAY).map(q => q.id));
  assert.deepEqual(ids({ priority: 3, due: iso(0) }), ['q2', 'q3', 'q4'], 'из «срочно и важно»');
  assert.deepEqual(ids({ priority: 3, due: null }), ['q1', 'q3', 'q4'], 'из «не срочно, но важно»');
  assert.deepEqual(ids({ priority: 1, due: iso(1) }), ['q1', 'q2', 'q4'], 'из «срочно, но не важно»');
  assert.deepEqual(ids({ priority: 0, due: null }), ['q1', 'q2', 'q3'], 'из «не срочно и не важно»');
  for (const over of [{ priority: 3, due: iso(0) }, { priority: 0, due: iso(40) }]) {
    const current = ctx.quadrantOf(task(ctx, over), TODAY);
    const others = ['q1', 'q2', 'q3', 'q4'].filter(id => id !== current);
    assert.deepEqual(ids(over), others,
      'остальные три квадранта, включая q4: архив — отдельная кнопка, а не четвёртый квадрант');
  }
});

// Выбор квадранта в форме добавления и перенос карточки обязаны означать
// одно и то же: для этого у правила есть одна функция (quadrantShape), и
// тест проверяет её напрямую, а не через DOM.
test('quadrantShape — одна причина для переноса и для формы', (t) => {
  const { context: ctx } = loadApp();
  assert.deepEqual(plain(ctx.quadrantShape('q1', { due: null, priority: 0 }, TODAY)),
    { priority: 2, due: iso(0) }, 'срок сегодня, важность не ниже средней');
  assert.deepEqual(plain(ctx.quadrantShape('q2', { due: iso(-3), priority: 3 }, TODAY)),
    { priority: 3, due: null }, 'срок снимается, важность остаётся');
  assert.deepEqual(plain(ctx.quadrantShape('q3', { due: iso(30), priority: 3 }, TODAY)),
    { priority: 1, due: iso(1) }, 'далёкий срок заменяется завтрашним');
  assert.deepEqual(plain(ctx.quadrantShape('q4', { due: iso(0), priority: 1 }, TODAY)),
    { priority: 1, due: null });
  assert.equal(ctx.quadrantShape('q7', {}, TODAY), null, 'несуществующий квадрант');
  assert.equal(ctx.quadrantShape('q1', null, TODAY).due, iso(0), 'пустой источник — не падение');
  assert.equal(ctx.quadrantShape('q1', { priority: '3' }, TODAY).priority, 2,
    'приоритет строкой не проходит проверку набора и становится «нет»');
});

test('срок, который уже делает квадрант срочным, сохраняется', (t) => {
  const { context: ctx } = loadApp();
  assert.equal(ctx.quadrantShape('q1', { due: iso(1), priority: 3 }, TODAY).due, iso(1),
    'завтрашний срок в «срочно и важно» двигать не нужно');
  assert.equal(ctx.quadrantShape('q3', { due: iso(-2), priority: 0 }, TODAY).due, iso(-2),
    'просроченный срок остаётся просроченным, а не становится завтрашним');
});

test('выполненные и архивные выборки не смешиваются', (t) => {
  const { context: ctx } = loadApp();
  const list = [
    task(ctx, { id: 'живая', priority: 3, due: iso(0) }),
    task(ctx, { id: 'сделанная', priority: 3, due: iso(0), done: true }),
    task(ctx, { id: 'архивная', priority: 3, due: iso(0), archived: true }),
  ];
  assert.deepEqual(plain(ctx.activeTasks(list).map(x => x.id)), ['живая']);
  assert.deepEqual(plain(ctx.doneTasks(list).map(x => x.id)), ['сделанная']);
  assert.deepEqual(plain(ctx.archiveTasks(list).map(x => x.id)), ['архивная']);

  assert.deepEqual(plain(ctx.listForQuadrant(list, 'q1', TODAY, false).map(x => x.id)),
    ['живая'], 'по умолчанию выполненных не видно');
  assert.deepEqual(plain(ctx.listForQuadrant(list, 'q1', TODAY, true).map(x => x.id)),
    ['живая', 'сделанная'], 'по просьбе — видно, и просроченная первая');
  assert.deepEqual(plain(ctx.groupByQuadrant(list, TODAY, true).q1.map(x => x.id)),
    ['живая', 'сделанная'], 'сетка и список квадранта должны сходиться');
  assert.equal(ctx.groupByQuadrant(list, TODAY, true).q4.length, 0,
    'архив не попадает ни в один квадрант');
});

test('из архива возвращаются и удаляют его осознанно', (t) => {
  const { context: ctx } = loadApp();
  const archived = task(ctx, { id: 'a', archived: true, done: true, priority: 2, due: iso(-1) });

  const back = ctx.restoreTask(archived);
  assert.equal(back.archived, false);
  assert.equal(back.done, false, 'возврат — это возвращение в работу, а не в «выполнено»');
  assert.equal(back.due, iso(-1), 'возврат не переписывает срок и приоритет');

  const list = [task(ctx, { id: 'keep' }), archived];
  assert.deepEqual(plain(ctx.purgeTask(list, 'a').map(x => x.id)), ['keep']);
  assert.equal(ctx.purgeTask(list, 'нет-такого').length, 2, 'чужой id не меняет список');
});

/* --- Строка ввода: выбор квадранта как причина --------------------------- */

// Здесь today() модуля — реальные часы машины, поэтому даты считаются тем же
// локальным способом, а не берутся из TODAY.
function realIso(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}

test('выбор квадранта в строке ввода переставляет причину и ведёт за собой экран', (t) => {
  const { context: ctx } = loadApp();

  ctx.openQuadrantView('q1', true);
  let st = ctx.matrixDebugState();
  assert.equal(st.openQuadrant, 'q1');
  assert.ok(st.draft.due, 'в срочный квадрант срок вписывается сразу');

  assert.equal(ctx.pickDraftQuadrant('q2'), true);
  st = ctx.matrixDebugState();
  assert.equal(st.openQuadrant, 'q2',
    'экран переезжает вместе с выбором: иначе добавленная карточка уходит из вида');
  assert.equal(st.draft.quadrant, 'q2');
  assert.equal(st.draft.due, null, 'q2 — без срока');
  assert.ok(st.draft.priority >= 2, 'q2 — важно');

  // Из «без срока» в «горит» срок обязан появиться сам: с пустой датой
  // карточка осталась бы в q2 при первой же перерисовке.
  assert.equal(ctx.pickDraftQuadrant('q1'), true);
  assert.equal(ctx.matrixDebugState().draft.due, realIso(0), 'q1 из q2 берёт сегодня');

  // Правило то же, что у переноса карточки: дата меняется только тогда, когда
  // она сама не делает квадрант, поэтому проверяем не конкретную дату, а прилёт.
  for (const id of ['q3', 'q4', 'q2', 'q1']) {
    assert.equal(ctx.pickDraftQuadrant(id), true);
    const d = ctx.matrixDebugState().draft;
    assert.equal(d.quadrant, id);
    assert.equal(ctx.matrixDebugState().openQuadrant, id, id + ': экран идёт за выбором');
    assert.equal(ctx.quadrantOf({ due: d.due, priority: d.priority }, new Date()), id,
      id + ': черновик долетает до обещанного квадранта');
  }

  assert.equal(ctx.pickDraftQuadrant('q9'), false, 'несуществующего квадранта нет');
  assert.equal(ctx.matrixDebugState().openQuadrant, 'q1', 'неудачный выбор ничего не меняет');
});

test('задача из строки ввода долетает ровно до выбранного квадранта', (t) => {
  const { context: ctx } = loadApp();
  ctx.openQuadrantView('q1', true);
  ctx.pickDraftQuadrant('q2');
  const draft = ctx.matrixDebugState().draft;
  const added = ctx.addTask(draft.quadrant, {
    title: 'Из строки ввода', notes: '', due: draft.due, priority: draft.priority,
  });
  assert.ok(added, 'задача не добавилась');
  assert.equal(ctx.quadrantOf(added, new Date()), 'q2',
    'то, что обещает пилюля, и то, где карточка лежит, — одно и то же');
});
