/* Экран «Матрица Эйзенхауэра» — 2×2 по эталону TickTick.

   Что здесь решает внешний вид, и почему именно так:

   * Квадрант не красится полосой и не обводится: его опознаватель — бейдж с
     римской цифрой и цвет заголовка (токены --matrix-qN). Полоса сверху —
     «странная линия», которая не значит ничего.
   * Добавляет задачи одна FAB справа снизу, а не четыре «+» в шапках:
     четыре кнопки делают одно и то же, и человек выбирает квадрант уже в
     листе — там, где он видит, КУДА пишет.
   * Перенос — лист на тап по «⋯», а не drag. Причина не в лени: drag на
     телефоне конфликтует с вертикальным скроллом (а список именно
     вертикальный), а его «призрак» на пол-экрана прячет тот самый квадрант,
     куда человек целится.

   Пользовательский текст уходит через textContent, разметка собирается из
   константных строк: `<img onerror>` в заголовке задачи не должен становиться
   разметкой (в проекте это правило действует для всех пользовательских
   строк). */

import { toISODate } from '../core/dates.js';
import { showToast } from '../core/dom.js';
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
  saveTasks,
} from '../data/matrix.js';

const PRIORITY_LABEL = {
  0: 'без приоритета',
  1: 'низкий',
  2: 'средний',
  3: 'высокий',
};

// Воронка пустого квадранта — единственная иллюстрация экрана, и она же
// подкраска из styles/matrix.css: рожок, конфетти над ним и звезда под срезом.
// Асимметрия сознательная: два одинаковых завитка по бокам читались как
// усики, а конфетти в эталоне рассыпано неровно.
const FUNNEL_SVG = '<svg class="matrix-empty-art" viewBox="0 0 62 54" aria-hidden="true">'
  + '<path class="funnel-curl" d="M15 11c-2.5-3.5 2.5-6.5 3.8-2.6"/>'
  + '<path class="funnel-mark" d="M38 4l1.2 2.6 2.6 1.2-2.6 1.2L38 12.4l-1.2-2.6-2.6-1.2 2.6-1.2z"/>'
  + '<circle class="funnel-mark" cx="50" cy="13" r="1.5"/>'
  + '<ellipse class="funnel-mouth" cx="31" cy="20" rx="15" ry="5.5"/>'
  + '<path class="funnel-body" d="M16 20l11 14h6l11-14"/>'
  + '<path class="funnel-body" d="M27 34v10h8V34"/>'
  + '<path class="funnel-mark" d="M31 45.5l1.5 3.1 3.4.5-2.5 2.3.6 3.4-3-1.6-3 1.6.6-3.4-2.5-2.3 3.4-.5z"/>'
  + '</svg>';

let tasks = [];
let composerQuadrant = null;   // id квадранта открытой формы добавления
let sheetFor = null;           // id задачи, для которой открыт лист переноса

function today() {
  return new Date();
}

function quadrantById(id) {
  for (let i = 0; i < QUADRANTS.length; i++) {
    if (QUADRANTS[i].id === id) return QUADRANTS[i];
  }
  return null;
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// Бейдж с римской цифрой. Один и тот же узел и в шапке карточки, и в листе, и
// в пилюле выбора квадранта — три копии разметки разошлись бы по размеру.
function badge(quadrant) {
  return el('span', 'matrix-badge', quadrant.numeral);
}

function taskRow(task, now) {
  const overdue = isOverdue(task, now);
  const row = el('div', 'matrix-task');
  row.dataset.taskId = task.id;

  const check = el('button', 'matrix-check');
  check.type = 'button';
  check.setAttribute('aria-label', 'Отметить выполненной: ' + task.title);
  check.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">'
    + '<path d="M4 10.5l3.6 3.6L16 5.6" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  check.addEventListener('click', () => toggleDone(task.id));

  const body = el('div', 'matrix-task-body');
  const title = el('div', 'matrix-task-title', task.title);
  // Название обрезается многоточием — полный текст остаётся доступным:
  // подсказкой на десктопе и подписью чекбокса ниже.
  title.title = task.title;
  body.appendChild(title);

  const meta = el('div', 'matrix-task-meta');
  if (task.priority !== PRIORITY_NONE) {
    const dot = el('span', 'matrix-dot p' + task.priority);
    dot.title = PRIORITY_LABEL[task.priority];
    meta.appendChild(dot);
  }
  if (task.due) {
    meta.appendChild(el('span', 'matrix-due' + (overdue ? ' is-overdue' : ''),
      dueLabel(task, now)));
  }
  if (task.notes) meta.appendChild(el('span', 'matrix-note-hint', 'заметка'));
  if (meta.childNodes.length) body.appendChild(meta);

  const more = el('button', 'matrix-more', '⋯');
  more.type = 'button';
  more.setAttribute('aria-label', 'Перенести задачу: ' + task.title);
  more.addEventListener('click', () => openMoveSheet(task.id));

  row.append(check, body, more);
  return row;
}

function quadrantCard(quadrant, list, now) {
  const card = el('section', 'matrix-card q-' + quadrant.id);
  card.dataset.quadrant = quadrant.id;

  const head = el('header', 'matrix-card-head');
  head.appendChild(badge(quadrant));
  head.appendChild(el('h3', 'matrix-card-title', quadrant.title));
  card.appendChild(head);

  if (!list.length) {
    const empty = el('p', 'matrix-empty');
    empty.innerHTML = FUNNEL_SVG + '<span>Нет задач</span>';
    card.appendChild(empty);
    return card;
  }

  const body = el('div', 'matrix-list');
  for (const task of list) body.appendChild(taskRow(task, now));
  card.appendChild(body);
  return card;
}

/* --- Листы ---------------------------------------------------------------- */

function sheetShell(titleNode) {
  const backdrop = el('div', 'matrix-sheet-backdrop');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  const panel = el('div', 'matrix-sheet');
  panel.appendChild(el('div', 'matrix-sheet-grabber'));
  if (titleNode) panel.appendChild(titleNode);
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeSheet();
  });
  return { backdrop, panel };
}

