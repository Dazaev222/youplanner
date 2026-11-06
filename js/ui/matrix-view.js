/* Экран «Матрица Эйзенхауэра».

   Что здесь живёт после перестройки раздела А (ТЗ от 04.11.2026):

   * Сетка 2×2 занимает всё пространство между шапкой и навигацией. Служебного
     поля под плавающую кнопку больше нет, и резерв 88/168 px под исчезнувшую
     кнопку снят: он был бронью от предыдущего дизайна, а не высотой контента.
   * В каждой карточке своя «+». Четыре локальные кнопки полностью заменяют
     прежний FAB.
   * Кнопок-многоточий нет. Всё, что они прятали, стало явным: панель
     `.matrix-toolbar` с «Показать выполненные» (aria-pressed) и «Архив (N)»,
     а перенос задачи — кнопка `.matrix-task-move` с именем
     «Перенести задачу: <название>».
   * Создание задачи — нижний ЛИСТ поверх прежнего экрана, один и тот же для
     сетки и для полноэкранного квадранта. Открытие листа НЕ перекладывает
     экран в квадрант: навигация и намерение черновика разведены.

   Два слоя DOM — #matrix-screen (экран) и #matrix-view (листы поверх него) —
   не косметика: прежняя перерисовка стирала весь холст вместе с открытым
   листом, и вложенный календарь на этом держаться не мог. Экран перерисовы-
   вается целиком, листы живут в своих узлах и переживают её, не теряя текст,
   каретку и фокус.

   Правила закрытия листа едины для крестика, подложки, Escape и перехода во
   вкладку: пустой черновик закрывается молча, непустой требует явного
   «Продолжить редактирование»/«Отбросить». Отказ хранилища поводом закрыть
   лист не считается.

   Пользовательский текст уходит через textContent, разметка собирается из
   константных строк: `<img onerror>` в заголовке задачи не должен становиться
   разметкой. Правка матрицы считается сделанной ПОСЛЕ успешной записи
   (см. commitTasks): при переполненной квоте «Добавлено» поверх несостояв-
   шейся записи было бы ложью интерфейса о сохранности данных. */

import { addDays, parseISODate, toISODate } from '../core/dates.js';
import { bus } from '../core/bus.js';
import { showErrorToast, showToast } from '../core/dom.js';
import {
  PRIORITY_HIGH,
  PRIORITY_LOW,
  PRIORITY_MEDIUM,
  PRIORITY_NONE,
  QUADRANTS,
  activeTasks,
  applyQuadrantMove,
  archiveTasks,
  completeOccurrence,
  createTask,
  doneTasks,
  editSchedule,
  groupByQuadrant,
  isAppointedSchedule,
  isOverdue,
  listForQuadrant,
  loadTasks,
  markDone,
  plannerOwnerUid,
  prepareQuadrantMove,
  purgeTask,
  quadrantOf,
  quadrantShape,
  reopenOccurrence,
  restoreTask,
  saveTasks,
  scheduleFromDue,
  startSeries,
} from '../data/matrix.js';
import {
  ALL_DAY_DEFAULT_TIME,
  MINUTES_PER_DAY,
  SCHEDULE_LIMITS,
  cloneSchedule,
  emptySchedule,
  nextOccurrence,
  normalizeSchedule,
  reminderMoment,
  scheduleDuration,
  scheduleToDue,
  validateSchedule,
} from '../data/matrix-schedule.js';

const PRIORITY_LABEL = {
  0: 'без приоритета',
  1: 'низкий',
  2: 'средний',
  3: 'высокий',
};

// Нулевой приоритет — не значение, а невыбранное состояние: кнопка остаётся
// серой и подписывается как поле, а не как «без приоритета» (в списке выбора
// 0 — такой же пункт, там текст другой). Поэтому помощники описывают именно
// кнопку, а не подменяют PRIORITY_LABEL, и правило не живёт в разметке.
function priorityClass(priority) {
  return priority === PRIORITY_NONE ? '' : ' is-set p' + priority;
}

function priorityLabel(priority) {
  return priority === PRIORITY_NONE ? 'Приоритет' : PRIORITY_LABEL[priority];
}

// Причина отказа записи называется вслух: «что-то не сохранилось» читают как
// «авось потом», а «память браузера занята» — как «надо почистить». Текст один
// на все правки, потому что важен не тип действия, а то, что правка до
// хранилища не дошла. showErrorToast — тот же единственный #toast, что у
// остальных экранов: второго слоя подсказок здесь нет.
const SAVE_ERROR_TEXT = 'Не удалось сохранить: память браузера занята, изменения не сохранены';

// Иконки — один набор, один штрих (1.6), одна сетка 24×24. Многоточия в наборе
// нет намеренно: оно ничего не обещало в имени и прятало перенос задачи.
const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/>'
    + '<path d="M3.5 10h17M8.5 3v4M15.5 3v4"/>',
  flag: '<path d="M6.5 21V4m0 .5h11l-2.2 3.7 2.2 3.8h-11"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="5" rx="1.6"/>'
    + '<path d="M5.5 9.5v8a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-8M10 13h4"/>',
  move: '<path d="M10 6H5.5A1.5 1.5 0 0 0 4 7.5v11A1.5 1.5 0 0 0 5.5 20H9"/>'
    + '<path d="M14 4l5 5-5 5"/><path d="M19 9h-9"/>',
  // Признаки расписания в строке: будильник — напоминание, круговая стрелка —
  // повтор. Оба различимы без цвета: у строки есть title с текстом правила.
  bell: '<path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4 18.5h16z"/>'
    + '<path d="M9.5 21a2.6 2.6 0 0 0 5 0"/>',
  repeat: '<path d="M4.5 10a7 7 0 0 1 12-3.5"/><path d="M19.5 14a7 7 0 0 1-12 3.5"/>'
    + '<path d="M16.5 3.5v3h-3M7.5 20.5v-3h3"/>',
};

function svgIcon(name, size) {
  const px = size || 20;
  return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px
    + '" fill="none" stroke="currentColor" stroke-width="1.6" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + ICON[name] + '</svg>';
}

// Воронка — единственная иллюстрация экрана: рожок, конфетти над ним и звезда
// под срезом. Асимметрия сознательная: два одинаковых завитка по бокам
// читались как усики, а в эталоне конфетти рассыпано неровно.
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
let showDone = false;          // выполненные видны только по явной просьбе
let openQuadrant = null;       // id квадранта в полноэкранном виде, null — сетка
let archiveOpen = false;       // тот же экран, но список архива
// Куда ведёт «назад» из архива: null — сетка, id — квадрант, из которого
// вошли. Прежнее `openQuadrant = openQuadrant || 'q1'` выдумывало первый
// квадрант на пустом архиве, и человек возвращался не туда.
let returnView = null;
let draft = null;              // черновик листа создания; null — лист закрыт
let draftSnapshot = null;      // снимок расписания при открытии: отличает правку от onboarding
let opener = null;             // узел «+», с которого открыли лист
let openerQuadrant = null;     // его квадрант — нужен для возврата фокуса
let pendingQuadrant = null;    // квадрант для «+», открытой после «Отбросить»
let detailAdd = null;          // «Добавить» полноэкранного вида — тот же opener
// Кнопки «+» сетки по квадрантам. Экран перерисовывается ЦЕЛИКОМ (так делает
// commitTasks после каждой успешной правки), и ссылка на узел из снятого дерева
// фокус не вернула бы — браузер отдал бы его body. Поэтому при закрытии ищем
// актуальный узел того же места.
let gridAdd = {};
let submitting = false;        // одна точка submit: второй Enter не дублирует

// Стек листов поверх экрана. Порядок — нижний первым, верхний последним; Escape
// работает с последним. У слоя есть id (повторное открытие ЗАМЕНЯЕТ слой, а не
// плодит второй) и parent: дочерний слой закрывается вместе с родителем, чтобы
// закрытие листа создания не оставляло висящий над пустотой календарь.
let overlays = [];

function today() {
  return new Date();
}

function quadrantById(id) {
  for (let i = 0; i < QUADRANTS.length; i++) {
    if (QUADRANTS[i].id === id) return QUADRANTS[i];
  }
  return null;
}

// «2 дня», «5 дней», «21 день» — русская форма, а не «2 дней».
function pluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

function dueLabel(task, now) {
  if (!task.due) return '';
  const due = new Date(task.due + 'T00:00:00');
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - startOfToday) / 86400000);
  let text;
  if (days < 0) text = 'просрочено';
  else if (days === 0) text = 'сегодня';
  else if (days === 1) text = 'завтра';
  // До двух недель срок ближе как относительная дата: «через 4 дня» человек
  // считывает быстрее, чем сверяет «7 ноя» с календарём в голове.
  else if (days <= 14) text = 'через ' + days + ' ' + pluralDays(days);
  else text = due.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return withScheduleTime(task, text);
}

// У назначенного интервала к ярлыку добавляется время начала: «сегодня» в 9:00
// и «сегодня» на весь день — разные намерения, различать их одним словом было
// бы враньём интерфейса. Ведущий ноль убран — так пишут время в списках.
function withScheduleTime(task, text) {
  const schedule = task && task.schedule;
  if (!schedule || schedule.allDay !== false || !schedule.startTime) return text;
  return text + ' · ' + String(schedule.startTime).replace(/^0(\d):/, '$1:');
}

// Краткие признаки расписания для плашки срока: повтор и напоминание должны
// быть видны в листе создания, иначе «Готово» календаря становится единствен-
// ным местом, где человек узнаёт о настроенном правиле.
function scheduleMarks(schedule) {
  if (!schedule) return '';
  let text = '';
  if (schedule.repeat) text += ' · ' + calRepeatText(schedule.repeat);
  if (schedule.reminders && schedule.reminders.length) text += ' · напоминание';
  return text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function iconButton(name, className, label, size) {
  const btn = el('button', 'matrix-icon ' + className);
  btn.type = 'button';
  btn.innerHTML = svgIcon(name, size);
  btn.setAttribute('aria-label', label);
  return btn;
}

function badge(quadrant) {
  return el('span', 'matrix-badge', quadrant.numeral);
}

function emptyBlock(label, sub) {
  const box = el('div', 'matrix-empty');
  box.innerHTML = FUNNEL_SVG;
  box.appendChild(el('p', 'matrix-empty-label', label));
  if (sub) box.appendChild(el('p', 'matrix-empty-sub', sub));
  return box;
}

/* --- Слои поверх экрана ---------------------------------------------------- */

function overlayById(id) {
  for (let i = 0; i < overlays.length; i++) if (overlays[i].id === id) return overlays[i];
  return null;
}

// id + всё, что транзитивно на него ссылается родителем. Один проход по списку
// не снял бы цепочку «календарь -> выбор напоминания», висящую над листом.
function overlayFamily(id) {
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const layer of overlays) {
      if (layer.parent && doomed.has(layer.parent) && !doomed.has(layer.id)) {
        doomed.add(layer.id);
        grew = true;
      }
    }
  }
  return doomed;
}

function removeOverlay(id) {
  if (!overlays.some(layer => layer.id === id)) return false;
  const doomed = overlayFamily(id);
  overlays = overlays.filter(layer => {
    if (!doomed.has(layer.id)) return true;
    if (layer.node && layer.node.remove) layer.node.remove();
    return false;
  });
  syncOverlayChrome();
  return true;
}

function pushOverlay(layer) {
  const host = document.getElementById('matrix-view');
  if (!host) return null;
  removeOverlay(layer.id);
  overlays.push(layer);
  host.appendChild(layer.node);
  syncOverlayChrome();
  // Диалог забирает фокус сам: оставить его на фоне, который только что стал
  // недоступным, — значит потерять и клавиатуру, и скринридер.
  if (layer.focusTarget) focusNode(layer.focusTarget);
  return layer;
}

// Фон под открытым слоем недоступен: без этого таб-бар и карточки отвечали бы
// на тапы и нажатия, пока человек отвечает на вопрос «Отбросить черновик?».
function syncOverlayChrome() {
  const open = overlays.length > 0;
  const screen = document.getElementById('matrix-screen');
  if (document.body && document.body.classList) {
    document.body.classList.toggle('matrix-sheet-open', open);
  }
  if (screen) {
    if (open) screen.setAttribute('aria-hidden', 'true');
    else screen.removeAttribute('aria-hidden');
    screen.inert = open;
  }
}

function focusNode(node) {
  if (node && typeof node.focus === 'function') node.focus();
}

// Tab и Shift+Tab не гуляют по фону: обход держится внутри верхнего окна.
// Фон под листом уже inert, но без ловушки Tab уводил бы каретку за край
// диалога — и человек возвращался бы к списку клавиатурой, чего диалог
// обещать не должен.
const FOCUSABLE_SELECTOR = 'button, textarea, input, [tabindex]';

function trapTab(panel) {
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const nodes = Array.prototype.slice.call(panel.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(node => !node.disabled);
    if (!nodes.length) return;
    const at = nodes.indexOf(document.activeElement);
    let next;
    if (at < 0) next = nodes[0];
    else if (event.shiftKey) next = at === 0 ? nodes[nodes.length - 1] : nodes[at - 1];
    else next = at === nodes.length - 1 ? nodes[0] : nodes[at + 1];
    event.preventDefault();
    focusNode(next);
  });
}

export function isTaskComposerOpen() {
  return !!overlayById('composer');
}

/* --- Строка задачи -------------------------------------------------------- */

