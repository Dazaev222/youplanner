// Матрица — ЭКРАН: сетка 2×2 на всю высоту, четыре локальных «+», нижний лист
// создания, явные «выполненные»/«архив»/«перенести» вместо многоточий.
//
// Это ТЗ А2 (Воркер 1). Каждый тест подписан номером пункта, чтобы в отчёте
// видно было, какое именно требование он фиксирует.
//
// Чего здесь СОЗНАТЕЛЬНО нет:
//   * геометрии (высоты, отступы, перенос «+») — fake DOM не считает CSS, это
//     проверяет tests/matrix-layout.browser.mjs;
//   * клавиатурной навигации и Tab-ловушки — по той же причине;
//   * моков `quadrantShape`, `createTask`, commit и хранилища: отказ записи
//     моделируется НАСТОЯЩИМ броском QuotaExceededError из setItem, а квадрант
//     считается реальным правилом (ТЗ А2, пункт «не мокать»).
//
// Вложенность кнопок проверяется структурно: fake не bubblит события, поэтому
// «клик по «+» не должен открыть квадрант» в песочнице означает ««+» не лежит
// внутри кнопки заголовка», а настоящий всплытие проверяется в браузере.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const KEY = 'youplanner.matrix.tasks';
const QUAD = [
  { id: 'q1', numeral: 'I', title: 'Срочно и важно' },
  { id: 'q2', numeral: 'II', title: 'Не срочно, но важно' },
  { id: 'q3', numeral: 'III', title: 'Срочно, но не важно' },
  { id: 'q4', numeral: 'IV', title: 'Не срочно и не важно' },
];

function hasClass(node, name) {
  return String(node.className).split(/\s+/).indexOf(name) >= 0;
}

// Узлы и массивы из песочницы живут в ДРУГОМ realm: `assert.equal(nodeA, nodeB)`
// заставил бы node:assert разбирать граф fake-DOM (там замыкания, _parent-цепочки
// и textContent-геттер, агрегирующий детей) — прогон встал бы на минуты и упал
// по памяти. Поэтому идентичность сравнивается assert.ok, а значения — через plain().
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameNode(actual, expected, message) {
  assert.ok(actual === expected, message);
}

