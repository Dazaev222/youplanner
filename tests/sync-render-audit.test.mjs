// Аудит гварда sync:applied и точечного диффа (коммиты 615a530, 7b36f9b).
//
// Восемь гипотез параноидального аудита, каждая — тестом:
//   H1  полночь/смена даты: гвард не пропускает перерисовку «сегодня»;
//   H2  сервер откатил значение после локальной правки: дифф возвращает
//       ячейку к серверному состоянию, пустая сверка её не «съедает»;
//   H3  любое структурное изменение списка привычек — полный рендер;
//   H4  sync:applied дважды в один тик: второй проход ничего не мутирует;
//   H5  упавший рендер не оставляет снимка — следующая сверка не пропускает
//       перерисовку;
//   H6  ветки ячеек диффа (choice/level/qaza) воспроизводят cellMarkup
//       один-в-один;
//   H7  круги переживают переходы 0% ↔ 100% живым узлом (цвет/dashoffset/
//       aria-label);
//   H8  дешевизна гварда (регрессионный потолок) и null-безопасность
//       updateTabCalendarDate.
//
// Плюс путь обновления снимка: правка уровня из попапа (level-sheet
// .onLevelPick) переписывает ячейку и круг мимо renderTable — снимок обязан
// обновиться следом, иначе следующая сверка перепишет их вслепую.
// Песочница та же, что в sync-render.test.mjs: фейковый документ с
// рукотворным деревом таблицы + querySelector/querySelectorAll для
// селекторов syncLevelCells/updateRowCircle.

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
    value: opts.value !== undefined ? opts.value : '',
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

// Один «кусочек» селектора: 'tag.class[attr="value"]', '#id', '.class', 'tag'
function matchPart(el, part) {
  let head = part;
  let attrName = null;
  let attrValue = null;
  const bracket = part.indexOf('[');
  if (bracket !== -1) {
    head = part.slice(0, bracket);
    const m = /\[([^=]+)="([^"]*)"\]/.exec(part.slice(bracket));
    if (!m) return false;
    attrName = m[1];
    attrValue = m[2];
  }
  if (head[0] === '#') {
    return el.getAttribute('id') === head.slice(1);
  }
  const dot = head.indexOf('.');
  const tag = dot === -1 ? head : head.slice(0, dot);
  const cls = dot === -1 ? null : head.slice(dot + 1);
  if (tag && el.tagName !== tag) return false;
  if (cls && !(el.classList && el.classList.contains(cls))) return false;
  if (attrName && el.getAttribute(attrName) !== attrValue) return false;
  return true;
}

// Селекторы, которые реально зовёт приложение из песочницы: односоставные
// ('td.cell[data-habit-id="…"]') и цепочка '#habits-tbody tr.habit-row[…]'
function fakeQuerySelectorAll(roots, selector) {
  const parts = String(selector).trim().split(/\s+/);
  const out = [];
  const from = (el, idx) => {
    if (!el || !el.children) return;
    for (const c of el.children) {
      if (!c || typeof c.classList !== 'object') continue;
      if (matchPart(c, parts[idx])) {
        if (idx === parts.length - 1) out.push(c);
        else from(c, idx + 1);
      }
      from(c, idx);
    }
  };
  for (const root of roots) {
    if (matchPart(root, parts[0])) {
      if (parts.length === 1) out.push(root);
      else from(root, 1);
    }
    from(root, 0);
  }
  return out;
}

function makeFakeDocument() {
  const byId = new Map();
  // Зарегистрированный по id узел получает и атрибут id — на нём стоит
  // селектор updateRowCircle ('#habits-tbody tr.habit-row[…]')
  const rawSet = byId.set.bind(byId);
  byId.set = (id, el) => {
    if (el && el.setAttribute) el.setAttribute('id', id);
    return rawSet(id, el);
  };
  return {
    _byId: byId,
    createElementCount: 0,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => {
      const el = makeEl(tag);
      el._isCreateElement = true;
      return el;
    },
    querySelector: (selector) => {
      const found = fakeQuerySelectorAll(byId.values(), selector);
      return found.length > 0 ? found[0] : null;
    },
    querySelectorAll: (selector) => fakeQuerySelectorAll(byId.values(), selector),
    addEventListener() {},
    body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
  };
}

