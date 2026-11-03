import { addDays, parseISODate, toISODate } from '../core/dates.js';
import { escapeHtml } from '../core/dom.js';
import { sparkValues, sparklineSvg } from './sparkline.js';
import { fastHistorySince } from '../data/archive.js';
import { FAST_HISTORY_MIN, fastPeriodStats, loadFast } from '../data/fast.js';
import { loadHabits } from '../data/habits.js';
import { loadQazaLog, qazaDayCounts, qazaTotalRemaining } from '../data/qaza.js';
import { calcProgress, loadRecords } from '../data/records.js';
import { loadSleep, sleepAverageDurationMin, sleepAverageMinutes, sleepEntriesInPeriod, sleepFormatDuration, sleepMinutesByDay, sleepTimeLabel, sleepTimeMinutes, sleepWakeMinutes } from '../data/sleep.js';
import { STATS_PERIOD_BOXES, habitBestStreak, habitCurrentStreak, habitMarked, habitMarkedDays, habitsAveragePercent, loadStatsPeriod, qazaStreak, statsPeriodDates } from '../data/stats.js';
import { ensureQazaState, getQazaState } from './qaza-view.js';

// Дней в микро-тренде строки списка привычек. Две недели: за неделю линия
// состоит из одного ритма («в выходные не делаю») и выглядит трендом,
// которого нет; за месяц мелкие провалы сливаются в кашу.
const SPARK_DAYS = 14;

