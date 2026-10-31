import { escapeHtml } from '../core/dom.js';
import { HABIT_TYPES, addHabit, hasRecords, loadHabits, removeHabit, updateHabit } from '../data/habits.js';
import { QAZA_HABIT_ID } from '../data/qaza.js';
import { isLevelHabit } from '../data/records.js';
import { findHabit, renderMainView } from './main-table.js';
import { appState } from './state.js';
// Опции выпадающего списка типов привычек
export function typeOptionsMarkup(current) {
  let html = '';
  for (let i = 0; i < HABIT_TYPES.length; i++) {
    const type = HABIT_TYPES[i];
    html += '<option value="' + escapeHtml(type.value) + '"' +
      (type.value === current ? ' selected' : '') + '>' + escapeHtml(type.label) + '</option>';
  }
  return html;
}
// Подпись типа привычки для экрана «Привычки»
export function habitTypeLabel(type) {
  for (let i = 0; i < HABIT_TYPES.length; i++) {
    if (HABIT_TYPES[i].value === type) return HABIT_TYPES[i].label;
  }
  return '';
}
export function openModal() {
  appState.habits = loadHabits();
  renderHabitList();
  const modal = document.getElementById('habit-modal');
  if (modal) modal.hidden = false;
}
export function closeModal() {
  const modal = document.getElementById('habit-modal');
  if (modal) modal.hidden = true;
  setFormError('');
  // После добавления привычки список на экране «Привычки» устарел
  renderHabitsEditList();
}
// Общие для обоих списков вычисления строки: блокировка типа (каза — всегда,
// остальные — когда по привычке уже есть записи), подсказка и строковое
// значение цели. Раньше этот блок был скопирован в два построителя дословно.
function habitRowFields(habit) {
  // У каза тип задаётся вкладкой «Каза-намазы» и заблокирован всегда;
  // у остальных — только если по привычке уже есть записи
  const isQaza = habit.id === QAZA_HABIT_ID;
  const locked = isQaza || hasRecords(habit.id);
  const lockedTitle = isQaza
    ? 'Тип каза задаётся вкладкой «Каза-намазы»'
    : 'Тип нельзя изменить: по привычке уже есть записи';
  return {
    isQaza: isQaza,
    lockedAttr: locked
      ? ' disabled title="' + escapeHtml(lockedTitle) + '"'
      : '',
    goalValue: habit.goal === null || habit.goal === undefined
      ? '' : String(habit.goal),
  };
}

// Единый построитель списков привычек: модалка (#habit-list) и экран
// «Привычки» (#habits-edit-list) идут по одному appState.habits и отличаются
// только разметкой строки — вариант приходит параметром (механизм тот же,
// что у EDIT_ROW_SELECTORS ниже).
function renderHabitRows(listId, rowMarkup) {
  const list = document.getElementById(listId);
  if (!list) return;

  let html = '';
  for (let i = 0; i < appState.habits.length; i++) {
    html += rowMarkup(appState.habits[i]);
  }

  list.innerHTML = html;
}

// Строка модалки: инлайн-поля редактирования
function modalHabitRow(habit) {
  const row = habitRowFields(habit);

  return '<li data-habit-id="' + escapeHtml(habit.id) + '">' +
    '<input type="text" class="habit-edit-name" value="' + escapeHtml(habit.name) +
    '" aria-label="Название">' +
    '<select class="habit-type"' + row.lockedAttr + ' aria-label="Тип">' +
    typeOptionsMarkup(habit.type) + '</select>' +
    '<input type="text" class="habit-edit-unit" value="' + escapeHtml(habit.unit || '') +
    '" placeholder="Ед." aria-label="Единица измерения">' +
    '<input type="number" class="habit-edit-goal" min="1" step="1" value="' +
    escapeHtml(row.goalValue) + '" placeholder="Цель" aria-label="Цель">' +
    // Время — только у привычек с уровнями: оно задаёт окно «вовремя»
    (isLevelHabit(habit.id)
      ? '<input type="time" class="habit-edit-time" value="' +
        escapeHtml(habit.time || '') + '" aria-label="Время">'
      : '') +
    '<button type="button" class="btn btn-secondary habit-save">Сохранить</button>' +
    // У каза кнопки удаления нет: удалив привычку, синхронизацию не восстановить
    (row.isQaza ? '' : '<button type="button" class="btn btn-danger habit-delete">Удалить</button>') +
    '</li>';
}