function collectTree(root) {
  const out = [root];
  const walk = (el) => {
    if (!el || !el.children) return;
    for (const c of el.children) { out.push(c); walk(c); }
  };
  walk(root);
  return out;
}

// ── Дерево таблицы под данные (зеркало renderTable/cellMarkup) ─────────────

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
    const raw = day[habit.id];
    if (habit.id === 'h6') {
      // Каза: span-счётчик дня, как qazaCellMarkup
      td.appendChild(makeEl('span', {
        classes: ['cell-qaza'].concat(typeof raw === 'number' ? [] : ['is-empty']),
        text: typeof raw === 'number' ? String(raw) : '—',
      }));
    } else if (habit.type === 'boolean') {
      td.appendChild(makeEl('input', {
        classes: ['cell-check'],
        attrs: { 'data-habit-id': habit.id, 'data-date': date },
      }));
      td.children[td.children.length - 1].checked = raw === true;
      td.appendChild(makeEl('button', {
        classes: ['cell-x'].concat(raw === false ? ['is-active'] : []),
        attrs: { 'data-habit-id': habit.id, 'data-date': date },
        text: '✗',
      }));
    } else if (habit.type === 'choice') {
      // Список выбора: коды SPORT_VALUES, как choiceOptionsMarkup
      const entry = raw && typeof raw === 'object' ? raw : null;
      const select = makeEl('select', {
        classes: ['cell-select'],
        attrs: { 'data-habit-id': habit.id, 'data-date': date },
        value: entry ? entry.value : '',
      });
      if (entry && entry.level === 'on-time') select.classList.add('is-on-time');
      if (entry && entry.level === 'late') select.classList.add('is-late');
      if (entry && entry.level === 'two-min') select.classList.add('is-two-min');
      for (const v of ['', 'yes', 'no', 'two-min', 'rest']) {
        select.appendChild(makeEl('option', { value: v, text: v }));
      }
      td.appendChild(select);
    } else {
      // number (+ Коран с кнопкой уровня)
      const entry = raw && typeof raw === 'object' ? raw : null;
      const input = makeEl('input', {
        classes: ['cell-number'],
        attrs: { 'data-habit-id': habit.id, 'data-date': date },
      });
      input.value = entry
        ? (typeof entry.value === 'number' ? String(entry.value) : '')
        : (typeof raw === 'number' ? String(raw) : '');
      if (entry && entry.level === 'on-time') input.classList.add('is-on-time');
      if (entry && entry.level === 'late') input.classList.add('is-late');
      if (entry && entry.level === 'two-min') input.classList.add('is-two-min');
      td.appendChild(input);
      if (habit.id === 'h8') {
        td.appendChild(makeEl('button', {
          classes: ['cell-level-btn'].concat(entry && entry.level ? ['is-set'] : []),
          attrs: { 'data-habit-id': habit.id, 'data-date': date },
        }));
      }
    }
    row.appendChild(td);
  }

  const progress = makeEl('td', { classes: ['progress-cell'] });
  const week = ctx.run('weekPercent(findHabit("' + habit.id + '"))');
  const month = ctx.run('monthPercent(findHabit("' + habit.id + '"))');
  const length = ctx.run('CIRCLE_LENGTH');
  const clamped = Math.min(Math.max(week, 0), 100);
  const svg = makeEl('svg', { classes: ['progress-circle'], attrs: { 'data-habit-id': habit.id } });
  svg.setAttribute('aria-label', 'Неделя ' + Math.round(week) + '%, месяц М: ' + Math.round(month) + '%');
  svg.appendChild(makeEl('circle', { classes: ['progress-track'] }));
  const arc = makeEl('circle', { classes: ['progress-arc'] });
  arc.style.stroke = week >= 100 ? 'var(--success)' : 'var(--accent)';
  arc.setAttribute('stroke-dasharray', length.toFixed(3));
  arc.setAttribute('stroke-dashoffset', (length * (1 - clamped / 100)).toFixed(3));
  svg.appendChild(arc);
  svg.appendChild(makeEl('text', { classes: ['progress-text'], text: Math.round(week) + '%' }));
  svg.appendChild(makeEl('text', { classes: ['progress-month'], text: 'М: ' + Math.round(month) + '%' }));
  progress.appendChild(svg);
  row.appendChild(progress);
  return row;
}

// ── Общая подготовка ────────────────────────────────────────────────────────