function findByClass(root, className) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (hasClass(child, className)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function oneByClass(root, className) {
  const found = findByClass(root, className);
  assert.equal(found.length, 1, 'узел .' + className + ' должен быть ровно один, найдено ' + found.length);
  return found[0];
}

function buttonsIn(root) {
  return (root.children || []).reduce((acc, child) => {
    if (String(child.tagName).toLowerCase() === 'button') acc.push(child);
    return acc.concat(buttonsIn(child));
  }, []);
}

function ancestors(node) {
  const out = [];
  for (let cur = node._parent; cur; cur = cur._parent) out.push(cur);
  return out;
}

/* --- Fake DOM ------------------------------------------------------------- */

function makeClassList(node) {
  const read = () => String(node.className).split(/\s+/).filter(Boolean);
  return {
    add(...names) {
      const list = read();
      for (const name of names) if (list.indexOf(name) < 0) list.push(name);
      node.className = list.join(' ');
    },
    remove(...names) {
      node.className = read().filter(item => names.indexOf(item) < 0).join(' ');
    },
    toggle(name, force) {
      const list = read();
      const has = list.indexOf(name) >= 0;
      const want = force === undefined ? !has : !!force;
      if (want && !has) list.push(name);
      if (!want && has) list.splice(list.indexOf(name), 1);
      node.className = list.join(' ');
      return want;
    },
    contains: (name) => read().indexOf(name) >= 0,
  };
}

function makeNode(tag, doc) {
  const node = {
    tagName: tag,
    className: '',
    innerHTML: '',
    hidden: false,
    value: '',
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    _events: {},
    _parent: null,
    _doc: doc,
    addEventListener(type, fn) {
      (node._events[type] || (node._events[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = node._events[type];
      if (!list) return;
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    setAttribute(name, value) { node[name] = String(value); },
    getAttribute(name) { return node[name] === undefined ? null : String(node[name]); },
    hasAttribute(name) { return node[name] !== undefined; },
    removeAttribute(name) { delete node[name]; },
    appendChild(child) {
      if (!child) return child;
      child._parent = node;
      node.children.push(child);
      return child;
    },
    append(...list) { for (const child of list) if (child) node.appendChild(child); },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) { node.children.splice(at, 1); child._parent = null; }
      return child;
    },
    remove() { if (node._parent) node._parent.removeChild(node); },
    contains(other) {
      for (let cur = other; cur; cur = cur._parent) if (cur === node) return true;
      return false;
    },
    // Разрешается ровно тот синтаксис, которым пользуется экран: список тегов,
    // .класс и [атрибут]. Больше селекторов production-код не зовёт, и
    // строить CSS-движок здесь незачем.
    querySelectorAll(selector) {
      const parts = String(selector).split(',').map(s => s.trim()).filter(Boolean);
      const matches = (n) => parts.some((part) => {
        if (part.charAt(0) === '.') return hasClass(n, part.slice(1));
        if (part.charAt(0) === '[') return n.hasAttribute(part.slice(1, -1));
        return String(n.tagName).toLowerCase() === part.toLowerCase();
      });
      const out = [];
      const walk = (n) => {
        for (const child of n.children) {
          if (matches(child)) out.push(child);
          walk(child);
        }
      };
      walk(node);
      return out;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    focus() { if (node._doc) node._doc.activeElement = node; },
    getBoundingClientRect() {
      return { top: 0, bottom: 40, left: 0, right: 100, width: 100, height: 40 };
    },
    fire(type, event) {
      const detail = event || {};
      if (typeof detail.preventDefault !== 'function') detail.preventDefault = () => {};
      if (detail.target === undefined) detail.target = node;
      for (const fn of node._events[type] || []) fn(detail);
    },
  };
  node.childNodes = node.children;
  node.classList = makeClassList(node);
  let text = '';
  Object.defineProperty(node, 'textContent', {
    // как в настоящем DOM: текст узла — это его текст ИЛИ текст потомков.
    // Без агрегации `confirm.textContent` читался бы пустым, и проверка
    // «подтверждение назвало задачу» проверяла бы fake, а не экран.
    get: () => (node.children.length
      ? node.children.map(child => child.textContent).join('')
      : text),
    set: (value) => {
      text = value === null || value === undefined ? '' : String(value);
      if (text === '') {
        for (const child of node.children) child._parent = null;
        node.children.length = 0;
      }
    },
  });
  return node;
}

// #matrix-view (холст), #matrix-screen (слой экрана), #toast (единственный
// тост). Два слоя — не украшение: перерисовка экрана обязана оставлять
// открытые листы в живых узлах, иначе лист теряется на каждом commitTasks.
function installMatrixDom(app) {
  const byId = {};
  const doc = app.sandbox.document;
  doc.createElement = (tag) => makeNode(tag, doc);
  doc.getElementById = (id) => byId[id] || null;
  doc.querySelector = () => null;
  doc.querySelectorAll = () => [];
  doc.activeElement = null;

  const host = makeNode('section', doc);
  host.id = 'matrix-view';
  const screen = makeNode('div', doc);
  screen.id = 'matrix-screen';
  screen.className = 'matrix-screen';
  host.appendChild(screen);
  const toast = makeNode('div', doc);
  toast.hidden = true;
  const body = makeNode('body', doc);
  byId['matrix-view'] = host;
  byId['matrix-screen'] = screen;
  byId.toast = toast;
  doc.body = body;
  return { host, screen, toast, body, doc };
}

function breakStorage(app) {
  app.sandbox.localStorage.setItem = () => {
    const error = new Error('QuotaExceededError');
    error.name = 'QuotaExceededError';
    throw error;
  };
}

function seeded(app, list) {
  app.context.saveTasks(list);
  app.context.renderMatrixView();
}

function task(ctx, over) {
  return Object.assign({
    id: 't1', title: 'Задача', notes: '', due: null, doDate: null,
    priority: 0, done: false, doneAt: null,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    order: 1, archived: false,
  }, over || {});
}

function realIso(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}

// от сетки — к карточке своего квадранта
function cardOf(dom, id) {
  const found = findByClass(dom.screen, 'matrix-card').filter(c => c.dataset.quadrant === id);
  assert.equal(found.length, 1, 'карточка .' + id + ' должна быть одна');
  return found[0];
}

function addButton(dom, id) {
  return oneByClass(cardOf(dom, id), 'matrix-card-add');
}

function composerSheets(dom) {
  return findByClass(dom.host, 'matrix-sheet').filter(n => hasClass(n, 'is-composer'));
}

function openVia(dom, id) {
  addButton(dom, id).fire('click');
}

/* ========================================================================= */
/* А2.1 — сетка: четыре карточки, у каждой своя «+» с доступным именем        */
/* ========================================================================= */

test('А2.1 в каждой карточке ровно одна «+» с именем «Добавить задачу: <квадрант>»', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();

  assert.equal(findByClass(dom.screen, 'matrix-card').length, 4, 'сетка 2×2 на месте');
  for (const q of QUAD) {
    const card = cardOf(dom, q.id);
    assert.equal(card.dataset.quadrant, q.id, 'data-quadrant на карточке');
    const adds = findByClass(card, 'matrix-card-add');
    assert.equal(adds.length, 1, q.id + ': кнопка «+» должна быть одна');
    assert.equal(adds[0].tagName, 'button', q.id + ': «+» — настоящая кнопка');
    assert.equal(adds[0].type, 'button', q.id + ': type=button, иначе это submit');
    assert.equal(adds[0].getAttribute('aria-label'), 'Добавить задачу: ' + q.title,
      q.id + ': имя кнопки обязано называть квадрант');
  }
});

/* ========================================================================= */
/* А2.2 — «+» открывает ОДИН лист, не трогая openQuadrant                    */
/* ========================================================================= */

test('А2.2 «+» каждого квадранта открывает один dialog и не меняет экран', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();

  for (const q of QUAD) {
    openVia(dom, q.id);
    const sheets = composerSheets(dom);
    assert.equal(sheets.length, 1, q.id + ': dialog создания обязан быть ровно один');
    assert.equal(sheets[0].getAttribute('role'), 'dialog', q.id + ': role=dialog');
    assert.equal(sheets[0].getAttribute('aria-modal'), 'true', q.id + ': aria-modal');
    assert.ok(sheets[0].getAttribute('aria-labelledby'), q.id + ': лист обязан иметь подпись');

    const st = app.context.matrixDebugState();
    assert.equal(st.openQuadrant, null, q.id + ': «+» в сетке не перекладывает экран в квадрант');
    assert.equal(st.archiveOpen, false, q.id + ': «+» не открывает архив');
    assert.equal(st.draft.quadrant, q.id, q.id + ': черновик обязан взять намерение карточки');

    const pill = oneByClass(dom.host, 'matrix-quad-pill');
    assert.ok(hasClass(pill, 'q-' + q.id), q.id + ': плашка листа показывает тот же квадрант');

    // пустой черновик закрывается без спроса — готовимся к следующему «+»
    assert.equal(app.context.requestCloseTaskComposer('test'), true);
  }
});

test('А2.2 лист открывается поверх прежнего экрана, а сетка остаётся под ним', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q2');

  assert.equal(findByClass(dom.screen, 'matrix-card').length, 4,
    'сетка не сменилась: лист — поверх прежнего экрана (ТЗ А1)');
  assert.equal(findByClass(dom.screen, 'matrix-detail').length, 0,
    'открытие листа — не переход на другой экран');
});

/* ========================================================================= */
/* А2.3 — черновик согласован с quadrantShape и долетает до квадранта         */
/* ========================================================================= */

test('А2.3 новый черновик каждого квадранта уже считает его квадрант', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  const now = new Date();

  for (const q of QUAD) {
    openVia(dom, q.id);
    const draft = app.context.matrixDebugState().draft;
    const shape = app.context.quadrantShape(q.id, {}, now);
    assert.equal(draft.priority, shape.priority,
      q.id + ': приоритет черновика обязан брать quadrantShape, а не средний для всех');
    assert.equal(draft.due, shape.due, q.id + ': срок черновика обязан брать quadrantShape');
    assert.equal(app.context.quadrantOf({ due: draft.due, priority: draft.priority }, now), q.id,
      q.id + ': черновик обязан САМ считаться своим квадрантом (ошибка q3/q4 была — средний приоритет)');
    app.context.requestCloseTaskComposer('test');
  }
});

