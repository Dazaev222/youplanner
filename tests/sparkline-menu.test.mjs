// Спарклайны в пунктах панели навигации статистики («Меню», aside#stats-menu).
//
// Юнит B ночной смены. Проверяется ровно то, из-за чего такая правка обычно
// и ломается:
//   * ряд считается ИЗ СУЩЕСТВУЮЩИХ источников раздела, а не из своего;
//   * слот декоративен (aria-hidden), смысл остаётся в тексте пункта;
//   * делегирование кликов по .stats-menu-item не получило вторую мишень;
//   * разметка и код не расходятся (пунктов в index.html столько же, сколько
//     ключей тренда, и у каждого есть свой слот);
//   * ничего не пишется в localStorage.
//
// Геометрию (ширину пункта на телефоне) fake DOM не считает — это проверка
// структурная: слот не тянет ширину (flex:none, margin-left:auto) и на
// узком экране уменьшается сам, а не подпись. Живой рендер — ручная
// браузерная проверка (см. отчёт смены).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadApp } from './helpers/load-app.mjs';
import { readIndexHtml } from './helpers/sources.mjs';
import { addDays, toISODate } from '../js/core/dates.js';

const HABITS_KEY = 'youplanner.habits';
const RECORDS_KEY = 'youplanner.records';
const QAZA_LOG_KEY = 'youplanner.qaza.log';
const FAST_KEY = 'youplanner.qaza.fast';
const MATRIX_KEY = 'youplanner.matrix.tasks';

const today = new Date();
const dayBack = (back) => toISODate(addDays(today, -back));
const window14 = (() => {
  const out = [];
  for (let back = 13; back >= 0; back--) out.push(dayBack(back));
  return out;
})();

/* --- fake DOM панели ------------------------------------------------------ */

function sparkSlot() {
  const node = {
    className: 'stats-menu-spark',
    innerHTML: '',
    attrs: { 'aria-hidden': 'true' },
    getAttribute(name) {
      return node.attrs[name] === undefined ? null : String(node.attrs[name]);
    },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name); },
  };
  return node;
}

// Пункт как он лежит в разметке: кнопка с атрибутом экрана, текстом-подписью
// и одним декоративным слотом внутри
function menuItem(attrs, label) {
  const slot = sparkSlot();
  return {
    attrs: Object.assign({}, attrs),
    label,
    slot,
    children: [slot],
    querySelector(sel) { return sel === '.stats-menu-spark' ? slot : null; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
        ? String(this.attrs[name]) : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name);
    },
  };
}

const MENU_ITEMS = [
  [{ 'class': 'stats-menu-item', 'data-stats-view': 'stats' }, 'Общая статистика'],
  [{ 'class': 'stats-menu-item', 'data-stats-view': 'stats-qaza' }, 'Каза-намазы'],
  [{ 'class': 'stats-menu-item', 'data-stats-view': 'stats-sleep' }, 'Сон'],
  [{ 'class': 'stats-menu-item', 'data-stats-view': 'stats-fast' }, 'Ураза'],
  [{ 'class': 'stats-menu-item', 'data-stats-view': 'stats-habits' }, 'Привычки'],
  [{ 'class': 'stats-menu-item', 'data-sleep-view': '' }, 'Цикл сна'],
  [{ 'class': 'stats-menu-item', 'data-matrix-view': '' }, 'Матрица Эйзенхауэра'],
];