// Строка-аккордеон экрана «Привычки»: поля раскрываются тапом по заголовку
function editHabitRow(habit) {
  const row = habitRowFields(habit);
  const isNumber = habit.type === 'number';
  const numberHidden = isNumber ? '' : ' hidden';

  return '<li class="habit-row-edit" data-habit-id="' + escapeHtml(habit.id) + '">' +
    '<button type="button" class="habit-row-head">' +
      '<span class="habit-row-name">' + escapeHtml(habit.name) + '</span>' +
      '<span class="habit-row-type">' + escapeHtml(habitTypeLabel(habit.type)) + '</span>' +
      '<span class="habit-row-chevron">›</span>' +
    '</button>' +
    '<div class="habit-row-body">' +
      '<label><span>Название</span>' +
        '<input type="text" class="edit-name" value="' + escapeHtml(habit.name) + '">' +
      '</label>' +
      '<label><span>Тип</span>' +
        '<select class="edit-type"' + row.lockedAttr + '>' +
        typeOptionsMarkup(habit.type) + '</select>' +
      '</label>' +
      '<label class="edit-number-field"' + numberHidden + '><span>Единица измерения</span>' +
        '<input type="text" class="edit-unit" value="' + escapeHtml(habit.unit || '') +
        '" placeholder="Ед.">' +
      '</label>' +
      '<label class="edit-number-field"' + numberHidden + '><span>Цель</span>' +
        '<input type="number" class="edit-goal" min="1" step="1" value="' +
        escapeHtml(row.goalValue) + '" placeholder="Цель">' +
      '</label>' +
      // Время — только у привычек с уровнями: оно задаёт окно «вовремя»
      (isLevelHabit(habit.id)
        ? '<label class="edit-time-field"><span>Время</span>' +
          '<input type="time" class="edit-time" value="' +
          escapeHtml(habit.time || '') + '">' +
          '</label>'
        : '') +
      '<p class="form-error" role="alert"></p>' +
      '<div class="habit-row-actions">' +
        '<button type="button" class="btn btn-primary edit-save">Сохранить</button>' +
        // У каза удаления нет: удалив привычку, синхронизацию не восстановить
        (row.isQaza ? '' : '<button type="button" class="btn btn-danger edit-delete">Удалить</button>') +
      '</div>' +
    '</div>' +
    '</li>';
}

// Список привычек в модалке. События делегированы на #habit-list.
export function renderHabitList() {
  renderHabitRows('habit-list', modalHabitRow);
}

// --- Общая логика кнопок строки (модалка и экран «Привычки») -----------------

// Подтверждённое удаление: окно, удаление, перечитывание состояния.
// false — пользователь отменил или удаление не удалось.
function removeHabitConfirmed(habitId, habit) {
  if (!window.confirm('Удалить привычку «' + habit.name + '» и все её записи?')) return false;
  if (!removeHabit(habitId)) return false;
  appState.habits = loadHabits();
  return true;
}

// Сборка patch из данных строки: время — только у привычек с уровнями
// (поле пустое — время не задано), тип — только у привычки без записей.
// Экспортируется для tests/habits-edit.test.mjs.
export function buildHabitPatch(habitId, data) {
  const patch = { name: data.name.trim(), unit: data.unit, goal: data.goal };
  // Время есть только у привычек с уровнями: поле пустое — время не задано
  if (isLevelHabit(habitId)) patch.time = data.time;
  // Тип меняем только у привычки без записей
  if (!hasRecords(habitId)) patch.type = data.type;
  return patch;
}

// Запись patch и перечитывание состояния. false — обновление не прошло.
function saveHabitPatch(habitId, patch) {
  if (!updateHabit(habitId, patch)) return false;
  appState.habits = loadHabits();
  return true;
}

// Делегированный обработчик кнопок «Сохранить» и «Удалить» в списке
export function onHabitListClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  const item = target.closest('li[data-habit-id]');
  if (!item) return;

  const habitId = item.getAttribute('data-habit-id');
  const habit = findHabit(habitId);
  if (!habit) return;

  if (target.closest('.habit-delete')) {
    if (!removeHabitConfirmed(habitId, habit)) return;
    setFormError('');
    renderHabitList();
    renderMainView();
    return;
  }

  if (target.closest('.habit-save')) {
    const data = readHabitItem(item);
    const result = validateHabitForm(data, habitId);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    if (!saveHabitPatch(habitId, buildHabitPatch(habitId, data))) return;
    setFormError('');
    renderHabitList();
    renderMainView();
  }
}

