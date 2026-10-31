import { addDays, getMonthDatesToToday, getWeekStart, toISODate } from '../core/dates.js';
import { QAZA_HABIT_ID } from '../data/qaza.js';
import { cloudReachable, cloudReady } from '../sync/sync.js';
import { qazaCellMarkup } from './qaza-view.js';
import { appState, isMainDayView, isMobileView, ui } from './state.js';
import { openLevelSheet } from './level-sheet.js';
import { CIRCLE_CENTER, CIRCLE_LENGTH, CIRCLE_RADIUS, CIRCLE_SIZE, MONTHS_GENITIVE, MONTHS_NOMINATIVE, MONTHS_SHORT } from './constants.js';
import { LEVEL_LATE, LEVEL_ON_TIME, LEVEL_TWO_MIN, QURAN_HABIT_ID, SPORT_VALUES, SPORT_VALUE_LABELS, calcProgress, defaultLevel, getEntry, getRecord, habitMarkDate, hasLevelPopup, isChoiceLevelHabit, isLevelHabit, writeHabitEntry } from '../data/records.js';
import { cssEscape, escapeHtml, pad2 } from '../core/dom.js';
import { CHOICE_OPTIONS, loadHabits } from '../data/habits.js';
// Привычка из текущего состояния по id
export function findHabit(habitId) {
  for (let i = 0; i < appState.habits.length; i++) {
    if (appState.habits[i].id === habitId) return appState.habits[i];
  }
  return null;
}
// Даты отображаемой недели: понедельник и шесть следующих дней
export function getWeekDates(weekStart) {
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(toISODate(addDays(weekStart, i)));
  return dates;
}
// Прогресс привычки за отображаемую неделю. Знаменатель всегда 7 дней,
// поэтому с каждым новым понедельником круг естественно обнуляется.
export function weekPercent(habit) {
  const weekStart = appState.weekStart;
  if (!weekStart) return 0;
  return calcProgress(habit, getWeekDates(weekStart));
}
// Прогресс привычки за месяц: с 1-го числа по сегодня включительно
export function monthPercent(habit) {
  const weekStart = appState.weekStart;
  if (!weekStart) return 0;
  const dates = getMonthDatesToToday(weekStart.getFullYear(), weekStart.getMonth());
  return calcProgress(habit, dates);
}
// Класс границы поля отметки по уровню записи (§1.5). Уровня нет — класс
// не ставится, и поле остаётся с обычной рамкой --border.
export function levelClass(level) {
  if (level === LEVEL_ON_TIME) return ' is-on-time';
  if (level === LEVEL_LATE) return ' is-late';
  if (level === LEVEL_TWO_MIN) return ' is-two-min';
  return '';
}
// Маленькая кнопка вызова попапа уровня — только у Корана (§1.2)
export function levelButtonMarkup(habit, date) {
  const entry = getEntry(date, habit.id);
  const isSet = entry && entry.level ? ' is-set' : '';
  return '<button type="button" class="cell-level-btn' + isSet + '"' +
    ' data-habit-id="' + escapeHtml(habit.id) + '"' +
    ' data-date="' + escapeHtml(date) + '" aria-label="Как выполнено">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
    ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 9l6 6 6-6"></path></svg></button>';
}
// Разметка одной ячейки дня: <td class="cell" data-habit-id data-date>…</td>
export function cellMarkup(habit, date) {
  const entry = getEntry(date, habit.id);
  const value = entry ? entry.value : undefined;
  const dataAttrs = ' data-habit-id="' + escapeHtml(habit.id) + '"' +
    ' data-date="' + escapeHtml(date) + '"';
  let inner = '';

  if (habit.type === 'boolean') {
    // Чекбокс = true, кнопка «✗» = false, пусто = записи нет
    const checked = value === true ? ' checked' : '';
    const xActive = value === false ? ' is-active' : '';
    inner =
      '<input type="checkbox" class="cell-check"' + dataAttrs + checked +
      ' aria-label="Выполнено">' +
      '<button type="button" class="cell-x' + xActive + '"' + dataAttrs +
      ' aria-label="Не выполнено">✗</button>';
  } else if (habit.id === QAZA_HABIT_ID) {
    // Каза ведётся во вкладке «Каза-намазы», ячейка только показывает счётчик дня
    inner = qazaCellMarkup(date);
  } else if (habit.id === QURAN_HABIT_ID) {
    // Коран: инпут + кнопка уровня (как у обычной числовой привычки)
    const text = typeof value === 'number' ? String(value) : '';
    const withButton = hasLevelPopup(habit.id);
    inner = '<input type="number" class="cell-number' +
      levelClass(entry ? entry.level : null) + (withButton ? ' has-level-btn' : '') +
      '" min="0" step="1"' + dataAttrs +
      ' value="' + escapeHtml(text) + '" aria-label="Значение">';
    if (withButton) inner += levelButtonMarkup(habit, date);
  } else if (habit.type === 'number') {
    const text = typeof value === 'number' ? String(value) : '';
    // Класс нужен только мобильному медиа-запросу: там поле делит ширину
    // колонки с кнопкой попапа, иначе кнопка уезжает на вторую строку
    const withButton = hasLevelPopup(habit.id);
    inner = '<input type="number" class="cell-number' +
      levelClass(entry ? entry.level : null) + (withButton ? ' has-level-btn' : '') +
      '" min="0" step="1"' + dataAttrs +
      ' value="' + escapeHtml(text) + '" aria-label="Значение">';
    if (withButton) inner += levelButtonMarkup(habit, date);
  } else {
    const current = typeof value === 'string' ? value : '';
    inner = '<select class="cell-select' +
      levelClass(entry ? entry.level : null) + '"' + dataAttrs + ' aria-label="Значение">' +
      choiceOptionsMarkup(current, habit.id) + '</select>';
  }

  return '<td class="cell"' + dataAttrs + '>' + inner + '</td>';
}
// SVG-круг прогресса. percent — недельный процент (может быть больше 100),
// дуга при этом обрезается по 100%. monthPct — месячный процент, выводится
// второй строкой внутри круга.
export function circleMarkup(percent, habitId, monthPct) {
  const raw = Number(percent);
  const safe = isFinite(raw) ? raw : 0;
  const clamped = Math.min(Math.max(safe, 0), 100);
  const dashoffset = CIRCLE_LENGTH * (1 - clamped / 100);
  // Цвет ставим инлайновым стилем, чтобы он перебивал возможные правила CSS
  const strokeStyle = safe >= 100 ? 'stroke:var(--success)' : 'stroke:var(--accent)';
  const label = Math.round(safe) + '%';

  const monthRaw = Number(monthPct);
  const monthLabel = 'М: ' + Math.round(isFinite(monthRaw) ? monthRaw : 0) + '%';

  const idAttr = habitId === null || habitId === undefined
    ? '' : ' data-habit-id="' + escapeHtml(habitId) + '"';

  return '<svg class="progress-circle" viewBox="0 0 ' + CIRCLE_SIZE + ' ' + CIRCLE_SIZE + '"' +
    ' width="' + CIRCLE_SIZE + '" height="' + CIRCLE_SIZE + '"' +
    ' role="img" aria-label="Неделя ' + escapeHtml(label) +
    ', месяц ' + escapeHtml(monthLabel) + '"' + idAttr + '>' +
    '<circle class="progress-track" cx="' + CIRCLE_CENTER + '" cy="' + CIRCLE_CENTER + '"' +
    ' r="' + CIRCLE_RADIUS + '" fill="none" stroke="var(--border)" stroke-width="5"></circle>' +
    '<circle class="progress-arc" cx="' + CIRCLE_CENTER + '" cy="' + CIRCLE_CENTER + '"' +
    ' r="' + CIRCLE_RADIUS + '" fill="none" stroke-width="5" stroke-linecap="round"' +
    ' style="' + strokeStyle + '"' +
    ' stroke-dasharray="' + CIRCLE_LENGTH.toFixed(3) + '"' +
    ' stroke-dashoffset="' + dashoffset.toFixed(3) + '"' +
    ' transform="rotate(-90 ' + CIRCLE_CENTER + ' ' + CIRCLE_CENTER + ')"></circle>' +
    '<text x="' + CIRCLE_CENTER + '" y="27" class="progress-text" text-anchor="middle"' +
    ' dominant-baseline="central">' + escapeHtml(label) + '</text>' +
    '<text x="' + CIRCLE_CENTER + '" y="41" class="progress-month" text-anchor="middle"' +
    ' dominant-baseline="central">' + escapeHtml(monthLabel) + '</text>' +
    '</svg>';
}
// Подпись недели: «Сентябрь 2026 · 7–13 сентября» либо
// «31 авг – 6 сент 2026», если неделя пересекает границу месяца.
export function renderHeader() {
  const label = document.getElementById('week-label');
  if (!label || !appState.weekStart) return;

  const weekStart = appState.weekStart;
  const weekEnd = addDays(weekStart, 6);
  const dayStart = weekStart.getDate();
  const dayEnd = weekEnd.getDate();
  const monthStart = weekStart.getMonth();
  const monthEnd = weekEnd.getMonth();
  const yearStart = weekStart.getFullYear();
  const yearEnd = weekEnd.getFullYear();

  let text;
  if (monthStart === monthEnd && yearStart === yearEnd) {
    text = MONTHS_NOMINATIVE[monthStart] + ' ' + yearStart +
      ' · ' + dayStart + '–' + dayEnd + ' ' + MONTHS_GENITIVE[monthStart];
  } else {
    text = dayStart + ' ' + MONTHS_SHORT[monthStart] + ' – ' +
      dayEnd + ' ' + MONTHS_SHORT[monthEnd] + ' ' + yearEnd;
  }

  label.textContent = text;
}
// Индексы дней недели (0 — понедельник), попадающие в текущий вид.
// На ПК это вся неделя, на телефоне — выбранная половина.
export function getVisibleDays() {
  if (!isMobileView()) return [0, 1, 2, 3, 4, 5, 6];
  return ui.mobileDayPage === 1 ? [4, 5, 6] : [0, 1, 2, 3];
}
// Первый выбор половины: показываем ту, где сегодняшний день.
// Дальше выбор пользователя не перебиваем.
export function initMobileDayPage() {
  if (ui.mobileDayPage !== -1) return;
  const d = new Date().getDay(); // 0 — воскресенье, 1–6 — понедельник…суббота
  ui.mobileDayPage = (d >= 1 && d <= 4) ? 0 : 1;
}
// Переключатель половин виден только в мобильном режиме;
// активная кнопка показывает текущую половину
export function updateMobileTabs() {
  const box = document.getElementById('mobile-day-tabs');
  if (box) box.hidden = !isMobileView();

  const tab1 = document.getElementById('day-tab-1');
  const tab2 = document.getElementById('day-tab-2');
  if (tab1) tab1.classList.toggle('is-active', ui.mobileDayPage === 0);
  if (tab2) tab2.classList.toggle('is-active', ui.mobileDayPage === 1);
}
// Единая точка перерисовки главного экрана: выбирает между карточками дня
// и таблицей недели и приводит видимость блоков в соответствие режиму
export function renderMainView() {
  const switchBox = document.getElementById('main-view-switch');
  if (switchBox) {
    switchBox.hidden = !isMobileView();
    switchBox.querySelectorAll('.view-switch-btn').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === ui.mainView);
    });
  }

  const dayBox = document.getElementById('day-cards');
  const tabs = document.getElementById('mobile-day-tabs');
  const weekNav = document.getElementById('week-nav');
  const table = document.getElementById('habits-table');

  // Пустая таблица при неотвеченной сверке — это «данные не загружены».
  // Пустая таблица после ответа сервера — «человек всё удалил», и молчит
  const note = document.getElementById('habits-note');
  if (note) note.hidden = !(cloudReady && !cloudReachable && appState.habits.length === 0);

  if (isMainDayView()) {
    if (dayBox) dayBox.hidden = false;
    if (tabs) tabs.hidden = true;
    if (weekNav) weekNav.hidden = true;
    if (table) table.hidden = true;
    renderDayCards();
  } else {
    if (dayBox) dayBox.hidden = true;
    if (tabs) tabs.hidden = !isMobileView();
    if (weekNav) weekNav.hidden = false;
    if (table) table.hidden = false;
    renderTable();
  }
}
// По карточке на привычку за сегодня. Контролы те же, что в ячейках таблицы,
// но крупнее — размеры заданы правилами .day-card .cell-* в медиа-запросе.
export function renderDayCards() {
  const box = document.getElementById('day-cards');
  if (!box) return;

  const today = toISODate(new Date());
  let html = '';

  for (let h = 0; h < appState.habits.length; h++) {
    const habit = appState.habits[h];
    let inner = '';

    if (habit.type === 'boolean') {
      const value = getRecord(today, habit.id);
      const checked = value === true ? ' checked' : '';
      const xActive = value === false ? ' is-active' : '';
      inner = '<div class="day-card-controls">' +
        '<input type="checkbox" class="cell-check" data-habit-id="' + escapeHtml(habit.id) +
        '" data-date="' + escapeHtml(today) + '"' + checked + ' aria-label="Выполнено">' +
        '<button type="button" class="cell-x' + xActive + '" data-habit-id="' +
        escapeHtml(habit.id) + '" data-date="' + escapeHtml(today) + '" aria-label="Не выполнено">✗</button>' +
        '</div>';
    } else if (habit.id === QAZA_HABIT_ID) {
      // Каза ведётся во вкладке, карточка только показывает счётчик дня
      inner = '<div class="day-card-controls">' + qazaCellMarkup(today) + '</div>';
    } else if (habit.type === 'number') {
      const entry = getEntry(today, habit.id);
      const value = entry ? entry.value : undefined;
      const text = typeof value === 'number' ? String(value) : '';
      inner = '<div class="day-card-controls">' +
        '<input type="number" class="cell-number' +
        levelClass(entry ? entry.level : null) + '" min="0" step="1" data-habit-id="' +
        escapeHtml(habit.id) + '" data-date="' + escapeHtml(today) + '" value="' + escapeHtml(text) +
        '" aria-label="Значение">' +
        (hasLevelPopup(habit.id) ? levelButtonMarkup(habit, today) : '') + '</div>';
    } else {
      const entry = getEntry(today, habit.id);
      const current = entry && typeof entry.value === 'string' ? entry.value : '';
      inner = '<div class="day-card-controls">' +
        '<select class="cell-select' + levelClass(entry ? entry.level : null) +
        '" data-habit-id="' + escapeHtml(habit.id) +
        '" data-date="' + escapeHtml(today) + '" aria-label="Значение">' +
        choiceOptionsMarkup(current, habit.id) + '</select></div>';
    }

    html += '<div class="day-card">' +
      '<div class="day-card-name">' + escapeHtml(habit.name) +
      (habit.unit ? '<span class="day-card-unit">(' + escapeHtml(habit.unit) + ')</span>' : '') +
      '</div>' + inner + '</div>';
  }

  box.innerHTML = html;
}
// Полная перерисовка шапки и тела таблицы.
// Разметка собирается строками и вставляется через DocumentFragment
// (<template>.content) — одно присвоение innerHTML на контейнер и одна
// вставка в живой DOM, чтобы уложиться в 50 мс.
export function renderTable() {
  const weekStart = appState.weekStart;
  if (!weekStart) return;

  initMobileDayPage();

  // Даты отображаемых дней недели: на ПК это вся неделя,
  // на телефоне — выбранная половина (Пн–Чт или Пт–Вс)
  const visibleDays = getVisibleDays();
  const dates = [];
  for (let i = 0; i < visibleDays.length; i++) {
    const day = addDays(weekStart, visibleDays[i]);
    dates.push(new Date(day.getFullYear(), day.getMonth(), day.getDate()));
  }

  let thead = '<tr><th class="habit-col">Привычка</th>';
  for (let i = 0; i < dates.length; i++) {
    thead += '<th class="day-col">' + pad2(dates[i].getDate()) + '.' +
      pad2(dates[i].getMonth() + 1) + '</th>';
  }
  thead += '<th class="progress-col">Прогресс</th></tr>';

  // В круге — прогресс за неделю, второй строкой — за месяц
  let tbody = '';
  for (let h = 0; h < appState.habits.length; h++) {
    const habit = appState.habits[h];
    tbody += '<tr class="habit-row" data-habit-id="' + escapeHtml(habit.id) + '">';
    tbody += '<td><span class="habit-name">' + escapeHtml(habit.name) + '</span>';
    if (habit.unit) {
      tbody += '<span class="habit-unit">(' + escapeHtml(habit.unit) + ')</span>';
    }
    tbody += '</td>';
    for (let i = 0; i < dates.length; i++) {
      tbody += cellMarkup(habit, toISODate(dates[i]));
    }
    tbody += '<td class="progress-cell">' +
      circleMarkup(weekPercent(habit), habit.id, monthPercent(habit)) + '</td>';
    tbody += '</tr>';
  }

  const headTemplate = document.createElement('template');
  headTemplate.innerHTML = thead;
  const bodyTemplate = document.createElement('template');
  bodyTemplate.innerHTML = tbody;

  const theadEl = document.getElementById('habits-thead');
  const tbodyEl = document.getElementById('habits-tbody');
  if (theadEl) theadEl.replaceChildren(headTemplate.content);
  if (tbodyEl) tbodyEl.replaceChildren(bodyTemplate.content);

  updateMobileTabs();
}
// Контейнер ячейки: в таблице это <td class="cell">, в режиме «День» — блок
// управления карточки. Нужен, чтобы после изменения обновить оба контрола
// boolean-ячейки (галочку и «✗»).
export function cellContainer(target) {
  return target.closest('td.cell') || target.closest('.day-card-controls');
}
// data-habit-id и data-date в таблице стоят на <td>, а в карточке — на самом
// контроле, поэтому читаем их с контейнера, а при отсутствии — с цели события.
export function cellData(container, target, name) {
  return container.getAttribute(name) || target.getAttribute(name);
}
export function onTableChange(event) {
  const target = event.target;
  if (!target || !target.classList || typeof target.closest !== 'function') return;

  const cell = cellContainer(target);
  if (!cell) return;

  const habitId = cellData(cell, target, 'data-habit-id');
  const date = cellData(cell, target, 'data-date');
  const habit = findHabit(habitId);
  if (!habit || !date) return;

  const entry = getEntry(date, habitId);
  const current = entry ? entry.value : undefined;
  // Уровень «2 минуты» выбран человеком и правку значения переживает (§2.4) —
  // но только у Корана: там значение и уровень независимы. У Спорта уровень
  // выводится из самого ответа, и «отдых» после «2 минут» не должен остаться
  // голубым, поэтому там он всегда пересчитывается.
  const kept = habitId === QURAN_HABIT_ID && entry && entry.level === LEVEL_TWO_MIN
    ? LEVEL_TWO_MIN : undefined;

  // boolean: галочка = true, снятая галочка = удаление записи
  if (target.classList.contains('cell-check')) {
    const value = target.checked ? true : undefined;
    if (current === value) {
      syncBooleanCell(cell, current);
      return;
    }
    if (!onCellChange(habit, date, value)) {
      // Запись не удалась: возвращаем галочку и «✗» к прежнему значению,
      // а не к новому. Тост уже показал safeSetItem.
      syncBooleanCell(cell, current);
      return;
    }
    syncBooleanCell(cell, value);
    return;
  }

  // choice: пустая опция = удаление записи
  if (target.classList.contains('cell-select')) {
    const value = target.value === '' ? undefined : target.value;
    if (current === value) return;
    if (!onCellChange(habit, date, value, kept === undefined ? defaultLevel(habit, value) : kept)) {
      target.value = current === undefined ? '' : current;
      return;
    }
    syncLevelCell(cell, habitId, date);
    return;
  }

  // number: '' -> удаление, 0 — значимое значение, отрицательное/NaN -> удаление
  if (target.classList.contains('cell-number')) {
    let value;
    if (target.value === '') {
      value = undefined;
    } else {
      const parsed = Number(target.value);
      value = (isFinite(parsed) && parsed >= 0) ? parsed : undefined;
    }
    if (current === value) return;
    if (!onCellChange(habit, date, value, kept === undefined ? defaultLevel(habit, value) : kept)) {
      target.value = current === undefined ? '' : current;
      return;
    }
    syncLevelCell(cell, habitId, date);
  }
}
// Вид полей ячейки после отметки: класс границы по уровню и метка на кнопке
export function syncLevelCell(cell, habitId, date) {
  if (!cell || !isLevelHabit(habitId)) return;

  const entry = getEntry(date, habitId);
  const level = entry ? entry.level : null;

  const field = cell.querySelector('.cell-number') || cell.querySelector('.cell-select');
  if (field) {
    field.classList.remove('is-on-time', 'is-late', 'is-two-min');
    const cls = levelClass(level).trim();
    if (cls) field.classList.add(cls);
  }

  const button = cell.querySelector('.cell-level-btn');
  if (button) button.classList.toggle('is-set', !!level);
}
export function onTableClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  // Кнопка уровня открывает попап на привычке и дне своей ячейки (§1.2)
  const levelButton = target.closest('.cell-level-btn');
  if (levelButton) {
    const levelCell = cellContainer(levelButton);
    if (!levelCell) return;
    openLevelSheet(
      cellData(levelCell, levelButton, 'data-habit-id'),
      cellData(levelCell, levelButton, 'data-date')
    );
    return;
  }

  const button = target.closest('.cell-x');
  if (!button) return;

  const cell = cellContainer(button);
  if (!cell) return;

  const habitId = cellData(cell, button, 'data-habit-id');
  const date = cellData(cell, button, 'data-date');
  const habit = findHabit(habitId);
  if (!habit || !date) return;

  // Повторный клик по «✗» сбрасывает запись в «пусто»
  const current = getRecord(date, habitId);
  const value = current === false ? undefined : false;

  if (!onCellChange(habit, date, value)) return;
  syncBooleanCell(cell, value);
}
// Синхронизация вида boolean-ячейки после изменения
export function syncBooleanCell(cell, value) {
  if (!cell) return;
  const check = cell.querySelector('.cell-check');
  const cross = cell.querySelector('.cell-x');
  if (check) check.checked = value === true;
  if (cross) cross.classList.toggle('is-active', value === false);
}
// Записывает значение и обновляет ТОЛЬКО круг своей строки — без renderTable().
// День отметки может уехать во вчерашний (§4): тогда без перерисовки не
// обойтись — отметка встанет в чужую колонку и останется незамеченной.
export function onCellChange(habit, date, value, level) {
  if (!habit) return false;

  const markDate = habitMarkDate(habit, date, new Date());
  if (!writeHabitEntry(habit, markDate, value, level)) return false;

  if (markDate !== date) {
    renderTable();
    renderDayCards();
    return true;
  }

  updateRowCircle(habit.id);
  return true;
}
// Перерисовка круга одной строки (полная перерисовка таблицы не нужна)
export function updateRowCircle(habitId) {
  let habit = findHabit(habitId);
  if (!habit) {
    appState.habits = loadHabits();
    habit = findHabit(habitId);
  }
  if (!habit || !appState.weekStart) return;

  const row = document.querySelector(
    '#habits-tbody tr.habit-row[data-habit-id="' + cssEscape(habitId) + '"]'
  );
  if (!row) return;

  const cell = row.querySelector('.progress-cell');
  if (!cell) return;

  cell.innerHTML = circleMarkup(weekPercent(habit), habit.id, monthPercent(habit));
}
export function changeWeek(delta) {
  appState.weekStart = addDays(appState.weekStart, delta * 7);
  renderHeader();
  renderTable();
}
export function goToday() {
  appState.weekStart = getWeekStart(new Date());
  renderHeader();
  renderTable();
}

// Опции выпадающего списка значений ячейки choice. У Спорта и Пресса свой
// список кодов и свои подписи (§3.1), у прочих привычек типа choice — общий.
export function choiceOptionsMarkup(current, habitId) {
  const isCoded = isChoiceLevelHabit(habitId);
  const codes = isCoded ? SPORT_VALUES : CHOICE_OPTIONS;

  let html = '<option value=""' + (current === '' ? ' selected' : '') + '>—</option>';
  for (let i = 0; i < codes.length; i++) {
    const option = codes[i];
    const label = isCoded ? SPORT_VALUE_LABELS[option] : option;
    html += '<option value="' + escapeHtml(option) + '"' +
      (option === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }
  return html;
}
