import { escapeHtml } from '../core/dom.js';
import { loadSchedule, saveSchedule } from '../data/schedule.js';
import { ui } from './state.js';
export function renderScheduleView() {
  markScheduleType();

  const list = document.getElementById('schedule-list');
  if (!list) return;

  const scheduleData = loadSchedule();
  const items = scheduleData[ui.scheduleType] || [];
  let html = '';
  for (let i = 0; i < items.length; i++) {
    html += '<li>' +
      '<span class="schedule-time">' + escapeHtml(items[i].time) + '</span>' +
      '<span class="schedule-text">' + escapeHtml(items[i].text) + '</span>' +
      '</li>';
  }
  list.innerHTML = html;
}
// Список + кнопка удаления на каждый пункт. Сортировка по времени даёт один
// порядок в DOM и в массиве: data-index кнопки указывает ровно на ту запись,
// которую видно. Изменение порядка переживает запись в хранилище — расписание
// дальше живёт отсортированным.
export function renderScheduleEditView() {
  const list = document.getElementById('schedule-edit-list');
  if (!list) return;

  const schedule = loadSchedule();
  const items = schedule[ui.scheduleEditType] || [];

  items.sort((a, b) => a.time.localeCompare(b.time));

  let html = '';
  for (let i = 0; i < items.length; i++) {
    html += '<li style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border);">' +
      '<div><span class="schedule-time" style="font-weight: 600; margin-right: 12px; font-variant-numeric: tabular-nums;">' + escapeHtml(items[i].time) + '</span>' +
      '<span class="schedule-text">' + escapeHtml(items[i].text) + '</span></div>' +
      '<button type="button" class="btn btn-danger delete-schedule-item" data-index="' + i + '" aria-label="Удалить">✕</button>' +
      '</li>';
  }
  list.innerHTML = html;
}
// Форма «Добавить». saveSchedule решает судьбу отправки и перерисовки:
// запись не удалась — поля не чистим и экран не трогаем.
export function onScheduleAddSubmit(event) {
  event.preventDefault();
  const timeInput = document.getElementById('schedule-add-time');
  const textInput = document.getElementById('schedule-add-text');
  if (!timeInput || !textInput) return;

  const time = timeInput.value;
  const text = textInput.value.trim();
  if (!time || !text) return;

  const schedule = loadSchedule();
  if (!schedule[ui.scheduleEditType]) schedule[ui.scheduleEditType] = [];

  schedule[ui.scheduleEditType].push({ time: time, text: text });

  if (!saveSchedule(schedule)) return;

  timeInput.value = '';
  textInput.value = '';
  renderScheduleEditView();
}
// Удаление пункта — делегировано на ul, поэтому перерисовки не теряют
// обработчик. Индекс согласован с DOM: render рисует уже отсортированный
// массив, поэтому и здесь сортируем до splice.
export function onScheduleEditListClick(event) {
  const btn = event.target.closest('.delete-schedule-item');
  if (!btn) return;

  const index = parseInt(btn.getAttribute('data-index'), 10);
  if (isNaN(index)) return;

  const schedule = loadSchedule();
  const items = schedule[ui.scheduleEditType];
  if (!items || index < 0 || index >= items.length) return;

  items.sort((a, b) => a.time.localeCompare(b.time));
  items.splice(index, 1);

  if (!saveSchedule(schedule)) return;

  renderScheduleEditView();
}
export function markScheduleType() {
  const box = document.getElementById('schedule-switch');
  if (!box) return;
  box.querySelectorAll('.view-switch-btn').forEach(function (btn) {
    btn.classList.toggle('is-active',
      btn.getAttribute('data-schedule') === ui.scheduleType);
  });
}