function makeDoc(items) {
  const menu = {
    items,
    querySelectorAll(sel) { return sel === '.stats-menu-item' ? items.slice() : []; },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
  const doc = {
    menu,
    getElementById(id) { return id === 'stats-menu' ? menu : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return doc;
}

// Песочница с панеляью и подсчётким localStorage: документ подменяется ПОСЛЕ
// загрузки приложения — код читает глобальный document в момент вызова
function appWithMenu(items, seeds) {
  const loaded = loadApp();
  const doc = makeDoc(items);
  loaded.sandbox.document = doc;
  if (seeds) {
    for (const key of Object.keys(seeds)) {
      loaded.sandbox.localStorage.setItem(key, seeds[key]);
    }
  }
  return { ctx: loaded.context, sandbox: loaded.sandbox, doc };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function pointsOf(svg) {
  const m = /points="([^"]+)"/.exec(svg || '');
  return m ? m[1].trim().split(/\s+/) : [];
}

/* --- источники разделов --------------------------------------------------- */

const src = {
  habits: [{ id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null }],
  records: { [dayBack(1)]: { h1: true }, [dayBack(3)]: { h1: true } },
  qazaLog: { version: 1, since: dayBack(13), entries: [
    { namaz: 'fajr', date: dayBack(2), source: 'done' },
    { namaz: 'zuhr', date: dayBack(2), source: 'done' },
  ] },
  sleep: { history: [
    { date: dayBack(1), realSleepMin: 420, sleepMin: 400 },
    { date: dayBack(4), realSleepMin: 300, sleepMin: 300, excluded: true },
  ] },
  fast: { version: 1, remaining: 5, history: [
    { date: dayBack(5), count: 2, source: 'done' },
    { date: dayBack(5), count: 7, source: 'add' },
  ] },
  tasks: [
    { id: 'm1', title: 'Полоскать рот', done: true, doneAt: new Date(today).toISOString() },
    { id: 'm2', title: '<img src=x onerror=alert(1)>', done: true, doneAt: dayBack(2) + 'T09:00:00.000Z' },
    { id: 'm3', title: 'Без отметки', done: true, doneAt: null },
    { id: 'm4', title: 'Живая', done: false, doneAt: null },
  ],
};

// Ряды «Привычек» и «Общей статистики» считают дни через calcProgress, а он
// читает записи из хранилища (js/data/records.js), а не из переданного src.
// Значит эти два ряда проверяются на НАСТОЯЩИХ записях — с тем же seeding,
// что и боевой путь renderStatsMenuSparks
function seededCtx() {
  return appWithMenu([], {
    [HABITS_KEY]: JSON.stringify(src.habits),
    [RECORDS_KEY]: JSON.stringify(src.records),
  }).ctx;
}

/* --- ряды --------------------------------------------------------------- */

test('menu: ключ тренда берётся из атрибутов пункта, новых не заводим', (t) => {
  const { ctx } = appWithMenu([], null);
  const cases = [
    ['stats', 'hub'], ['stats-qaza', 'qaza'], ['stats-sleep', 'sleep'],
    ['stats-fast', 'fast'], ['stats-habits', 'habits'],
  ];
  for (const [view, key] of cases) {
    assert.equal(ctx.statsMenuSparkKey(menuItem({ 'data-stats-view': view }, 'x')), key,
      'data-stats-view=' + view);
  }
  assert.equal(ctx.statsMenuSparkKey(menuItem({ 'data-sleep-view': '' }, 'x')), 'sleep-cycle');
  assert.equal(ctx.statsMenuSparkKey(menuItem({ 'data-matrix-view': '' }, 'x')), 'matrix');
  // Пункт без известного экрана и чужой элемент — null: чужой тренд не рисуется
  assert.equal(ctx.statsMenuSparkKey(menuItem({ 'data-stats-view': 'stats-habit' }, 'x')), null);
  assert.equal(ctx.statsMenuSparkKey(null), null);
  assert.equal(ctx.statsMenuSparkKey({}), null);
});

test('menu: ряд каза — дни журнала, потолок не ниже дневной цели', (t) => {
  const { ctx } = appWithMenu([], null);
  const series = ctx.statsMenuSparkSeries('qaza', window14, src);
  assert.ok(series, 'ряд есть');
  assert.equal(series.values.length, 14, 'точка на каждый день окна');
  assert.equal(series.values[11], 2, 'два намаза dayBack(2): ' + JSON.stringify(plain(series.values)));
  assert.ok(series.values.reduce((a, b) => a + b, 0) === 2, 'сумма ряда = события журнала');
  assert.ok(series.ceiling >= 3, 'дневная цель каза (3) остаётся нормой шкалы');
});

test('menu: ряд привычек нормирован 0..1 и идёт через sparkValues', (t) => {
  const ctx = seededCtx();
  const series = ctx.statsMenuSparkSeries('habits', window14, src);
  assert.equal(series.ceiling, 1);
  assert.deepEqual(plain(series.values), plain(window14.map(d => (
    d === dayBack(1) || d === dayBack(3) ? 1 : 0
  ))), 'отмеченный день = 1, пустой = 0');
});

test('menu: ряд сна — минуты, excluded-запись не попадает', (t) => {
  const { ctx } = appWithMenu([], null);
  const series = ctx.statsMenuSparkSeries('sleep', window14, src);
  assert.equal(series.values[12], 420, 'dayBack(1) = 420 мин (realSleepMin, не sleepMin)');
  assert.equal(series.values[9], 0, 'excluded-запись dayBack(4) отсечена правилом data-слоя');
  assert.equal(series.ceiling, 420, 'шкала по максимуму окна: нормы у минут нет');
});

test('menu: «Цикл сна» — ритм записей, а не повтор линии «Сна»', (t) => {
  const { ctx } = appWithMenu([], null);
  const series = ctx.statsMenuSparkSeries('sleep-cycle', window14, src);
  assert.equal(series.values[12], 1);
  assert.equal(series.values[11], 0, 'день без записи сна — 0');
  assert.equal(series.ceiling, 1);
  assert.deepEqual(plain(series.values), plain(ctx.statsMenuSparkSeries('sleep', window14, src).values.map(v => (v > 0 ? 1 : 0))),
    'тот же факт наличия записи, что и у линии сна');
});

test('menu: ряд уразы — только возмещение, add в шкалу не входит', (t) => {
  const { ctx } = appWithMenu([], null);
  const series = ctx.statsMenuSparkSeries('fast', window14, src);
  assert.equal(series.values[8], 2, 'done=2 за dayBack(5): ' + JSON.stringify(plain(series.values)));
  assert.equal(series.ceiling, 2, 'add (7) не растит шкалу: график — про возмещение');
});

test('menu: ряд матрицы — выполненные задачи по местным дням', (t) => {
  const { ctx } = appWithMenu([], null);
  const series = ctx.statsMenuSparkSeries('matrix', window14, src);
  assert.equal(series.values[13], 1, 'сегодня: m1');
  assert.ok(series.values.reduce((a, b) => a + b, 0) === 2,
    'только две выполненные с отметкой: ' + JSON.stringify(plain(series.values)));
  assert.equal(series.ceiling, 1);
});

test('menu: ряд хаба — доля разделов с прогрессом, а не чужая линия', (t) => {
  const ctx = seededCtx();
  const series = ctx.statsMenuSparkSeries('hub', window14, src);
  assert.equal(series.ceiling, 1);
  assert.ok(series.values.every(v => v >= 0 && v <= 1), 'доля, а не количество');
  // dayBack(2): каза есть (2 намаза) + матрица (m2 по UTC-дню) → не ноль
  const sum = series.values.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0 && sum < 14, 'есть заполненные дни и есть пустые: ' + sum);
  // Хаб НЕ совпадает ни с одним из четырёх рядов по форме — иначе это дубль
  const shapes = ['qaza', 'sleep', 'fast', 'habits']
    .map(key => JSON.stringify(plain(ctx.statsMenuSparkSeries(key, window14, src).values)));
  assert.ok(shapes.indexOf(JSON.stringify(plain(series.values))) < 0,
    'линия хаба не повторяет линию одного раздела');
});

test('menu: неизвестный ключ, пустое окно и отсутствие данных → null/flat', (t) => {
  const { ctx } = appWithMenu([], null);
  assert.equal(ctx.statsMenuSparkSeries('нет-такого', window14, src), null);
  assert.equal(ctx.statsMenuSparkSeries('qaza', [], src), null,
    'пустого окна на графике быть не должно');
  assert.equal(ctx.statsMenuSparkSeries('qaza', window14, null), null);
  // Отсутствующий раздел (хранилище пустое) — ряд из нулей, а не падение
  const empty = ctx.statsMenuSparkSeries('sleep', window14, {});
  assert.deepEqual(plain(empty.values), plain(window14.map(() => 0)));
  const svg = ctx.sparklineSvg(empty.values, { ceiling: empty.ceiling });
  assert.match(svg, /class="spark is-flat"/, 'пустой раздел не притворяется трендом');
});

test('menu: один день окна — точка, а не линия нулевой длины', (t) => {
  const { ctx } = appWithMenu([], null);
  const series = ctx.statsMenuSparkSeries('sleep', [dayBack(0)], {
    sleep: { history: [{ date: dayBack(0), realSleepMin: 380 }] },
  });
  assert.equal(series.values.length, 1);
  const svg = ctx.sparklineSvg(series.values, { ceiling: series.ceiling });
  assert.ok(!svg.includes('<polyline'), 'из одной точки ломаной не выходит');
  assert.match(svg, /<circle class="spark-dot"/);
  assert.ok(!svg.includes('NaN'), svg);
});

/* --- отрисовка в панели -------------------------------------------------- */

test('menu: все семь пунктов получают свой ряд, подпись не тронута', (t) => {
  const items = MENU_ITEMS.map(([attrs, label]) => menuItem(attrs, label));
  const { ctx, doc } = appWithMenu(items, {
    [HABITS_KEY]: JSON.stringify(src.habits),
    [RECORDS_KEY]: JSON.stringify(src.records),
    [MATRIX_KEY]: JSON.stringify(src.tasks),
  });
  const drawn = ctx.renderStatsMenuSparks();
  assert.equal(drawn, 7, 'рядов на все пункты');
  for (const item of items) {
    assert.match(item.slot.innerHTML, /^<svg class="spark/, item.label);
    assert.equal(pointsOf(item.slot.innerHTML).length, 14, item.label + ': окно 14 дней');
    assert.equal(item.label, item.label, 'подпись пункта не правится');
    assert.equal(item.slot.getAttribute('aria-hidden'), 'true',
      item.label + ': слот остаётся декоративным');
  }
  assert.equal(doc.menu.items.length, 7, 'структура панели не изменилась');
});

test('menu: пустое хранилище не роняет панель и не выглядит трендом', (t) => {
  const items = MENU_ITEMS.map(([attrs, label]) => menuItem(attrs, label));
  const { ctx } = appWithMenu(items, null);
  assert.equal(ctx.renderStatsMenuSparks(), 7);
  for (const item of items) {
    // is-flat — единственный честный вид пустого раздела: линия на нулевой
    // шкале, точка последнего дня спрятана правилом в sparkline.css (не в
    // разметке: svg остаётся одним и тем же кодом для любого ряда)
    assert.match(item.slot.innerHTML, /class="spark is-flat"/, item.label);
  }
  const css = readFileSync(new URL('../styles/sparkline.css', import.meta.url), 'utf8');
  assert.match(css, /\.stats-menu-spark \.spark\.is-flat \.spark-dot\s*\{\s*display: none/,
    'пустому дню точка не рисуется и в пункте меню');
});

test('menu: ничего не пишется в localStorage', (t) => {
  const items = MENU_ITEMS.map(([attrs, label]) => menuItem(attrs, label));
  const seeds = {
    [HABITS_KEY]: JSON.stringify(src.habits),
    [RECORDS_KEY]: JSON.stringify(src.records),
    [QAZA_LOG_KEY]: JSON.stringify(src.qazaLog),
    [FAST_KEY]: JSON.stringify(src.fast),
    [MATRIX_KEY]: JSON.stringify(src.tasks),
  };
  const { ctx, sandbox } = appWithMenu(items, seeds);
  const before = JSON.stringify(sandbox.localStorage._dump());
  ctx.renderStatsMenuSparks();
  // Открытие панели целиком — тоже без записи (openStatsMenu рисует ряды)
  ctx.openStatsMenu();
  assert.equal(JSON.stringify(sandbox.localStorage._dump()), before,
    'меню только читает: ни нового ключа, ни перенормировки старых');
});

test('menu: слот не становится второй мишенью и не лезёт в обход Tab', (t) => {
  const items = MENU_ITEMS.map(([attrs, label]) => menuItem(attrs, label));
  const { ctx } = appWithMenu(items, { [MATRIX_KEY]: JSON.stringify(src.tasks) });
  ctx.renderStatsMenuSparks();
  for (const item of items) {
    const svg = item.slot.innerHTML;
    assert.ok(!/<(button|a|input)\b/i.test(svg), item.label + ': внутри слота интерактива нет');
    assert.ok(!/tabindex/i.test(svg), item.label + ': в обход Tab слот не встает');
    assert.match(svg, /focusable="false"/, item.label + ': svg вне фокуса');
    // Атрибуты пункта, по которым app.js делегирует клик, целы
    for (const name of Object.keys(item.attrs)) {
      assert.ok(item.hasAttribute(name), item.label + ': атрибут ' + name + ' на месте');
    }
  }
});

test('menu: текст задачи и привычки не становится разметкой', (t) => {
  const items = MENU_ITEMS.map(([attrs, label]) => menuItem(attrs, label));
  const { ctx } = appWithMenu(items, {
    [HABITS_KEY]: JSON.stringify([{ id: 'h1', name: '<img src=x onerror=alert(1)>', type: 'boolean' }]),
    [RECORDS_KEY]: JSON.stringify(src.records),
    [MATRIX_KEY]: JSON.stringify(src.tasks),
  });
  ctx.renderStatsMenuSparks();
  for (const item of items) {
    assert.ok(!/<img|onerror/i.test(item.slot.innerHTML), item.label + ': ' + item.slot.innerHTML.slice(0, 80));
    assert.ok(!item.slot.innerHTML.includes('undefined') && !item.slot.innerHTML.includes('NaN'),
      item.label);
  }
});

test('menu: пункт без слота и панель без пунктов — тихо, без падения', (t) => {
  // Пункт, добавленный в разметку без слота, не обязан иметь тренд
  const noSlot = menuItem({ 'data-stats-view': 'stats' }, 'Без слота');
  noSlot.querySelector = () => null;
  const { ctx } = appWithMenu([noSlot], null);
  assert.equal(ctx.renderStatsMenuSparks(), 0, 'рисовать нечего');
  assert.equal(noSlot.slot.innerHTML, '', 'и слот не заполняется');

  // Пункт неизвестного экрана: слот очищается, чужой тренд не рисуется
  const alien = [menuItem({ 'data-stats-view': 'stats-habit' }, 'Чужой')];
  const alienCase = appWithMenu(alien, null);
  alien[0].slot.innerHTML = '<svg class="spark"></svg>';
  assert.equal(alienCase.ctx.renderStatsMenuSparks(), 0);
  assert.equal(alien[0].slot.innerHTML, '', 'старая линия не должна пережить отсутствие ряда');

  // Панели нет вовсе (ПК: display:none, но элемент есть; здесь — нет элемента)
  const bare = loadApp();
  bare.sandbox.document = { getElementById: () => null, querySelectorAll: () => [] };
  assert.equal(bare.context.renderStatsMenuSparks(), 0);
});

/* --- разметка и стили --------------------------------------------------- */

test('menu: index.html — у каждого пункта свой слот с aria-hidden', (t) => {
  const html = readIndexHtml();
  const start = html.indexOf('<aside id="stats-menu"');
  const end = html.indexOf('</aside>', start);
  assert.ok(start >= 0 && end > start, 'панель stats-menu найдена в разметке');
  const panel = html.slice(start, end);

  const items = panel.match(/<button[^>]*class="stats-menu-item"[^>]*>.*?<\/button>/gs) || [];
  assert.equal(items.length, 7, 'пунктов в панели: ' + items.length);
  for (const item of items) {
    const slots = item.match(/<span class="stats-menu-spark"[^>]*><\/span>/g) || [];
    assert.equal(slots.length, 1, 'ровно один слот на пункт: ' + item.slice(0, 60));
    assert.match(slots[0], /aria-hidden="true"/, 'слот декоративен');
    assert.match(item, /data-(stats|sleep|matrix)-view/, 'у пункта есть экран');
  }
  // Ключей тренда столько же, сколько пунктов: ни один не остался без ряда.
  // Атрибуты читаются из ОТКРЫВАЮЩЕГО тега кнопки: data-sleep-view и
  // data-matrix-view в разметке стоят без значения, как и в живом DOM
  const keys = items.map(node => {
    const open = node.slice(0, node.indexOf('>') + 1);
    const attrs = {};
    for (const m of open.matchAll(/([a-z][a-z-]*)(?:="([^"]*)")?/g)) {
      if (m[1].indexOf('data-') === 0) attrs[m[1]] = m[2] || '';
    }
    return {
      attrs: attrs,
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name);
      },
      getAttribute(name) {
        return this.hasAttribute(name) ? this.attrs[name] : null;
      },
    };
  });
  const { ctx } = appWithMenu([], null);
  const resolved = keys.map(item => ctx.statsMenuSparkKey(item));
  assert.equal(resolved.filter(k => k === null).length, 0,
    'каждый пункт панели имеет свой ключ: ' + JSON.stringify(plain(resolved)));
});

test('menu: стили — слот не тянет ширину пункта и красится токенами', (t) => {
  const css = readFileSync(new URL('../styles/sparkline.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.stats-menu-spark {'), css.indexOf('@media (max-width: 360px)'));
  assert.ok(block.length > 0, 'правило .stats-menu-spark найдено');
  assert.match(block, /pointer-events:\s*none/, 'клик всегда остаётся на кнопке');
  assert.match(block, /flex:\s*none/, 'линия не сжимается и не тянет строку');
  assert.match(block, /margin-left:\s*auto/, 'подпись не теряет ширину');
  assert.match(block, /var\(--accent\)/, 'цвет — существующий токен');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(block), 'новых цветовых литералов нет');
  assert.ok(!/font(-size)?:|background:/.test(block),
    'шрифты и фоны пункта правка не трогает');
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*?\.stats-menu-spark\s*\{[^}]*width/,
    'на узком экране штрих укорачивается сам, а не подпись');
});