// Строки-аккордеоны: поля раскрываются тапом по заголовку
export function renderHabitsEditList() {
  renderHabitRows('habits-edit-list', editHabitRow);
}
// Ошибка показывается внутри раскрытой строки — форма модалки здесь не видна
export function setRowError(item, message) {
  const error = item.querySelector('.form-error');
  if (error) error.textContent = message || '';
}
// Делегированный обработчик экрана «Привычки»
export function onHabitsEditClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  if (target.closest('.habit-row-head')) {
    const row = target.closest('.habit-row-edit');
    if (!row) return;
    const wasOpen = row.classList.contains('is-open');
    // Открыта не более одной строки: раскрытие закрывает соседей
    const siblings = row.parentNode.children;
    for (let i = 0; i < siblings.length; i++) {
      siblings[i].classList.remove('is-open');
    }
    if (!wasOpen) row.classList.add('is-open');
    return;
  }

  const item = target.closest('li[data-habit-id]');
  if (!item) return;

  const habitId = item.getAttribute('data-habit-id');
  const habit = findHabit(habitId);
  if (!habit) return;

  if (target.closest('.edit-delete')) {
    if (!removeHabitConfirmed(habitId, habit)) return;
    renderHabitsEditList();
    renderMainView();
    return;
  }

  if (target.closest('.edit-save')) {
    const data = readHabitItem(item, EDIT_ROW_SELECTORS);
    const result = validateHabitForm(data, habitId);
    if (!result.ok) {
      setRowError(item, result.error);
      return;
    }
    if (!saveHabitPatch(habitId, buildHabitPatch(habitId, data))) return;
    renderHabitsEditList();
    renderMainView();
  }
}
// Поля «Единица» и «Цель» нужны только числовому типу
export function onHabitsEditChange(event) {
  const field = event.target;
  if (!field || !field.classList || !field.classList.contains('edit-type')) return;

  const item = field.closest('li[data-habit-id]');
  if (!item) return;

  const isNumber = field.value === 'number';
  const fields = item.querySelectorAll('.edit-number-field');
  for (let i = 0; i < fields.length; i++) {
    fields[i].hidden = !isNumber;
  }
}
// Селекторы строки экрана «Привычки» — имена классов отличаются от модалки
export const EDIT_ROW_SELECTORS = {
  name: '.edit-name',
  type: '.edit-type',
  unit: '.edit-unit',
  goal: '.edit-goal',
  time: '.edit-time',
};
// Данные одной строки списка привычек.
// cls переопределяет селекторы: в модалке и на экране «Привычки» они разные.
export function readHabitItem(item, cls) {
  const sel = cls || {};
  const nameField = item.querySelector(sel.name || '.habit-edit-name');
  const typeField = item.querySelector(sel.type || '.habit-type');
  const unitField = item.querySelector(sel.unit || '.habit-edit-unit');
  const goalField = item.querySelector(sel.goal || '.habit-edit-goal');
  const timeField = item.querySelector(sel.time || '.habit-edit-time');

  const type = typeField ? typeField.value : 'boolean';
  const unit = unitField ? unitField.value.trim() : '';
  const goalText = goalField ? goalField.value.trim() : '';
  // Пустое поле времени — это null, а не пустая строка: так «времени нет»
  // и «время затёрли» читаются одинаково
  const timeText = timeField ? timeField.value.trim() : '';

  return {
    name: nameField ? nameField.value : '',
    type: type,
    unit: type === 'number' ? unit : '',
    goal: type === 'number' ? Number(goalText) : null,
    time: timeText === '' ? null : timeText,
  };
}
export function setFormError(message) {
  const error = document.getElementById('form-error');
  if (error) error.textContent = message || '';
}
// Поля unit и goal имеют смысл только для числового типа
export function updateFormFields() {
  const typeField = document.getElementById('form-type');
  const unitField = document.getElementById('form-unit');
  const goalField = document.getElementById('form-goal');
  const isNumber = !!typeField && typeField.value === 'number';
  if (unitField) unitField.hidden = !isNumber;
  if (goalField) goalField.hidden = !isNumber;
}
export function onFormSubmit(event) {
  event.preventDefault();

  const nameField = document.getElementById('form-name');
  const typeField = document.getElementById('form-type');
  const unitField = document.getElementById('form-unit');
  const goalField = document.getElementById('form-goal');

  const type = typeField ? typeField.value : 'boolean';
  const data = {
    name: nameField ? nameField.value : '',
    type: type,
    unit: unitField ? unitField.value.trim() : '',
    goal: type === 'number' && goalField ? Number(goalField.value.trim()) : null,
  };

  const result = validateHabitForm(data);
  if (!result.ok) {
    setFormError(result.error);
    return;
  }

  const created = addHabit({
    name: data.name.trim(),
    type: data.type,
    unit: data.type === 'number' ? data.unit : '',
    goal: data.goal,
  });
  if (!created) return;

  appState.habits = loadHabits();
  setFormError('');

  const form = document.getElementById('habit-form');
  if (form) form.reset();
  updateFormFields();

  renderHabitList();
  renderMainView();
}
// validateHabitForm(data, excludeId) -> { ok: true } | { ok: false, error }
// excludeId позволяет не считать саму привычку дубликатом при редактировании.
export function validateHabitForm(data, excludeId) {
  const skipId = excludeId !== undefined && excludeId !== null
    ? excludeId
    : (data && data.excludeId !== undefined ? data.excludeId : null);

  const name = (data && data.name ? String(data.name) : '').trim();
  if (name === '') {
    return { ok: false, error: 'Введите название привычки' };
  }

  const habits = loadHabits();
  const lowerName = name.toLowerCase();
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === skipId) continue;
    if (String(habits[i].name).trim().toLowerCase() === lowerName) {
      return { ok: false, error: 'Привычка с названием «' + name + '» уже существует' };
    }
  }

  if (data && data.type === 'number') {
    const goal = data.goal;
    const isInteger = typeof goal === 'number' && isFinite(goal) &&
      Math.floor(goal) === goal && goal > 0;
    if (!isInteger) {
      return { ok: false, error: 'Цель должна быть целым числом больше 0' };
    }
    if (!(data.unit ? String(data.unit) : '').trim()) {
      return { ok: false, error: 'Укажите единицу измерения для числовой привычки' };
    }
  }

  return { ok: true };
}