test('А2.3 submit из «+» кладёт задачу в тот же квадрант, и она перечитывается', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  const now = new Date();
  const results = {};

  for (const q of QUAD) {
    app.context.renderMatrixView();
    openVia(dom, q.id);
    const title = oneByClass(dom.host, 'matrix-composer-title');
    title.value = 'Проверка ' + q.id;
    title.fire('input');
    oneByClass(dom.host, 'matrix-composer').fire('submit');
    results[q.id] = app.context.matrixDebugState().tasks[0];
  }

  for (const q of QUAD) {
    const stored = app.context.loadTasks();
    const mine = stored.filter(x => x.title === 'Проверка ' + q.id);
    assert.equal(mine.length, 1, q.id + ': задача обязана лежать в хранилище ровно один раз');
    assert.equal(app.context.quadrantOf(mine[0], now), q.id,
      q.id + ': после loadTasks задача должна считаться своим квадрантом');
  }
});

/* ========================================================================= */
/* А2.4 — заголовок по-прежнему открывает список, «+» не всплывает в него     */
/* ========================================================================= */

test('А2.4 заголовок карточки открывает полноэкранный список, «+» — не его кнопка', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();

  for (const q of QUAD) {
    const card = cardOf(dom, q.id);
    const head = oneByClass(card, 'matrix-card-head');
    const add = oneByClass(card, 'matrix-card-add');

    assert.ok(!head.contains(add),
      q.id + ': «+» не может лежать ВНУТРИ кнопки заголовка — вложенный button недопустим');
    const header = oneByClass(card, 'matrix-card-header');
    assert.equal(String(header.tagName).toLowerCase(), 'div',
      q.id + ': общий контейнер header — не кнопка');
    assert.ok(header.contains(head) && header.contains(add),
      q.id + ': заголовок и «+» живут рядом в .matrix-card-header');
    assert.equal(buttonsIn(header).length, 2,
      q.id + ': ровно две кнопки — заголовок и «+»');
  }

  oneByClass(cardOf(dom, 'q3'), 'matrix-card-head').fire('click');
  assert.equal(app.context.matrixDebugState().openQuadrant, 'q3',
    'тап по заголовку открывает полноэкранный список квадранта');
  assert.equal(findByClass(dom.host, 'matrix-detail').length, 1);
});

/* ========================================================================= */
/* А2.5 — плашка меняет намерение, но не экран, и бережёт ввод               */
/* ========================================================================= */

