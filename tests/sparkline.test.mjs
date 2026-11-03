// Спарклайн: чистая функция «числа → SVG».
//
// Проверяется то, из-за чего график обычно и ломают: количество точек,
// прижим к потолку шкалы, поведение пустого и одиночного ряда, экранирование
// подписи и то, что пустой тренд НЕ выглядит уверенным нулём.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

function coords(svg) {
  const m = /points="([^"]+)"/.exec(svg || '');
  return m ? m[1].trim().split(/\s+/) : [];
}

test('ряд из n значений даёт n точек', (t) => {
  const { context: ctx } = loadApp();
  const svg = ctx.sparklineSvg([0.2, 0.5, 0.1, 0.9], { width: 72, height: 20 });
  assert.equal(coords(svg).length, 4);
  assert.match(svg, /^<svg class="spark"/);
  assert.match(svg, /<polyline class="spark-line"/);
  assert.match(svg, /<path class="spark-area"/);
  assert.match(svg, /<circle class="spark-dot"/);
});

test('пустой ряд рисуется, а не роняет строку меню', (t) => {
  const { context: ctx } = loadApp();
  const svg = ctx.sparklineSvg([], { label: 'пусто' });
  assert.match(svg, /^<svg/);
  assert.equal(coords(svg).length, 0);
  assert.ok(!svg.includes('<polyline'), 'линии из нуля точек быть не должно');
  assert.ok(!svg.includes('<circle'), 'точки последнему дню взяться неоткуда');
});

test('одинокое значение — точка, а не линия нулевой длины', (t) => {
  const { context: ctx } = loadApp();
  const svg = ctx.sparklineSvg([0.5]);
  assert.ok(!svg.includes('<polyline'), 'один сегмент ломаной — это не тренд');
  assert.match(svg, /<circle class="spark-dot"/, 'одиночное значение рисуется точкой');
  assert.ok(!svg.includes('NaN'), svg);
});

test('значения за шкалой прижимаются к потолку, а не улетают за viewBox', (t) => {
  const { context: ctx } = loadApp();
  const g = ctx.sparklinePoints([5, -3, 0.5], { height: 20, pad: 2, ceiling: 1 });
  const ys = g.points.split(' ').map(pair => Number(pair.split(',')[1]));
  assert.equal(ys[0], 2, 'максимум = верхняя граница');
  assert.equal(ys[1], 18, 'минимум = нижняя граница');
  assert.ok(ys.every(y => y >= 2 && y <= 18), JSON.stringify(ys));
});

test('не-числа в ряду становятся нулём, а не NaN в разметке', (t) => {
  const { context: ctx } = loadApp();
  const svg = ctx.sparklineSvg([0.4, undefined, 'x', null, NaN]);
  assert.ok(!svg.includes('NaN'), svg);
  assert.equal(coords(svg).length, 5);
});

test('пустой тренд помечается is-flat', (t) => {
  const { context: ctx } = loadApp();
  const flat = ctx.sparklineSvg([0, 0, 0]);
  assert.match(flat, /class="spark is-flat"/, 'нулевая линия не должна выглядеть трендом');
  const live = ctx.sparklineSvg([0, 0.3, 0]);
  assert.ok(!/is-flat/.test(live), 'одна отметка — уже не пусто');
});

test('подпись экранируется: пользовательский текст не становится разметкой', (t) => {
  const { context: ctx } = loadApp();
  const svg = ctx.sparklineSvg([0.1, 0.2], { label: '</title><img src=x onerror=alert(1)>' });
  assert.ok(!svg.includes('<img'), svg);
  assert.ok(svg.includes('&lt;img'), 'знаки должны остаться текстом');
});

test('sparkValues читает ряд через переданный счётчик и режет по шкале', (t) => {
  const { context: ctx } = loadApp();
  const seen = [];
  const values = ctx.sparkValues(['2026-11-01', '2026-11-02'], (d) => {
    seen.push(d);
    return d === '2026-11-02' ? 1.7 : -0.4;
  });
  assert.deepEqual(seen, ['2026-11-01', '2026-11-02'], 'порядок дат сохраняется');
  assert.deepEqual(values, [0, 1], 'всё, что вне 0..1, прижимается к шкале');
  // plain(): пустой ряд — массив из реалма песочницы, а deepStrictEqual сверяет
  // prototypes и на «одинаковых» [] из разных реалмов падает на ровном месте.
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.sparkValues(['a'], null))), [],
    'без счётчика ряда нет');
});