function closeSheet() {
  sheetFor = null;
  composerQuadrant = null;
  const old = document.querySelector('.matrix-sheet-backdrop');
  if (old) old.remove();
}

function sheetCancel(panel, label) {
  const cancel = el('button', 'matrix-sheet-cancel', label || 'Отмена');
  cancel.type = 'button';
  cancel.addEventListener('click', closeSheet);
  panel.appendChild(cancel);
}

// Куда предложен перенос — вынесено из разметки отдельной функцией: весь
// остальной экран это DOM, а здесь чистое решение о смысле, и оно единственное
// в листе, где можно ошибиться.
//   * текущий квадрант не предлагаем: перенос «в никуда» менял бы срок и
//     приоритет попусту (сравниваем с quadrantOf, а не с id задачи — путаница
//     этих двух идентификаторов как раз и прятала нужный пункт);
//   * «не срочно и не важно» в списке не участвует: перенос в q4 архивирует
//     задачу, то есть это ровно та же кнопка «В архив» другими словами, а два
//     пункта с одним действием — это выбор без выбора.
export function moveOptions(task, now) {
  const current = quadrantOf(task, now);
  return QUADRANTS.filter(q => q.id !== current && q.id !== 'q4');
}

function openMoveSheet(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  closeSheet();
  sheetFor = taskId;
  const host = document.getElementById('matrix-view');
  if (!host) return;

  const title = el('p', 'matrix-sheet-title', task.title.length > 44
    ? task.title.slice(0, 44) + '…' : task.title);
  const { backdrop, panel } = sheetShell(title);
  panel.appendChild(el('p', 'matrix-sheet-task',
    'Сейчас: ' + (quadrantById(quadrantOf(task, today())) || {}).title));

  for (const q of moveOptions(task, today())) {
    const item = el('button', 'matrix-sheet-item q-' + q.id);
    item.type = 'button';
    item.appendChild(badge(q));
    item.appendChild(el('span', null, q.title));
    item.appendChild(el('span', 'matrix-sheet-hint', q.hint));
    item.addEventListener('click', () => {
      moveToQuadrant(task.id, q.id);
      closeSheet();
    });
    panel.appendChild(item);
  }

  const archive = el('button', 'matrix-sheet-item is-archive');
  archive.type = 'button';
  archive.textContent = 'В архив';
  archive.addEventListener('click', () => {
    archiveTask(task.id);
    closeSheet();
  });
  panel.appendChild(archive);

  sheetCancel(panel);
  host.appendChild(backdrop);
}

/* --- Форма добавления ----------------------------------------------------- */