test('А2.5 переключение плашки меняет квадрант черновика и сохраняет title/notes', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q1');

  const title = oneByClass(dom.host, 'matrix-composer-title');
  const notes = oneByClass(dom.host, 'matrix-composer-notes');
  title.value = 'Не теряет текст';
  title.fire('input');
  notes.value = 'и заметку';
  notes.fire('input');

  assert.equal(app.context.pickDraftQuadrant('q3'), true);
  const st = app.context.matrixDebugState();
  assert.equal(st.draft.quadrant, 'q3');
  assert.equal(st.draft.title, 'Не теряет текст', 'переключение плашки не имеет права стирать заголовок');
  assert.equal(st.draft.notes, 'и заметку', 'и заметку тоже');
  assert.equal(st.openQuadrant, null,
    'плашка — намерение черновика, а не переход на другой экран (ТЗ А2.5)');
  assert.equal(st.archiveOpen, false);
  assert.equal(composerSheets(dom).length, 1, 'лист остался тем же одним листом');
  assert.equal(oneByClass(dom.host, 'matrix-composer-title').value, 'Не теряет текст',
    'введённый текст обязан остаться в поле после перерисовки');
  assert.equal(oneByClass(dom.host, 'matrix-quad-pill').className.indexOf('q-q3') >= 0, true,
    'плашка перекрасилась в новый квадрант');

  // и намерение доживает до задачи
  oneByClass(dom.host, 'matrix-composer').fire('submit');
  const saved = app.context.loadTasks().filter(x => x.title === 'Не теряет текст');
  assert.equal(saved.length, 1);
  assert.equal(app.context.quadrantOf(saved[0], new Date()), 'q3',
    'плашка q3 должна привести к задаче в q3');
});

/* ========================================================================= */
/* А2.6 — многоточий нет; перенос задачи стал явной доступной кнопкой         */
/* ========================================================================= */

test('А2.6 в DOM нет ни меню-многоточий, ни кнопки с символом «⋯»', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [task(app.context, { id: 'a', title: 'Горячее', priority: 3, due: realIso(0) })]);

  for (const cls of ['matrix-head-menu', 'matrix-detail-menu', 'matrix-more', 'matrix-fab']) {
    assert.equal(findByClass(dom.host, cls).length, 0, '.' + cls + ' быть больше не должно');
  }
  const dotted = buttonsIn(dom.host).filter(b => /[⋯…]/.test(String(b.textContent)));
  assert.deepEqual(dotted.map(b => b.className), [], 'кнопок с символом многоточия остаться не должно');

  app.context.openQuadrantView('q1');
  for (const cls of ['matrix-head-menu', 'matrix-detail-menu', 'matrix-more']) {
    assert.equal(findByClass(dom.host, cls).length, 0, 'в полноэкранном списке .' + cls + ' быть не должно');
  }
  assert.deepEqual(
    buttonsIn(dom.host).filter(b => /[⋯…]/.test(String(b.textContent))).map(b => b.className),
    [], 'в списке тоже');
});

test('А2.6 вместо многоточия — доступная «Перенести задачу: <title>», открывающая прежний лист', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [task(app.context, { id: 'a', title: 'Перенеси меня', priority: 3, due: realIso(0) })]);

  const move = oneByClass(dom.host, 'matrix-task-move');
  assert.equal(move.tagName, 'button');
  assert.equal(move.getAttribute('aria-label'), 'Перенести задачу: Перенеси меня',
    'имя кнопки обязано называть задачу');
  assert.ok(!/[⋯…]/.test(String(move.textContent)), 'перенос — иконка, а не многоточие');

  move.fire('click');
  const sheet = oneByClass(dom.host, 'matrix-sheet');
  assert.equal(sheet.getAttribute('aria-label'), 'Перенести задачу',
    'открывается ПРЕЖНИЙ лист переноса');
  const targets = findByClass(sheet, 'matrix-sheet-item').filter(i => !hasClass(i, 'is-archive'));
  assert.deepEqual(targets.map(i => i.dataset.quadrant), ['q2', 'q3', 'q4'],
    'лист предлагает перенос в остальные квадранты');

  targets[0].fire('click');
  const moved = app.context.loadTasks()[0];
  assert.equal(app.context.quadrantOf(moved, new Date()), 'q2',
    'перенос из листа должен долететь до целевого квадранта');
  assert.equal(composerSheets(dom).length, 0);
});

/* ========================================================================= */
/* А2.7 — выполненные и архив переехали в явную панель инструментов           */
/* ========================================================================= */

function doneToggle(dom) {
  const found = findByClass(dom.host, 'matrix-toolbar-action').filter(n => n.hasAttribute('aria-pressed'));
  assert.equal(found.length, 1, 'переключатель выполненных обязан быть один и с aria-pressed');
  return found[0];
}

function archiveButton(dom) {
  const found = findByClass(dom.host, 'matrix-toolbar-archive');
  assert.equal(found.length, 1, 'кнопка архива обязана быть одна');
  return found[0];
}