// Даты последних n дней, от самого старого к сегодня — тот порядок, в котором
// читается линия. toISODate даёт ключ хранилища, поэтому расчёт идёт по тем
// же дням, что и круги прогресса в таблице.
function lastDates(today, n) {
  const out = [];
  for (let back = n - 1; back >= 0; back--) out.push(toISODate(addDays(today, -back)));
  return out;
}
// Панель открыта — на панели класс is-open: по нему едет transform,
// а visibility снимается без задержки. Подложка отдельным элементом
// и гасится атрибутом hidden.
export function openStatsMenu() {
  const menu = document.getElementById('stats-menu');
  const backdrop = document.getElementById('stats-menu-backdrop');
  if (!menu || !backdrop) return;
  menu.classList.add('is-open');
  backdrop.hidden = false;
}
export function closeStatsMenu() {
  const menu = document.getElementById('stats-menu');
  const backdrop = document.getElementById('stats-menu-backdrop');
  if (!menu || !backdrop) return;
  menu.classList.remove('is-open');
  // Аккордеон категорий возвращается в свёрнутый вид: следующее открытие
  // панели не должно показывать чужое состояние. Работает для всех способов
  // закрытия — Escape, тап по подложке, выбор пункта: все они идут сюда
  menu.classList.remove('is-hub-open');
  const sub = document.getElementById('stats-hub-sub');
  if (sub) sub.hidden = true;
  const toggle = document.getElementById('stats-hub-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  backdrop.hidden = true;
}
// Открыта ли панель. Спрашивает Escape: он разбирает шторки по слоям
export function isStatsMenuOpen() {
  const menu = document.getElementById('stats-menu');
  return !!menu && menu.classList.contains('is-open');
}
// Экраны раздела «Статистика»: у них общий вход и общий возврат «Назад»
export function isStatsView(name) {
  return name === 'stats' || name === 'stats-qaza' || name === 'stats-habits' ||
    name === 'stats-habit' || name === 'stats-fast' || name === 'stats-sleep';
}
// Перерисовка экранов одной категории. Скрытые трогать незачем: их нарисует
// вход на экран (switchAppView)
export function renderStatsCategory(category) {
  if (category === 'hub') {
    renderStatsView();
  } else if (category === 'qaza') {
    renderStatsQazaView();
  } else if (category === 'habits') {
    renderStatsHabitsView();
    renderStatsHabitView();
  } else if (category === 'fast') {
    renderStatsFastView();
  } else if (category === 'sleep') {
    renderStatsSleepView();
  }
}
// Хаб: четыре строки. Цифры считаются по хранилищу, а не по appState:
// раздел открывается из Настроек, где состояние таблицы могло устареть.
export function renderStatsView() {
  markStatsPeriod('stats-period');

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('hub'), today);

  ensureQazaState();
  setStatsValue('#stats-list [data-stat="qaza"] .stats-row-value',
    qazaTotalRemaining(getQazaState()));

  // Сон — средняя длительность записи за период хаба. Дни берутся уже
  // собранные: период у строки тот же, что у остальных цифр. Отбор записей
  // и среднее — те же функции data-слоя, что у экрана «Сон»: одна формула
  // на обе цифры, а не две разошедшиеся
  const sleep = loadSleep();
  let sleepValue = '—';
  if (sleep && sleep.history.length > 0) {
    const entries = sleepEntriesInPeriod(sleep.history, dates);
    const avg = sleepAverageDurationMin(entries);
    sleepValue = avg === null ? '—' : sleepFormatDuration(avg);
  }
  setStatsValue('#stats-list [data-stat="sleep"] .stats-row-value', sleepValue);

  const fast = loadFast();
  setStatsValue('#stats-list [data-stat="fast"] .stats-row-value',
    fast ? fast.remaining : '—');

  const average = habitsAveragePercent(loadHabits(), dates);
  setStatsValue('#stats-list [data-stat="habits"] .stats-row-value',
    average === null ? '—' : Math.round(average) + '%');
}
export function renderStatsQazaView() {
  markStatsPeriod('stats-qaza-period');

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('qaza'), today);
  const records = loadRecords();

  // Источник за день — «журнал с since, до него поле h6» — решает data-слой:
  // qazaDayCounts отдаёт значения по дням и сумму, view только раскладывает
  // готовое по местам
  const log = loadQazaLog();
  const counts = qazaDayCounts(records, log, dates);

  ensureQazaState();
  const average = counts.total / dates.length;

  const summary = document.getElementById('stats-qaza-summary');
  if (summary) {
    summary.innerHTML = statsSummaryMarkup([
      ['done', 'Выполнено за период', String(counts.total)],
      ['average', 'Средний темп в день', average.toFixed(1).replace('.', ',')],
      ['streak', 'Текущая серия, дней', String(qazaStreak(records, today))],
      ['total', 'Общий остаток', String(qazaTotalRemaining(getQazaState()))],
    ]);
  }

  const chart = document.getElementById('stats-qaza-chart');
  if (chart) chart.innerHTML = statsChartMarkup(counts.values);
}
// Категория «Ураза». Источник — растущая история счётчика (§5): интерфейс
// уразы её только пишет, читает раздел статистики. Счётчика нет — ни цифр,
// ни графика: собрать их не из чего
export function renderStatsFastView() {
  markStatsPeriod('stats-fast-period');

  const summary = document.getElementById('stats-fast-summary');
  const chart = document.getElementById('stats-fast-chart');
  const note = document.getElementById('stats-fast-empty-note');
  if (!summary || !chart || !note) return;

  const fast = loadFast();
  if (!fast) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'Счётчик не заведён';
    note.hidden = false;
    return;
  }

  summary.hidden = false;

  const dates = statsPeriodDates(loadStatsPeriod('fast'), new Date());
  // Суммы, разбор по источникам и начало истории — арифметика data-слоя:
  // fastPeriodStats отдаёт значения по дням, суммы done/add и since,
  // view только раскладывает готовое по местам
  const stats = fastPeriodStats(fast, dates);
  // «История копится с» смотрит и в архив: детализация старше года срезана
  // в своды (js/data/archive.js), но начало истории — не сегодня минус год
  const since = fastHistorySince(fast);

  summary.innerHTML = statsSummaryMarkup([
    ['remaining', 'Остаток', String(fast.remaining)],
    ['done', 'Возмещено за период', String(stats.done)],
    ['added', 'Добавлено за период', String(stats.added)],
    ['since', 'История копится с', since === null ? '—' : since],
  ]);

  // Истории мало — вместо графика строка текста: три столбика на всю ширину
  // читались бы как «данных достаточно», хотя это ещё начало
  if (fast.history.length < FAST_HISTORY_MIN) {
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'История копится с ' + (since === null ? '—' : since) +
      '. Данных пока мало для графика';
    note.hidden = false;
  } else {
    chart.hidden = false;
    chart.innerHTML = statsChartMarkup(stats.values, 'Возмещено по дням');
    note.hidden = true;
  }
}
// Категория «Сон». Источник — история раздела «Цикл сна» (§11ab): форма её
// только пишет, читает раздел статистики. Пустых состояний два, и это разные
// вещи: истории нет вовсе — показывать нечего, истории нет за выбранное окно
// — данные есть, но не здесь. Арифметика периода — отбор годных записей,
// суммы по дням и средняя длительность — живёт в data/sleep.js: экран и
// строка хаба считают её одной формулой, а view только рендерит готовое.
// Средние отбоя и подъёма считает sleepAverageMinutes: у времени суток своя
// арифметика, и обычное среднее на ней врёт. Средний подъём — по полю
// actualWake, а не wake: в историю идёт то, что вышло на самом деле,
// а wake — цель
export function renderStatsSleepView() {
  markStatsPeriod('stats-sleep-period');

  const sleep = loadSleep();
  const summary = document.getElementById('stats-sleep-summary');
  const chart = document.getElementById('stats-sleep-chart');
  const note = document.getElementById('stats-sleep-empty-note');
  if (!summary || !chart || !note) return;

  if (!sleep || sleep.history.length === 0) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'Истории сна нет';
    note.hidden = false;
    return;
  }

  const dates = statsPeriodDates(loadStatsPeriod('sleep'), new Date());
  // Годные записи периода отбирает data-слой: excluded и дни вне окна до
  // сюда не доходят — то же правило, по которому хаб считает свою строку
  const inPeriod = sleepEntriesInPeriod(sleep.history, dates);

  if (inPeriod.length === 0) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'За выбранный период записей нет';
    note.hidden = false;
    return;
  }

  summary.hidden = false;

  // Суммы по дням — для графика, средняя длительность — для сводки: обе
  // цифры считаются в data-слое, view только раскладывает их по местам
  const values = sleepMinutesByDay(sleep.history, dates);
  const averageDuration = sleepAverageDurationMin(inPeriod);

  // Оба конца ночи — время суток, и history их уже проверила при чтении:
  // каждое значение здесь число, а не null. Средний подъём — по факту,
  // если он задан, иначе по плану: правило «факт ?? план» берётся из
  // data-слоя (sleepWakeMinutes), как и вся арифметика раздела. Это среднее
  // точки на циферблате — средняя длительность считается отдельно, в data-слое
  const bedMinutes = inPeriod.map(function (e) { return sleepTimeMinutes(e.bed); });
  const wakeMinutes = inPeriod.map(function (e) {
    return sleepTimeMinutes(sleepWakeMinutes(e));
  });

  const averageBed = sleepAverageMinutes(bedMinutes);
  const averageWake = sleepAverageMinutes(wakeMinutes);

  summary.innerHTML = statsSummaryMarkup([
    ['bed',     'Средний отбой',        averageBed === null ? '—' : sleepTimeLabel(averageBed)],
    ['wake',    'Средний подъём',       averageWake === null ? '—' : sleepTimeLabel(averageWake)],
    ['average', 'Средняя длительность', sleepFormatDuration(averageDuration)],
    ['count',   'Записей за период',    String(inPeriod.length)],
  ]);

  chart.hidden = false;
  chart.innerHTML = statsChartMarkup(values, 'Длительность сна по дням');
  note.hidden = true;
}
// Выбранная привычка. Живёт только в интерфейсе: список обнуляет её при входе,
// строка списка ставит своё значение перед показом карточки
export let statsHabitId = null;
// Список привычек. Процент за период — calcProgress, и это же делает «0%»
// при полном отсутствии записей: пустой день даёт ноль, ветка «—» не нужна
export function renderStatsHabitsView() {
  markStatsPeriod('stats-habits-period');

  const list = document.getElementById('stats-habits-list');
  if (!list) return;

  const dates = statsPeriodDates(loadStatsPeriod('habits'), new Date());
  const habits = loadHabits();
  // Спарклайн — за последние SPARK_DAYS дней НЕЗАВИСИМО от выбранного периода:
  // процент справа уже отвечает на «как за период», а микро-тренд нужен на
  // вопрос «что с этим происходит в последние две недели». Один и тот же
  // период дал бы линию, повторяющую цифру, и строка стала бы шумом.
  const sparkDates = lastDates(new Date(), SPARK_DAYS);

  // Строка — кнопка, как строка хаба: <div> выпал бы из таб-навигации
  let markup = '';
  for (let i = 0; i < habits.length; i++) {
    const habit = habits[i];
    const spark = sparklineSvg(sparkValues(sparkDates, d => calcProgress(habit, [d])), {
      label: habit.name + ', тренд за ' + SPARK_DAYS + ' дней',
    });
    markup += '<li><button type="button" class="settings-row" data-habit-id="' +
      escapeHtml(habit.id) + '"><span>' + escapeHtml(habit.name) + '</span>' +
      '<span class="stats-row-spark" aria-hidden="false">' + spark + '</span>' +
      '<span class="stats-row-value">' + escapeHtml(Math.round(calcProgress(habit, dates))) +
      '%</span></button></li>';
  }
  list.innerHTML = markup;
}
// Карточка одной привычки. Без выбранного id рисовать нечего: экран
// открывается только тапом по строке списка
export function renderStatsHabitView() {
  if (statsHabitId === null) return;

  markStatsPeriod('stats-habit-period');

  // Список читается из хранилища, как в хабе: раздел открывают из Настроек,
  // где состояние таблицы могло устареть
  const habits = loadHabits();
  let habit = null;
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === statsHabitId) { habit = habits[i]; break; }
  }
  if (!habit) return;

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('habits'), today);

  const title = document.getElementById('stats-habit-title');
  if (title) title.textContent = habit.name;

  const summary = document.getElementById('stats-habit-summary');
  if (summary) {
    summary.innerHTML = statsSummaryMarkup([
      ['average', 'Средний процент за период', Math.round(calcProgress(habit, dates)) + '%'],
      ['streak', 'Текущая серия, дней', String(habitCurrentStreak(habit, today))],
      ['best', 'Лучшая серия за период, дней', String(habitBestStreak(habit, dates))],
      ['marks', 'Всего отметок за период', String(habitMarkedDays(habit, dates).length)],
    ]);
  }

  const values = [];
  for (let i = 0; i < dates.length; i++) values.push(calcProgress(habit, [dates[i]]));

  const chart = document.getElementById('stats-habit-chart');
  if (chart) chart.innerHTML = statsChartMarkup(values, 'Отметки по дням');

  const grid = document.getElementById('stats-habit-grid');
  if (grid) {
    grid.innerHTML = statsHabitGridMarkup(habit, dates);
    // Свежие отметки лежат справа: без этого «Всё время» открывалось бы
    // на неделях пустоты, а сегодняшний край оставался за кадром
    grid.scrollLeft = grid.scrollWidth;
  }
}

