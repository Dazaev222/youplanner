/* Спарклайн — маленькая линия тренда в строках меню статистики.

   SVG, а не canvas: все графики приложения уже SVG (`js/ui/stats-view.js`,
   `js/ui/sleep-view.js`, круги в `js/ui/main-table.js`), и это не мода, а
   следствие того, что линия обязана масштабироваться вместе с текстом и
   печататься в PDF без растрирования. Canvas добавил бы второй слой,
   devicePixelRatio и отдельную перерисовку на resize — ровно то, чего
   семантике «12 точек на строку меню» не нужно.

   Функция чистая: строки на вход, строка SVG на выход — тестируется без DOM
   и без документа (см. tests/sparkline.test.mjs). */

import { escapeHtml } from '../core/dom.js';

export const SPARK_DEFAULT = {
  width: 72,
  height: 20,
  pad: 2,
  // Максимум в шкале: 100% прогресса. Передаётся, потому что у привычки с
  // goal = 3 «3» — это уже потолок, а не треть.
  ceiling: 1,
};

// Ряд → числа. Не-числа становятся нулём: в SVG-разметке им взяться неоткуда,
// а `NaN` в атрибуте молча обнулил бы всю ломаную.
function toValues(values) {
  return (Array.isArray(values) ? values : []).map(v => (Number.isFinite(v) ? v : 0));
}

// Значения → ломаная. Пустой список и один элемент рисуются осознанно:
// пустая строка меню без точки выглядит сломанной, поэтому одна точка
// становится точкой, а не линией нулевой длины.
export function sparklinePoints(values, options) {
  const opts = Object.assign({}, SPARK_DEFAULT, options || {});
  const list = toValues(values);
  if (!list.length) return { points: '', area: '', last: null, width: opts.width, height: opts.height };

  const innerW = Math.max(1, opts.width - opts.pad * 2);
  const innerH = Math.max(1, opts.height - opts.pad * 2);
  const ceiling = opts.ceiling > 0 ? opts.ceiling : 1;
  const step = list.length > 1 ? innerW / (list.length - 1) : 0;

  const coords = list.map((v, i) => {
    const x = opts.pad + (list.length > 1 ? i * step : innerW / 2);
    const clamped = Math.max(0, Math.min(ceiling, v));
    const y = opts.pad + innerH - (clamped / ceiling) * innerH;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });

  const points = coords.map(c => c.join(',')).join(' ');
  const baseline = opts.pad + innerH;
  const area = coords.length > 1
    ? opts.pad + ',' + baseline + ' ' + points + ' ' + (opts.pad + innerW) + ',' + baseline
    : '';
  return {
    points,
    area,
    last: coords[coords.length - 1],
    width: opts.width,
    height: opts.height,
    pad: opts.pad,
    innerH,
  };
}

// Готовый <svg> строкой. `label` — доступное имя тренда: без него скринридер
// читает ряд меню как «пусто», а смысл строки именно в форме линии.
export function sparklineSvg(values, options) {
  const opts = Object.assign({}, SPARK_DEFAULT, options || {});
  const g = sparklinePoints(values, opts);
  const title = opts.label
    ? '<title>' + escapeHtml(opts.label) + '</title>'
    : '';
  const area = g.area
    ? '<path class="spark-area" d="M' + g.area.replace(/ /g, ' L') + ' Z"/>'
    : '';
  const dot = g.last
    ? '<circle class="spark-dot" cx="' + g.last[0] + '" cy="' + g.last[1] + '" r="1.8"/>'
    : '';
  const line = g.points && g.points.indexOf(' ') >= 0
    ? '<polyline class="spark-line" points="' + g.points + '"/>'
    : '';
  // Пустой тренд (всё по нулям) не должен выглядеть как «держим ноль
  // уверенно»: без данных линия серая и без точки-«последнего дня».
  const flat = toValues(values).every(v => v === 0);
  return '<svg class="spark' + (flat ? ' is-flat' : '') + '" viewBox="0 0 '
    + g.width + ' ' + g.height
    + '" width="' + g.width + '" height="' + g.height + '" focusable="false"'
    + '>' + title + area + line + dot + '</svg>';
}

// Ряд за N последних дней по той же шкале, что и круги прогресса в таблице:
// один день = calcProgress по одному дню, то есть непроставленный день даёт
// 0, а не «дырку» в линии (см. js/data/stats.js, habitMarked).
export function sparkValues(dates, progressFor) {
  const list = Array.isArray(dates) ? dates : [];
  if (typeof progressFor !== 'function') return [];
  return list.map(d => {
    const p = progressFor(d);
    return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0;
  });
}