function taskRow(task, now, options) {
  const opts = options || {};
  const overdue = isOverdue(task, now);
  const row = el('div', 'matrix-task'
    + (opts.plain ? ' is-plain' : '')
    + (opts.archive ? ' is-archive' : '')
    + (task.done ? ' is-done' : ''));
  row.dataset.taskId = task.id;

  const check = el('button', 'matrix-check');
  check.type = 'button';
  check.setAttribute('aria-label', (task.done ? 'Вернуть в работу: ' : 'Отметить выполненной: ')
    + task.title);
  check.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">'
    + '<path d="M4 10.5l3.6 3.6L16 5.6" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  check.addEventListener('click', () => toggleDone(task.id));

  const body = el('div', 'matrix-task-body');
  const title = el('div', 'matrix-task-title', task.title);
  // Название может обрезаться — полный текст остаётся доступным подсказкой.
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
  // Признаки расписания читаются прямо в строке: напоминание и повтор видно до
  // того, как человек откроет лист, — и их нельзя потерять при перерисовке.
  if (task.schedule && task.schedule.repeat) {
    const mark = el('span', 'matrix-repeat-mark');
    mark.innerHTML = svgIcon('repeat', 14);
    mark.title = 'Повтор: ' + calRepeatText(task.schedule.repeat);
    meta.appendChild(mark);
  }
  if (task.schedule && task.schedule.reminders && task.schedule.reminders.length) {
    const mark = el('span', 'matrix-reminder-mark');
    mark.innerHTML = svgIcon('bell', 14);
    mark.title = 'Напоминание: ' + calReminderText(task.schedule.reminders[0]);
    meta.appendChild(mark);
  }
  if (task.notes) meta.appendChild(el('span', 'matrix-note-hint', task.notes));
  if (meta.childNodes.length) body.appendChild(meta);

  // В архиве галочка не нужна: карточка уже снята с матрицы, а «выполнено»
  // поверх «в архиве» — состояние, которое никуда не ведёт. Плюс строка
  // из трёх кнопок на телефоне теснит две настоящие.
  if (opts.archive) {
    row.appendChild(body);
    const restore = el('button', 'matrix-act', 'Вернуть');
    restore.type = 'button';
    restore.addEventListener('click', () => restoreFromArchive(task.id));
    const drop = el('button', 'matrix-act is-danger', 'Удалить');
    drop.type = 'button';
    drop.addEventListener('click', () => confirmPurge(task));
    row.append(restore, drop);
    return row;
  }

  row.appendChild(check);
  row.appendChild(body);
  // Явное действие «Изменить дату и время» (ТЗ Б4.10): галочка точкой
  // редактирования расписания не становится — у неё уже есть своё намерение.
  // Обе кнопки живут в одной обёртке, чтобы строка осталась трёхколоночной и
  // на телефоне, где места ровно на один ряд кнопок.
  const actions = el('div', 'matrix-task-actions');
  const schedule = el('button', 'matrix-task-schedule');
  schedule.type = 'button';
  schedule.innerHTML = svgIcon('calendar', 18);
  schedule.setAttribute('aria-label', 'Изменить дату и время: ' + task.title);
  schedule.addEventListener('click', () => openDateSheet({ taskId: task.id }));
  actions.appendChild(schedule);
  // Многоточие было единственной точкой переноса и ничего не обещало в имени.
  // Теперь это явная кнопка перемещения с тем же листом за ней.
  const move = el('button', 'matrix-task-move');
  move.type = 'button';
  move.innerHTML = svgIcon('move', 18);
  move.setAttribute('aria-label', 'Перенести задачу: ' + task.title);
  move.addEventListener('click', () => openMoveSheet(task.id));
  actions.appendChild(move);
  row.appendChild(actions);
  return row;
}

/* --- Панель явных действий ------------------------------------------------ */

// Прежние «⋯» в шапке сетки и полноэкранного вида прятали ровно две вещи, и
// обе стоят теперь словами: показ выполненных (состояние читается по
// aria-pressed) и архив со счётчиком. «Архив (0)» показывается и при пустом
// архиве — молча пустой раздел человек прочитал бы как отсутствие функции.
function matrixToolbar(options) {
  const opts = options || {};
  const bar = el('div', 'matrix-toolbar');

  const done = el('button', 'matrix-toolbar-action matrix-toolbar-done');
  done.type = 'button';
  done.setAttribute('aria-pressed', showDone ? 'true' : 'false');
  const doneMark = el('span', 'matrix-toolbar-icon');
  doneMark.innerHTML = svgIcon('check', 18);
  done.append(doneMark, el('span', 'matrix-toolbar-label',
    showDone ? 'Скрыть выполненные' : 'Показать выполненные'));
  done.addEventListener('click', () => {
    showDone = !showDone;
    renderMatrixView();
  });
  bar.appendChild(done);

  if (opts.withArchive !== false) {
    const archived = archiveTasks(tasks).length;
    const box = el('button', 'matrix-toolbar-action matrix-toolbar-archive');
    box.type = 'button';
    const boxMark = el('span', 'matrix-toolbar-icon');
    boxMark.innerHTML = svgIcon('archive', 18);
    box.append(boxMark, el('span', 'matrix-toolbar-label', 'Архив (' + archived + ')'));
    box.addEventListener('click', () => openArchiveView());
    bar.appendChild(box);
  }
  return bar;
}

/* --- Сетка 2×2 ------------------------------------------------------------ */

function quadrantCard(quadrant, list, now) {
  const card = el('section', 'matrix-card q-' + quadrant.id);
  card.dataset.quadrant = quadrant.id;
  card.setAttribute('aria-label', quadrant.title);

  // Заголовок и «+» — СОСЕДИ в одной строке, а не кнопка в кнопке: вложенный
  // button и разметку ломает, и тап по «+» всплывает в обработчик заголовка,
  // который открыл бы полноэкранный список вместо листа создания.
  // Плашка-пилюля с римской цифрой внутри выглядела инородным элементом, а
  // перенос «+» на вторую строку на 390 px вешал его в воздухе: строка больше
  // не переносится, при нехватке ширины переносится только название.
  const header = el('div', 'matrix-card-header');

  const head = el('button', 'matrix-card-head');
  head.type = 'button';
  head.setAttribute('aria-label', 'Открыть квадрант: ' + quadrant.title);
  head.appendChild(el('span', 'matrix-card-dot'));
  head.appendChild(el('span', 'matrix-card-title', quadrant.title));
  head.addEventListener('click', () => openQuadrantView(quadrant.id));

  const add = el('button', 'matrix-card-add');
  add.type = 'button';
  add.setAttribute('aria-label', 'Добавить задачу: ' + quadrant.title);
  add.innerHTML = svgIcon('plus', 18);
  add.addEventListener('click', () => openTaskComposer({
    quadrantId: quadrant.id,
    opener: add,
  }));
  gridAdd[quadrant.id] = add;

  header.append(head, add);
  card.appendChild(header);

  if (!list.length) {
    const empty = emptyBlock('Нет задач');
    empty.className = 'matrix-empty is-card';
    card.appendChild(empty);
    return card;
  }

  const body = el('div', 'matrix-list');
  for (const task of list) body.appendChild(taskRow(task, now));
  card.appendChild(body);
  return card;
}

function renderGrid(host, now) {
  gridAdd = {};
  const groups = groupByQuadrant(tasks, now, showDone);
  const visible = showDone
    ? activeTasks(tasks).concat(doneTasks(tasks))
    : activeTasks(tasks);
  const overdue = visible.filter(t => isOverdue(t, now)).length;

  const head = el('div', 'matrix-head');
  head.appendChild(el('h2', 'matrix-title', 'Матрица Эйзенхауэра'));
  if (overdue) {
    head.appendChild(el('p', 'matrix-alert', 'Просрочено задач: ' + overdue));
  }
  // Плашка о хранении раздела. До plannerV1 (ТЗ §1.4) матрица жила только на
  // устройстве, и сказать об этом заранее было обязанностью интерфейса.
  // Слияние отменило эту локальность — но только у подтверждённого владельца:
  // в анонимном режиме публикацию держит закрытым владелец-гейт
  // (plannerPublishNode), и список по-прежнему не уезжает никуда. Врать в обе
  // стороны нельзя: прежняя строка «не синхронизируются» читается как
  // «на втором телефоне потеряю всё», а обещание облака анонимному режиму —
  // как «обещали и не довезли».
  head.appendChild(el('p', 'matrix-sync-note', plannerOwnerUid()
    ? 'Задачи матрицы синхронизируются с вашим аккаунтом'
    : 'Задачи матрицы хранятся только на этом устройстве: без входа в аккаунт они не уходят в облако'));
  host.appendChild(head);

  host.appendChild(matrixToolbar());

  const grid = el('div', 'matrix-grid');
  for (const q of QUADRANTS) grid.appendChild(quadrantCard(q, groups[q.id], now));
  host.appendChild(grid);
}

/* --- Полноэкранный вид квадранта и архив --------------------------------- */

// Третья колонка шапки — пустой span: место под «⋯» больше не резервируем, но
// сетка 44/1fr/44 держит заголовок по центру ровно так же, как с кнопкой.
function detailHead(titleText) {
  const head = el('header', 'matrix-detail-head');
  const back = iconButton('back', 'matrix-back', 'Назад к матрице');
  back.addEventListener('click', () => {
    if (archiveOpen) closeArchiveView();
    else {
      openQuadrant = null;
      renderMatrixView();
    }
  });
  head.appendChild(back);
  head.appendChild(el('h2', 'matrix-detail-title', titleText));
  head.appendChild(el('span', 'matrix-detail-head-space'));
  return head;
}

function detailList(items) {
  const rows = el('div', 'matrix-detail-list');
  for (const item of items) rows.appendChild(item);
  return rows;
}

function renderDetail(host, now) {
  const quadrant = quadrantById(openQuadrant);
  if (!quadrant) {
    openQuadrant = null;
    renderGrid(host, now);
    return;
  }
  const wrap = el('div', 'matrix-detail q-' + quadrant.id);
  wrap.appendChild(detailHead(quadrant.title));
  wrap.appendChild(matrixToolbar());

  const body = el('div', 'matrix-detail-body');
  const list = listForQuadrant(tasks, quadrant.id, now, showDone);
  if (!list.length) {
    body.appendChild(emptyBlock('Нет задач', 'Здесь появятся задачи'));
  } else {
    body.appendChild(detailList(list.map(task => {
      const item = el('div', 'matrix-detail-item q-' + quadrantOf(task, now));
      item.appendChild(taskRow(task, now, { plain: true }));
      return item;
    })));
  }
  wrap.appendChild(body);

  wrap.appendChild(detailAddLine(quadrant));
  host.appendChild(wrap);
}

// «Добавить» в полноэкранном квадранте открывает ТОТ ЖЕ нижний лист, что и «+»
// в сетке: вторая форма создания на экране означала бы два разных контракта.
function detailAddLine(quadrant) {
  const line = el('div', 'matrix-detail-actions');
  const add = el('button', 'matrix-detail-add');
  add.type = 'button';
  add.setAttribute('aria-label', 'Добавить задачу: ' + quadrant.title);
  const mark = el('span', 'matrix-detail-add-icon');
  mark.innerHTML = svgIcon('plus', 18);
  add.append(mark, el('span', 'matrix-detail-add-label', 'Добавить'));
  add.addEventListener('click', () => openTaskComposer({ quadrantId: quadrant.id, opener: add }));
  detailAdd = add;
  line.appendChild(add);
  return line;
}

function renderArchive(host, now) {
  const archived = archiveTasks(tasks);
  const wrap = el('div', 'matrix-detail is-archive');
  wrap.appendChild(detailHead('Архив (' + archived.length + ')'));
  // Собственной кнопки архива здесь нет: человек уже внутри.
  wrap.appendChild(matrixToolbar({ withArchive: false }));

  const body = el('div', 'matrix-detail-body');
  if (!archived.length) {
    body.appendChild(emptyBlock('Архив пуст',
      'Сюда попадают снятые задачи — их можно вернуть в матрицу'));
  } else {
    body.appendChild(detailList(archived.map(task => {
      const item = el('div', 'matrix-detail-item');
      item.appendChild(taskRow(task, now, { plain: true, archive: true }));
      return item;
    })));
  }
  wrap.appendChild(body);
  host.appendChild(wrap);
}

function openArchiveView() {
  if (archiveOpen) return;
  returnView = openQuadrant || null;
  archiveOpen = true;
  renderMatrixView();
}

function closeArchiveView() {
  archiveOpen = false;
  openQuadrant = returnView;
  returnView = null;
  renderMatrixView();
}

/* --- Черновик и нижний лист создания ------------------------------------- */

// Черновик обязан брать ПРИЧИНУ из quadrantShape: прежний `newDraft` ставил
// средний приоритет всем четверым, и «срочно, но не важно» с плашкой q3
// считалось важным и уезжало в q1 ещё до сохранения.
//
// `schedule` — рабочая копия расписания (ТЗ Б6.1): намерение квадранта
// применяется сначала по-старому (quadrantShape → due), и только потом из него
// нормализуется интервал. Так сохранение без захода в календарь попадает ровно
// туда, куда нажали «+», а календарь получает полноценный объект, а не пять
// разрозненных полей. `scheduleSnapshot` нужен одному вопросу: не трогал ли
// человек расписание (закрыть лист с несброшенным расписанием = потерять ввод).
function newDraft(quadrantId) {
  const now = today();
  const id = quadrantById(quadrantId) ? quadrantId : 'q1';
  const shape = quadrantShape(id, {}, now) || { due: null, priority: PRIORITY_NONE };
  return {
    quadrant: id,
    title: '',
    notes: '',
    due: shape.due,
    priority: shape.priority,
    schedule: scheduleFromDue(shape.due),
    // Б6.2: пока расписание не правили руками, плашка показывает намерение;
    // после правки — реальный quadrantOf.
    quadrantResolved: false,
  };
}

function draftIsDirty() {
  return !!draft
    && (!!String(draft.title || '').trim()
      || !!String(draft.notes || '').trim()
      || scheduleEdited());
}

// Расписание считается изменённым, если оно разошлось со снимком, сделанным
// при открытии листа: «плюс» в q1 сам ставит сегодня, и это не правка.
function scheduleEdited() {
  if (!draft || !draftSnapshot) return false;
  return JSON.stringify(draft.schedule) !== draftSnapshot;
}

/* Узкий API листа (ТЗ А5). Открытие не трогает навигацию; закрытие отвечает на
   вопрос «можно ли уже уходить», и ответ всегда однозначен: true — лист закрыт. */