const HABITS = [
  { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
  { id: 'h2', name: 'Вода', type: 'number', unit: 'ст.', goal: 8 },
  { id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 },
  { id: 'h7', name: 'Спорт', type: 'choice', unit: '', goal: null, time: null },
  { id: 'h8', name: 'Коран', type: 'number', unit: 'стр.', goal: 5, time: null },
];

// seedFn(dates) -> записи, видимые в дереве «как после рендера»
function setup(seedFn) {
  const app = loadApp();
  const fakeDoc = makeFakeDocument();
  app.sandbox.document = fakeDoc;

  const errors = [];
  app.sandbox.console = {
    error: (...args) => errors.push(args.map(String).join(' ')),
    warn() {},
    log() {},
  };

  const { run } = app;

  run(`
    appState.weekStart = getWeekStart(new Date());
    localStorage.setItem('youplanner.habits', JSON.stringify(${JSON.stringify(HABITS)}));
    globalThis.__dates = (function () {
      const out = [];
      for (let i = 0; i < 7; i++) out.push(toISODate(addDays(appState.weekStart, i)));
      return out;
    })();
  `);
  const dates = run('globalThis.__dates');
  const records = seedFn(dates) || {};

  run(`
    globalThis.__records = ${JSON.stringify(records)};
    localStorage.setItem('youplanner.records', JSON.stringify(__records));
    localStorage.setItem('youplanner.qaza', JSON.stringify({
      version: 3, cursor: 0,
      remaining: { fajr: 1, zuhr: 1, asr: 1, maghrib: 1, isha: 1 },
      history: [],
    }));
    appState.habits = loadHabits();
    invalidateRecordsCache();
  `);

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
      if (!row || row.getAttribute('data-habit-id') !== habitId) continue;
      for (const c of row.children) {
        if (c.classList && c.classList.contains('cell') && c.getAttribute('data-date') === date) return c;
      }
    }
    return null;
  }

  function circleEl(habitId) {
    for (const row of tbody.children) {
      if (!row || row.getAttribute('data-habit-id') !== habitId) continue;
      const progress = row.children[row.children.length - 1];
      return progress.children[0];
    }
    return null;
  }

  function recordPatch(patchFn) {
    // Правка хранилища «как чужой снимок»: прямая запись + сброс кэша,
    // без setRecord — тот эмитит data:changed и ставит отправку.
    // IIFE: vm.runInContext копит глобальные лексические связки между
    // вызовами — повторный const на верхнем уровне падал бы
    run(`
      (function () {
        const rec = JSON.parse(localStorage.getItem('youplanner.records'));
        (${patchFn})(rec, globalThis.__dates);
        localStorage.setItem('youplanner.records', JSON.stringify(rec));
        invalidateRecordsCache();
      })();
    `);
  }

  function habitsPatch(newHabits) {
    run(`
      localStorage.setItem('youplanner.habits', JSON.stringify(${JSON.stringify(newHabits)}));
      appState.habits = loadHabits();
      invalidateRecordsCache();
    `);
  }

  return {
    app, run, dates, errors, thead, tbody,
    counters, cellEl, circleEl, recordPatch, habitsPatch, fakeDoc,
  };
}

function seedFor(dates) {
  const r = {};
  r[dates[0]] = { h1: true, h2: 3, h6: 2, h7: { value: 'no', level: null }, h8: { value: 3, level: 'late' } };
  r[dates[1]] = { h1: true };
  return r;
}

function seedAllTrue(dates) {
  const r = {};
  for (const date of dates) r[date] = { h1: true };
  return r;
}

// ── H1: полночь/смена даты ──────────────────────────────────────────────────

