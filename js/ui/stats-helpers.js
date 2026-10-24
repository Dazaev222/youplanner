import { parseISODate } from '../core/dates.js';
import { escapeHtml } from '../core/dom.js';
import { STATS_PERIOD_BOXES, habitMarked, loadStatsPeriod } from '../data/stats.js';
// Строка цифр: подпись слева, значение справа — тем же .settings-row,
// что и список хаба. data-stat нужен проверкам, разметку не украшает.
export function statsSummaryMarkup(rows) {
  return rows.map(function (row) {
    return '<p class="settings-row" data-stat="' + escapeHtml(row[0]) + '">' +
      '<span>' + escapeHtml(row[1]) + '</span>' +
      '<span class="stats-row-value">' + escapeHtml(row[2]) + '</span></p>';
  }).join('');
}
// Столбики по дням: высота — значение дня. Строка SVG собирается вручную
// через innerHTML, как circleMarkup; библиотек нет (§4). Подпись — второй
// параметр: у каза и у привычек она своя, а рисование одно и то же.
export function statsChartMarkup(values, label) {
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > max) max = values[i];
  }
  if (max <= 0) return '';

  // 94, а не 100: самый высокий столбик не должен упираться в верх графика
  let bars = '';
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0) continue;
    // Минимум 2 единицы: день с одним каза иначе был бы не виден
    const height = Math.max(2, Math.round(values[i] / max * 94));
    bars += '<rect x="' + i + '" y="' + (100 - height) + '" width="0.7" height="' +
      height + '"></rect>';
  }

  return '<svg viewBox="0 0 ' + values.length + ' 100" preserveAspectRatio="none" ' +
    'role="img" aria-label="' + escapeHtml(label || 'Каза по дням') + '">' + bars + '</svg>';
}
// Подсветка выбранного периода. Период читается для категории этого блока:
// у каждой свой. Разметка кнопок статична, поэтому пересобирать её не нужно —
// как у переключателя «День / Неделя»
export function markStatsPeriod(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const period = loadStatsPeriod(STATS_PERIOD_BOXES[boxId]);
  box.querySelectorAll('.view-switch-btn').forEach(function (btn) {
    btn.classList.toggle('is-active', btn.getAttribute('data-period') === period);
  });
}
export function setStatsValue(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}
// Календарь-сетка: колонка — неделя (понедельник сверху), строка — день недели.
// Клетки одинаковые и заданы в пикселях, поэтому ширина сетки растёт вместе
// с числом недель, а не подгоняется под экран: на телефоне её прокручивает
// контейнер. Новых переменных палитры нет — цвета берёт §9
export function statsHabitGridMarkup(habit, dates) {
  if (!dates || dates.length === 0) return '';

  const CELL = 10;
  const GAP = 2;
  const STEP = CELL + GAP;

  // Сдвиг первого дня от понедельника: 0 — понедельник, 6 — воскресенье
  const offset = (parseISODate(dates[0]).getDay() + 6) % 7;
  const weeks = Math.ceil((offset + dates.length) / 7);

  let cells = '';
  for (let i = 0; i < dates.length; i++) {
    const slot = offset + i;
    cells += '<rect class="stats-grid-day' +
      (habitMarked(habit, dates[i]) ? ' is-on' : '') +
      '" x="' + Math.floor(slot / 7) * STEP + '" y="' + slot % 7 * STEP +
      '" width="' + CELL + '" height="' + CELL + '" rx="2"></rect>';
  }

  return '<svg width="' + (weeks * STEP - GAP) + '" height="' + (7 * STEP - GAP) +
    '" role="img" aria-label="Отметки по дням">' + cells + '</svg>';
}
