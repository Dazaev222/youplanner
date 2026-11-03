/* Экран «Матрица Эйзенхауэра». Визуальный язык — TickTick: четыре карточки
   2×2, у каждой заголовок со счётчиком, внутри — строки задач с круглым
   чекбоксом, цветной точкой приоритета и пилюлей срока. Никаких своих
   палитр и радиусов: только токены из styles/tokens.css.

   Перенос между квадрантами — лист на тап по «⋯», а не drag. Причина не в
   лени: drag на телефоне конфликтует с вертикальным скроллом списка (а
   список именно вертикальный), а его «призрак» на пол-экрана прячет тот
   самый квадрант, куда человек целится. Лист даёт три варианта ответа
   всегда, в том числе под пальцем. */

import { toISODate } from '../core/dates.js';
import { escapeHtml, showToast } from '../core/dom.js';
import {
  PRIORITY_MEDIUM,
  PRIORITY_NONE,
  QUADRANTS,
  activeTasks,
  applyQuadrantMove,
  createTask,
  groupByQuadrant,
  isOverdue,
  loadTasks,
  markDone,
  quadrantOf,
  quadrantStats,
  saveTasks,
} from '../data/matrix.js';

const PRIORITY_LABEL = {
  0: 'без приоритета',
  1: 'низкий',
  2: 'средний',
  3: 'высокий',
};

let tasks = [];
let composerOpenIn = null;   // id квадранта с открытой формой добавления
let sheetFor = null;         // id задачи, для которой открыт лист переноса

function today() {
  return new Date();
}

function dueLabel(task, now) {
  if (!task.due) return '';
  const due = new Date(task.due + 'T00:00:00');
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - startOfToday) / 86400000);
  if (days < 0) return 'просрочено';
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return due.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// Одна строка задачи. Текст уходит через escapeHtml: заголовок — то, что
// набрал человек, и `<img onerror>` в нём не должен становиться разметкой
// (в проекте это правило действует для всех пользовательских строк).
function taskRow(task, now) {
  const overdue = isOverdue(task, now);
  const row = document.createElement('div');
  row.className = 'matrix-task'
    + (overdue ? ' is-overdue' : '')
    + (task.priority >= PRIORITY_MEDIUM ? ' is-important' : '');
  row.dataset.taskId = task.id;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'matrix-check';
  check.setAttribute('aria-label', 'Отметить выполненной: ' + task.title);
  check.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
    + '<path class="matrix-check-mark" d="M4 10.5l3.6 3.6L16 5.6" fill="none" '
    + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  check.addEventListener('click', () => toggleDone(task.id));

  const body = document.createElement('div');
  body.className = 'matrix-task-body';
  const title = document.createElement('div');
  title.className = 'matrix-task-title';
  title.textContent = task.title;
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'matrix-task-meta';
  if (task.priority !== PRIORITY_NONE) {
    const dot = document.createElement('span');
    dot.className = 'matrix-dot p' + task.priority;
    dot.title = PRIORITY_LABEL[task.priority];
    meta.appendChild(dot);
  }
  if (task.due) {
    const chip = document.createElement('span');
    chip.className = 'matrix-due' + (overdue ? ' is-overdue' : '');
    chip.textContent = dueLabel(task, now);
    meta.appendChild(chip);
  }
  if (task.notes) {
    const note = document.createElement('span');
    note.className = 'matrix-note-hint';
    note.textContent = 'заметка';
    meta.appendChild(note);
  }
  body.appendChild(meta);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'matrix-more';
  more.setAttribute('aria-label', 'Перенести задачу: ' + task.title);
  more.textContent = '⋯';
  more.addEventListener('click', () => openMoveSheet(task.id));

  row.append(check, body, more);
  return row;
}

function composer(quadrantId) {
  const form = document.createElement('form');
  form.className = 'matrix-composer';
  form.dataset.quadrant = quadrantId;
  const dueDefault = quadrantId === 'q1' || quadrantId === 'q3'
    ? toISODate(today()) : '';
  form.innerHTML = '<input class="matrix-composer-title" name="title" type="text" '
    + 'placeholder="Новая задача" maxlength="200" autocomplete="off" required>'
    + '<div class="matrix-composer-row">'
    + '<label class="matrix-composer-field">Срок<input name="due" type="date" value="'
    + dueDefault + '"></label>'
    + '<label class="matrix-composer-field">Приоритет<select name="priority">'
    + '<option value="0">Нет</option><option value="1">Низкий</option>'
    + '<option value="2" selected>Средний</option><option value="3">Высокий</option>'
    + '</select></label>'
    + '<button type="submit" class="matrix-composer-add">Добавить</button>'
    + '<button type="button" class="matrix-composer-cancel" name="cancel">Отмена</button>'
    + '</div>';
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    if (!title) return;
    const due = String(data.get('due') || '') || null;
    const priority = Number(data.get('priority')) || 0;
    addTask(quadrantId, { title, due, priority });
  });
  form.querySelector('.matrix-composer-cancel').addEventListener('click', () => {
    composerOpenIn = null;
    renderMatrixView();
  });
  return form;
}