export function openTaskComposer(options) {
  const opts = options || {};
  const quadrant = quadrantById(opts.quadrantId);
  if (!quadrant) return false;

  if (isTaskComposerOpen()) {
    if (draft.quadrant === quadrant.id) return true;
    if (draftIsDirty()) {
      // Открытие другой «+» при непустом черновике — явное решение, а не
      // подмена: иначе набранный текст исчезает от одного случайного тапа.
      pendingQuadrant = quadrant.id;
      opener = opts.opener || null;
      openerQuadrant = quadrant.id;
      openDiscardPrompt();
      return false;
    }
    removeOverlay('composer');
  }

  opener = opts.opener || null;
  openerQuadrant = quadrant.id;
  pendingQuadrant = null;
  draft = newDraft(quadrant.id);
  draftSnapshot = JSON.stringify(draft.schedule);
  pushOverlay(buildComposerOverlay());
  return true;
}

// `reason` — 'button' | 'backdrop' | 'escape' | 'navigate'. Он принимается,
// потому что правило ОДНО для всех четырёх путей (ТЗ А2.9): пустой черновик
// закрывается, непустой требует ответа. Различий в поведении по причине нет, и
// заводить их означало бы четыре разных контракта там, где человек ожидает
// одного.
export function requestCloseTaskComposer(reason) {
  if (!isTaskComposerOpen()) return true;
  if (draftIsDirty()) {
    openDiscardPrompt();
    return false;
  }
  closeTaskComposer();
  return true;
}

function closeTaskComposer() {
  const target = resolveOpener();
  removeOverlay('composer');
  draft = null;
  draftSnapshot = null;
  opener = null;
  openerQuadrant = null;
  pendingQuadrant = null;
  focusNode(target);
}

// Живой узел для возврата фокуса: полноэкранный вид отдаёт свою «Добавить»,
// сетка — кнопку того квадранта, с которым лист открыли.
function resolveOpener() {
  if (openQuadrant && !archiveOpen) return detailAdd || opener;
  return gridAdd[openerQuadrant] || opener;
}

// Подтверждение с двумя ответами. `onCancel` — безопасный: его вызывают
// Подтверждение с двумя ответами. Безопасный ответ помечен в действии словом
// `safe`: именно его вызывают подложка и Escape, и на него же ставится фокус.
// Позицией это не выражается намеренно: у вопроса про черновик безопасный
// ответ стоит первым, у удаления из архива — вторым, и «первая кнопка» была бы
// в одном из них кнопкой беды.
function confirmLayer(options) {
  const backdrop = el('div', 'matrix-sheet-backdrop is-confirm');
  const panel = el('div', 'matrix-sheet matrix-confirm');
  const headingId = 'matrix-confirm-heading';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', headingId);
  const heading = el('p', 'matrix-confirm-heading', options.heading);
  heading.id = headingId;
  panel.appendChild(heading);
  if (options.text) panel.appendChild(el('p', 'matrix-confirm-text', options.text));

  const safe = options.actions.filter(a => a.safe)[0] || options.actions[0];
  const actions = el('div', 'matrix-confirm-actions');
  let focusTarget = null;
  for (const action of options.actions) {
    const btn = el('button', 'matrix-confirm-action ' + action.className);
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      removeOverlay('confirm');
      action.onClick();
    });
    if (action === safe) focusTarget = btn;
    actions.appendChild(btn);
  }
  panel.appendChild(actions);
  backdrop.appendChild(panel);
  trapTab(panel);

  const cancel = () => {
    removeOverlay('confirm');
    safe.onClick();
  };
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) cancel();
  });
  return {
    id: 'confirm',
    kind: 'confirm',
    node: backdrop,
    panel,
    focusTarget,
    onEscape: cancel,
  };
}

// Спросить один раз и вернуть человека в то же поле, где он стоял: вопрос не
// должен сбрасывать каретку в начало формы.
function openDiscardPrompt() {
  if (overlayById('confirm')) return;
  const wasFocused = document.activeElement;
  pushOverlay(confirmLayer({
    heading: 'Черновик ещё не сохранён',
    text: 'Набранное не стало задачей. Что сделать?',
    actions: [
      {
        label: 'Продолжить редактирование',
        className: 'matrix-confirm-keep',
        safe: true,
        onClick: () => {
          pendingQuadrant = null;
          focusNode(wasFocused);
        },
      },
      {
        label: 'Отбросить',
        className: 'matrix-confirm-discard',
        onClick: () => {
          const next = pendingQuadrant;
          const nextOpener = opener;
          closeTaskComposer();
          if (next) openTaskComposer({ quadrantId: next, opener: nextOpener });
        },
      },
    ],
  }));
}

// Безвозвратное удаление из архива — единственная правка, которую нельзя
// отменить. Название задачи в вопросе обязательно: «Удалить» в строке списка
// не говорит, ЧТО именно стирается.
function confirmPurge(task) {
  if (overlayById('confirm')) return;
  pushOverlay(confirmLayer({
    heading: 'Удалить безвозвратно?',
    text: 'Задача «' + task.title + '» будет стёрта с этого устройства. Отменить это нельзя.',
    actions: [
      {
        label: 'Удалить',
        className: 'matrix-confirm-accept is-danger',
        onClick: () => { purgeArchived(task.id); },
      },
      {
        label: 'Отмена',
        className: 'matrix-confirm-cancel',
        safe: true,
        onClick: () => {},
      },
    ],
  }));
}

function buildComposerOverlay() {
  const backdrop = el('div', 'matrix-sheet-backdrop is-composer');
  const panel = el('div', 'matrix-sheet is-composer');
  const headingId = 'matrix-composer-heading';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', headingId);
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) requestCloseTaskComposer('backdrop');
  });


  const head = el('div', 'matrix-sheet-head');
  const close = iconButton('close', 'matrix-sheet-x matrix-composer-close', 'Закрыть');
  close.addEventListener('click', () => requestCloseTaskComposer('button'));
  head.appendChild(close);
  const heading = el('p', 'matrix-composer-heading', 'Новая задача');
  heading.id = headingId;
  head.appendChild(heading);
  head.appendChild(el('span', 'matrix-sheet-head-space'));
  panel.appendChild(head);

  const form = el('form', 'matrix-composer');
  const layer = {
    id: 'composer',
    kind: 'composer',
    node: backdrop,
    panel,
    form,
    // Escape идёт через ТОТ ЖЕ запрос закрытия, что и крестик с подложкой: без
    // этого слоя лист сорвался бы и при непустом черновике, и фокус не вернулся
    // бы (removeOverlay сам по себе состоянием черновика не владеет).
    onEscape: () => requestCloseTaskComposer('escape'),
  };

  const title = el('textarea', 'matrix-composer-title');
  title.name = 'title';
  title.rows = 1;
  title.maxLength = 200;
  title.placeholder = 'Что бы вы хотели сделать?';
  title.setAttribute('aria-label', 'Название задачи');
  title.value = draft.title;
  title.addEventListener('input', () => {
    draft.title = title.value;
    autoGrow(title);
  });
  layer.title = title;
  layer.focusTarget = title;

  const notes = el('input', 'matrix-composer-notes');
  notes.type = 'text';
  notes.name = 'notes';
  notes.maxLength = 2000;
  notes.placeholder = 'Описание';
  notes.setAttribute('aria-label', 'Описание задачи');
  notes.value = draft.notes;
  notes.addEventListener('input', () => { draft.notes = notes.value; });

  const line = el('div', 'matrix-composer-line');
  layer.line = line;

  form.append(title, notes, line);
  form.addEventListener('submit', event => {
    event.preventDefault();
    submitDraft();
  });
  form.addEventListener('keydown', event => {
    // Enter в заголовке = «добавить», Shift+Enter = перенос строки. В эталоне
    // отправка именно с клавиатуры, и мышкой по экрану никто не обязан
    // попадать по галочке.
    if (event.key === 'Enter' && !event.shiftKey && event.target === title) {
      event.preventDefault();
      submitDraft();
    }
  });
  panel.appendChild(form);

  trapTab(panel);
  refreshComposerLine(layer);
  return layer;
}

// Строка атрибутов перерисовывается целиком, поля — нет: смена квадранта,
// срока и приоритета не имеет права съедать набранный текст и каретку.
function refreshComposerLine(layer) {
  if (!layer || !layer.line) return;
  layer.line.textContent = '';
  const picked = quadrantById(draft.quadrant) || QUADRANTS[0];

  // Квадрант в строке атрибутов — такой же текстовый чип, как срок и
  // приоритет: залитая пастелью пилюля рядом с двумя прозрачными кнопками
  // выглядела вставкой из другой системы.
  const pill = el('button', 'matrix-quad-pill q-' + draft.quadrant);
  pill.type = 'button';
  pill.setAttribute('aria-label', 'Квадрант: ' + picked.title);
  pill.appendChild(el('span', 'matrix-card-dot'));
  pill.appendChild(el('span', null, picked.title));
  pill.addEventListener('click', () => openQuadrantMenu());
  layer.line.appendChild(pill);

  const due = el('button', 'matrix-attr' + (draft.due ? ' is-set' : ''));
  due.type = 'button';
  due.innerHTML = svgIcon('calendar', 18);
  // Плашка срока называет не только дату: назначенный интервал отличается от
  // «весь день» временем, а повтор и напоминание видно до открытия листа (Б4.8).
  due.appendChild(el('span', 'matrix-attr-label',
    (draft.due ? dueLabel({ due: draft.due, schedule: draft.schedule }, today()) : 'Срок')
      + scheduleMarks(draft.schedule)));
  due.setAttribute('aria-label', 'Срок исполнения');
  due.addEventListener('click', () => openDateSheet());
  layer.line.appendChild(due);

  const flag = el('button', 'matrix-attr' + priorityClass(draft.priority));
  flag.type = 'button';
  flag.innerHTML = svgIcon('flag', 18);
  flag.appendChild(el('span', 'matrix-attr-label', priorityLabel(draft.priority)));
  flag.setAttribute('aria-label', 'Приоритет');
  flag.addEventListener('click', () => openPriorityMenu());
  layer.line.appendChild(flag);

  const send = el('button', 'matrix-send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Добавить задачу');
  send.innerHTML = svgIcon('check', 22);
  layer.line.appendChild(send);
}

function refreshComposer() {
  refreshComposerLine(overlayById('composer'));
}

function focusComposer() {
  focusNode((overlayById('composer') || {}).title);
}

function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = Math.min(120, node.scrollHeight || 0) + 'px';
}

// Единственная точка отправки. `submitting` держит повторное событие в том же
// такте, а пустой черновик после закрытия листа — вторую задачу.
export function submitDraft() {
  if (submitting || !isTaskComposerOpen()) return false;
  const name = String(draft.title || '').trim();
  if (!name) {
    showToast('Нужно название задачи');
    return false;
  }
  const quadrant = draft.quadrant;
  const fields = {
    title: name,
    notes: draft.notes,
    due: draft.due,
    priority: draft.priority,
    // Б6.2: расписание из календаря — согласованный черновик, а не «намерение
    // квадранта, которое надо ещё раз прогнать через shape». addTask различает
    // эти два случая по наличию schedule в полях.
    schedule: scheduleEdited() ? cloneSchedule(draft.schedule) : null,
  };
  // Черновик сбрасывается ДО записи — единственная перерисовка (внутри
  // commitTasks) показывает уже пустой список. Не состоялась запись — черновик
  // возвращается ЦЕЛИКОМ, вместе со сроком, расписанием и приоритетом, а лист
  // остаётся открытым: отказ хранилища не повод выбрасывать ввод.
  const typed = draft;
  const typedSnapshot = draftSnapshot;
  draft = newDraft(quadrant);
  submitting = true;
  let added = null;
  try {
    added = addTask(quadrant, fields);
  } finally {
    submitting = false;
  }
  if (added) {
    closeTaskComposer();
    showToast('Добавлено');
    return true;
  }
  draft = typed;
  draftSnapshot = typedSnapshot;
  renderMatrixView();
  return false;
}

// Выбор квадранта в листе — это выбор ПРИЧИНЫ: срок и приоритет переставляются
// тем же правилом, что и перенос карточки (quadrantShape), иначе форма и
// перенос означали бы разное. Экран за выбором НЕ идёт: лист лежит поверх
// любого экрана, и переключение плашки не имеет права уводить человека из сетки
// в полноэкранный вид и обратно.
//
// Б6.1/Б6.3: пока интервал не назначен, работает прежняя причина (в q2 срок
// снимается). Назначенный интервал при смене намерения СДВИГАЕТСЯ по правилам
// Б6.4, а не обнуляется молча — для этого черновик на минуту становится
// обычным объектом задачи и проходит то же applyQuadrantMove: правило одно,
// и второго экземпляра логики переноса в экране нет.
export function pickDraftQuadrant(quadrantId) {
  if (!quadrantById(quadrantId)) return false;
  if (!isTaskComposerOpen()) return false;
  const keep = { due: draft.due, priority: draft.priority };
  draft.quadrant = quadrantId;
  const shape = quadrantShape(quadrantId, keep, today());
  if (shape) {
    draft.due = shape.due;
    draft.priority = shape.priority;
  }
  if (isAppointedSchedule(draft.schedule)) {
    const moved = applyQuadrantMove({
      id: DRAFT_TASK_ID,
      title: draft.title || ' ',
      notes: draft.notes,
      priority: draft.priority,
      due: draft.due,
      schedule: draft.schedule,
    }, quadrantId, today());
    draft.schedule = moved ? moved.schedule : draft.schedule;
    draft.due = moved ? moved.due : draft.due;
  } else {
    // Даты следуют за сроком (Б6.3), но настроенные напоминания не стираются:
    // относительные следуют за новой датой, как и у назначенного интервала.
    const reminders = draft.schedule && Array.isArray(draft.schedule.reminders)
      ? draft.schedule.reminders : [];
    const rebuilt = scheduleFromDue(draft.due);
    if (rebuilt && reminders.length) rebuilt.reminders = reminders;
    draft.schedule = rebuilt;
  }
  draft.quadrantResolved = false;
  refreshComposer();
  return true;
}

const DRAFT_TASK_ID = 'draft';

/* Контракт с Воркером 2 (ТЗ А5): лист обмена расписанием отдаёт и принимает
   КОПИИ, а apply вызывает только «Готово» календаря. Интеграция интервала
   выполнена — адаптер больше не живёт над одной `due`: наружу уходит
   нормализованный schedule версии 1, а `due` выводится из endDate (Б3.1). */

export function getDraftSchedule() {
  if (!draft) return null;
  return cloneSchedule(draft.schedule);
}