test('А2.7 «Показать выполненные» работает в сетке и называет состояние через aria-pressed', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [
    task(app.context, { id: 'live', title: 'Живая', priority: 3, due: realIso(0) }),
    task(app.context, { id: 'old', title: 'Сделанная', priority: 3, due: realIso(0), done: true }),
  ]);

  const toggle = doneToggle(dom);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.textContent, 'Показать выполненные');
  assert.equal(findByClass(dom.host, 'matrix-task').filter(r => hasClass(r, 'is-done')).length, 0,
    'по умолчанию выполненных не видно');

  toggle.fire('click');
  assert.equal(doneToggle(dom).getAttribute('aria-pressed'), 'true');
  assert.equal(doneToggle(dom).textContent, 'Скрыть выполненные');
  assert.equal(findByClass(dom.host, 'matrix-task').filter(r => hasClass(r, 'is-done')).length, 1,
    'по просьбе сделанная строка видна в сетке');
});

test('А2.7 переключатель выполненных есть и в полноэкранном списке квадранта', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [
    task(app.context, { id: 'live', title: 'Живая', priority: 3, due: realIso(0) }),
    task(app.context, { id: 'old', title: 'Сделанная', priority: 3, due: realIso(0), done: true }),
  ]);
  app.context.openQuadrantView('q1');

  assert.equal(doneToggle(dom).getAttribute('aria-pressed'), 'false');
  doneToggle(dom).fire('click');
  assert.equal(doneToggle(dom).getAttribute('aria-pressed'), 'true');
  assert.equal(findByClass(dom.host, 'matrix-task').filter(r => hasClass(r, 'is-done')).length, 1,
    'список квадранта обязан слушать тот же переключатель');
});

test('А2.7 «Архив (0)» доступен при пустом архиве, назад возвращает в исходный экран', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [task(app.context, { id: 'live', title: 'Живая', priority: 3, due: realIso(0) })]);

  assert.equal(archiveButton(dom).textContent, 'Архив (0)',
    'нулевой архив обязан быть виден: пустой раздел — это тоже ответ');

  archiveButton(dom).fire('click');
  assert.equal(app.context.matrixDebugState().archiveOpen, true);
  assert.match(findByClass(dom.host, 'matrix-detail-title')[0].textContent, /Архив \(0\)/);
  assert.equal(findByClass(dom.host, 'matrix-task').length, 0, 'в пустом архиве строк нет');
  assert.ok(findByClass(dom.host, 'matrix-empty').length >= 1, 'пустое состояние объяснимо словами');

  oneByClass(dom.host, 'matrix-back').fire('click');
  assert.equal(app.context.matrixDebugState().archiveOpen, false);
  assert.equal(app.context.matrixDebugState().openQuadrant, null,
    'из архива, открытого из сетки, назад — в сетку, а не в выдуманный q1');
});

test('А2.7 архив, открытый из полноэкранного квадранта, возвращает в тот же квадрант', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [task(app.context, { id: 'live', title: 'Живая', priority: 3, due: realIso(0) })]);
  app.context.openQuadrantView('q3');

  archiveButton(dom).fire('click');
  assert.equal(app.context.matrixDebugState().archiveOpen, true);
  oneByClass(dom.host, 'matrix-back').fire('click');
  assert.equal(app.context.matrixDebugState().archiveOpen, false);
  assert.equal(app.context.matrixDebugState().openQuadrant, 'q3',
    '«назад» обязан вернуть туда, откуда вошли (ТЗ А4.7 про returnView)');
});

test('А2.7 архив не смешивается с выполненными', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [
    task(app.context, { id: 'live', title: 'Живая', priority: 3, due: realIso(0) }),
    task(app.context, { id: 'old', title: 'Сделанная', priority: 3, due: realIso(0), done: true }),
    task(app.context, { id: 'box', title: 'В архиве', priority: 3, due: realIso(0), archived: true }),
  ]);

  assert.equal(archiveButton(dom).textContent, 'Архив (1)');
  archiveButton(dom).fire('click');
  const rows = findByClass(dom.host, 'matrix-task');
  assert.deepEqual(rows.map(r => r.dataset.taskId), ['box'],
    'в архиве только архивные: «сделано» и «снято» — разные состояния');

  doneToggle(dom).fire('click');
  assert.deepEqual(findByClass(dom.host, 'matrix-task').map(r => r.dataset.taskId), ['box'],
    'показ выполненных не наполняет архив');
});

