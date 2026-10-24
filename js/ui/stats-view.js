import { escapeHtml } from '../core/dom.js';
import { FAST_HISTORY_MIN, FAST_SOURCE_ADD, FAST_SOURCE_DONE, loadFast } from '../data/fast.js';
import { loadHabits } from '../data/habits.js';
import { loadQazaLog, qazaLogDoneByDay, qazaTotalRemaining } from '../data/qaza.js';
import { calcProgress, loadRecords } from '../data/records.js';
import { loadSleep, sleepAverageMinutes, sleepFormatDuration, sleepTimeLabel, sleepTimeMinutes } from '../data/sleep.js';
import { habitBestStreak, habitCurrentStreak, habitMarkedDays, habitsAveragePercent, loadStatsPeriod, qazaDoneOn, qazaStreak, statsPeriodDates } from '../data/stats.js';
import { ensureQazaState, getQazaState } from './qaza-view.js';
import { markStatsPeriod, setStatsValue, statsChartMarkup, statsHabitGridMarkup, statsSummaryMarkup } from './stats-helpers.js';
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
  // собранные: период у строки тот же, что у остальных цифр. Записи
  // excluded пропускаются целиком, значение дня — realSleepMin ?? sleepMin
  const sleep = loadSleep();
  let sleepValue = '—';
  if (sleep && sleep.history.length > 0) {
    const dayIndex = {};
    for (let i = 0; i < dates.length; i++) dayIndex[dates[i]] = i;

    let sum = 0;
    let count = 0;
    for (let i = 0; i < sleep.history.length; i++) {
      const entry = sleep.history[i];
      if (entry.excluded === true) continue;
      if (dayIndex[entry.date] === undefined) continue;
      sum += entry.realSleepMin ?? entry.sleepMin;
      count++;
    }
    if (count > 0) sleepValue = sleepFormatDuration(Math.round(sum / count));
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

  // Источник за день зависит от журнала (§5). Журнала нет — как было: поле h6
  // в записях дня, единственный свидетель каза за день. Журнал заведён — за
  // дни до since всё ещё h6, а с since и позже считает журнал: стек очереди
  // живёт только за сегодня, журнал же по датам не чистится
  const log = loadQazaLog();
  const logDone = qazaLogDoneByDay(log);

  let done = 0;
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    const count = log && dates[i] >= log.since
      ? (logDone[dates[i]] || 0)
      : qazaDoneOn(records, dates[i]);
    values.push(count);
    done += count;
  }

  ensureQazaState();
  const average = done / dates.length;

  const summary = document.getElementById('stats-qaza-summary');
  if (summary) {
    summary.innerHTML = statsSummaryMarkup([
      ['done', 'Выполнено за период', String(done)],
      ['average', 'Средний темп в день', average.toFixed(1).replace('.', ',')],
      ['streak', 'Текущая серия, дней', String(qazaStreak(records, today))],
      ['total', 'Общий остаток', String(qazaTotalRemaining(getQazaState()))],
    ]);
  }

  const chart = document.getElementById('stats-qaza-chart');
  if (chart) chart.innerHTML = statsChartMarkup(values);
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
  const dayIndex = {};
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    dayIndex[dates[i]] = i;
    values.push(0);
  }

  let done = 0;
  let added = 0;
  let since = null;

  for (let i = 0; i < fast.history.length; i++) {
    const event = fast.history[i];
    // Начало истории — по всей истории, а не по периоду: «с какого дня
    // копится» не должно меняться от выбранного окна
    if (since === null || event.date < since) since = event.date;

    const day = dayIndex[event.date];
    if (day === undefined) continue;
    if (event.source === FAST_SOURCE_DONE) {
      done += event.count;
      values[day] += event.count;
    } else if (event.source === FAST_SOURCE_ADD) {
      added += event.count;
    }
  }

  summary.innerHTML = statsSummaryMarkup([
    ['remaining', 'Остаток', String(fast.remaining)],
    ['done', 'Возмещено за период', String(done)],
    ['added', 'Добавлено за период', String(added)],
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
    chart.innerHTML = statsChartMarkup(values, 'Возмещено по дням');
    note.hidden = true;
  }
}
// Категория «Сон». Источник — история раздела «Цикл сна» (§11ab): форма её
// только пишет, читает раздел статистики. Пустых состояний два, и это разные
// вещи: истории нет вовсе — показывать нечего, истории нет за выбранное окно
// — данные есть, но не здесь. Средние отбоя и подъёма считает
// sleepAverageMinutes: у времени суток своя арифметика, и обычное среднее
// на ней врёт. Средний подъём — по полю actualWake, а не wake: в историю
// идёт то, что вышло на самом деле, а wake — цель
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
  const dayIndex = {};
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    dayIndex[dates[i]] = i;
    values.push(0);
  }

  // Записи периода. Одна запись на день — держит sleepHistoryEntry, — но
  // сумма на день, а не присваивание: вторая запись о том же дне сложилась бы
  // в значение дня, а не затёрла первую. Записи excluded пропускаются целиком:
  // человек сказал «не считать этот день», и он не должен попасть ни в средние,
  // ни в график, ни в счётчик
  const inPeriod = [];
  for (let i = 0; i < sleep.history.length; i++) {
    const entry = sleep.history[i];
    if (entry.excluded === true) continue;
    const day = dayIndex[entry.date];
    if (day === undefined) continue;
    inPeriod.push(entry);
    values[day] += entry.realSleepMin ?? entry.sleepMin;
  }

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

  // Оба конца ночи — время суток, и history их уже проверила при чтении:
  // каждое значение здесь число, а не null. Средний подъём — по факту
  // (realWake), если он задан, иначе по actualWake. Средняя длительность —
  // по realSleepMin, если он задан, иначе по sleepMin
  const bedMinutes = inPeriod.map(function (e) { return sleepTimeMinutes(e.bed); });
  const wakeMinutes = inPeriod.map(function (e) {
    return sleepTimeMinutes(e.realWake ?? e.actualWake);
  });

  let durationSum = 0;
  for (let i = 0; i < inPeriod.length; i++) {
    durationSum += inPeriod[i].realSleepMin ?? inPeriod[i].sleepMin;
  }
  const averageDuration = Math.round(durationSum / inPeriod.length);

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

  // Строка — кнопка, как строка хаба: <div> выпал бы из таб-навигации
  let markup = '';
  for (let i = 0; i < habits.length; i++) {
    const habit = habits[i];
    markup += '<li><button type="button" class="settings-row" data-habit-id="' +
      escapeHtml(habit.id) + '"><span>' + escapeHtml(habit.name) + '</span>' +
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
    if (habits[i].id === statsHabitId) habit = habits[i];
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