// Единственная точка, куда календарь складывает результат. Валидация уже
// пройдена листом, но здесь она повторяется сознательно: applyDraftSchedule —
// публичный API, и вызвать его может не только этот лист. `null` наружу не
// принимается: сброс — это пустой schedule, а не «значения не было».
export function applyDraftSchedule(value) {
  if (!draft) return false;
  if (!value || typeof value !== 'object') return false;
  if (validateSchedule(value).ok === false) return false;
  const normalized = normalizeSchedule(value, {
    legacyDue: typeof value.due === 'string' ? value.due : null,
  }).schedule;
  draft.schedule = normalized;
  draft.due = scheduleToDue(normalized);
  // Б6.2: после ручной правки расписания плашка показывает РЕАЛЬНЫЙ quadrantOf,
  // а не намерение, выбранное до неё.
  draft.quadrant = quadrantOf({ due: draft.due, priority: draft.priority }, today());
  draft.quadrantResolved = true;
  refreshComposer();
  return true;
}

/* --- Меню и листы --------------------------------------------------------- */

/* --- Вложенный нижний лист выбора ---------------------------------------- */

/* Квадрант и приоритет выбираются нижним листом — тем же каркасом, что лист
   перемещения и лист срока. Прежнее плавающее меню считало координаты по
   якорю и повисало над листом создания инородным телом, в которое ещё и
   надо было попасть пальцем. */
function choiceSheet({ id, title, options, parent, onDismiss }) {
  removeOverlay(id);

  const backdrop = el('div', 'matrix-sheet-backdrop is-' + id);
  const panel = el('div', 'matrix-sheet is-' + id);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  panel.appendChild(el('p', 'matrix-sheet-title', title));

  const close = () => {
    removeOverlay(id);
    if (onDismiss) onDismiss();
  };

  // Фокус обязан уехать внутрь листа: оставить его на чипе, который только
  // что стал недоступным, — значит потерять и клавиатуру, и скринридер.
  // Целевая строка — текущий выбор, а не первая сверху.
  let entry = null;

  for (const opt of options) {
    const btn = el('button', 'matrix-sheet-item' + (opt.className ? ' ' + opt.className : ''));
    btn.type = 'button';
    // Роль — button, а не option: панель ниже это dialog с кнопкой «Отмена»,
    // а option живёт только внутри listbox. Текущий выбор читается через
    // aria-current, поэтому скринридер называет его, не ломая роль.
    if (opt.current) btn.setAttribute('aria-current', 'true');
    if (opt.badge) btn.appendChild(badge(opt.badge));
    if (opt.dot) btn.appendChild(el('span', 'matrix-dot ' + opt.dot));
    btn.appendChild(el('span', 'matrix-sheet-name', opt.label));
    if (opt.hint) btn.appendChild(el('span', 'matrix-sheet-hint', opt.hint));
    btn.addEventListener('click', () => {
      // Снятие слоя до onPick: pick может открыть свой слой, и два одинаковых
      // id в стеке оставили бы висящую подложку.
      removeOverlay(id);
      opt.onPick();
      if (onDismiss) onDismiss();
    });
    if (!entry || opt.current) entry = btn;
    panel.appendChild(btn);
  }

  const cancel = el('button', 'matrix-sheet-cancel', 'Отмена');
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  panel.appendChild(cancel);

  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close();
  });

  const layer = pushOverlay({
    id, kind: 'sheet', parent, node: backdrop, panel,
    focusTarget: entry, onEscape: close,
  });
  if (!layer) return null;
  trapTab(panel);
  return layer;
}

function openQuadrantMenu() {
  choiceSheet({
    id: 'quadpick',
    title: 'Квадрант',
    parent: 'composer',
    options: QUADRANTS.map(q => ({
      label: q.title,
      hint: q.hint,
      badge: q,
      className: 'q-' + q.id + (q.id === draft.quadrant ? ' is-current' : ''),
      current: q.id === draft.quadrant,
      onPick: () => pickDraftQuadrant(q.id),
    })),
    onDismiss: focusComposer,
  });
}

function openPriorityMenu() {
  const order = [PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW, PRIORITY_NONE];
  choiceSheet({
    id: 'pickpriority',
    title: 'Приоритет',
    parent: 'composer',
    options: order.map(value => ({
      label: PRIORITY_LABEL[value],
      dot: 'p' + value,
      className: value === draft.priority ? ' is-current' : '',
      current: value === draft.priority,
      onPick: () => { draft.priority = value; refreshComposer(); },
    })),
    onDismiss: focusComposer,
  });
}

/* --- Лист «Дата и длительность» (ТЗ Б4) ----------------------------------- */

/* Лист владеет КОПИЕЙ расписания. Черновик создания (а для уже записанной
   задачи — хранилище) не узнаёт о правках до «Готово»: отмена стоит дешевле
   отката, и крестик, подложка и Escape просто выбрасывают копию (Б4.1, Б4.7,
   Б4.9). Всё, что лист обязан помнить между перерисовками, живёт в календарных
   переменных ниже и не протекает в черновик. */

let calendarDraft = null;    // рабочая копия расписания внутри листа
let calTarget = null;        // {mode:'draft'} | {mode:'task', id}
let calEndpoint = 'start';   // к какой границе относится следующий клик по дню
let calNotice = '';          // пояснения листа («Сначала выберите дату»…)
let calIssues = [];          // ошибки последней проверки: aria-invalid и фокус
let calFields = {};          // код поля → узел, чтобы фокусить первый неверный
let calHours = null;         // введённые часы: «весь день» → «часы» вернёт их
let calMonthCursor = null;   // первое число месяца в сетке дней

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

const CAL_HEADING_ID = 'matrix-date-heading';
const CAL_ERROR_ID = 'matrix-date-error';
const CAL_NOTICE_ID = 'matrix-date-notice';
const CAL_ALLDAY_ID = 'matrix-cal-allday';
const CAL_LOCAL_NOTE = 'Напоминания работают, пока приложение открыто. В фоне могут '
  + 'задерживаться; при закрытом приложении не доставляются.';
const CAL_DEVICE_NOTE = 'Часы берутся у устройства: при смене зоны встреча остаётся '
  + 'в тех же локальных часах.';

// Быстрые даты (Б4.4): пустой интервал делают одним днём «весь день»,
// существующий — переносят ЦЕЛИКОМ, сохраняя календарную длину и часы.
const CAL_QUICK = [
  { label: 'Сегодня', offset: 0 },
  { label: 'Завтра', offset: 1 },
  { label: 'Через неделю', offset: 7 },
];

/* Меню напоминания (ТЗ Б5). `whole` — вариант годен и в режиме «весь день»:
   там смещение обязано быть кратным суткам, поэтому минутные опережения в
   all-day НЕ показываются, а не молча отбрасываются нормализацией. */
const CAL_REMINDERS = [
  { offset: null, anchor: null, label: 'Без напоминания', whole: true },
  { offset: 0, anchor: 'start', label: 'В момент начала', whole: true },
  { offset: 5, anchor: 'start', label: 'За 5 минут' },
  { offset: 10, anchor: 'start', label: 'За 10 минут' },
  { offset: 15, anchor: 'start', label: 'За 15 минут' },
  { offset: 30, anchor: 'start', label: 'За 30 минут' },
  { offset: 60, anchor: 'start', label: 'За 1 час' },
  { offset: 720, anchor: 'start', label: 'За 12 часов' },
  { offset: 1440, anchor: 'start', label: 'За 1 день', whole: true },
  { offset: 2880, anchor: 'start', label: 'За 2 дня', whole: true },
  { offset: 10080, anchor: 'start', label: 'За 1 неделю', whole: true },
  { offset: 0, anchor: 'end', label: 'В момент окончания', whole: true },
  { absolute: true, anchor: 'absolute', offset: 0, label: 'Другое время…', whole: true },
];

// Готовые правила повтора. `build` получает копию расписания, чтобы «каждую
// неделю» брала день недели из выбранной даты, а не из сегодняшнего числа.
const CAL_REPEATS = [
  { label: 'Не повторять', unit: 'none', build: null },
  { label: 'Каждый день', unit: 'day', build: () => ({ unit: 'day', interval: 1 }) },
  { label: 'Каждые 3 дня', unit: 'day', build: () => ({ unit: 'day', interval: 3 }) },
  {
    label: 'По будням',
    unit: 'week',
    build: () => ({ unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }),
  },
  {
    label: 'Каждую неделю',
    unit: 'week',
    build: schedule => ({ unit: 'week', interval: 1, weekdays: [calIsoWeekday(schedule.startDate)] }),
  },
  {
    label: 'Каждые 2 недели',
    unit: 'week',
    build: schedule => ({ unit: 'week', interval: 2, weekdays: [calIsoWeekday(schedule.startDate)] }),
  },
  {
    label: 'Каждый месяц',
    unit: 'month',
    build: () => ({ unit: 'month', interval: 1, monthMode: 'dayOfMonth' }),
  },
  {
    label: 'Каждый год',
    unit: 'year',
    build: () => ({ unit: 'year', interval: 1 }),
  },
];

function calIsoWeekday(isoDate) {
  const parsed = isoDate ? parseISODate(isoDate) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return 1;
  return ((parsed.getDay() + 6) % 7) + 1;
}