// Квадрант выбирается прямо в форме четырьмя пилюлями: до нажатия «Добавить»
// человек видит, куда попадёт задача, — и заодно то, что выбор меняет срок и
// приоритет, а не только картинку.
function composer(quadrantId) {
  const form = el('form', 'matrix-composer');
  let chosen = quadrantId || 'q1';

  const { backdrop, panel } = sheetShell(el('p', 'matrix-sheet-title', 'Новая задача'));

  const picks = el('div', 'matrix-quadrant-picks');
  picks.setAttribute('role', 'radiogroup');
  picks.setAttribute('aria-label', 'Квадрант');
  const pickNodes = [];
  for (const q of QUADRANTS) {
    const pick = el('button', 'matrix-pick q-' + q.id);
    pick.type = 'button';
    pick.setAttribute('role', 'radio');
    pick.dataset.quadrant = q.id;
    pick.appendChild(badge(q));
    pick.appendChild(el('span', null, q.title));
    pick.addEventListener('click', () => {
      chosen = q.id;
      for (const node of pickNodes) {
        node.setAttribute('aria-checked', node.dataset.quadrant === chosen ? 'true' : 'false');
      }
    });
    pickNodes.push(pick);
    picks.appendChild(pick);
  }
  form.appendChild(picks);

  const field = el('label', 'matrix-composer-field');
  field.appendChild(el('span', 'matrix-composer-field-label', 'Что бы вы хотели сделать?'));
  const titleInput = el('input', 'matrix-composer-title');
  titleInput.type = 'text';
  titleInput.name = 'title';
  titleInput.maxLength = 200;
  titleInput.autocomplete = 'off';
  titleInput.placeholder = 'Например: позвонить в сервис';
  titleInput.required = true;
  field.appendChild(titleInput);
  form.appendChild(field);

  const row = el('div', 'matrix-composer-row');
  const dueField = el('label', 'matrix-composer-field');
  dueField.appendChild(el('span', 'matrix-composer-field-label', 'Срок'));
  const due = el('input', 'matrix-composer-due');
  due.type = 'date';
  due.name = 'due';
  dueField.appendChild(due);

  const prioField = el('label', 'matrix-composer-field');
  prioField.appendChild(el('span', 'matrix-composer-field-label', 'Приоритет'));
  const prio = el('select', 'matrix-composer-priority');
  prio.name = 'priority';
  for (const value of [0, 1, 2, 3]) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = PRIORITY_LABEL[value];
    if (value === PRIORITY_MEDIUM) option.selected = true;
    prio.appendChild(option);
  }
  prioField.appendChild(prio);
  row.append(dueField, prioField);
  form.appendChild(row);

  const actions = el('div', 'matrix-composer-actions');
  const add = el('button', 'matrix-composer-add', 'Добавить');
  add.type = 'submit';
  const cancel = el('button', 'matrix-composer-cancel', 'Отмена');
  cancel.type = 'button';
  cancel.addEventListener('click', closeSheet);
  actions.append(add, cancel);
  form.appendChild(actions);

  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = titleInput.value.trim();
    if (!name) {
      titleInput.focus();
      return;
    }
    addTask(chosen, {
      title: name,
      due: due.value || null,
      priority: Number(prio.value) || 0,
    });
    showToast('Добавлено');
  });

  for (const node of pickNodes) {
    node.setAttribute('aria-checked', node.dataset.quadrant === chosen ? 'true' : 'false');
  }
  panel.appendChild(form);
  return { backdrop, input: titleInput };
}

function openComposer(quadrantId) {
  closeSheet();
  const host = document.getElementById('matrix-view');
  if (!host) return;
  const sheet = composer(quadrantId);
  composerQuadrant = quadrantId || 'q1';
  host.appendChild(sheet.backdrop);
  sheet.input.focus();
}

/* --- Действия ------------------------------------------------------------- */

function persist() {
  saveTasks(tasks);
}

export function addTask(quadrantId, fields) {
  const task = createTask(fields);
  if (!task) return null;
  // Квадрант, который человек выбрал в форме, — это намерение, а не метка:
  // превращаем его в причину (срок/приоритет) тем же move-правилом.
  const shaped = applyQuadrantMove(task, quadrantId, today()) || task;
  tasks = [shaped].concat(tasks);
  persist();
  renderMatrixView();
  return shaped;
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
  showToast('Задача в архиве');
}

export function matrixTasks() {
  return activeTasks(tasks);
}

/* --- Экран ---------------------------------------------------------------- */

// Вход на экран: читаем хранилище, а не живём на остатке прошлого захода —
// задача могла появиться с другого экрана или после синхронизации.
export function renderMatrixView() {
  const host = document.getElementById('matrix-view');
  if (!host) return;
  tasks = loadTasks();
  const now = today();
  const groups = groupByQuadrant(tasks, now);
  const active = activeTasks(tasks);
  // Просрочки считаем по всем квадрантам: у просроченной мелочи важности нет,
  // и живёт она в «срочно, но не важно», а не в «срочно и важно» — сводка по
  // одному квадранту врала бы человеку в заголовке.
  const overdue = active.filter(t => isOverdue(t, now)).length;

  // Листы живут внутри #matrix-view, поэтому перерисовка экрана снимает их
  // сама: ни закрывать, ни восстанавливать их не нужно — открытым остаётся
  // только то, что открыли заново.
  host.textContent = '';
  composerQuadrant = null;
  sheetFor = null;

  const head = el('div', 'matrix-head');
  head.appendChild(el('h2', 'matrix-title', 'Матрица Эйзенхауэра'));
  if (overdue) {
    head.appendChild(el('p', 'matrix-alert', 'Просрочено задач: ' + overdue));
  }
  host.appendChild(head);

  const grid = el('div', 'matrix-grid');
  for (const q of QUADRANTS) grid.appendChild(quadrantCard(q, groups[q.id], now));
  host.appendChild(grid);

  const fab = el('button', 'matrix-fab');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Добавить задачу в матрицу');
  fab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">'
    + '<path d="M12 5.5v13M5.5 12h13" fill="none" stroke="currentColor" '
    + 'stroke-width="2.2" stroke-linecap="round"/></svg>';
  fab.addEventListener('click', () => openComposer('q1'));
  host.appendChild(fab);
}

// Для тестов и для будущего экрана «Важные»: состояние модуля наружу копией.
export function matrixDebugState() {
  return {
    tasks: tasks.slice(),
    composerQuadrant,
    sheetFor,
    priorityLabels: Object.assign({}, PRIORITY_LABEL),
  };
}