test('H1: смена даты (полночь) вынуждает полный рендер, пустая сверка — нет', () => {
  const t = setup(seedFor);
  const before = t.counters();

  // «Полночь»: toISODate сдвигается на день вперёд — «сегодня» и даты
  // колонок поехали, данные и DOM остались прежними
  t.run(`
    globalThis.__origToISODate = toISODate;
    toISODate = function (d) {
      return __origToISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    };
  `);

  // Снимок обязан увидеть новый «сегодня» — иначе гвард пропустил бы перерисовку
  const shiftedToday = t.run('captureMainSnapshot().today');
  const unshiftedToday = t.run('__origToISODate(new Date())');
  assert.notEqual(shiftedToday, unshiftedToday, 'снимок не заметил смену даты');

  t.run("bus.emit('sync:applied')");
  assert.equal(t.counters().renders - before.renders, 1,
    'гвард пропустил перерисовку после смены даты');

  // Вторая сверка в том же «новом дне»: снимок уже соответствует — ноль работы
  t.run("bus.emit('sync:applied')");
  assert.equal(t.counters().renders - before.renders, 1,
    'повторная сверка в новом дне снова перерисовала экран');

  // Возврат к настоящей дате — снова структурная разница, снова рендер
  t.run('toISODate = globalThis.__origToISODate');
  t.run("bus.emit('sync:applied')");
  assert.equal(t.counters().renders - before.renders, 2,
    'возврат даты не долетел до экрана');
  assert.equal(t.errors.length, 0, 'броня сработала на ровном месте: ' + JSON.stringify(t.errors));
});

test('H1: сигнатура экрана каза включает день (полночь меняет её без данных)', () => {
  const t = setup(() => ({}));
  // Состояние казы загружено, иначе сигнатура null и сравнивать нечего
  t.run(`
    setQazaState(loadQaza(true));
  `);
  const sig1 = t.run('qazaViewSignature()');
  t.run(`
    globalThis.__origToISODate = toISODate;
    toISODate = function (d) {
      return __origToISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    };
  `);
  const sig2 = t.run('qazaViewSignature()');
  t.run('toISODate = globalThis.__origToISODate');
  assert.notEqual(sig1, sig2, 'сигнатура каза не меняется в полночь — экран устареет');
});

// ── H2: сервер откатил данные после локальной правки ────────────────────────

test('H2: откат сервера после локальной правки — дифф возвращает ячейку к серверному значению', () => {
  const t = setup(seedFor);
  const dates = t.dates;

  // Локальная правка штатным путём (снимок обновляется следом за ней)
  t.run(`onCellChange(findHabit('h2'), '${dates[0]}', 5)`);
  const input = t.cellEl('h2', dates[0]).children[0];

  // Пустая сверка сразу после правки: снимок уже знает правку — ноль мутаций,
  // изменение не «съедено»
  const before = t.counters();
  t.run("bus.emit('sync:applied')");
  const mid = t.counters();
  assert.equal(mid.renders - before.renders, 0);
  assert.equal(mid.mutations - before.mutations, 0, 'пустая сверка тронула узлы после локальной правки');

  // «Сервер» откатил значение на 3: дифф обязан вернуть ячейку к 3
  t.recordPatch((rec, d) => { rec[d[0]].h2 = 3; });
  t.run("bus.emit('sync:applied')");
  const after = t.counters();
  assert.equal(after.renders - mid.renders, 0, 'откат одного значения вызвал полный рендер');
  assert.equal(input.value, '3', 'снимок съел откат сервера — ячейка не вернулась к серверному значению');
});

// ── Путь обновления снимка: правка уровня из попапа уровня ──────────────────

test('H2+: выбор уровня в попапе обновляет снимок — следующая пустая сверка молчит', () => {
  const t = setup(seedFor);
  const dates = t.dates;

  // Настоящий onLevelPick: «2 минуты» меняют уровень записи при том же числе
  t.run(`
    openLevelSheet('h8', '${dates[0]}');
    onLevelPick({
      target: {
        closest: function () {
          return { getAttribute: function (n) { return n === 'data-level' ? 'two-min' : null; } };
        },
      },
    });
  `);

  const before = t.counters();
  t.run("bus.emit('sync:applied')");
  const after = t.counters();
  assert.equal(after.renders - before.renders, 0);
  assert.equal(after.mutations - before.mutations, 0,
    'снимок не узнал про правку уровня — sync:applied переписал уже актуальные узлы вслепую');
});

// ── H3: структурные изменения списка привычек ───────────────────────────────