function calMonthStart(isoDate) {
  const parsed = isoDate ? parseISODate(isoDate) : null;
  const base = parsed && !Number.isNaN(parsed.getTime()) ? parsed : today();
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

function calIso(dayOffset) {
  return toISODate(addDays(today(), dayOffset));
}

// Разница двух дат в календарных днях (включительно даёт +1).
function calDayGap(fromIso, toIso) {
  const a = parseISODate(fromIso);
  const b = parseISODate(toIso);
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
    - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

function newReminderId() {
  calReminderSeq += 1;
  return 'r' + Date.now().toString(36) + '-' + calReminderSeq;
}

let calReminderSeq = 0;

function calIssueOf(code) {
  for (const issue of calIssues) if (issue.field === code) return issue;
  return null;
}

// Ошибку у поля показывает ОДИН живой регион (см. calErrorRow), а контрол
// получает aria-invalid и ссылку на него: так скринридер дочитает причину
// именно к тому полю, на которое поставит фокус calFinish.
function calMarkField(node, code) {
  if (!node) return node;
  calFields[code] = node;
  const issue = calIssueOf(code);
  if (issue) {
    node.setAttribute('aria-invalid', 'true');
    node.setAttribute('aria-describedby', CAL_ERROR_ID);
  } else {
    node.removeAttribute('aria-invalid');
    node.removeAttribute('aria-describedby');
  }
  return node;
}

function calDateText(isoDate) {
  if (!isoDate) return 'не выбрано';
  const parsed = parseISODate(isoDate);
  if (!parsed || Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
}

function calEndpointText(which) {
  const iso = which === 'start' ? calendarDraft.startDate : calendarDraft.endDate;
  const time = which === 'start' ? calendarDraft.startTime : calendarDraft.endTime;
  if (!iso) return '—';
  return calDateText(iso) + (calendarDraft.allDay || !time ? '' : ', ' + time);
}

function calReminderText(reminder) {
  if (!reminder) return 'Нет';
  if (reminder.anchor === 'absolute') {
    return 'В ' + reminder.time + ' ' + calDateText(reminder.date);
  }
  const edge = reminder.anchor === 'end' ? 'окончания' : 'начала';
  if (!reminder.offsetMinutes) return 'В момент ' + edge;
  const minutes = reminder.offsetMinutes;
  const days = minutes / MINUTES_PER_DAY;
  const whole = minutes % MINUTES_PER_DAY === 0;
  const hours = minutes / 60;
  const unit = whole ? days + ' ' + pluralDays(days)
    : (hours >= 1 && hours % 1 === 0 ? hours + ' ч' : minutes + ' мин');
  return 'За ' + unit + ' до ' + edge;
}

// Одна строка на правило: дубликаты по факту (anchor + смещение, либо date +
// time) не создают второго напоминания (Б5).
function calReminderSame(a, b) {
  if (!a || !b) return false;
  if (a.anchor !== b.anchor) return false;
  if (a.anchor === 'absolute') return a.date === b.date && a.time === b.time;
  return a.offsetMinutes === b.offsetMinutes;
}

function calRepeatText(repeat) {
  if (!repeat) return 'Не повторять';
  const every = repeat.interval > 1 ? repeat.interval + ' × ' : '';
  if (repeat.unit === 'day') return every + 'каждый день';
  if (repeat.unit === 'week') return every + 'каждую неделю';
  if (repeat.unit === 'month') return every + 'каждый месяц';
  if (repeat.unit === 'year') return every + 'каждый год';
  if (repeat.unit === 'dates') return 'по выбранным датам';
  return 'повтор';
}

/* Открытие листа. `taskId` задаёт режим правки существующей задачи (Б4.10):
   тот же лист, но применяется он не к черновику, а к копии задачи, и запись
   происходит только после успешного commitTasks. */

function openDateSheet(options) {
  const opts = options || {};
  let task = null;
  if (opts.taskId) {
    task = tasks.filter(t => t.id === opts.taskId)[0] || null;
    if (!task) return false;
  } else if (!draft) {
    return false;
  }

  const source = task ? task.schedule : draft.schedule;
  calendarDraft = normalizeSchedule(cloneSchedule(source || {}), {
    legacyDue: task ? task.due : draft.due,
  }).schedule;
  calTarget = task ? { mode: 'task', id: task.id } : { mode: 'draft' };
  calEndpoint = 'start';
  calNotice = '';
  calIssues = [];
  calFields = {};
  calHours = calendarDraft.allDay
    ? null
    : { startTime: calendarDraft.startTime, endTime: calendarDraft.endTime };
  calMonthCursor = calMonthStart(calendarDraft.startDate);

  const backdrop = el('div', 'matrix-sheet-backdrop is-schedule');
  const panel = el('div', 'matrix-sheet is-date');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', CAL_HEADING_ID);
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeDateSheet();
  });

  // Дочерний слой родителя имеет только в режиме черновика: закрытие листа
  // создания обязано снять и календарь, но у режима «правлю задачу» листа
  // создания над календарём нет.
  pushOverlay({
    id: 'date',
    kind: 'sheet',
    parent: task ? null : 'composer',
    node: backdrop,
    panel,
    onEscape: () => closeDateSheet(),
  });
  trapTab(panel);
  redrawDateSheet();
  focusNode(calFields.startDate || calFields.endDate || panel);
  return true;
}

// Закрыть = выбросить копию. Ни черновик, ни хранилище не меняются: «Готово»
// — единственная точка применения (Б4.1/Б4.9).
function closeDateSheet() {
  removeOverlay('date');
  calendarDraft = null;
  calTarget = null;
  calNotice = '';
  calIssues = [];
  calFields = {};
  refreshComposer();
}

function redrawDateSheet() {
  const layer = overlayById('date');
  if (!layer || !calendarDraft) return;
  calIssues = validateSchedule(calendarDraft).issues;
  calFields = {};
  const panel = layer.panel;
  panel.textContent = '';


  const head = el('div', 'matrix-sheet-head');
  const close = iconButton('close', 'matrix-sheet-x', 'Закрыть');
  close.addEventListener('click', () => closeDateSheet());
  head.appendChild(close);
  const heading = el('p', 'matrix-date-title', 'Дата и длительность');
  heading.id = CAL_HEADING_ID;
  head.appendChild(heading);
  const ready = el('button', 'matrix-date-ready');
  ready.type = 'button';
  ready.innerHTML = svgIcon('check', 22);
  ready.setAttribute('aria-label', 'Готово');
  ready.addEventListener('click', () => calFinish());
  head.appendChild(ready);
  panel.appendChild(head);

  panel.appendChild(calChipsRow());
  panel.appendChild(calMonthRow());
  panel.appendChild(calDayGrid());

  const fields = el('div', 'matrix-schedule-fields');
  fields.appendChild(calEndpointRow('start'));
  fields.appendChild(calEndpointRow('end'));
  fields.appendChild(calModeRow());
  fields.appendChild(calDurationRow());
  fields.appendChild(calErrorRow());
  fields.appendChild(calNoticeRow());
  fields.appendChild(calReminderBlock());
  fields.appendChild(calRepeatBlock());
  panel.appendChild(fields);

  const clear = el('button', 'matrix-clear', 'Очистить');
  clear.type = 'button';
  clear.addEventListener('click', () => calClear());
  panel.appendChild(clear);

  panel.appendChild(el('p', 'matrix-schedule-note', CAL_DEVICE_NOTE));
}

function calChipsRow() {
  const row = el('div', 'matrix-chips');
  for (const item of CAL_QUICK) {
    const iso = calIso(item.offset);
    const chip = el('button', 'matrix-chip'
      + (calendarDraft.startDate === iso && !calendarDraft.repeat ? ' is-current' : ''));
    chip.type = 'button';
    chip.textContent = item.label;
    chip.addEventListener('click', () => calPickQuick(iso));
    row.appendChild(chip);
  }
  return row;
}

function calMonthRow() {
  const row = el('div', 'matrix-cal-month');
  const prev = iconButton('back', 'matrix-cal-nav', 'Предыдущий месяц', 18);
  prev.addEventListener('click', () => {
    calMonthCursor = new Date(calMonthCursor.getFullYear(), calMonthCursor.getMonth() - 1, 1);
    redrawDateSheet();
  });
  // Месяц строчными и без «г.»: так пишет русская типографика, а
  // toLocaleDateString с year:'numeric' выдаёт «ноябрь 2026 г.».
  const label = el('span', 'matrix-cal-label',
    calMonthCursor.toLocaleDateString('ru-RU', { month: 'long' }) + ' ' + calMonthCursor.getFullYear());
  const next = iconButton('back', 'matrix-cal-nav is-next', 'Следующий месяц', 18);
  next.addEventListener('click', () => {
    calMonthCursor = new Date(calMonthCursor.getFullYear(), calMonthCursor.getMonth() + 1, 1);
    redrawDateSheet();
  });
  row.append(prev, label, next);
  return row;
}

// Сетка дней принадлежит листу, поэтому выбор помечается по активной границе:
// день начала и день окончания различаются не только цветом (Б4.3), а текстом
// aria-label и классом.
function calDayGrid() {
  const grid = el('div', 'matrix-cal-grid');
  grid.setAttribute('role', 'grid');
  for (const wd of WEEKDAYS) grid.appendChild(el('span', 'matrix-cal-wd', wd));
  const offset = (calMonthCursor.getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) grid.appendChild(el('span', 'matrix-cal-pad'));
  const daysInMonth = new Date(calMonthCursor.getFullYear(), calMonthCursor.getMonth() + 1, 0)
    .getDate();
  const todayIso = toISODate(today());
  const startIso = calendarDraft.startDate;
  const endIso = calendarDraft.endDate;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = toISODate(new Date(calMonthCursor.getFullYear(), calMonthCursor.getMonth(), day));
    const isStart = !!startIso && iso === startIso;
    const isEnd = !!endIso && iso === endIso;
    const picked = (isStart && (calEndpoint === 'start' || isEnd))
      || (isEnd && calEndpoint === 'end');
    const cell = el('button', 'matrix-cal-day'
      + (iso === todayIso ? ' is-today' : '')
      + (picked ? ' is-selected' : '')
      + (isStart ? ' is-range-start' : '')
      + (isEnd ? ' is-range-end' : '')
      + (!!startIso && !!endIso && iso > startIso && iso < endIso ? ' is-in-range' : ''));
    cell.type = 'button';
    cell.textContent = String(day);
    // aria-label остаётся чистой датой: по ней лист ищут тесты и скринридер
    // читает cell как «4 ноября». Принадлежность границе — title и класс, а
    // не дописанное в подпись слово, которое ломало бы сопоставление дня.
    cell.setAttribute('aria-label', iso);
    if (isStart || isEnd) {
      cell.title = iso + (isStart && isEnd ? ' — начало и конец'
        : isStart ? ' — начало' : ' — конец');
      cell.dataset.range = isStart && isEnd ? 'both' : isStart ? 'start' : 'end';
    }
    cell.setAttribute('aria-pressed', picked ? 'true' : 'false');
    cell.addEventListener('click', () => calPickDay(iso));
    grid.appendChild(cell);
  }
  return grid;
}

function calEndpointRow(which) {
  const row = el('div', 'matrix-schedule-row matrix-schedule-endpoint-row');
  const pill = el('button', 'matrix-schedule-endpoint'
    + (calEndpoint === which ? ' is-active' : ''));
  pill.type = 'button';
  pill.dataset.endpoint = which;
  // Дата границы читается из разметки, а не только из подписи: тест и
  // будущий экран видят, ЧТО именно выбрано, когда форма невалидна.
  pill.dataset.date = (which === 'start' ? calendarDraft.startDate : calendarDraft.endDate) || '';
  pill.setAttribute('aria-pressed', calEndpoint === which ? 'true' : 'false');
  pill.setAttribute('aria-label', (which === 'start' ? 'Начать: ' : 'Закончить: ')
    + calEndpointText(which));
  pill.appendChild(el('span', 'matrix-schedule-endpoint-label',
    which === 'start' ? 'Начать' : 'Закончить'));
  pill.appendChild(el('span', 'matrix-schedule-endpoint-date', calEndpointText(which)));
  pill.addEventListener('click', () => {
    calEndpoint = which;
    redrawDateSheet();
    // Календарь принадлежит листу: после выбора границы фокус возвращается к
    // сетке, и следующий шаг — стрелками по дням, а не по всему листу.
    focusNode(calFields.startDate || calFields.endDate);
  });
  calMarkField(pill, which === 'start' ? 'startDate' : 'endDate');
  row.appendChild(pill);
  if (!calendarDraft.allDay) row.appendChild(calTimeInput(which));
  return row;
}

function calTimeInput(which) {
  const input = el('input', 'matrix-schedule-time');
  input.type = 'time';
  // Шаг 1 минута и ручной ввод (Б4.6): «закончить» — самостоятельное поле, а
  // не производная от начала.
  input.setAttribute('step', '60');
  input.dataset.endpoint = which;
  input.value = (which === 'start' ? calendarDraft.startTime : calendarDraft.endTime) || '';
  input.setAttribute('aria-label', which === 'start' ? 'Время начала' : 'Время окончания');
  const code = which === 'start' ? 'startTime' : 'endTime';
  input.addEventListener('input', () => {
    const wasFocused = document.activeElement === input;
    calendarDraft[which === 'start' ? 'startTime' : 'endTime']
      = /^[0-2]\d:[0-5]\d$/.test(String(input.value)) ? input.value : null;
    redrawDateSheet();
    if (wasFocused) focusNode(calFields[code]);
  });
  calMarkField(input, code);
  return input;
}

function calModeRow() {
  const row = el('div', 'matrix-schedule-row matrix-all-day');
  const label = el('label', 'matrix-all-day-label');
  label.setAttribute('for', CAL_ALLDAY_ID);
  const box = el('input', 'matrix-all-day-input');
  box.type = 'checkbox';
  box.id = CAL_ALLDAY_ID;
  box.checked = calendarDraft.allDay;
  box.addEventListener('change', () => calSetMode(box.checked));
  // Тумблер СПРАВА от текста: сперва подпись, потом переключатель
  label.append(el('span', 'matrix-all-day-text', 'Весь день'), box);
  row.appendChild(label);

  const seg = el('div', 'matrix-mode-segment');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Режим интервала');
  for (const mode of [{ id: 'all-day', text: 'Весь день' }, { id: 'timed', text: 'Часы' }]) {
    const btn = el('button', 'matrix-mode-btn'
      + ((mode.id === 'all-day') === calendarDraft.allDay ? ' is-current' : ''));
    btn.type = 'button';
    btn.dataset.mode = mode.id;
    btn.setAttribute('aria-pressed', (mode.id === 'all-day') === calendarDraft.allDay ? 'true' : 'false');
    btn.textContent = mode.text;
    btn.addEventListener('click', () => calSetMode(mode.id === 'all-day'));
    seg.appendChild(btn);
  }
  row.appendChild(seg);
  return row;
}

function calDurationRow() {
  const row = el('div', 'matrix-schedule-row matrix-duration-row');
  row.appendChild(el('span', 'matrix-duration-label', 'Длительность'));
  const value = el('span', 'matrix-duration');
  const duration = scheduleDuration(calendarDraft);
  const extra = duration.kind === 'timed' && duration.days > 1
    ? ' (' + duration.days + ' ' + pluralDays(duration.days) + ')'
    : '';
  value.textContent = duration.label ? duration.label + extra : '—';
  row.appendChild(value);
  return row;
}

function calErrorRow() {
  const box = el('div', 'matrix-schedule-error');
  box.id = CAL_ERROR_ID;
  box.setAttribute('role', 'alert');
  box.setAttribute('aria-live', 'assertive');
  // Причина называется до «Готово»: человек видит, что уже не сойдётся, и
  // правит именно это поле, а не получает отказ постфактум.
  box.textContent = calIssues.map(issue => issue.message).join('; ');
  if (!calIssues.length) box.hidden = true;
  return box;
}

function calNoticeRow() {
  const box = el('div', 'matrix-schedule-hint');
  box.id = CAL_NOTICE_ID;
  box.setAttribute('aria-live', 'polite');
  box.textContent = calNotice;
  if (!calNotice) box.hidden = true;
  return box;
}

function calReminderBlock() {
  const block = el('div', 'matrix-schedule-field is-reminder');
  const row = el('button', 'matrix-schedule-row matrix-reminder-row');
  row.type = 'button';
  row.setAttribute('aria-label', 'Время для напоминания');
  row.appendChild(el('span', 'matrix-schedule-row-label', 'Напоминание'));
  row.appendChild(el('span', 'matrix-schedule-row-value', calReminderSummary()));
  const blocked = !calendarDraft.startDate;
  if (blocked) row.setAttribute('aria-disabled', 'true');
  row.addEventListener('click', () => calOpenReminders());
  calMarkField(row, 'reminders');
  block.appendChild(row);

  if (calendarDraft.reminders.length) {
    const list = el('div', 'matrix-reminder-list');
    for (const reminder of calendarDraft.reminders) {
      const chip = el('div', 'matrix-reminder-chip');
      chip.appendChild(el('span', 'matrix-reminder-chip-text', calReminderText(reminder)));
      const moment = reminderMoment(calendarDraft, reminder);
      if (moment.ok && moment.at.getTime() < today().getTime()) {
        chip.appendChild(el('span', 'matrix-reminder-chip-warn',
          'Время уже прошло, уведомление сейчас отправлено не будет'));
      } else if (!moment.ok && reminder.anchor !== 'absolute') {
        chip.appendChild(el('span', 'matrix-reminder-chip-warn',
          'Правило не образует момента: смещение или дата неверны'));
      }
      const drop = el('button', 'matrix-reminder-drop', '×');
      drop.type = 'button';
      drop.dataset.reminderId = reminder.id;
      drop.setAttribute('aria-label', 'Снять напоминание: ' + calReminderText(reminder));
      drop.addEventListener('click', () => {
        calendarDraft.reminders = calendarDraft.reminders.filter(r => r.id !== reminder.id);
        calNotice = '';
        redrawDateSheet();
      });
      chip.appendChild(drop);
      block.appendChild(chip);
    }
    block.appendChild(list);
  }
  return block;
}

function calReminderSummary() {
  if (!calendarDraft.reminders.length) return 'Нет';
  const first = calReminderText(calendarDraft.reminders[0]);
  if (calendarDraft.reminders.length === 1) return first;
  return first + ' и ещё ' + (calendarDraft.reminders.length - 1);
}

