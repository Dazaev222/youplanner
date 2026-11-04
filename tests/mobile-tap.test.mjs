// Мобильные тап-цели (находка 1 очереди постаничного аудита): размеры из
// styles/mobile.css.
//
// Живая геометрия меряется в браузере — tests/mobile-tap.browser.mjs (запуск
// отдельный, как у tests/matrix-layout.browser.mjs: fake DOM не считает CSS).
// Здесь — дешёвая структурная броня внутри общего прогона: правка размеров в
// мобильном блоке не должна молча вернуть компактные контролы там, где они
// являются основной целью нажатия.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles/mobile.css', import.meta.url), 'utf8');

// Правило ищется с отступом строки: глобальный `.btn` тоже даёт 44 px, но
// именно правило по классу/id перебивает его, и брать надо его.
function rule(selector) {
  const start = css.indexOf('\n  ' + selector + ' {');
  assert.ok(start >= 0, 'правило ' + selector + ' не найдено в styles/mobile.css');
  return css.slice(start, css.indexOf('}', start));
}

function px(block, property) {
  const m = block.match(new RegExp(property + ':\\s*(\\d+(?:\\.\\d+)?)px'));
  return m ? parseFloat(m[1]) : null;
}

// Высота цели: min-height важнее height (поля задаются именно им), но если
// задан только height — считаем его.
function heightOf(block) {
  const min = px(block, 'min-height');
  return min === null ? px(block, 'height') : min;
}

test('карточка дня: галочка и «✗» — тап-цель 44×44', () => {
  for (const selector of ['.day-card .cell-check', '.day-card .cell-x']) {
    const block = rule(selector);
    assert.deepEqual([px(block, 'width'), px(block, 'height')], [44, 44],
      selector + ': нужно 44×44, сейчас ' +
      [px(block, 'width'), px(block, 'height')].join('×'));
  }
});

test('карточка дня: поля значения и кнопка уровня — не короче 44px', () => {
  for (const selector of ['.day-card .cell-number', '.day-card .cell-select',
    '.day-card .cell-level-btn']) {
    const block = rule(selector);
    const height = heightOf(block);
    assert.ok(height !== null && height >= 44,
      selector + ': высота ' + height + ' px ниже тап-цели в 44 px');
  }
});

test('навигация и отправка: стрелки недель, переходы каза, отправка чата — 44px', () => {
  assert.ok(px(rule('#week-nav .btn'), 'min-width') >= 44,
    'стрелки ‹ и › — единственный способ листать недели: по ширине не меньше 44px');

  const headStart = css.indexOf('#prayer-btn,');
  assert.ok(headStart >= 0, 'правило переходов раздела каза найдено');
  const head = css.slice(headStart, css.indexOf('}', headStart));
  assert.ok(heightOf(head) >= 44,
    '«Молитвы» и «Ураза» — главный переход раздела: min-height ' + heightOf(head) + ' px');

  const send = rule('#assistant-send');
  assert.deepEqual([px(send, 'width'), px(send, 'height')], [44, 44],
    'отправка — главное действие чата: тап-цель 44×44');
});

test('правка не залезла в таблицу недели: мелкие контролы остались табличными', () => {
  // Колонка таблицы на 320 px — 39.5 px, и целью нажатия там служит весь
  // td.cell: разгон галочки до 44 px сломал бы строку. Оставлено как есть,
  // поэтому табличные правила обязаны остаться компактными.
  assert.ok(px(rule('#habits-table .cell-level-btn'), 'width') <= 24,
    'кнопка уровня в таблице не выросла до карточной');
  assert.ok(px(rule('.cell-check'), 'width') <= 20,
    'галочка таблицы осталась табличного размера');
});