test('А2.7 безвозвратное удаление из архива требует подтверждения с названием задачи', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  seeded(app, [
    task(app.context, { id: 'box', title: 'Удали меня', priority: 2, due: null, archived: true }),
    task(app.context, { id: 'keep', title: 'Не трожь', priority: 3, due: realIso(0) }),
  ]);
  archiveButton(dom).fire('click');

  const drop = findByClass(dom.host, 'matrix-act').filter(b => b.textContent === 'Удалить')[0];
  assert.ok(drop, 'в архиве осталась кнопка безвозвратного удаления');
  drop.fire('click');

  assert.equal(app.context.loadTasks().length, 2, 'клик по «Удалить» не имеет права писать немедленно');
  const confirm = oneByClass(dom.host, 'matrix-confirm');
  assert.match(confirm.textContent, /Удали меня/,
    'подтверждение обязано назвать задачу, которую стирают');
  // Безопасный ответ здесь стоит ВТОРЫМ: фокус обязан идти по признаку
  // «безопасный», а не по позиции, иначе Enter с клавиатуры стирал бы задачу.
  sameNode(dom.doc.activeElement, findByClass(confirm, 'matrix-confirm-cancel')[0],
    'фокус обязан встать на «Отмена», а не на опасную кнопку');

  findByClass(confirm, 'matrix-confirm-cancel')[0].fire('click');
  assert.equal(app.context.loadTasks().length, 2, 'отмена ничего не пишет');
  assert.equal(findByClass(dom.host, 'matrix-confirm').length, 0, 'подтверждение снято');

  findByClass(dom.host, 'matrix-act').filter(b => b.textContent === 'Удалить')[0].fire('click');
  findByClass(oneByClass(dom.host, 'matrix-confirm'), 'matrix-confirm-accept')[0].fire('click');
  assert.deepEqual(plain(app.context.loadTasks().map(x => x.id)), ['keep'],
    'подтверждённое удаление стирает ровно выбранную задачу');
});

/* ========================================================================= */
/* А2.8 — отказ записи, ровно одна задача, защита от повторного Enter         */
/* ========================================================================= */

test('А2.8 отказ записи сохраняет ВЕСЬ черновик и открытый лист, и не «Добавлено»', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q1');

  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Всё должно остаться';
  title.fire('input');
  const notes = oneByClass(dom.host, 'matrix-composer-notes');
  notes.value = 'и это тоже';
  notes.fire('input');
  const before = app.context.matrixDebugState().draft;
  const beforeDue = before.due;
  const beforePriority = before.priority;

  breakStorage(app);
  oneByClass(dom.host, 'matrix-composer').fire('submit');

  const after = app.context.matrixDebugState().draft;
  assert.ok(after, 'черновик обязан остаться');
  assert.equal(after.title, 'Всё должно остаться');
  assert.equal(after.notes, 'и это тоже', 'заметка — часть черновика, а не расходник');
  assert.equal(after.due, beforeDue, 'срок обязан пережить отказ');
  assert.equal(after.priority, beforePriority, 'и приоритет тоже');
  assert.equal(composerSheets(dom).length, 1, 'лист обязан остаться открытым');
  assert.equal(oneByClass(dom.host, 'matrix-composer-title').value, 'Всё должно остаться');
  assert.equal(app.context.loadTasks().length, 0);
  assert.equal(dom.toast.hidden, false);
  assert.match(dom.toast.textContent, /память браузера/);
  assert.ok(!/Добавлено/.test(dom.toast.textContent));
});

test('А2.8 успешная запись создаёт ровно одну задачу, повторный Enter — дубликат не нужен', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q2');

  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Одна единственная';
  title.fire('input');
  const form = oneByClass(dom.host, 'matrix-composer');
  form.fire('submit');
  form.fire('submit');
  title.fire('keydown', { key: 'Enter', shiftKey: false, target: title });

  assert.equal(app.context.loadTasks().length, 1, 'задача обязана лечь ровно один раз');
  assert.equal(app.context.matrixDebugState().tasks.length, 1);
});

/* ========================================================================= */
/* А2.9 — правила закрытия листа                                             */
/* ========================================================================= */

test('А2.9 пустой черновик закрывается кнопкой, backdrop и Escape, фокус возвращается на «+»', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();

  for (const way of ['button', 'backdrop', 'escape']) {
    const add = addButton(dom, 'q1');
    openVia(dom, 'q1');
    assert.equal(app.context.isTaskComposerOpen(), true);
    const backdrop = findByClass(dom.host, 'matrix-sheet-backdrop').filter(n => hasClass(n, 'is-composer'))[0];
    assert.ok(backdrop, 'у листа обязана быть подложка');

    if (way === 'button') {
      oneByClass(dom.host, 'matrix-composer-close').fire('click');
    } else if (way === 'backdrop') {
      backdrop.fire('click', { target: backdrop });
    } else {
      assert.equal(app.context.handleMatrixEscape(), true, 'Escape обязан погасить лист');
    }
    assert.equal(app.context.isTaskComposerOpen(), false, way + ': пустой лист закрылся');
    sameNode(dom.doc.activeElement, add, way + ': фокус обязан вернуться на исходную «+»');
  }
});