function calRepeatBlock() {
  const block = el('div', 'matrix-schedule-field is-repeat');
  const row = el('button', 'matrix-schedule-row matrix-repeat-row');
  row.type = 'button';
  row.setAttribute('aria-label', 'Повтор');
  row.appendChild(el('span', 'matrix-schedule-row-label', 'Повтор'));
  row.appendChild(el('span', 'matrix-schedule-row-value', calRepeatText(calendarDraft.repeat)));
  if (!calendarDraft.startDate) row.setAttribute('aria-disabled', 'true');
  row.addEventListener('click', () => calOpenRepeat());
  calMarkField(row, 'repeat');
  block.appendChild(row);

  if (calendarDraft.repeat) {
    // Превью считает от реального состояния задачи: series существующей
    // задачи уходит в зонд как есть — nextOccurrence сам берёт из неё index
    // (потолок «после N», Б7.5) и anchorDay (день «по числу», Б7.2), с
    // честными fallback'ами. Прежний зонд затирал index единицей: потолок
    // считался от начала правила, и у задачи на последнем экземпляре серии
    // превью обещало несуществующий следующий (отчёт марафона §4.2 п.11).
    // Для новой задачи series нет — index=1, как и раньше.
    const series = calendarDraft.series
      ? Object.assign({}, calendarDraft.series)
      : { id: 'draft', index: 1, anchorDate: calendarDraft.startDate, anchorDay: null, anchorMonth: null };
    const probe = nextOccurrence(Object.assign({}, calendarDraft, { series: series }),
      { completionDate: today() });
    if (probe.status === 'ok' && probe.occurrence) {
      block.appendChild(el('p', 'matrix-repeat-next',
        'Далее: ' + calDateText(probe.occurrence.startDate)));
    }
  }
  return block;
}

/* --- Правка копии --------------------------------------------------------- */

function calPickDay(isoDate) {
  if (!calendarDraft.startDate && !calendarDraft.endDate) {
    calendarDraft.startDate = isoDate;
    calendarDraft.endDate = isoDate;
    calEndpoint = 'end';
  } else if (calEndpoint === 'end') {
    calendarDraft.endDate = isoDate;
    if (!calendarDraft.startDate) calendarDraft.startDate = isoDate;
  } else {
    calendarDraft.startDate = isoDate;
    if (!calendarDraft.endDate) calendarDraft.endDate = isoDate;
  }
  // Порядок границ не «чинится» молча: если окончание уехало раньше начала,
  // это увидит валидация (Б4.3), а не вторая граница, сдвинутая за спиной.
  calNotice = '';
  redrawDateSheet();
  focusNode(calFields.startDate || calFields.endDate);
}

function calPickQuick(isoDate) {
  if (calendarDraft.startDate && calendarDraft.endDate) {
    const gap = calDayGap(calendarDraft.startDate, calendarDraft.endDate);
    calendarDraft.startDate = isoDate;
    calendarDraft.endDate = toISODate(addDays(parseISODate(isoDate), gap));
  } else {
    calendarDraft.startDate = isoDate;
    calendarDraft.endDate = isoDate;
    calendarDraft.allDay = true;
    calendarDraft.startTime = null;
    calendarDraft.endTime = null;
    calHours = null;
  }
  calEndpoint = 'start';
  calMonthCursor = calMonthStart(isoDate);
  calNotice = '';
  redrawDateSheet();
}

function calSetMode(allDay) {
  if (!calendarDraft || calendarDraft.allDay === allDay) return;
  if (allDay) {
    if (calendarDraft.startTime && calendarDraft.endTime) {
      calHours = { startTime: calendarDraft.startTime, endTime: calendarDraft.endTime };
    }
    calendarDraft.allDay = true;
    calendarDraft.startTime = null;
    calendarDraft.endTime = null;
    const stranded = calendarDraft.reminders
      .filter(r => r.anchor !== 'absolute' && r.offsetMinutes % MINUTES_PER_DAY !== 0).length;
    calNotice = stranded
      ? 'В режиме «весь день» смещение должно быть целыми сутками: напоминаний на '
        + stranded + ' надо переставить или снять.'
      : '';
  } else {
    const remembered = calHours || {};
    calendarDraft.allDay = false;
    calendarDraft.startTime = remembered.startTime || ALL_DAY_DEFAULT_TIME;
    calendarDraft.endTime = remembered.endTime || '10:00';
    calHours = { startTime: calendarDraft.startTime, endTime: calendarDraft.endTime };
    calNotice = '';
  }
  redrawDateSheet();
}

function calClear() {
  const had = calendarDraft.reminders.length || calendarDraft.repeat ? 1 : 0;
  calendarDraft = emptySchedule();
  calHours = null;
  calEndpoint = 'start';
  // Сброс зависимых настроек показывается внутри листа: «Очистить» до «Готово»
  // отменяемо, и человек обязан видеть, ЧТО именно будет удалено (Б4.7).
  calNotice = had ? 'Вместе со сроком будут сняты напоминание и повтор.' : '';
  redrawDateSheet();
}

// Единственная точка, где копия становится чьим-то значением.
function calApply(value) {
  return calTarget.mode === 'task'
    ? commitTaskSchedule(calTarget.id, value)
    : applyDraftSchedule(value);
}

function calFinish() {
  const check = validateSchedule(calendarDraft);
  calIssues = check.issues;
  if (!check.ok) {
    redrawDateSheet();
    const first = check.issues[0];
    focusNode((first && calFields[first.field]) || calFields.startDate
      || (overlayById('date') || {}).panel);
    return false;
  }
  if (!calApply(cloneSchedule(calendarDraft))) {
    // Отказ хранилища редактор не закрывает: правка ещё не состоялась, а
    // молча выброшенная копия означала бы потерю ввода.
    redrawDateSheet();
    return false;
  }
  closeDateSheet();
  return true;
}

/* --- Вложенные слои: напоминание и повтор --------------------------------- */

function calBlockWithoutDate(what) {
  calNotice = 'Сначала выберите дату — ' + what + ' привязан к интервалу.';
  redrawDateSheet();
}

function calSheetLayer(id, title, role) {
  const backdrop = el('div', 'matrix-sheet-backdrop is-' + id);
  const panel = el('div', 'matrix-sheet is-' + id);
  panel.setAttribute('role', role || 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  panel.appendChild(el('p', 'matrix-sheet-title', title));
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) removeOverlay(id);
  });
  return { backdrop, panel };
}

function calOpenReminders() {
  if (!calendarDraft.startDate) {
    calBlockWithoutDate('напоминание');
    return;
  }
  removeOverlay('reminder');
  const layer = calSheetLayer('reminder', 'Время для напоминания', 'listbox');
  const panel = layer.panel;
  const choices = CAL_REMINDERS.filter(c => !calendarDraft.allDay || c.whole === true);
  if (calendarDraft.reminders.length >= SCHEDULE_LIMITS.reminders) {
    panel.appendChild(el('p', 'matrix-sheet-sub',
      'Не больше ' + SCHEDULE_LIMITS.reminders + ' напоминаний: одно надо сначала снять.'));
  }
  for (const choice of choices) {
    const btn = el('button', 'matrix-reminder-option'
      + (calChoiceCurrent(choice) ? ' is-current' : ''));
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.dataset.offset = choice.absolute ? 'absolute'
      : (choice.offset === null ? 'none' : String(choice.offset));
    btn.dataset.anchor = choice.anchor || 'none';
    btn.setAttribute('aria-selected', calChoiceCurrent(choice) ? 'true' : 'false');
    btn.appendChild(el('span', 'matrix-reminder-option-label', choice.label));
    btn.addEventListener('click', () => calPickReminder(choice));
    panel.appendChild(btn);
  }
  panel.appendChild(el('p', 'matrix-schedule-note', CAL_LOCAL_NOTE));
  pushOverlay({
    id: 'reminder',
    kind: 'sheet',
    parent: 'date',
    node: layer.backdrop,
    panel,
    onEscape: () => removeOverlay('reminder'),
  });
}

function calChoiceCurrent(choice) {
  // Подсветка текущего пункта сравнивает ПРАВИЛА, а не пункт меню с его
  // полем `offset`: иначе «выбрано» не показывалось бы никогда.
  if (choice.absolute) {
    return calendarDraft.reminders.some(r => r.anchor === 'absolute');
  }
  if (choice.offset === null) return calendarDraft.reminders.length === 0;
  const probe = {
    anchor: choice.anchor, offsetMinutes: choice.offset, date: null, time: null,
  };
  return calendarDraft.reminders.some(r => calReminderSame(r, probe));
}

function calPickReminder(choice) {
  removeOverlay('reminder');
  if (choice.absolute) {
    calOpenAbsolute();
    return;
  }
  if (choice.offset === null) {
    calendarDraft.reminders = [];
    calNotice = '';
  } else if (calendarDraft.reminders.length >= SCHEDULE_LIMITS.reminders
    && !calendarDraft.reminders.some(r => calReminderSame(r, choice))) {
    calNotice = 'Не больше ' + SCHEDULE_LIMITS.reminders + ' напоминаний.';
  } else {
    const rule = {
      id: newReminderId(),
      anchor: choice.anchor,
      offsetMinutes: choice.offset,
      date: null,
      time: calendarDraft.allDay ? ALL_DAY_DEFAULT_TIME : null,
    };
    // Дубликат по правилу заменяется, а не добавляется вторым (Б5): сравнение
    // идёт по ГОТОВОМУ правилу, а не по пункту меню — у пункта смещение живёт
    // в `offset`, и проверка против него никогда бы не совпала.
    calendarDraft.reminders = calendarDraft.reminders
      .filter(r => !calReminderSame(r, rule))
      .concat([rule]);
    calNotice = '';
  }
  redrawDateSheet();
}

// Абсолютное напоминание живёт своими датой и временем: интервал за ним не
// тянет, поэтому при включении повтора оно снимается явно (Б5).
function calOpenAbsolute() {
  removeOverlay('reminder-abs');
  const layer = calSheetLayer('reminder-abs', 'Другое время');
  const panel = layer.panel;
  const date = el('input', 'matrix-absolute-date');
  date.type = 'date';
  date.value = calendarDraft.startDate || toISODate(today());
  date.setAttribute('aria-label', 'Дата напоминания');
  const time = el('input', 'matrix-absolute-time');
  time.type = 'time';
  time.setAttribute('step', '60');
  time.value = '09:00';
  time.setAttribute('aria-label', 'Время напоминания');
  panel.append(date, time);
  const add = el('button', 'matrix-absolute-add', 'Добавить');
  add.type = 'button';
  add.addEventListener('click', () => {
    const rule = {
      id: newReminderId(),
      anchor: 'absolute',
      offsetMinutes: 0,
      date: String(date.value || ''),
      time: String(time.value || ''),
    };
    const probe = reminderMoment(calendarDraft, rule);
    if (!probe.ok) {
      calNotice = 'Дата и время не образуют существующий момент: ' + probe.code;
      removeOverlay('reminder-abs');
      redrawDateSheet();
      return;
    }
    calendarDraft.reminders = calendarDraft.reminders
      .filter(r => !calReminderSame(r, rule));
    if (calendarDraft.reminders.length >= SCHEDULE_LIMITS.reminders) {
      calNotice = 'Не больше ' + SCHEDULE_LIMITS.reminders + ' напоминаний.';
    } else {
      calendarDraft.reminders = calendarDraft.reminders.concat([rule]);
      calNotice = '';
    }
    removeOverlay('reminder-abs');
    redrawDateSheet();
  });
  panel.appendChild(add);
  pushOverlay({
    id: 'reminder-abs',
    kind: 'sheet',
    parent: 'reminder',
    node: layer.backdrop,
    panel,
    onEscape: () => removeOverlay('reminder-abs'),
  });
}

/* Слой «Повтор». Пресеты применяются сразу, блок «Настроить» собирает
   правило целиком: единица, интервал, дни недели, режим месяца, база и
   завершение (ТЗ Б7). Промежуточный выбор живёт в calRepeatEdit и не касается
   черновика до «Применить правило»: половина выбранного правила не должна
   превращаться в половину серии. */

let calRepeatEdit = null;
let calRepeatFocus = null;
let calRepeatNotice = '';

function calEmptyRepeat() {
  return {
    basis: 'scheduled', unit: 'day', interval: 1, weekdays: [], monthMode: 'dayOfMonth',
    nth: null, weekday: null, dates: [], picked: '', ends: { type: 'never', until: null, count: null },
  };
}

// Копия правила поверх явных defaults: поля, которых в сохранённом правиле
// нет, получают ровно те же значения, что требует Б3.8.
function calCloneRepeat(repeat) {
  const out = calEmptyRepeat();
  if (!repeat || typeof repeat !== 'object') return out;
  for (const key of ['basis', 'unit', 'interval', 'monthMode', 'nth', 'weekday']) {
    if (repeat[key] !== undefined && repeat[key] !== null) out[key] = repeat[key];
  }
  if (Array.isArray(repeat.weekdays)) out.weekdays = repeat.weekdays.slice();
  if (Array.isArray(repeat.dates)) out.dates = repeat.dates.slice();
  if (repeat.ends && typeof repeat.ends === 'object') {
    out.ends = {
      type: repeat.ends.type || 'never',
      until: repeat.ends.until || null,
      count: repeat.ends.count === undefined ? null : repeat.ends.count,
    };
  }
  return out;
}

function calRepeatSelect(className, label, options, current) {
  const select = el('select', className);
  select.setAttribute('aria-label', label);
  for (const item of options) {
    const node = el('option', null, item[1]);
    node.value = String(item[0]);
    if (String(item[0]) === String(current)) node.selected = true;
    select.appendChild(node);
  }
  select.value = String(current);
  return select;
}

// Правила, для которых «от выполнения» не имеет однозначного смысла: список
// дней, N-й день недели и произвольный набор дат. ТЗ требует не молча
// переписывать, а явно отключить с пояснением.
function calRepeatCompletionAmbiguous(edit) {
  if (edit.unit === 'dates') return true;
  if (edit.unit === 'week' && edit.weekdays.length > 1) return true;
  return edit.unit === 'month' && edit.monthMode === 'nthWeekday';
}

function calNormalizeRepeatRule(edit) {
  const monthly = edit.unit === 'month';
  const nthWeekday = monthly && edit.monthMode === 'nthWeekday';
  const probe = normalizeSchedule(Object.assign({}, calendarDraft, {
    repeat: {
      basis: edit.basis,
      unit: edit.unit,
      interval: edit.interval,
      weekdays: edit.unit === 'week' ? edit.weekdays.slice().sort((a, b) => a - b) : [],
      monthMode: monthly ? edit.monthMode : 'dayOfMonth',
      nth: nthWeekday ? edit.nth : null,
      weekday: nthWeekday ? edit.weekday : null,
      dates: edit.unit === 'dates' ? edit.dates.slice() : [],
      ends: edit.ends,
    },
    series: null,
  }), {}).schedule;
  return probe.repeat;
}