test('H3: переименование, порядок, цель, время, добавление, удаление — каждый полный рендер', () => {
  const t = setup(seedFor);
  const base = JSON.parse(JSON.stringify(HABITS));

  function expectFullRender(name, mutate) {
    const next = JSON.parse(JSON.stringify(base));
    mutate(next);
    t.habitsPatch(next);
    const before = t.counters();
    t.run("bus.emit('sync:applied')");
    const after = t.counters();
    assert.equal(after.renders - before.renders, 1, name + ': гвард не вызвал полный рендер');
    assert.equal(after.tbodyRebuilds - before.tbodyRebuilds, 1, name + ': тело таблицы не пересобрано');
    // Мутации здесь не считаются: полный рендер в фейковом DOM выкидывает
    // старое дерево целиком, счётчики старых узлов больше не обходятся
  }

  expectFullRender('переименование', (hs) => { hs[1].name = 'Вода новая'; });
  expectFullRender('смена цели', (hs) => { hs[1].goal = 10; });
  expectFullRender('добавление времени', (hs) => { hs[1].time = '08:00'; });
  expectFullRender('перестановка порядка', (hs) => { const tmp = hs[0]; hs[0] = hs[1]; hs[1] = tmp; });
  expectFullRender('добавление привычки', (hs) => { hs.push({ id: 'h9', name: 'Новая', type: 'boolean', unit: '', goal: null }); });
  expectFullRender('удаление привычки', (hs) => { hs.pop(); });

  assert.equal(t.errors.length, 0, 'броня сработала на структурных изменениях: ' + JSON.stringify(t.errors));
});

// ── H4: sync:applied дважды в один тик ──────────────────────────────────────

test('H4: двойной sync:applied в один тик — повторные проходы не мутируют и не рендерят', () => {
  const t = setup(seedFor);
  const dates = t.dates;

  const before = t.counters();
  const beforeTree = collectTree(t.tbody).slice();

  t.recordPatch((rec, d) => { rec[d[0]].h2 = 7; });
  t.run("bus.emit('sync:applied')");
  t.run("bus.emit('sync:applied')");

  const after = t.counters();
  assert.equal(after.renders - before.renders, 0);
  assert.ok(after.mutations - before.mutations > 0, 'первый проход обязан был пропатчить ячейку');
  const input = t.cellEl('h2', dates[0]).children[0];
  assert.equal(input.value, '7');

  // Третья сверка с теми же данными: строго ноль мутаций
  const before3 = t.counters();
  t.run("bus.emit('sync:applied')");
  const after3 = t.counters();
  assert.equal(after3.renders - before3.renders, 0);
  assert.equal(after3.mutations - before3.mutations, 0, 'рассинхрон узлов после двойной сверки');

  const afterTree = collectTree(t.tbody);
  for (let i = 0; i < beforeTree.length; i++) {
    assert.ok(afterTree[i] === beforeTree[i], 'узел ' + i + ' пересоздан');
  }
});

// ── H5: упавший рендер не оставляет снимка ──────────────────────────────────

test('H5: упавший полный рендер не оставляет снимка — следующая сверка рендерит заново', () => {
  // Свежая песочница без DOM-дерева и без снимка: первый рендер обязан упасть
  const app = loadApp();
  const fakeDoc = makeFakeDocument();
  app.sandbox.document = fakeDoc;
  const errors = [];
  app.sandbox.console = {
    error: (...args) => errors.push(args.map(String).join(' ')),
    warn() {}, log() {},
  };
  const { run } = app;
  run(`
    appState.weekStart = getWeekStart(new Date());
    localStorage.setItem('youplanner.habits', JSON.stringify(${JSON.stringify(HABITS)}));
    appState.habits = loadHabits();
    globalThis.__renderMainViewCalls = 0;
    globalThis.__poisonRender = true;
    const __orig = renderMainView;
    renderMainView = function () {
      globalThis.__renderMainViewCalls++;
      if (globalThis.__poisonRender) throw new Error('яд в рендере');
      return __orig.apply(this, arguments);
    };
  `);

  run("bus.emit('sync:applied')");
  assert.equal(run('globalThis.__renderMainViewCalls'), 1, 'первая сверка не дошла до рендера');
  assert.ok(errors.some((m) => m.includes('[bus]')), 'падение рендера не видно в консоли');

  // Яд снят: следующая сверка обязана снова рендерить — упавший рендер не мог
  // оставить снимок, по которому гвард решил бы, что экран актуален
  run('globalThis.__poisonRender = false');
  run("bus.emit('sync:applied')");
  assert.equal(run('globalThis.__renderMainViewCalls'), 2,
    'после упавшего рендера следующая сверка пропустила перерисовку');

  // Экран отрисован: пустые сверки снова молчат
  run("bus.emit('sync:applied')");
  assert.equal(run('globalThis.__renderMainViewCalls'), 2);
});