// Выбранная привычка карточки принадлежит этому модулю; выбор ставит
// список (вход) и строка списка (тап) — им accessor, как у казы.
export function setStatsHabitId(value) {
  statsHabitId = value;
}

// Хелперы разметки и точечных DOM-правок экранов статистики. Жили отдельным
// файлом (stats-helpers.js), но использовались только этим модулем — слиты
// сюда (этап Y5).
// Строка цифр: подпись слева, значение справа — тем же .settings-row,
// что и список хаба. data-stat нужен проверкам, разметку не украшает.
function statsSummaryMarkup(rows) {
  return rows.map(function (row) {
    return '<p class="settings-row" data-stat="' + escapeHtml(row[0]) + '">' +
      '<span>' + escapeHtml(row[1]) + '</span>' +
      '<span class="stats-row-value">' + escapeHtml(row[2]) + '</span></p>';
  }).join('');
}
// Столбики по дням: высота — значение дня. Строка SVG собирается вручную
// через innerHTML, как circleMarkup; библиотек нет (§4). Подпись — второй
// параметр: у каза и у привычек она своя, а рисование одно и то же.
function statsChartMarkup(values, label) {
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
function markStatsPeriod(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const period = loadStatsPeriod(STATS_PERIOD_BOXES[boxId]);
  box.querySelectorAll('.view-switch-btn').forEach(function (btn) {
    btn.classList.toggle('is-active', btn.getAttribute('data-period') === period);
  });
}
function setStatsValue(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}
// Календарь-сетка: колонка — неделя (понедельник сверху), строка — день недели.
// Клетки одинаковые и заданы в пикселях, поэтому ширина сетки растёт вместе
// с числом недель, а не подгоняется под экран: на телефоне её прокручивает
// контейнер. Новых переменных палитры нет — цвета берёт §9
function statsHabitGridMarkup(habit, dates) {
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