function calOpenRepeat() {
  if (!calendarDraft.startDate) {
    calBlockWithoutDate('повтор');
    return;
  }
  removeOverlay('repeat');
  if (!calRepeatEdit) calRepeatEdit = calCloneRepeat(calendarDraft.repeat);
  const edit = calRepeatEdit;
  const controls = {};
  const notice = calRepeatNotice;
  calRepeatNotice = '';

  const rerender = (key) => {
    calRepeatFocus = key || null;
    calOpenRepeat();
  };

  const layer = calSheetLayer('repeat', 'Повтор');
  const panel = layer.panel;

  for (const preset of CAL_REPEATS) {
    const btn = el('button', 'matrix-repeat-option' + (calRepeatCurrent(preset) ? ' is-current' : ''));
    btn.type = 'button';
    btn.dataset.unit = preset.unit;
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      calSetRepeat(preset.build ? preset.build(calendarDraft) : null);
      calRepeatEdit = null;
      removeOverlay('repeat');
      redrawDateSheet();
    });
    panel.appendChild(btn);
  }

  const custom = el('div', 'matrix-repeat-custom');
  custom.appendChild(el('p', 'matrix-repeat-custom-title', 'Настроить'));

  // — каждые N единиц
  const unitLine = el('div', 'matrix-repeat-line');
  const interval = el('input', 'matrix-repeat-interval');
  interval.type = 'number';
  interval.min = '1';
  interval.max = String(SCHEDULE_LIMITS.intervalMax);
  interval.value = String(edit.interval);
  interval.setAttribute('aria-label', 'Каждые N');
  interval.addEventListener('change', () => {
    edit.interval = Number(interval.value) || 1;
    rerender('interval');
  });
  const unit = calRepeatSelect('matrix-repeat-unit', 'Единица повтора', [
    ['day', 'дней'], ['week', 'недель'], ['month', 'месяцев'], ['year', 'лет'],
    ['dates', 'по выбранным датам'],
  ], edit.unit);
  unit.addEventListener('change', () => {
    edit.unit = unit.value;
    if (edit.unit === 'dates') {
      // Интервал и база у набора дат не бывает: правила Б3.8 фиксируют
      // interval=1 и basis='scheduled'. Даты молча не подставляются —
      // список обязан быть выбранным человеком.
      edit.interval = 1;
      edit.basis = 'scheduled';
    }
    rerender('unit');
  });
  unitLine.append(el('span', 'matrix-repeat-line-label', 'Каждые'), interval, unit);
  custom.appendChild(unitLine);
  controls.interval = interval;
  controls.unit = unit;

  // — какие дни недели (только для недели)
  if (edit.unit === 'week') {
    const days = el('div', 'matrix-repeat-weekdays');
    for (let index = 0; index < WEEKDAYS.length; index++) {
      const number = index + 1;
      const on = edit.weekdays.indexOf(number) >= 0;
      const toggle = el('button', 'matrix-repeat-weekday' + (on ? ' is-current' : ''));
      toggle.type = 'button';
      toggle.dataset.weekday = String(number);
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      toggle.textContent = WEEKDAYS[index];
      toggle.addEventListener('click', () => {
        const at = edit.weekdays.indexOf(number);
        if (at >= 0) edit.weekdays.splice(at, 1);
        else edit.weekdays.push(number);
        edit.weekdays.sort((a, b) => a - b);
        rerender('weekday' + number);
      });
      days.appendChild(toggle);
    }
    custom.appendChild(days);
  }

  // — режим месяца: по числу либо N-й/последний день недели
  if (edit.unit === 'month') {
    const modeLine = el('div', 'matrix-repeat-line');
    const mode = calRepeatSelect('matrix-repeat-month-mode', 'Режим месяца', [
      ['dayOfMonth', 'по числу'], ['nthWeekday', 'N-й день недели'],
    ], edit.monthMode);
    mode.addEventListener('change', () => {
      edit.monthMode = mode.value;
      if (edit.monthMode === 'nthWeekday') {
        if (!edit.nth) edit.nth = 1;
        if (!edit.weekday) edit.weekday = calIsoWeekday(calendarDraft.startDate);
      }
      rerender('month-mode');
    });
    modeLine.append(el('span', 'matrix-repeat-line-label', 'Раз в месяц'), mode);
    custom.appendChild(modeLine);
    controls['month-mode'] = mode;

    if (edit.monthMode === 'nthWeekday') {
      const nthLine = el('div', 'matrix-repeat-line');
      const nth = calRepeatSelect('matrix-repeat-nth', 'Номер вхождения', [
        ['1', 'первый'], ['2', 'второй'], ['3', 'третий'], ['4', 'четвёртый'], ['-1', 'последний'],
      ], edit.nth === null ? 1 : edit.nth);
      nth.addEventListener('change', () => {
        edit.nth = Number(nth.value);
        rerender('nth');
      });
      const pick = calRepeatSelect('matrix-repeat-weekday-pick', 'День недели',
        WEEKDAYS.map((name, index) => [String(index + 1), name]),
        edit.weekday === null ? 1 : edit.weekday);
      pick.addEventListener('change', () => {
        edit.weekday = Number(pick.value);
        rerender('weekday-pick');
      });
      nthLine.append(nth, pick);
      custom.appendChild(nthLine);
      controls.nth = nth;
      controls['weekday-pick'] = pick;
    }
  }

  // — собственный набор дат
  if (edit.unit === 'dates') {
    const dateLine = el('div', 'matrix-repeat-line');
    const input = el('input', 'matrix-repeat-date-input');
    input.type = 'date';
    // Введанная дата живёт в промежуточном правиле: перерисовка слоя не имеет
    // права её выбрасывать, иначе второе «Добавить дату» добавляет другую дату.
    if (!edit.picked) edit.picked = calendarDraft.startDate;
    input.value = edit.picked;
    input.setAttribute('aria-label', 'Добавить дату повтора');
    input.addEventListener('change', () => {
      edit.picked = String(input.value || '');
    });
    const add = el('button', 'matrix-repeat-date-add', 'Добавить дату');
    add.type = 'button';
    const commit = () => {
      edit.picked = String(input.value || '');
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(edit.picked) ? edit.picked : null;
      if (!iso) {
        calRepeatNotice = 'Дата не выбрана — из неё правило не собирается.';
        rerender('date-input');
        return;
      }
      if (edit.dates.indexOf(iso) >= 0) {
        calRepeatNotice = 'Эта дата уже в списке.';
      } else if (edit.dates.length >= SCHEDULE_LIMITS.datesMax) {
        calRepeatNotice = 'Не больше ' + SCHEDULE_LIMITS.datesMax + ' дат.';
      } else {
        edit.dates = edit.dates.concat([iso]).sort();
      }
      rerender('date-input');
    };
    add.addEventListener('click', commit);
    dateLine.append(input, add);
    custom.appendChild(dateLine);
    controls['date-input'] = input;

    const list = el('div', 'matrix-repeat-dates');
    for (const iso of edit.dates) {
      const chip = el('div', 'matrix-repeat-date');
      chip.dataset.date = iso;
      chip.appendChild(el('span', 'matrix-repeat-date-text', calDateText(iso)));
      const drop = el('button', 'matrix-repeat-date-drop', '×');
      drop.type = 'button';
      drop.setAttribute('aria-label', 'Убрать дату ' + iso);
      drop.addEventListener('click', () => {
        edit.dates = edit.dates.filter(item => item !== iso);
        rerender('dates');
      });
      chip.appendChild(drop);
      list.appendChild(chip);
    }
    custom.appendChild(list);
    if (!edit.dates.length) {
      custom.appendChild(el('p', 'matrix-repeat-hint', 'Список пуст: добавьте хотя бы одну дату.'));
    }
  }

  // — от чего считать
  const ambiguous = calRepeatCompletionAmbiguous(edit);
  if (ambiguous) edit.basis = 'scheduled';
  const basisLine = el('div', 'matrix-repeat-line');
  const basis = calRepeatSelect('matrix-repeat-basis', 'От чего считать повтор', [
    ['scheduled', 'от даты задачи'], ['completion', 'от выполнения'],
  ], edit.basis);
  basis.disabled = ambiguous;
  basis.addEventListener('change', () => {
    edit.basis = basis.value;
    rerender('basis');
  });
  basisLine.append(el('span', 'matrix-repeat-line-label', 'Считать'), basis);
  custom.appendChild(basisLine);
  controls.basis = basis;
  if (ambiguous) {
    custom.appendChild(el('p', 'matrix-repeat-hint',
      '«От выполнения» доступно только простому правилу: каждые N дней, недель, '
      + 'месяцев или лет — без списка дней, режима месяца и набора дат.'));
  }

  // — когда закончить
  const endsLine = el('div', 'matrix-repeat-line');
  const ends = calRepeatSelect('matrix-repeat-ends', 'Когда закончить повтор', [
    ['never', 'никогда'], ['until', 'включительно до'], ['count', 'после N'],
  ], edit.ends.type);
  ends.addEventListener('change', () => {
    edit.ends = {
      type: ends.value,
      until: ends.value === 'until' ? (edit.ends.until || calendarDraft.endDate || calendarDraft.startDate) : null,
      count: ends.value === 'count' ? (edit.ends.count || 3) : null,
    };
    rerender('ends');
  });
  endsLine.append(el('span', 'matrix-repeat-line-label', 'Завершить'), ends);
  custom.appendChild(endsLine);
  controls.ends = ends;

  if (edit.ends.type === 'until') {
    const until = el('input', 'matrix-repeat-until');
    until.type = 'date';
    until.value = edit.ends.until || calendarDraft.startDate;
    until.setAttribute('aria-label', 'Повторять включительно до');
    until.addEventListener('change', () => {
      edit.ends = { type: 'until', until: until.value, count: null };
      rerender('until');
    });
    custom.appendChild(until);
    controls.until = until;
  }
  if (edit.ends.type === 'count') {
    const count = el('input', 'matrix-repeat-count');
    count.type = 'number';
    count.min = '1';
    count.max = String(SCHEDULE_LIMITS.countMax);
    count.value = String(edit.ends.count || 3);
    count.setAttribute('aria-label', 'Повторить N раз');
    count.addEventListener('change', () => {
      edit.ends = { type: 'count', until: null, count: Number(count.value) || 1 };
      rerender('count');
    });
    custom.appendChild(count);
    controls.count = count;
  }

  const apply = el('button', 'matrix-repeat-apply', 'Применить правило');
  apply.type = 'button';
  apply.addEventListener('click', () => {
    if (edit.unit === 'dates' && !edit.dates.length) {
      calRepeatNotice = 'Список дат пуст: правило из него не собирается.';
      rerender('date-input');
      return;
    }
    const built = calNormalizeRepeatRule(edit);
    if (!built) {
      calRepeatNotice = 'Правило неполное: проверьте единицу, режим месяца и завершение.';
      rerender('apply');
      return;
    }
    calSetRepeat(built);
    // У правила «по выбранным датам» список и есть расписание: срок задачи
    // обязан стоять на одной из них (Б7.4). Первая дата становится сроком, и
    // лист говорит об этом вслух — молча сдвинуть выбранную человеком дату
    // нельзя, но и оставить правило невалидным нельзя.
    if (built.unit === 'dates') {
      const first = built.dates[0];
      if (calendarDraft.startDate !== first) {
        calendarDraft.startDate = first;
        calendarDraft.endDate = first;
        calendarDraft.due = first;
        calMonthCursor = calMonthStart(first);
        calNotice = 'Срок встал на первую дату списка: ' + calDateText(first) + '.';
      }
    }
    calRepeatEdit = null;
    removeOverlay('repeat');
    redrawDateSheet();
  });
  custom.appendChild(apply);
  controls.apply = apply;
  panel.appendChild(custom);

  if (notice) panel.appendChild(el('p', 'matrix-repeat-hint', notice));

  pushOverlay({
    id: 'repeat',
    kind: 'sheet',
    parent: 'date',
    node: layer.backdrop,
    panel,
    onEscape: () => {
      // Закрытие без «Применить правило» — черновик повтора выбрасывается:
      // лист даты не обязан помнить недобранный вариант.
      calRepeatEdit = null;
      removeOverlay('repeat');
      redrawDateSheet();
    },
  });
  if (calRepeatFocus && controls[calRepeatFocus]) focusNode(controls[calRepeatFocus]);
  calRepeatFocus = null;
}

function calRepeatCurrent(preset) {
  const current = calendarDraft.repeat;
  if (!preset.build) return !current;
  const built = preset.build(calendarDraft);
  if (!current || current.unit !== built.unit) return false;
  if (Number(current.interval) !== Number(built.interval)) return false;
  // Пресет месяца строит «по числу» (dayOfMonth): правило «N-й день недели
  // месяца» — другое правило при тех же unit и interval, подсвечиваться не
  // должно, иначе клик по пресету молча переписывал бы режим месяца.
  if (built.unit === 'month' && current.monthMode !== built.monthMode) return false;
  return JSON.stringify((current.weekdays || []).slice().sort())
    === JSON.stringify((built.weekdays || []).slice().sort());
}

function calSetRepeat(repeat) {
  calendarDraft.repeat = repeat || null;
  if (!repeat) {
    calendarDraft.series = null;
    calNotice = '';
    return;
  }
  // Absolute-напоминание не переезжает на следующий экземпляр серии (Б5):
  // оно снимается, и лист говорит об этом вслух.
  const absolute = calendarDraft.reminders.filter(r => r.anchor === 'absolute').length;
  if (absolute) {
    calendarDraft.reminders = calendarDraft.reminders.filter(r => r.anchor !== 'absolute');
    calNotice = 'Абсолютное напоминание снято: повтор его не переносит. '
      + 'Поставьте относительное — от начала или окончания.';
  } else {
    calNotice = '';
  }
}

/* --- Правка существующей задачи ------------------------------------------- */