test('А2.9 непустой черновик требует «Продолжить редактирование»/«Отбросить»', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  const add = addButton(dom, 'q1');
  openVia(dom, 'q1');

  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Жалко терять';
  title.fire('input');

  assert.equal(app.context.handleMatrixEscape(), true, 'Escape съеден листом');
  assert.equal(app.context.isTaskComposerOpen(), true, 'непустой лист сам не закрывается');
  assert.equal(app.context.matrixDebugState().draft.title, 'Жалко терять');

  const confirm = oneByClass(dom.host, 'matrix-confirm');
  assert.equal(confirm.getAttribute('role'), 'alertdialog', 'спрос — модальное подтверждение');
  const keep = findByClass(confirm, 'matrix-confirm-keep')[0];
  assert.equal(keep.textContent, 'Продолжить редактирование');
  assert.equal(findByClass(confirm, 'matrix-confirm-discard')[0].textContent, 'Отбросить');

  keep.fire('click');
  assert.equal(findByClass(dom.host, 'matrix-confirm').length, 0, 'вопрос снят');
  assert.equal(app.context.isTaskComposerOpen(), true, 'и лист остался');
  sameNode(dom.doc.activeElement, title, 'вернулись в поле, а не в сетку');

  assert.equal(app.context.requestCloseTaskComposer('backdrop'), false, 'снова спросили');
  findByClass(oneByClass(dom.host, 'matrix-confirm'), 'matrix-confirm-discard')[0].fire('click');
  assert.equal(app.context.isTaskComposerOpen(), false, '«Отбросить» закрывает лист');
  assert.equal(app.context.matrixDebugState().draft, null);
  sameNode(dom.doc.activeElement, add, 'после отказа фокус тоже возвращается на «+»');
});

test('А2.9 навигация во вкладку подчиняется тому же правилу, что и Escape', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();

  openVia(dom, 'q1');
  assert.equal(app.context.handleMatrixNavigation('qaza'), true,
    'пустой лист не держит человека на экране');
  assert.equal(app.context.isTaskComposerOpen(), false);

  openVia(dom, 'q1');
  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Ещё пишу';
  title.fire('input');
  assert.equal(app.context.handleMatrixNavigation('qaza'), false,
    'непустой лист обязан остановить переход и спросить');
  assert.equal(app.context.isTaskComposerOpen(), true);
  assert.equal(findByClass(oneByClass(dom.host, 'matrix-confirm'), 'matrix-confirm-discard').length, 1);

  findByClass(oneByClass(dom.host, 'matrix-confirm'), 'matrix-confirm-discard')[0].fire('click');
  assert.equal(app.context.handleMatrixNavigation('qaza'), true, 'после ответа переход свободен');
});

test('А2.9 после успешной записи фокус возвращается на ЖИВУЮ кнопку карточки', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  const add = addButton(dom, 'q1');
  add.fire('click');

  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Успех тоже возвращается';
  title.fire('input');
  oneByClass(dom.host, 'matrix-composer').fire('submit');

  // commitTasks перерисовывает экран, и узел, с которого всё началось,
  // остаётся в снятом дереве. Возврат фокуса по ссылке на него был бы
  // возвратом в никуда: браузер отдает фокус body, и с клавиатуры человек
  // теряет позицию.
  const live = addButton(dom, 'q1');
  assert.notEqual(live, add, 'перерисовка обязана была заменить узел — иначе проверка пустая');
  sameNode(dom.doc.activeElement, live,
    'фокус обязан вернуться на актуальную кнопку того же квадранта');
});

test('А5 Tab держится внутри верхнего листа, а вопрос забирает фокус на безопасный ответ', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q1');

  const panel = oneByClass(dom.host, 'matrix-sheet');
  const focusables = panel.querySelectorAll('button, textarea, input');
  assert.ok(focusables.length >= 4, 'в листе есть по чему_tab-ить: ' + focusables.length);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  dom.doc.activeElement = last;
  panel.fire('keydown', { key: 'Tab', shiftKey: false, target: last });
  sameNode(dom.doc.activeElement, first,
    'Tab с последнего поля возвращается к первому, а не уходит в фон');

  dom.doc.activeElement = first;
  panel.fire('keydown', { key: 'Tab', shiftKey: true, target: first });
  sameNode(dom.doc.activeElement, last, 'Shift+Tab с первого поля уходит в конец листа');

  dom.doc.activeElement = first;
  panel.fire('keydown', { key: 'Enter', shiftKey: false, target: first });
  sameNode(dom.doc.activeElement, first, 'обычная клавиша не двигает фокус');

  // Непустой черновик -> вопрос. Фокус обязан уйти в вопрос и вернуться.
  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Текст';
  title.fire('input');
  title.focus();
  app.context.handleMatrixEscape();
  const confirm = oneByClass(dom.host, 'matrix-confirm');
  sameNode(dom.doc.activeElement, confirm.querySelectorAll('button')[0],
    'вопрос забирает фокус на свой первый (безопасный) ответ');
  findByClass(confirm, 'matrix-confirm-keep')[0].fire('click');
  sameNode(dom.doc.activeElement, title, 'ответ «Продолжить» возвращает каретку в поле');
});

/* ========================================================================= */
/* А2.10 — перерисовка не плодит листы, HTML остаётся текстом                 */
/* ========================================================================= */

