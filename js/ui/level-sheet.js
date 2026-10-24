import { LEVEL_TWO_MIN, QURAN_HABIT_ID, defaultLevel, getEntry, habitMarkDate, hasLevelPopup, writeHabitEntry } from '../data/records.js';
import { isMainDayView } from './state.js';
import { findHabit, renderDayCards, syncLevelCell, updateRowCircle } from './main-table.js';
import { cssEscape, syncSheetToKeyboard } from '../core/dom.js';
// Привычка и день, для которых открыт попап. День здесь уже выправленный
// правилом полуночи (§4): попап пишет туда же, куда писала бы клетка.
export let levelSheetTarget = null;
// Текущее значение отметки — из него считается «Полная версия».
// Пустое поле значит, что выполнять нечего, и пункт гаснет (§2.3).
export function openLevelSheet(habitId, date) {
  const habit = findHabit(habitId);
  if (!habit || !date || !hasLevelPopup(habitId)) return;

  const entry = getEntry(date, habitId);
  const value = entry ? entry.value : undefined;
  const hasValue = typeof value === 'number';

  levelSheetTarget = {
    habitId: habitId,
    date: habitMarkDate(habit, date, new Date()),
    value: value,
  };

  const full = document.getElementById('level-option-full');
  if (full) {
    full.disabled = !hasValue;
    full.classList.toggle('is-active', !!entry && entry.level !== LEVEL_TWO_MIN);
  }

  const twoMin = document.getElementById('level-option-two-min');
  if (twoMin) twoMin.classList.toggle('is-active', !!entry && entry.level === LEVEL_TWO_MIN);

  const sheet = document.getElementById('level-sheet');
  if (!sheet) return;

  // Для Корана показываем только «Полная версия» и «2 минуты»,
  // остальные кнопки скрываем
  const options = sheet.querySelectorAll('.level-option');
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (habitId === QURAN_HABIT_ID) {
      const lvl = opt.getAttribute('data-level');
      opt.style.display = (lvl === 'full' || lvl === 'two-min') ? '' : 'none';
    } else {
      opt.style.display = '';
    }
  }

  sheet.hidden = false;
  syncSheetToKeyboard();
}
export function closeLevelSheet() {
  const sheet = document.getElementById('level-sheet');
  if (sheet) sheet.hidden = true;
  levelSheetTarget = null;
  document.documentElement.style.setProperty('--keyboard-offset', '0px');
}
// Выбор пункта попапа. «2 минуты» пишутся и уровнем, и значением, если
// значения ещё нет: у Корана это 0, у Спорта — сам код «2 минуты».
export function onLevelPick(event) {
  const option = event.target.closest('.level-option');
  if (!option || option.disabled || !levelSheetTarget) return;

  const habit = findHabit(levelSheetTarget.habitId);
  const date = levelSheetTarget.date;
  const value = levelSheetTarget.value;
  if (!habit) return;

  let level;
  if (option.getAttribute('data-level') === 'two-min') {
    level = LEVEL_TWO_MIN;
  } else {
    level = defaultLevel(habit, value);
  }

  // Числа ещё нет — «2 минуты» пишутся нулём страниц (§2.4).
  // «Полная версия» без числа недоступна, поэтому дальше пути нет.
  let written = value;
  if (written === undefined && level === LEVEL_TWO_MIN) written = 0;
  if (written === undefined) return;

  if (!writeHabitEntry(habit, date, written, level)) return;

  closeLevelSheet();
  syncLevelCells(habit.id, date);
  updateRowCircle(habit.id);
}
// Вид полей уровня после выбора в попапе: клетки таблицы и, если открыт режим
// «День», карточки. Так же поступает updateQazaCells: на телефоне таблица
// скрыта медиа-запросом, но остаётся в DOM, и обновления одной её мало.
export function syncLevelCells(habitId, date) {
  const cells = document.querySelectorAll(
    'td.cell[data-habit-id="' + cssEscape(habitId) + '"]');
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].getAttribute('data-date') === date) syncLevelCell(cells[i], habitId, date);
  }

  if (isMainDayView()) renderDayCards();
}
