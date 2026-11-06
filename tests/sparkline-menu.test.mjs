// Эмодзи-значки в пунктах панели навигации статистики («Меню», aside#stats-menu).
//
// SVG-тренды пунктов убраны: вместо слота .stats-menu-spark и рендера
// renderStatsMenuSparks у каждого пункта — текстовый эмодзи слева от названия.
// Проверяется ровно то, из-за чего такая правка обычно и ломается:
//   * у каждого пункта ровно один эмодзи-слот, и он ПЕРЕД текстом —
//     значок слева, подпись читается первой;
//   * слот декоративен (aria-hidden), смысл остаётся в тексте пункта;
//   * старого слота и его рендера больше нет нигде — ни в разметке, ни в
//     коде, ни в стилях; спарклайны СТРОК статистики (.stats-row-spark)
//     при этом не тронуты;
//   * пункт остаётся flex-строкой с прежними шрифтом, цветом и высотой,
//     значок держится тем же внутренним ритмом (gap: 12px = вертикальный
//     паддинг пункта);
//   * открытие панели по-прежнему ничего не пишет в localStorage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadApp } from './helpers/load-app.mjs';
import { getModuleOrder, readIndexHtml } from './helpers/sources.mjs';

function readProjectFile(rel) {
  return readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
}

// Тело правила «selector { ... }» — первое вхождение селектора в файле
function ruleBody(css, selector) {
  const at = css.indexOf(selector + ' {');
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/* --- разметка ------------------------------------------------------------ */

const ITEMS = [
  // [атрибут экрана, подпись, эмодзи] — распределение значков по пунктам
  ['data-stats-view="stats"', 'Общая статистика', '📊'],
  ['data-stats-view="stats-qaza"', 'Каза-намазы', '🚫'],
  ['data-stats-view="stats-sleep"', 'Сон', '🌙'],
  ['data-stats-view="stats-fast"', 'Ураза', '✅'],
  ['data-stats-view="stats-habits"', 'Привычки', '✅'],
  ['data-sleep-view', 'Цикл сна', '🌙'],
  ['data-matrix-view', 'Матрица Эйзенхауэра', '🗂️'],
];

function menuPanel() {
  const html = readIndexHtml();
  const start = html.indexOf('<aside id="stats-menu"');
  const end = html.indexOf('</aside>', start);
  assert.ok(start >= 0 && end > start, 'панель stats-menu найдена в разметке');
  return html.slice(start, end);
}

test('menu: index.html — у каждого пункта один эмодзи-слот и он перед текстом', () => {
  const buttons = menuPanel().match(/<button[^>]*class="stats-menu-item"[^>]*>.*?<\/button>/gs) || [];
  assert.equal(buttons.length, 7, 'пунктов в панели: ' + buttons.length);
  for (const item of buttons) {
    const slots = item.match(/<span class="stats-menu-emoji" aria-hidden="true">[^<]+<\/span>/g) || [];
    assert.equal(slots.length, 1, 'ровно один эмодзи-слот на пункт: ' + item.slice(0, 60));
    assert.match(slots[0], /aria-hidden="true"/, 'слот декоративен');
    // Значок ПЕРЕД подписью: содержимое пункта начинается со слота
    const inner = item.slice(item.indexOf('>') + 1, -9);
    assert.ok(inner.startsWith(slots[0]),
      'эмодзи стоит слева от названия: ' + item.slice(0, 60));
    assert.match(item, /data-(stats|sleep|matrix)-view/, 'у пункта есть экран');
  }
});

test('menu: распределение эмодзи по пунктам совпадает со спекой', () => {
  const buttons = menuPanel().match(/<button[^>]*class="stats-menu-item"[^>]*>.*?<\/button>/gs) || [];
  const found = buttons.map(node => {
    const open = node.slice(0, node.indexOf('>') + 1);
    const attrs = {};
    for (const m of open.matchAll(/([a-z][a-z-]*)(?:="([^"]*)")?/g)) {
      if (m[1].indexOf('data-') === 0) attrs[m[1]] = m[2] || '';
    }
    const emoji = /<span class="stats-menu-emoji" aria-hidden="true">([^<]*)<\/span>/.exec(node);
    // Подпись — то, что осталось после слота; текст пункта не правится
    const label = node.slice(node.indexOf('>') + 1, -9)
      .replace(/<span class="stats-menu-emoji" aria-hidden="true">[^<]*<\/span>/, '');
    const view = attrs['data-stats-view']
      || (Object.prototype.hasOwnProperty.call(attrs, 'data-sleep-view') ? 'sleep-view' : '')
      || (Object.prototype.hasOwnProperty.call(attrs, 'data-matrix-view') ? 'matrix-view' : '');
    return { view, label, emoji: emoji ? emoji[1] : null };
  });
  for (const [attr, label, emoji] of ITEMS) {
    const key = attr.replace('data-stats-view="', '').replace('"', '')
      .replace('data-sleep-view', 'sleep-view').replace('data-matrix-view', 'matrix-view');
    const item = found.find(i => i.view === key);
    assert.ok(item, 'пункт найден: ' + key);
    assert.equal(item.emoji, emoji, key + ': значок пункта');
    assert.equal(item.label, label, key + ': подпись пункта не тронута');
  }
});

test('menu: старого SVG-слота и его рендера нет нигде в проекте', () => {
  assert.ok(!readIndexHtml().includes('stats-menu-spark'), 'разметка без .stats-menu-spark');
  // Все модули приложения: ни ключа тренда, ни источников, ни рендера
  for (const file of getModuleOrder()) {
    const text = readProjectFile(file);
    assert.ok(!text.includes('statsMenuSpark'),
      file + ': API трендов пунктов удалён');
    assert.ok(!text.includes('renderStatsMenuSparks'),
      file + ': вызов рендера трендов удалён');
    assert.ok(!text.includes('stats-menu-spark'),
      file + ': селектор слота удалён');
  }
  // Спарклайны строк статистики остаются: слот меню — единственная жертва
  const statsView = readProjectFile('js/ui/stats-view.js');
  assert.match(statsView, /import \{ sparkValues, sparklineSvg \} from '\.\/sparkline\.js';/,
    'sparkline.js жив: линии строк статистики рисуются тем же кодом');
});

/* --- стили ---------------------------------------------------------------- */

test('menu: стили — значок не тянет ширину, шрифт и цвет пункта не тронуты', () => {
  // 2026-11-06: стили спарклайна слиты в stats.css (микро-файл <5 КБ),
  // правила переехали дословно — проверяем их там же
  const sparklineCss = readProjectFile('styles/stats.css');
  const emoji = ruleBody(sparklineCss, '.stats-menu-emoji');
  assert.ok(emoji, 'правило .stats-menu-emoji найдено');
  assert.match(emoji, /flex:\s*none/, 'значок не сжимается и не тянет строку');
  assert.match(emoji, /line-height:\s*1/, 'глиф держится по центру строки');
  // Размер наследуется от пункта, цвет не задаётся — новых литералов нет
  assert.ok(!/font-size|color|#/.test(emoji), 'шрифт и цвет значку не назначаются');
  assert.ok(!sparklineCss.includes('stats-menu-spark'), 'правила слота удалены');
  assert.match(sparklineCss, /\.stats-row-spark \{/, 'спарклайны строк статистики живы');
  assert.match(sparklineCss, /\.stats-row-spark \.spark-line \{/, 'линия строки жива');

  const mobileCss = readProjectFile('styles/mobile.css');
  const item = ruleBody(mobileCss, '\n  .stats-menu-item');
  assert.ok(item, 'правило .stats-menu-item найдено');
  assert.match(item, /gap:\s*12px/, 'gap повторяет вертикальный паддинг пункта');
  assert.match(item, /display:\s*flex/, 'пункт остаётся flex-строкой');
  assert.match(item, /align-items:\s*center/, 'значок по центру строки');
  assert.match(item, /padding:\s*12px 20px/, 'паддинг пункта не тронут');
  assert.match(item, /min-height:\s*44px/, 'высота тапа не тронута');
  assert.match(item, /font-size:\s*15px/, 'шрифт пункта не тронут');
  assert.match(item, /color:\s*var\(--text\)/, 'цвет текста — существующий токен');
  assert.match(item, /border-bottom:\s*1px solid var\(--separator\)/, 'разделитель списка на месте');
});

/* --- поведение ------------------------------------------------------------ */

test('menu: открытие панели работает без рендера и не пишет в localStorage', () => {
  const loaded = loadApp();
  const menu = { classList: { add() {}, remove() {}, contains() { return false; } } };
  const backdrop = { hidden: true };
  loaded.sandbox.document = {
    getElementById(id) {
      return id === 'stats-menu' ? menu : id === 'stats-menu-backdrop' ? backdrop : null;
    },
    addEventListener() {},
  };
  const before = JSON.stringify(loaded.sandbox.localStorage._dump());
  loaded.context.openStatsMenu();
  assert.ok(!backdrop.hidden, 'подложка показана');
  // Панель открыта, и записи в хранилище нет: меню теперь только показывает
  // пункты и не пересчитывает тренды на открытии
  assert.equal(JSON.stringify(loaded.sandbox.localStorage._dump()), before,
    'меню только читает разметку: ни нового ключа, ни записи');
});
