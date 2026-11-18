// Экран «Архив привычек»: привычки, которые больше не отмечаются каждый день,
// но их записи и история сохранены. Возврат делает привычку активной снова;
// версия архивной пары уже записана setHabitArchived (js/data/habits.js).
//
// Источник — полный список привычек: архивные отбирает selectArchivedHabits.
// Слушатель кликов делегирован на статичный #habits-archive-list в
// js/events/nav-events.js — перерисовка списка его не дублирует.

import { escapeHtml } from '../core/dom.js';
import { loadHabits, selectArchivedHabits, setHabitArchived } from '../data/habits.js';
import { findHabit, renderMainView } from './main-table.js';
import { appState } from './state.js';

// Текст ошибки действия. Коды приходят из setHabitArchived; неизвестный код
// не должен превращаться в пустоту — человеку нужен понятный следующий шаг.
export function habitArchiveErrorMessage(error) {
  if (error === 'unknown-habit') return 'Привычка не найдена. Обновите список.';
  if (error === 'invalid-state') return 'Не удалось изменить состояние привычки.';
  if (error === 'actor-unavailable') {
    return 'Хранилище не позволило создать метку устройства. Проверьте свободное место.';
  }
  if (error === 'version-exhausted') {
    return 'Счётчик изменений привычки исчерпан. Изменение не сохранено.';
  }
  if (error === 'save-failed') {
    return 'Не удалось сохранить изменения. Проверьте свободное место и повторите.';
  }
  return 'Не удалось изменить привычку. Повторите попытку.';
}

export function setHabitsArchiveError(message) {
  const node = document.getElementById('habits-archive-error');
  if (node) node.textContent = message || '';
}

// Строка архива: имя и кнопка возврата. li[data-habit-id] — общий адрес
// действия для делегированного обработчика (как li в списке правки).
function archiveRowMarkup(habit) {
  const unit = habit.unit
    ? '<span class="habit-archive-unit">(' + escapeHtml(habit.unit) + ')</span>'
    : '';
  return '<li class="habit-archive-row" data-habit-id="' + escapeHtml(habit.id) + '">' +
    '<span class="habit-archive-name">' + escapeHtml(habit.name) + '</span>' + unit +
    '<button type="button" class="btn btn-secondary archive-restore">Вернуть</button>' +
    '</li>';
}

export function renderHabitsArchiveView() {
  // Экран открывается из Настроек: состояние таблицы могло устареть, как у
  // списка правки. Полный список остаётся в appState — фильтр только в выборке
  appState.habits = loadHabits();
  const archived = selectArchivedHabits(appState.habits);

  const list = document.getElementById('habits-archive-list');
  if (list) list.innerHTML = archived.map(archiveRowMarkup).join('');

  const empty = document.getElementById('habits-archive-empty');
  if (empty) empty.hidden = archived.length > 0;

  // Старая ошибка не должна переживать успешную перерисовку/вход
  setHabitsArchiveError('');
}

export function onHabitsArchiveClick(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== 'function') return;
  if (!target.closest('.archive-restore')) return;

  const item = target.closest('li[data-habit-id]');
  if (!item) return;

  const habitId = item.getAttribute('data-habit-id');
  const habit = findHabit(habitId);
  // Уже вернули (повторный клик по той же кнопке до/после перерисовки) —
  // это не ошибка и не повод для второй записи
  if (!habit || habit.isArchived !== true) return;

  const result = setHabitArchived(habitId, false);
  if (!result.ok) {
    setHabitsArchiveError(habitArchiveErrorMessage(result.error));
    return;
  }

  appState.habits = loadHabits();
  renderHabitsArchiveView();
  // Главная могла быть уже отрисована без этой привычки — обновляем, чтобы
  // возвращённая привычка появилась сразу, а не после следующей сверки
  renderMainView();
}