function quadrantCard(quadrant, list, now) {
  const card = document.createElement('section');
  card.className = 'matrix-card q-' + quadrant.id;
  card.dataset.quadrant = quadrant.id;

  const head = document.createElement('header');
  head.className = 'matrix-card-head';
  const title = document.createElement('h3');
  title.textContent = quadrant.title;
  const count = document.createElement('span');
  count.className = 'matrix-count';
  count.textContent = String(list.length);
  head.append(title, count);
  // Просроченные — отдельной пилюлей, а не «1 · 2» рядом с числом: две цифры
  // подряд человек читает как дробь или как версию, и угадывает, где что.
  const overdue = list.filter(t => isOverdue(t, now)).length;
  if (overdue) {
    const flag = document.createElement('span');
    flag.className = 'matrix-overdue';
    flag.textContent = overdue + ' просрочено';
    head.appendChild(flag);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'matrix-add';
  add.setAttribute('aria-label', 'Добавить задачу в «' + quadrant.title + '»');
  add.textContent = '+';
  add.addEventListener('click', () => {
    composerOpenIn = composerOpenIn === quadrant.id ? null : quadrant.id;
    renderMatrixView();
  });
  head.appendChild(add);
  card.appendChild(head);

  const hint = document.createElement('p');
  hint.className = 'matrix-hint';
  hint.textContent = quadrant.hint;
  card.appendChild(hint);

  const body = document.createElement('div');
  body.className = 'matrix-card-body';
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'matrix-empty';
    empty.textContent = 'Пусто';
    body.appendChild(empty);
  } else {
    for (const task of list) body.appendChild(taskRow(task, now));
  }
  card.appendChild(body);

  if (composerOpenIn === quadrant.id) card.appendChild(composer(quadrant.id));
  return card;
}

// Куда предложен перенос — вынесено из разметки отдельной функцией: весь
// остальной экран это DOM, а здесь чистое решение о смысле, и оно единственное
// в листе, где можно ошибиться.
//   * текущий квадрант не предлагаем: перенос «в никуда» менял бы срок и
//     приоритет попусту (сравниваем с quadrantOf, а не с id задачи — путаница
//     этих двух идентификаторов как раз и прятала нужный пункт);
//   * «Не стоит» в списке не участвует: перенос в q4 архивирует задачу, то
//     есть это ровно та же кнопка «В архив» другими словами, а два пункта с
//     одним действием — это выбор без выбора.
export function moveOptions(task, now) {
  const current = quadrantOf(task, now);
  return QUADRANTS.filter(q => q.id !== current && q.id !== 'q4');
}

// Лист переноса: куда отнести задачу. «В архив» отдельно — это не квадрант,
// а способ убрать из матрицы, и смешивать их с осями нельзя.
function moveSheet(task) {
  const sheet = document.createElement('div');
  sheet.className = 'matrix-sheet-backdrop';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Перенести задачу');
  const panel = document.createElement('div');
  panel.className = 'matrix-sheet';
  const title = document.createElement('p');
  title.className = 'matrix-sheet-title';
  title.textContent = task.title.length > 46 ? task.title.slice(0, 46) + '…' : task.title;
  panel.appendChild(title);
  for (const q of moveOptions(task, today())) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'matrix-sheet-item q-' + q.id;
    item.innerHTML = '<span class="matrix-sheet-name">' + escapeHtml(q.title)
      + '</span><span class="matrix-sheet-hint">' + escapeHtml(q.hint) + '</span>';
    item.addEventListener('click', () => {
      moveToQuadrant(task.id, q.id);
      closeSheet();
    });
    panel.appendChild(item);
  }
  const archive = document.createElement('button');
  archive.type = 'button';
  archive.className = 'matrix-sheet-item is-archive';
  archive.textContent = 'В архив';
  archive.addEventListener('click', () => {
    archiveTask(task.id);
    closeSheet();
  });
  panel.appendChild(archive);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'matrix-sheet-cancel';
  cancel.textContent = 'Отмена';
  cancel.addEventListener('click', closeSheet);
  panel.appendChild(cancel);
  sheet.appendChild(panel);
  sheet.addEventListener('click', event => {
    if (event.target === sheet) closeSheet();
  });
  return sheet;
}