test('А2.10 перерисовка и повторное открытие не плодят листов, узлов и слушателей', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q1');

  const form = oneByClass(dom.host, 'matrix-composer');
  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Держись, узел';
  title.fire('input');

  for (let i = 0; i < 3; i++) {
    app.context.renderMatrixView();
    assert.equal(composerSheets(dom).length, 1, 'перерисовка №' + i + ' не должна плодить листы');
    assert.equal(findByClass(dom.host, 'matrix-composer').length, 1);
    sameNode(oneByClass(dom.host, 'matrix-composer'), form,
      'тот же лист, а не новый: иначе теряются фокус и каретка');
    assert.equal(form._events.submit.length, 1, 'обработчик submit обязан остаться одним');
    assert.equal(oneByClass(dom.host, 'matrix-composer-title').value, 'Держись, узел',
      'перерисовка не съедает ввод');
  }

  // Черновик непустой, поэтому закрытие требует ответа «Отбросить» (А2.9):
  // молча сорвать ввод этот контракт не разрешает.
  assert.equal(app.context.requestCloseTaskComposer('test'), false, 'непустой лист не закрывается сам');
  findByClass(oneByClass(dom.host, 'matrix-confirm'), 'matrix-confirm-discard')[0].fire('click');
  assert.equal(composerSheets(dom).length, 0, '«Отбросить» снимает и вопрос, и лист');

  // второй клик по «+» при пустом черновике — не второй лист
  openVia(dom, 'q1');
  openVia(dom, 'q1');
  assert.equal(composerSheets(dom).length, 1, 'повторное открытие даёт один лист');
  assert.equal(findByClass(dom.host, 'matrix-sheet-backdrop').filter(n => hasClass(n, 'is-composer')).length, 1);

  app.context.requestCloseTaskComposer('test');
  assert.equal(composerSheets(dom).length, 0, 'закрытый лист убирается из DOM целиком');
  assert.equal(findByClass(dom.host, 'matrix-sheet-backdrop').length, 0);
  assert.equal(findByClass(dom.host, 'matrix-confirm').length, 0);
});

test('А2.10 чужая «+» при непустом черновике не подменяет его, а ждёт ответа', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q1');
  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Пишу в q1';
  title.fire('input');

  assert.equal(app.context.openTaskComposer({ quadrantId: 'q3', opener: addButton(dom, 'q3') }), false,
    'открытие другой «+» не имеет права произойти без решения');
  assert.equal(app.context.matrixDebugState().draft.title, 'Пишу в q1', 'черновик не подменён');
  assert.equal(composerSheets(dom).length, 1, 'и второго листа нет');

  findByClass(oneByClass(dom.host, 'matrix-confirm'), 'matrix-confirm-discard')[0].fire('click');
  assert.equal(composerSheets(dom).length, 1, 'после «Отбросить» открылся лист q3');
  assert.equal(app.context.matrixDebugState().draft.quadrant, 'q3');
  assert.equal(app.context.matrixDebugState().draft.title, '', 'новый черновик пуст');
  assert.equal(findByClass(dom.host, 'matrix-sheet-backdrop').length, 1, 'по-прежнему один лист');
});

test('А2.10 пользовательский HTML остаётся текстом и в листе, и в строке', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q1');

  const evil = '<img src=x onerror=alert(1)>';
  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = evil;
  title.fire('input');
  oneByClass(dom.host, 'matrix-composer').fire('submit');

  const row = oneByClass(dom.host, 'matrix-task-title');
  assert.equal(row.textContent, evil, 'заголовок обязан читаться буквально');
  assert.equal(row.children.length, 0, 'из пользовательского текста разметку строить нельзя');
  assert.equal(buttonsIn(row).length, 0);
});

/* ========================================================================= */
/* А5 — узкий API листа (контракт с Воркером 2)                               */
/* ========================================================================= */

test('А5 openTaskComposer валидирует id и не открывает лист на чужой квадрант', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();

  assert.equal(app.context.openTaskComposer({ quadrantId: 'q9' }), false);
  assert.equal(app.context.openTaskComposer({}), false);
  assert.equal(app.context.isTaskComposerOpen(), false, 'отказ не должен оставить полусостояние');
  assert.equal(app.context.openTaskComposer({ quadrantId: 'q4' }), true);
  assert.equal(app.context.matrixDebugState().draft.quadrant, 'q4');
  app.context.requestCloseTaskComposer('test');
});

test('А5 getDraftSchedule/applyDraftSchedule обмениваются КОПИЯМИ и не роняют лист', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  app.context.renderMatrixView();
  openVia(dom, 'q2');

  const first = app.context.getDraftSchedule();
  assert.ok(first && typeof first === 'object', 'адаптер обязан вернуть объект');
  const snapshot = JSON.stringify(first);
  first.due = '1999-01-01';
  assert.equal(JSON.stringify(app.context.getDraftSchedule()), snapshot,
    'изменение возвращённого объекта не имеет права трогать черновик');

  assert.equal(app.context.applyDraftSchedule({ due: realIso(9) }), true);
  assert.equal(app.context.matrixDebugState().draft.due, realIso(9),
    'только явный apply двигает срок');
  assert.equal(app.context.isTaskComposerOpen(), true, 'применение расписания лист не закрывает');
  assert.equal(app.context.applyDraftSchedule(null), false);
});