// Значение применяется к КОПИИ задачи и уходит в хранилище одним commitTasks:
// при отказе квоты задача остаётся прежней, а лист — открытым (Б4.10).
function commitTaskSchedule(taskId, value) {
  let updated = null;
  const next = tasks.map(task => {
    if (task.id !== taskId) return task;
    updated = editSchedule(task, value, today());
    return updated || task;
  });
  if (!updated) return false;
  return commitTasks(next);
}

function openMoveSheet(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  const id = 'move:' + taskId;
  removeOverlay(id);

  const backdrop = el('div', 'matrix-sheet-backdrop is-move');
  const panel = el('div', 'matrix-sheet is-move');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Перенести задачу');
  panel.appendChild(el('p', 'matrix-sheet-title', task.title.length > 44
    ? task.title.slice(0, 44) + '…' : task.title));
  panel.appendChild(el('p', 'matrix-sheet-sub',
    'Сейчас: ' + ((quadrantById(quadrantOf(task, today())) || {}).title || '—')));

  const closeMove = () => removeOverlay(id);

  for (const q of moveOptions(task, today())) {
    const item = el('button', 'matrix-sheet-item q-' + q.id);
    item.type = 'button';
    item.dataset.quadrant = q.id;
    item.appendChild(badge(q));
    item.appendChild(el('span', 'matrix-sheet-name', q.title));
    item.appendChild(el('span', 'matrix-sheet-hint', q.hint));
    item.addEventListener('click', () => {
      // Запись сначала, лист потом: при отказе хранилища commitTasks сам
      // покажет причину, а лист не должен исчезать с «несделанной» правкой.
      // Назначенный интервал сначала спрашивает разрешение (Б6.4).
      if (requestMove(task.id, q.id, closeMove)) closeMove();
    });
    panel.appendChild(item);
  }

  const archive = el('button', 'matrix-sheet-item is-archive');
  archive.type = 'button';
  const archiveMark = el('span', 'matrix-pop-icon');
  archiveMark.innerHTML = svgIcon('archive', 18);
  archive.appendChild(archiveMark);
  archive.appendChild(el('span', 'matrix-sheet-name', 'В архив'));
  archive.addEventListener('click', () => {
    if (archiveTask(task.id)) closeMove();
  });
  panel.appendChild(archive);

  const cancel = el('button', 'matrix-sheet-cancel', 'Отмена');
  cancel.type = 'button';
  cancel.addEventListener('click', closeMove);
  panel.appendChild(cancel);

  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeMove();
  });

  pushOverlay({ id, kind: 'sheet', node: backdrop, panel, onEscape: closeMove });
  trapTab(panel);
}

/* --- Действия ------------------------------------------------------------- */

// Куда предложен перенос — чистая функция, потому что это решение о смысле,
// а не разметка: текущий квадрант не предлагаем, перенос «в никуда» менял бы
// срок и приоритет попусту. «Не срочно и не важно» в списке УЧАСТВУЕТ: это
// настоящий квадрант, а не архив — снятие в архив стоит отдельной кнопкой.
export function moveOptions(task, now) {
  const current = quadrantOf(task, now);
  return QUADRANTS.filter(q => q.id !== current);
}

// Результат записи наружу: отказ хранилища иначе превращается в «Добавлено»
// поверх незаписанных данных.
function persist() {
  return saveTasks(tasks);
}

// Единственное место, где правка матрицы встречается с хранилищем: новый
// список сначала записывается, и только при успехе экран считает правку
// состоявшейся и перерисовывается. При отказе переменная модуля возвращается к
// прежнему значению — перечитывать хранилище незачем, в нём лежит ровно оно, а
// неоткатанный список врал бы человеку до первой перерисовки, которая молча
// вернула бы старый.
function commitTasks(next) {
  const previous = tasks;
  tasks = next;
  if (persist()) {
    renderMatrixView();
    // Отдельное событие матрицы (ТЗ Б5.2): оно нужно планировщику напоминаний.
    // В облако правка уезжает не отсюда — за это отвечает persist() →
    // saveTasks, который пишет envelope plannerV1. Эмится ПОСЛЕ
    // успешной записи: отменённая правка не имеет права двигать pending-моменты.
    bus.emit('matrix:changed', { count: tasks.length });
    return true;
  }
  tasks = previous;
  showErrorToast(SAVE_ERROR_TEXT);
  return false;
}

export function addTask(quadrantId, fields) {
  const source = fields && typeof fields === 'object' ? fields : {};
  // Два разных входа (ТЗ Б6.2): намерение квадранта («+» без захода в
  // календарь) и согласованный черновик из листа. Второй НЕ прогоняется через
  // quadrantShape повторно — иначе даты, которые человек выбрал в календаре,
  // были бы переписаны правилом переноса.
  const planned = source.schedule && typeof source.schedule === 'object'
    && !Array.isArray(source.schedule) ? source.schedule : null;
  const task = createTask({
    title: source.title,
    notes: source.notes,
    due: source.due,
    priority: source.priority,
    schedule: planned ? cloneSchedule(planned) : null,
  });
  if (!task) return null;
  let shaped;
  if (planned) {
    // Повтор, включённый в листе, обязан иметь серию с самого начала (Б7.7).
    shaped = startSeries(task, today()) || task;
  } else {
    shaped = applyQuadrantMove(task, quadrantId, today()) || task;
  }
  // null = «задачи нет ни в хранилище, ни на экране»: по этому ответу
  // вызывающий код не имеет права рапортовать добавление.
  return commitTasks([shaped].concat(tasks)) ? shaped : null;
}

// Отметка «выполнено» над повторяющейся задачей — это завершение ЭКЗЕМПЛЯРА:
// одним списком закрываем текущий и открываем следующий (Б7.6). Клика по
// уже выполненному экземпляру достаточно, чтобы предложить возврат в работу
// (Б7.8) — прежний снятие галочки молча ломал бы связь серии.
export function toggleDone(taskId) {
  const result = completeOccurrence(tasks, taskId, today());
  if (result.status === 'noop') return reopenDone(taskId);
  if (!result.ok) return false;
  if (!commitTasks(result.tasks)) return false;
  if (result.status === 'recurring') {
    showToast('Выполнено — следующий уже в списке');
  } else if (!showDone) {
    showToast('Выполнено');
  } else {
    showToast('Выполнено — осталось в списке');
  }
  return true;
}

function reopenDone(taskId) {
  const back = reopenOccurrence(tasks, taskId, today());
  if (back.ok) {
    if (!commitTasks(back.tasks)) return false;
    showToast('Вернули в работу');
    return true;
  }
  if (back.status === 'no-series' || back.status === 'reopened-no-generation') {
    const next = tasks.map(t => (t.id === taskId ? markDone(t, false) : t));
    if (!commitTasks(next)) return false;
    showToast('Вернули в работу');
    return true;
  }
  // Следующий экземпляр правился или уже выполнен — удалять его нельзя,
  // поэтому возврат предлагается как отдельная задача без повтора (Б7.8).
  openRestorePrompt(taskId);
  return false;
}

function openRestorePrompt(taskId) {
  if (overlayById('confirm')) return;
  pushOverlay(confirmLayer({
    heading: 'Возврат ломает серию',
    text: 'Следующий экземпляр уже существует и правился. Вернуть эту задачу '
      + 'отдельной — без правила повтора?',
    actions: [
      {
        label: 'Отмена',
        className: 'matrix-confirm-cancel',
        safe: true,
        onClick: () => {},
      },
      {
        label: 'Вернуть отдельной',
        className: 'matrix-confirm-accept',
        onClick: () => restoreAsSingle(taskId),
      },
    ],
  }));
}

function restoreAsSingle(taskId) {
  const source = tasks.filter(t => t.id === taskId)[0];
  if (!source) return false;
  const schedule = cloneSchedule(source.schedule);
  schedule.repeat = null;
  schedule.series = null;
  const edited = editSchedule(source, schedule, today());
  if (!edited) return false;
  const single = markDone(edited, false);
  const next = tasks.map(t => (t.id === taskId ? single : t));
  if (!commitTasks(next)) return false;
  showToast('Задача вернулась без повтора');
  return true;
}

export function moveToQuadrant(taskId, quadrantId) {
  let moved = null;
  const next = tasks.map(t => {
    if (t.id !== taskId) return t;
    moved = applyQuadrantMove(t, quadrantId, today()) || t;
    return moved;
  });
  if (!moved) return null;
  return commitTasks(next) ? moved : null;
}

// Перенос назначенного интервала (ТЗ Б6.4/Б6.6): данные готовят кандидата и
// список конфликтов, а решение подтверждает экран. Без конфликтов перенос
// происходит сразу — прежний путь legacy не обрастает лишним вопросом.
function requestMove(taskId, quadrantId, closeMove) {
  const task = tasks.filter(t => t.id === taskId)[0];
  if (!task) return false;
  const plan = prepareQuadrantMove(task, quadrantId, today());
  if (!plan) return false;
  if (!plan.conflicts.length) return !!moveToQuadrant(taskId, quadrantId);
  openMovePreview(task, quadrantId, plan, closeMove);
  return false;
}

function openMovePreview(task, quadrantId, plan, closeMove) {
  removeOverlay('move-preview');
  const backdrop = el('div', 'matrix-sheet-backdrop is-move-preview');
  const panel = el('div', 'matrix-sheet matrix-move-preview');
  const headingId = 'matrix-move-preview-heading';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', headingId);
  const heading = el('p', 'matrix-confirm-heading', 'Перенос изменит расписание');
  heading.id = headingId;
  panel.appendChild(heading);
  panel.appendChild(el('p', 'matrix-confirm-text', 'Задача «' + task.title + '»'));

  const list = el('ul', 'matrix-move-conflicts');
  for (const conflict of plan.conflicts) {
    list.appendChild(el('li', 'matrix-move-conflict', conflict.message));
  }
  panel.appendChild(list);

  const actions = el('div', 'matrix-confirm-actions');
  const cancel = el('button', 'matrix-confirm-action matrix-move-cancel');
  cancel.type = 'button';
  cancel.textContent = 'Отмена';
  const accept = el('button', 'matrix-confirm-action matrix-move-confirm');
  accept.type = 'button';
  accept.textContent = 'Изменить срок и перенести';
  const drop = () => {
    removeOverlay('move-preview');
    // Лист переноса остаётся открытым: человек не ответил «нет» на весь перенос,
    // он отказался только менять даты.
  };
  cancel.addEventListener('click', drop);
  accept.addEventListener('click', () => {
    removeOverlay('move-preview');
    if (moveToQuadrant(task.id, quadrantId) && closeMove) closeMove();
  });
  actions.append(accept, cancel);
  panel.appendChild(actions);
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) drop();
  });
  trapTab(panel);
  pushOverlay({
    id: 'move-preview',
    kind: 'confirm',
    // Перенос снимается вместе с листом переноса: вопрос не должен остаться
    // висеть над уже закрытым списком.
    parent: 'move:' + task.id,
    node: backdrop,
    panel,
    focusTarget: cancel,
    onEscape: drop,
  });
}

export function archiveTask(taskId) {
  const next = tasks.map(t => (t.id === taskId
    ? Object.assign({}, t, { archived: true, updatedAt: new Date().toISOString() })
    : t));
  if (!commitTasks(next)) return false;
  showToast('Задача в архиве');
  return true;
}

export function restoreFromArchive(taskId) {
  const next = tasks.map(t => (t.id === taskId ? restoreTask(t) : t));
  if (!commitTasks(next)) return false;
  showToast('Вернули в матрицу');
  return true;
}

export function purgeArchived(taskId) {
  if (!commitTasks(purgeTask(tasks, taskId))) return false;
  showToast('Удалено безвозвратно');
  return true;
}

export function openQuadrantView(quadrantId, withComposer) {
  openQuadrant = quadrantId;
  archiveOpen = false;
  returnView = null;
  renderMatrixView();
  // «Добавить» из полноэкранного вида — тот же лист и та же точка возврата
  // фокуса, что и «+» в карточке.
  if (withComposer) openTaskComposer({ quadrantId, opener: detailAdd });
}

/* --- События верхнего уровня ---------------------------------------------- */

// Escape гасит ровно один верхний слой, как во всём приложении (js/app.js):
// подтверждение -> меню -> лист. true — событие разобрано, приложению больше
// ничего делать не нужно.
export function handleMatrixEscape() {
  const top = overlays[overlays.length - 1];
  if (!top) return false;
  if (top.onEscape) top.onEscape();
  else removeOverlay(top.id);
  return true;
}

// Уход с экрана подчиняется тому же правилу, что и закрытие листа: пустой
// черновик гасится молча, непустой требует решения, и переход ждёт ответа.
// false = «не уходи, я спросил».
export function handleMatrixNavigation(toView) {
  if (toView === 'matrix') return true;
  if (!requestCloseTaskComposer('navigate')) return false;
  while (overlays.length) removeOverlay(overlays[overlays.length - 1].id);
  return true;
}

/* --- Экран ---------------------------------------------------------------- */

export function renderMatrixView() {
  const host = document.getElementById('matrix-view');
  if (!host) return;
  tasks = loadTasks();
  const now = today();

  // Перерисовка снимает ТОЛЬКО экран. Листы живут в #matrix-view отдельным
  // слоем: на этом держится и «не теряет текст», и будущий вложенный
  // календарь, и возврат фокуса.
  const screen = document.getElementById('matrix-screen') || host;
  screen.textContent = '';
  detailAdd = null;

  if (archiveOpen) renderArchive(screen, now);
  else if (openQuadrant) renderDetail(screen, now);
  else renderGrid(screen, now);

  syncOverlayChrome();
}

// Для тестов и для будущего экрана «Важные»: состояние модуля наружу КОПИЕЙ.
// `schedule` — вложенный объект, и поверхностная копия отдавала бы живой
// черновик: правка returned.schedule.startDate протыкала бы форму (ТЗ Б3.7).
export function matrixDebugState() {
  return {
    tasks: tasks.map(task => Object.assign({}, task, task.schedule
      ? { schedule: cloneSchedule(task.schedule) } : null)),
    showDone,
    openQuadrant,
    archiveOpen,
    returnView,
    composerOpen: isTaskComposerOpen(),
    draft: draft ? Object.assign({}, draft, {
      schedule: cloneSchedule(draft.schedule),
    }) : null,
    priorityLabels: Object.assign({}, PRIORITY_LABEL),
  };
}
