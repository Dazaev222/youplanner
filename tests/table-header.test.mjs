// Шапка таблицы привычек: <th> обязан иметь scope (находка 2 очереди
// постаничного аудита).
//
// why: <thead> в index.html пуст — разметку шапки строит renderTable() из
// js/ui/main-table.js, поэтому проверяется генератор, а не статичная
// разметка. Таблица — данные (строки — привычки, столбцы — дни недели), а не
// раскладка: без scope скринридер читает ячейку как «12.09  5» и человек
// теряет, к какому дню и какой привычке относится число.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { readIndexHtml } from './helpers/sources.mjs';

function renderHeaderHtml() {
  const app = loadApp();
  const created = [];
  const replaced = [];

  app.sandbox.document.createElement = function (tag) {
    const el = { tagName: tag, innerHTML: '', content: { nodeType: 11 } };
    created.push(el);
    return el;
  };
  app.sandbox.document.getElementById = function (id) {
    if (id !== 'habits-thead' && id !== 'habits-tbody') return null;
    return {
      _id: id,
      replaceChildren: function (node) { replaced.push({ id: id, node: node }); },
    };
  };

  app.run(`
    appState.weekStart = getWeekStart(new Date());
    appState.habits = loadHabits();
    renderTable();
  `);

  const template = created.find((el) => el.innerHTML.indexOf('<th') !== -1);
  assert.ok(template, 'renderTable обязан собрать шапку таблицы через template');
  assert.equal(replaced.filter((r) => r.id === 'habits-thead').length, 1,
    'шапка вставлена в thead одной операцией');
  return template.innerHTML;
}

test('шапка таблицы: каждый <th> имеет scope="col"', () => {
  const thead = renderHeaderHtml();
  const tags = thead.match(/<th\b[^>]*>/g) || [];
  assert.ok(tags.length >= 3, 'в шапке есть столбцы привычки, дней и прогресса: ' + tags.length);
  for (const tag of tags) {
    assert.match(tag, /scope="col"/, 'без scope скринридер не скажет, чей это столбец: ' + tag);
  }
});

test('таблица привычек — данные, а не раскладка: в разметке есть thead и tbody', () => {
  const html = readIndexHtml();
  const table = html.slice(html.indexOf('<table id="habits-table"'), html.indexOf('</table>'));
  assert.match(table, /<thead id="habits-thead">/, 'шапка отделена от тела');
  assert.match(table, /<tbody id="habits-tbody">/, 'тело — строки данных');
  // Статичных <th> в index.html нет: их генерирует renderTable, и проверка
  // выше — единственное место, где шапка существует по-настоящему
  assert.equal((table.match(/<th\b/g) || []).length, 0,
    'разметка файла не дублирует генерируемую шапку');
});
