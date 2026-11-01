// Тесты точечного обновления главного экрана при sync:applied (гвард + дифф).
//
// Проблема, которую фиксируют тесты: каждая пересинхронизация с Firebase
// раньше пересобирала таблицу целиком (renderMainView → replaceChildren),
// даже когда снимок не менял ни одной видимой ячейки — сверок «ничего
// нового» большинство. Ожидания:
//   (а) sync:applied на неизменившихся данных — ни одного DOM-узла;
//   (б) sync:applied с одной изменившейся ячейкой — точечный patch:
//       пересозданий узлов нет, изменённые контролы переписаны на месте,
//       остальные узлы живы (сравнение ссылок до/после);
//   (в) броня: исключение в точечном пути откатывает экран к полному
//       рендеру, ошибка видна в console.error.
//
// Песочница loadApp по умолчанию не умеет DOM, поэтому тест подставляет
// собственный фейковый документ с рукотворным деревом таблицы — ровно той
// структуры, которую строит renderTable (классы, data-атрибуты, контролы).
// Дерево строится ПОД данные, снимок снимается refreshMainSnapshot() — так
// фейковый DOM считается «отрисованным», как после настоящего рендера.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// ── Фейковый DOM ────────────────────────────────────────────────────────────

function makeEl(tag, opts = {}) {
  const classes = new Set(opts.classes || []);
  const attrs = {};
  const children = [];
  const el = {
    tagName: tag,
    style: {},
    hidden: false,
    checked: false,
    value: '',
    textContent: opts.text || '',
    innerHTML: '',
    mutations: 0,
    replaceChildrenCalls: 0,
    classList: {
      add: (...cs) => { for (const c of cs) classes.add(c); },
      remove: (...cs) => { for (const c of cs) classes.delete(c); },
      toggle: (c, force) => {
        const target = force === undefined ? !classes.has(c) : Boolean(force);
        if (target) classes.add(c); else classes.delete(c);
        el.mutations++;
        return target;
      },
      contains: (c) => classes.has(c),
    },
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = String(v); el.mutations++; },
    appendChild: (child) => { children.push(child); return child; },
    replaceChildren: (...args) => {
      el.replaceChildrenCalls++;
      children.length = 0;
      for (const a of args) children.push(a);
    },
    // Минимальная поддержка селекторов '.class' — ровно то, что зовут
    // syncBooleanCell/syncLevelCell на контейнере ячейки
    querySelector: (selector) => {
      const m = /^(?:([a-z]+)\.)?\.?([\w-]+)$/.exec(String(selector));
      if (!m) return null;
      const wantTag = m[1] || null;
      const wantClass = m[2];
      let found = null;
      const walk = (parent) => {
        if (found) return;
        for (const c of parent.children) {
          if (!c || !c.classList) continue;
          if (wantTag && c.tagName !== wantTag) continue;
          if (c.classList.contains(wantClass)) { found = c; return; }
          walk(c);
        }
      };
      walk(el);
      return found;
    },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  Object.defineProperty(el, 'children', { value: children });
  for (const [n, v] of Object.entries(opts.attrs || {})) attrs[n] = v;
  for (const child of opts.children || []) children.push(child);
  return el;
}