function closeSheet() {
  sheetFor = null;
  const old = document.querySelector('.matrix-sheet-backdrop');
  if (old) old.remove();
}

function openMoveSheet(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  closeSheet();
  sheetFor = taskId;
  const host = document.getElementById('matrix-view');
  if (!host) return;
  host.appendChild(moveSheet(task));
}

function persist() {
  saveTasks(tasks);
}

export function addTask(quadrantId, fields) {
  const task = createTask(fields);
  if (!task) return null;
  // Квадрант, в котором человек печатал, — это намерение, а не метка:
  // превращаем его в причину (срок/приоритет) тем же move-правилом.
  const shaped = applyQuadrantMove(task, quadrantId, today()) || task;
  tasks = [shaped].concat(tasks);
  persist();
  composerOpenIn = quadrantId;
  renderMatrixView();
  // Форма остаётся открытой для быстрой серии, но перерисовка уносила фокус:
  // на телефоне после каждой добавленной задачи клавиатура сворачивалась, и
  // человек тыкал в поле заново.
  const input = composerInput();
  if (input) input.focus();
  return shaped;
}

function composerInput() {
  const form = document.querySelector('#matrix-view .matrix-composer');
  return form ? form.querySelector('.matrix-composer-title') : null;
}

export function toggleDone(taskId) {
  let doneNow = false;
  tasks = tasks.map(t => {
    if (t.id !== taskId) return t;
    doneNow = !t.done;
    return markDone(t, !t.done);
  });
  persist();
  renderMatrixView();
  // Выполненная задача исчезает из матрицы сразу: без подписи человек не
  // понимает, куда она делась, и жмёт чекбокс ещё раз.
  if (doneNow) showToast('Выполнено');
}

export function moveToQuadrant(taskId, quadrantId) {
  let moved = null;
  tasks = tasks.map(t => {
    if (t.id !== taskId) return t;
    moved = applyQuadrantMove(t, quadrantId, today()) || t;
    return moved;
  });
  if (!moved) return null;
  persist();
  renderMatrixView();
  return moved;
}

export function archiveTask(taskId) {
  tasks = tasks.map(t => (t.id === taskId
    ? Object.assign({}, t, { archived: true, updatedAt: new Date().toISOString() })
    : t));
  persist();
  renderMatrixView();
}

export function matrixTasks() {
  return activeTasks(tasks);
}

// Вход на экран: читаем хранилище, а не живём на остатке прошлого захода —
// задача могла появиться с другого экрана или после синхронизации.
export function renderMatrixView() {
  const host = document.getElementById('matrix-view');
  if (!host) return;
  tasks = loadTasks();
  const now = today();
  const groups = groupByQuadrant(tasks, now);
  const stats = quadrantStats(tasks, now);
  const active = activeTasks(tasks);
  // Просрочки считаем по всем квадрантам: у непросроченной-важности у
  // просроченной мелочи нет, и живёт она в «Делегировать», а не в
  // «Сделать сразу» — сводка по одному квадранту врала бы человеку в заголовке.
  const overdue = QUADRANTS.reduce((n, q) => n + stats[q.id].overdue, 0);

  closeSheet();
  host.textContent = '';

  const head = document.createElement('div');
  head.className = 'matrix-header';
  const title = document.createElement('h2');
  title.className = 'matrix-title';
  title.textContent = 'Матрица';
  const sub = document.createElement('p');
  sub.className = 'matrix-sub';
  sub.textContent = active.length
    ? 'Активных задач: ' + active.length + (overdue ? ', просрочено ' + overdue : '')
    : 'Задач пока нет — добавьте в любом квадранте';
  head.append(title, sub);
  host.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'matrix-grid';
  for (const q of QUADRANTS) grid.appendChild(quadrantCard(q, groups[q.id], now));
  host.appendChild(grid);
}

// Для тестов и для будущего экрана «Важные»: состояние модуля наружу копией.
export function matrixDebugState() {
  return {
    tasks: tasks.slice(),
    composerOpenIn,
    sheetFor,
    priorityLabels: Object.assign({}, PRIORITY_LABEL),
  };
}