test('H5+: упавший рендер при живом снимке — следующая сверка приводит DOM к данным', () => {
  const t = setup(seedFor);
  const dates = t.dates;

  // Ссылка на ячейку сохраняется заранее: после подмены classList ядом
  // тестовый поиск по классам в этой ячейке сам падал бы
  const victimCell = t.cellEl('h2', dates[0]);

  // Яд в ячейке (дифф упадёт) и яд в полном рендере (броня тоже упадёт)
  victimCell.classList = {
    contains() { throw new Error('яд в classList'); },
    add() {}, remove() {}, toggle() {},
  };
  t.run(`
    globalThis.__poisonRender = true;
    const __origRender = renderMainView;
    renderMainView = function () {
      if (globalThis.__poisonRender) throw new Error('яд в полном рендере');
      return __origRender.apply(this, arguments);
    };
  `);

  const before = t.counters();
  t.recordPatch((rec, d) => { rec[d[0]].h2 = 9; });
  t.run("bus.emit('sync:applied')");
  assert.ok(t.errors.some((m) => m.includes('[sync-render]')), 'броня не отрапортовала об ошибке диффа');
  assert.ok(t.errors.some((m) => m.includes('[bus]')), 'падение полного рендера не видно в консоли');
  assert.equal(t.counters().renders - before.renders, 0, 'полный рендер отчитался, хотя упал');

  // Снимок обязан остаться ДО правки: после снятия ядов следующая сверка
  // доводит DOM до данных (диффом), а не решает, что всё уже показано
  t.run('globalThis.__poisonRender = false');
  victimCell.classList = {
    contains(c) { return c === 'cell'; },
    add() {}, remove() {}, toggle() {},
  };
  t.run("bus.emit('sync:applied')");
  const input = victimCell.children[0];
  assert.equal(input.value, '9', 'после упавшего рендера следующая сверка не довела DOM до данных');
});

// ── H6: ветки ячеек диффа воспроизводят cellMarkup один-в-один ──────────────

test('H6: дифф choice/Коран/каза переписывает ячейки как полный рендер', () => {
  const t = setup(seedFor);
  const dates = t.dates;

  const sport = t.cellEl('h7', dates[0]).children[0];      // select, было 'no'
  const quran = t.cellEl('h8', dates[0]).children[0];      // input, было 3/late
  const quranBtn = t.cellEl('h8', dates[0]).children[1];
  const qaza = t.cellEl('h6', dates[0]).children[0];       // span, было 2

  // Полный рендер показал бы: Спорт 'two-min' с голубой рамкой, Коран 5
  // вовремя с зелёной рамкой и активной кнопкой, каза без записи — «—»
  t.recordPatch((rec, d) => {
    rec[d[0]].h7 = { value: 'two-min', level: 'two-min' };
    rec[d[0]].h8 = { value: 5, level: 'on-time' };
    delete rec[d[0]].h6;
  });
  t.run("bus.emit('sync:applied')");

  assert.equal(sport.value, 'two-min', 'значение выбора не переписано');
  assert.ok(sport.classList.contains('is-two-min'), 'уровень «2 минуты» не виден на списке');
  assert.ok(!sport.classList.contains('is-late'), 'старый уровень списка не снят');
  assert.equal(quran.value, '5', 'значение Корана не переписано');
  assert.ok(quran.classList.contains('is-on-time'), 'уровень «вовремя» не виден на поле');
  assert.ok(!quran.classList.contains('is-late'), 'старый уровень Корана не снят');
  assert.ok(quranBtn.classList.contains('is-set'), 'кнопка уровня не активирована');
  assert.equal(qaza.textContent, '—', 'пустая каза не показана прочерком');
  assert.ok(qaza.classList.contains('is-empty'), 'у пустой казы нет класса is-empty');

  // Обратно: появление записи у казы и снятие уровней — те же узлы
  const before = t.counters();
  t.recordPatch((rec, d) => {
    rec[d[0]].h6 = 7;
    rec[d[0]].h7 = { value: 'no', level: null };
    rec[d[0]].h8 = { value: 3, level: null };
  });
  t.run("bus.emit('sync:applied')");
  assert.equal(t.counters().renders - before.renders, 0, 'обратный откат вызвал полный рендер');
  assert.equal(qaza.textContent, '7', 'счётчик казы не переписан');
  assert.ok(!qaza.classList.contains('is-empty'), 'класс is-empty не снят');
  assert.equal(sport.value, 'no', 'значение выбора не откачено');
  assert.ok(!sport.classList.contains('is-two-min'), 'уровень выбора не снят');
  assert.equal(quran.value, '3', 'значение Корана не откачено');
  assert.ok(!quranBtn.classList.contains('is-set'), 'кнопка уровня не деактивирована');
});