function makeFakeDocument() {
  const byId = new Map();
  return {
    _byId: byId,
    createElementCount: 0,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => {
      const el = makeEl(tag);
      el._isCreateElement = true;
      return el;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };
}

// Обход дерева в плоский список — для сравнения ссылок «до/после» и подсчёта
function collectTree(root) {
  const out = [root];
  const walk = (el) => {
    if (!el || !el.children) return; // template.content фейковой заглушки
    for (const c of el.children) { out.push(c); walk(c); }
  };
  walk(root);
  return out;
}

// ── Построение дерева таблицы под данные ───────────────────────────────────
// Зеркало renderTable: tr.habit-row[data-habit-id] → td (имя), td.cell
// (контролы с data-habit-id/data-date), td.progress-cell → svg.progress-circle
// с track/arc/text/month. Начальные проценты кругов берутся из приложения,
// чтобы дерево соответствовало тому, что нарисовал бы настоящий рендер.

function buildRow(habit, dates, records, ctx) {
  const row = makeEl('tr', { classes: ['habit-row'], attrs: { 'data-habit-id': habit.id } });

  const nameTd = makeEl('td');
  nameTd.appendChild(makeEl('span', { classes: ['habit-name'], text: habit.name }));
  row.appendChild(nameTd);

  for (const date of dates) {
    const td = makeEl('td', {
      classes: ['cell'],
      attrs: { 'data-habit-id': habit.id, 'data-date': date },
    });
    const day = records[date] || {};
    if (habit.type === 'boolean') {
      const check = makeEl('input', {
        classes: ['cell-check'],
        attrs: { 'data-habit-id': habit.id, 'data-date': date },
      });
      check.checked = day[habit.id] === true;
      const cross = makeEl('button', {
        classes: ['cell-x'],
        attrs: { 'data-habit-id': habit.id, 'data-date': date },
        text: '✗',
      });
      td.appendChild(check);
      td.appendChild(cross);
    } else {
      const input = makeEl('input', {
        classes: ['cell-number'],
        attrs: { 'data-habit-id': habit.id, 'data-date': date },
      });
      input.value = typeof day[habit.id] === 'number' ? String(day[habit.id]) : '';
      td.appendChild(input);
    }
    row.appendChild(td);
  }

  const progress = makeEl('td', { classes: ['progress-cell'] });
  const svg = makeEl('svg', { classes: ['progress-circle'], attrs: { 'data-habit-id': habit.id } });
  svg.appendChild(makeEl('circle', { classes: ['progress-track'] }));
  const arc = makeEl('circle', { classes: ['progress-arc'] });
  arc.style.stroke = 'var(--accent)';
  svg.appendChild(arc);
  const text = makeEl('text', { classes: ['progress-text'] });
  const monthText = makeEl('text', { classes: ['progress-month'] });

  // Проценты на момент «рендера» — тем же правилом, что circleMarkup
  const week = ctx.run('weekPercent(findHabit("' + habit.id + '"))');
  const month = ctx.run('monthPercent(findHabit("' + habit.id + '"))');
  const length = ctx.run('CIRCLE_LENGTH');
  const clamped = Math.min(Math.max(week, 0), 100);
  arc.setAttribute('stroke-dasharray', length.toFixed(3));
  arc.setAttribute('stroke-dashoffset', (length * (1 - clamped / 100)).toFixed(3));
  text.textContent = Math.round(week) + '%';
  monthText.textContent = 'М: ' + Math.round(month) + '%';

  svg.appendChild(text);
  svg.appendChild(monthText);
  progress.appendChild(svg);
  row.appendChild(progress);
  return row;
}

// ── Общая подготовка ────────────────────────────────────────────────────────

const HABITS = [
  { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
  { id: 'h2', name: 'Вода', type: 'number', unit: 'ст.', goal: 8 },
];

function setup() {
  const app = loadApp();
  const fakeDoc = makeFakeDocument();
  app.sandbox.document = fakeDoc;

  // Ошибки брони собираются вместо реальной консоли
  const errors = [];
  app.sandbox.console = {
    error: (...args) => errors.push(args.map(String).join(' ')),
    warn() {},
    log() {},
  };

  const { sandbox, context, run } = app;

  // Данные: две привычки, записи в текущей неделе (D0: вода 3, D1: Фаджр)
  run(`
    appState.weekStart = getWeekStart(new Date());
    localStorage.setItem('youplanner.habits', JSON.stringify(${JSON.stringify(HABITS)}));
    globalThis.__dates = (function () {
      const out = [];
      for (let i = 0; i < 7; i++) out.push(toISODate(addDays(appState.weekStart, i)));
      return out;
    })();
    globalThis.__records = {};
    __records[__dates[0]] = { h2: 3 };
    __records[__dates[1]] = { h1: true };
    localStorage.setItem('youplanner.records', JSON.stringify(__records));
    localStorage.setItem('youplanner.qaza', JSON.stringify({
      version: 3, cursor: 0,
      remaining: { fajr: 1, zuhr: 1, asr: 1, maghrib: 1, isha: 1 },
      history: [],
    }));
    appState.habits = loadHabits();
  `);
  const dates = run('globalThis.__dates');
  const records = run('globalThis.__records');

  // Дерево таблицы «как после рендера»
  const tbody = makeEl('tbody');
  const thead = makeEl('thead');
  for (const habit of HABITS) tbody.appendChild(buildRow(habit, dates, records, app));

  fakeDoc._byId.set('habits-thead', thead);
  fakeDoc._byId.set('habits-tbody', tbody);
  fakeDoc._byId.set('habits-note', makeEl('div'));
  fakeDoc._byId.set('main-view-switch', makeEl('div'));
  fakeDoc._byId.set('day-cards', makeEl('div'));
  fakeDoc._byId.set('mobile-day-tabs', makeEl('div'));
  fakeDoc._byId.set('week-nav', makeEl('div'));
  fakeDoc._byId.set('habits-table', makeEl('table'));

  // Счётчик вызовов renderMainView
  run(`
    globalThis.__renderMainViewCalls = 0;
    const __origRenderMainView = renderMainView;
    renderMainView = function () {
      globalThis.__renderMainViewCalls++;
      return __origRenderMainView.apply(this, arguments);
    };
  `);

  // «Экран отрисован»: снимок соответствует дереву и данным
  run('refreshMainSnapshot()');

  function counters() {
    let mutations = 0;
    for (const e of collectTree(tbody)) {
      if (e && typeof e.mutations === 'number') mutations += e.mutations;
    }
    return {
      renders: run('globalThis.__renderMainViewCalls'),
      theadRebuilds: thead.replaceChildrenCalls,
      tbodyRebuilds: tbody.replaceChildrenCalls,
      created: fakeDoc.createElementCount,
      mutations: mutations,
    };
  }

  function cellEl(habitId, date) {
    for (const row of tbody.children) {
      if (row.getAttribute('data-habit-id') !== habitId) continue;
      for (const c of row.children) {
        if (c.classList.contains('cell') && c.getAttribute('data-date') === date) return c;
      }
    }
    return null;
  }

  function circleEl(habitId) {
    for (const row of tbody.children) {
      if (row.getAttribute('data-habit-id') !== habitId) continue;
      const progress = row.children[row.children.length - 1];
      return progress.children[0];
    }
    return null;
  }

  function recordPatch(patchFn) {
    // Правка хранилища «как чужой снимок»: прямая запись + сброс кэша,
    // без setRecord — тот эмитит data:changed и ставит отправку
    run(`
      const rec = JSON.parse(localStorage.getItem('youplanner.records'));
      (${patchFn})(rec, globalThis.__dates);
      localStorage.setItem('youplanner.records', JSON.stringify(rec));
      invalidateRecordsCache();
    `);
  }

  return {
    app, sandbox, run, dates, records, errors,
    thead, tbody, counters, cellEl, circleEl, recordPatch,
  };
}

// ── (а) Неизменившиеся данные: ни одного DOM-узла ───────────────────────────

test('sync:applied на неизменившихся данных не пересоздаёт ни одного узла', () => {
  const t = setup();

  const before = t.counters();
  const beforeTree = collectTree(t.tbody).slice();

  t.run("bus.emit('sync:applied')");

  const after = t.counters();
  assert.equal(after.renders - before.renders, 0, 'полный рендер на пустой сверке');
  assert.equal(after.theadRebuilds - before.theadRebuilds, 0, 'шапка пересобрана');
  assert.equal(after.tbodyRebuilds - before.tbodyRebuilds, 0, 'тело пересобрано');
  assert.equal(after.created - before.created, 0, 'созданы новые узлы');
  assert.equal(after.mutations - before.mutations, 0, 'мутированы живые узлы');

  // Все узлы живы — те же ссылки, что и до сверки
  const afterTree = collectTree(t.tbody);
  assert.equal(afterTree.length, beforeTree.length, 'состав узлов изменился');
  for (let i = 0; i < beforeTree.length; i++) {
    assert.ok(afterTree[i] === beforeTree[i], 'узел ' + i + ' пересоздан');
  }
});

test('первая сверка на неотрисованном экране собирает таблицу (запасной путь)', () => {
  // Свежая песочница без refreshMainSnapshot(): DOM не отрисован, снимка нет —
  // гвард обязан вызвать полный рендер, а не решить, что экран актуален
  const app = loadApp();
  const fakeDoc = makeFakeDocument();
  app.sandbox.document = fakeDoc;
  const { run } = app;
  run(`
    appState.weekStart = getWeekStart(new Date());
    appState.habits = loadHabits();
    globalThis.__renderMainViewCalls = 0;
    const __orig = renderMainView;
    renderMainView = function () {
      globalThis.__renderMainViewCalls++;
      return __orig.apply(this, arguments);
    };
  `);
  run("bus.emit('sync:applied')");
  assert.equal(run('globalThis.__renderMainViewCalls'), 1,
    'без снимка гвард должен уйти в полный рендер');
});

// ── (б) Одна ячейка изменилась: точечный patch, остальные узлы живы ─────────

test('sync:applied с одной изменившейся ячейкой обновляет только её и круг строки', () => {
  const t = setup();
  const dates = t.dates;

  const before = t.counters();
  const beforeTree = collectTree(t.tbody).slice();
  const check = t.cellEl('h1', dates[1]).children[0];   // была true
  const otherCheck = t.cellEl('h1', dates[2]).children[0];
  const otherCircle = t.circleEl('h2');
  const otherOffset = otherCircle.children[1].getAttribute('stroke-dashoffset');

  // Чужой снимок снимает отметку Фаджра за D1 — единственная разница
  t.recordPatch((rec, d) => { delete rec[d[1]].h1; });
  t.run("bus.emit('sync:applied')");

  const after = t.counters();
  assert.equal(after.renders - before.renders, 0, 'полный рендер вместо точечного patch');
  assert.equal(after.theadRebuilds - before.theadRebuilds, 0, 'шапка пересобрана');
  assert.equal(after.tbodyRebuilds - before.tbodyRebuilds, 0, 'тело пересобрано');
  assert.equal(after.created - before.created, 0, 'созданы новые узлы');

  // Изменённая ячейка: узлы те же (сравнение ссылок), состояние переписано
  const cell = t.cellEl('h1', dates[1]);
  assert.ok(cell.children[0] === check, 'галочка пересоздана');
  const cross = cell.children[1];
  assert.equal(check.checked, false, 'галочка не переписана точечным обновлением');
  assert.equal(cross.classList.contains('is-active'), false, '«✗» активирован');

  // Круг строки: дуга показала 0%, узел тот же
  const circle = t.circleEl('h1');
  assert.ok(circle.children[1].getAttribute('stroke-dashoffset') !== undefined);
  const length = t.run('CIRCLE_LENGTH');
  assert.equal(circle.children[1].getAttribute('stroke-dashoffset'),
    length.toFixed(3), 'смещение дуги не соответствует 0%');
  assert.equal(circle.children[2].textContent, '0%', 'метка круга не обновлена');

  // Остальные узлы живы и не тронуты
  const afterTree = collectTree(t.tbody);
  assert.equal(afterTree.length, beforeTree.length, 'состав узлов изменился');
  for (let i = 0; i < beforeTree.length; i++) {
    assert.ok(afterTree[i] === beforeTree[i], 'узел ' + i + ' пересоздан');
  }
  assert.equal(otherCheck.checked, false, 'чужая ячейка переписана');
  assert.equal(t.circleEl('h2').children[1].getAttribute('stroke-dashoffset'),
    otherOffset, 'чужой круг переписан');

  // Дифф применён: следующая «пустая» сверка не делает вообще ничего
  const before2 = t.counters();
  t.run("bus.emit('sync:applied')");
  const after2 = t.counters();
  assert.equal(after2.renders - before2.renders, 0);
  assert.equal(after2.mutations - before2.mutations, 0, 'повторная пустая сверка мутирует DOM');
});

test('sync:applied при изменившемся значении числовой ячейки переписывает поле на месте', () => {
  const t = setup();
  const dates = t.dates;

  const input = t.cellEl('h2', dates[0]).children[0];
  assert.equal(input.value, '3');

  t.recordPatch((rec, d) => { rec[d[0]].h2 = 5; });
  t.run("bus.emit('sync:applied')");

  const cell = t.cellEl('h2', dates[0]);
  assert.ok(cell.children[0] === input, 'числовое поле пересоздано');
  assert.equal(input.value, '5', 'значение не переписано точечным обновлением');
});

// ── data:replaced проходит через тот же гвард ───────────────────────────────

test('data:replaced на неизменившихся данных тоже не перерисовывает экран', () => {
  const t = setup();
  const before = t.counters();

  t.run("bus.emit('data:replaced')");

  const after = t.counters();
  assert.equal(after.renders - before.renders, 0,
    'импорт копии с теми же данными вызвал полный рендер');
  assert.equal(after.mutations - before.mutations, 0);
});

// ── Уровень 1 на неглавных экранах: сигнатура каза ──────────────────────────

test('sync:applied на экране каза перерисовывает его только при изменившихся данных', () => {
  const t = setup();

  // Экран каза в песочнице не рисует DOM (все getElementById дают null),
  // но нас интересует сам факт вызова renderQazaView — уровень 1
  t.run(`
    currentView = 'qaza';
    globalThis.__renderQazaViewCalls = 0;
    const __origRenderQazaView = renderQazaView;
    renderQazaView = function () {
      globalThis.__renderQazaViewCalls++;
      return __origRenderQazaView.apply(this, arguments);
    };
  `);

  // Первая сверка: сигнатуры ещё нет — экран собирается, сигнатура снимается
  t.run("bus.emit('sync:applied')");
  assert.equal(t.run('globalThis.__renderQazaViewCalls'), 1,
    'первая сверка должна отрисовать экран');

  // Вторая сверка с теми же данными: перерисовки нет
  t.run("bus.emit('sync:applied')");
  assert.equal(t.run('globalThis.__renderQazaViewCalls'), 1,
    'пустая сверка перерисовала экран каза');

  // Чужой снимок меняет остаток: экран перерисовывается
  t.run(`
    const q = JSON.parse(localStorage.getItem('youplanner.qaza'));
    q.remaining.zuhr = 2;
    localStorage.setItem('youplanner.qaza', JSON.stringify(q));
  `);
  t.run("bus.emit('sync:applied')");
  assert.equal(t.run('globalThis.__renderQazaViewCalls'), 2,
    'изменившиеся данные каза не долетели до экрана');
});

// ── (в) Броня: сбой точечного пути откатывает к полному рендеру ─────────────

test('исключение в точечном пути откатывает экран к полному рендеру и видно в консоли', () => {
  const t = setup();
  const dates = t.dates;

  // Яд в classList одной ячейки: дифф найдёт изменение и упадёт на обходе
  const victim = t.cellEl('h2', dates[0]);
  victim.classList = {
    contains() { throw new Error('яд в classList'); },
    add() {},
    remove() {},
    toggle() {},
  };

  const before = t.counters();
  t.recordPatch((rec, d) => { rec[d[0]].h2 = 4; });
  t.run("bus.emit('sync:applied')");

  const after = t.counters();
  assert.equal(after.renders - before.renders, 1,
    'броня не вызвала полный рендер');
  assert.equal(after.theadRebuilds - before.theadRebuilds, 1,
    'шапка не пересобрана броней');
  assert.equal(after.tbodyRebuilds - before.tbodyRebuilds, 1,
    'тело не пересобрано броней');
  assert.ok(t.errors.some((m) => m.includes('[sync-render]')),
    'ошибка точечного пути не видна в console.error: ' + JSON.stringify(t.errors));

  // После брони снимок соответствует данным: следующая пустая сверка молчит
  const before2 = t.counters();
  t.run("bus.emit('sync:applied')");
  const after2 = t.counters();
  assert.equal(after2.renders - before2.renders, 0, 'после брони пустые сверки снова рендерят');
});