// ── H7: круги на переходах 0% ↔ 100% ────────────────────────────────────────

test('H7: переход 100% -> 0% -> 100% живым узлом: цвет, dashoffset, aria-label', () => {
  const t = setup(seedAllTrue);

  const svg = t.circleEl('h1');
  const arc = svg.children[1];
  const length = t.run('CIRCLE_LENGTH');

  // Старт: все 7 дней отмечены — 100%
  assert.equal(svg.children[2].textContent, '100%');
  assert.equal(arc.style.stroke, 'var(--success)');

  // Сервер снял все отметки — 0%
  t.recordPatch((rec, d) => { for (const date of d) delete rec[date].h1; });
  t.run("bus.emit('sync:applied')");

  assert.equal(arc.style.stroke, 'var(--accent)', 'цвет дуги не сменился на обычный');
  assert.equal(arc.getAttribute('stroke-dashoffset'), length.toFixed(3), 'дуга не обнулилась');
  assert.equal(svg.children[2].textContent, '0%', 'метка недели не обнулилась');
  assert.equal(svg.children[3].textContent, 'М: 0%', 'месячная метка не обнулилась');
  assert.equal(svg.getAttribute('aria-label'), 'Неделя 0%, месяц М: 0%', 'aria-label не обновлён');
  assert.ok(t.circleEl('h1') === svg, 'круг пересобран, а не переписан живым узлом');

  // Сервер вернул все отметки — снова 100%
  t.recordPatch((rec, d) => {
    for (const date of d) rec[date] = Object.assign({}, rec[date], { h1: true });
  });
  t.run("bus.emit('sync:applied')");
  assert.equal(arc.style.stroke, 'var(--success)', 'цвет дуги не вернулся к успеху');
  assert.equal(arc.getAttribute('stroke-dashoffset'), (0).toFixed(3), 'дуга не вернулась к полной');
  assert.equal(svg.children[2].textContent, '100%', 'метка недели не вернулась');
  assert.equal(svg.getAttribute('aria-label'), 'Неделя 100%, месяц М: 100%', 'aria-label не вернулся');
});

// ── H8: null-безопасность updateTabCalendarDate и регрессионный потолок ─────

test('H8: updateTabCalendarDate безопасен при отсутствующем узле и ставит константу', () => {
  const app = loadApp(); // дефолтный документ: getElementById всегда null
  const { run } = app;
  assert.doesNotThrow(() => run('updateTabCalendarDate()'),
    'updateTabCalendarDate падает без узла tab-calendar-date');

  // Узел есть — на иконке фиксированное 27
  const fakeDoc = makeFakeDocument();
  const dateEl = makeEl('span');
  fakeDoc._byId.set('tab-calendar-date', dateEl);
  app.sandbox.document = fakeDoc;
  run('updateTabCalendarDate()');
  assert.equal(dateEl.textContent, '27');
});

test('H8: captureMainSnapshot укладывается в регрессионный потолок (12x7, тёплые вызовы)', () => {
  const t = setup(seedAllTrue);
  // прогрев кэша calcProgress и JIT
  for (let i = 0; i < 100; i++) t.run('captureMainSnapshot()');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 300; i++) t.run('captureMainSnapshot()');
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / 300;

  // Потолок — грубая броня от катастрофической деградации, не бенчмарк:
  // после хоиста массивов дат ожидаем ~0.5 мс, аварийным считаем 25 мс
  assert.ok(perCallMs < 25, 'captureMainSnapshot деградировал: ' + perCallMs.toFixed(2) + ' мс/вызов');

  // Структурная санити-проверка снимка: 5 привычек x 7 дней — 35 ячеек
  const cells = t.run('Object.keys(captureMainSnapshot().cells).length');
  assert.equal(cells, 35, 'снимок покрывает не все видимые ячейки');
});
