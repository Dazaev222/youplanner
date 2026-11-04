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
  createTask,
  doneTasks,
  groupByQuadrant,
  isOverdue,
  listForQuadrant,
  loadTasks,
  markDone,
  purgeTask,
  quadrantOf,
  quadrantShape,
  restoreTask,
  saveTasks,
} from '../data/matrix.js';

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
let opener = null;             // узел «+», с которого открыли лист
let openerQuadrant = null;     // его квадрант — нужен для возврата фокуса
let pendingQuadrant = null;    // квадрант для «+», открытой после «Отбросить»
let detailAdd = null;          // «Добавить» полноэкранного вида — тот же opener
// Кнопки «+» сетки по квадрантам. Экран перерисовывается ЦЕЛИКОМ (так делает
// commitTasks после каждой успешной правки), и ссылка на узел из снятого дерева
// фокус не вернула бы — браузер отдал бы его body. Поэтому при закрытии ищем
// актуальный узел того же места.
let gridAdd = {};
let calCursor = null;          // первое число месяца в листе срока
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
  if (days < 0) return 'просрочено';
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  // До двух недель срок ближе как относительная дата: «через 4 дня» человек
  // считывает быстрее, чем сверяет «7 ноя» с календарём в голове.
  if (days <= 14) return 'через ' + days + ' ' + pluralDays(days);
  return due.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
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
  // Многоточие было единственной точкой переноса и ничего не обещало в имени.
  // Теперь это явная кнопка перемещения с тем же листом за ней.
  const move = el('button', 'matrix-task-move');
  move.type = 'button';
  move.innerHTML = svgIcon('move', 18);
  move.setAttribute('aria-label', 'Перенести задачу: ' + task.title);
  move.addEventListener('click', () => openMoveSheet(task.id));
  row.appendChild(move);
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

  // Заголовок-пилюля и «+» — СОСЕДИ в div-контейнере, а не кнопка в кнопке:
  // вложенный button и разметку ломает, и тап по «+» всплывает в обработчик
  // заголовка, который открыл бы полноэкранный список вместо листа создания.
  const header = el('div', 'matrix-card-header');

  const head = el('button', 'matrix-card-head');
  head.type = 'button';
  head.setAttribute('aria-label', 'Открыть квадрант: ' + quadrant.title);
  head.appendChild(badge(quadrant));
  head.appendChild(el('span', 'matrix-card-title', quadrant.title));
  head.addEventListener('click', () => openQuadrantView(quadrant.id));

  const add = el('button', 'matrix-card-add');
  add.type = 'button';
  add.setAttribute('aria-label', 'Добавить задачу: ' + quadrant.title);
  add.innerHTML = svgIcon('plus', 20);
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
  // Раздел живёт на одном устройстве: ключ youplanner.matrix.tasks не входит в
  // снимок синхронизации, и человек обязан читать это со спокойного слова
  // заранее, а не узнавать о нём по потерянному списку на втором телефоне.
  head.appendChild(el('p', 'matrix-sync-note',
    'Задачи матрицы хранятся только на этом устройстве и не синхронизируются'));
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
  };
}

function draftIsDirty() {
  return !!draft
    && (!!String(draft.title || '').trim() || !!String(draft.notes || '').trim());
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
  panel.appendChild(el('div', 'matrix-sheet-grabber'));
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

  panel.appendChild(el('div', 'matrix-sheet-grabber'));

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

  const pill = el('button', 'matrix-quad-pill q-' + draft.quadrant);
  pill.type = 'button';
  pill.setAttribute('aria-label', 'Квадрант: ' + picked.title);
  pill.appendChild(badge(picked));
  pill.appendChild(el('span', null, picked.title));
  pill.addEventListener('click', () => openQuadrantMenu(pill));
  layer.line.appendChild(pill);

  const due = el('button', 'matrix-attr' + (draft.due ? ' is-set' : ''));
  due.type = 'button';
  due.innerHTML = svgIcon('calendar', 18);
  due.appendChild(el('span', 'matrix-attr-label',
    draft.due ? dueLabel({ due: draft.due }, today()) : 'Срок'));
  due.setAttribute('aria-label', 'Срок исполнения');
  due.addEventListener('click', () => openDateSheet());
  layer.line.appendChild(due);

  const flag = el('button', 'matrix-attr' + priorityClass(draft.priority));
  flag.type = 'button';
  flag.innerHTML = svgIcon('flag', 18);
  flag.appendChild(el('span', 'matrix-attr-label', priorityLabel(draft.priority)));
  flag.setAttribute('aria-label', 'Приоритет');
  flag.addEventListener('click', () => openPriorityMenu(flag));
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
  };
  // Черновик сбрасывается ДО записи — единственная перерисовка (внутри
  // commitTasks) показывает уже пустой список. Не состоялась запись — черновик
  // возвращается ЦЕЛИКОМ, вместе со сроком и приоритетом, а лист остаётся
  // открытым: отказ хранилища не повод выбрасывать ввод.
  const typed = draft;
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
  renderMatrixView();
  return false;
}

// Выбор квадранта в листе — это выбор ПРИЧИНЫ: срок и приоритет переставляются
// тем же правилом, что и перенос карточки (quadrantShape), иначе форма и
// перенос означали бы разное. Экран за выбором НЕ идёт: лист лежит поверх
// любого экрана, и переключение плашки не имеет права уводить человека из сетки
// в полноэкранный вид и обратно.
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
  refreshComposer();
  return true;
}

/* Контракт с Воркером 2 (ТЗ А5): лист обмена расписанием отдаёт и принимает
   КОПИИ, а apply вызывает только «Готово» календаря. До интеграции интервала
   адаптер живёт над `due` — в DOM будущая схема не зашита. */

export function getDraftSchedule() {
  if (!draft) return null;
  return { due: draft.due };
}

export function applyDraftSchedule(value) {
  if (!draft || !value || typeof value !== 'object') return false;
  draft.due = typeof value.due === 'string' ? value.due : null;
  refreshComposer();
  return true;
}

/* --- Меню и листы --------------------------------------------------------- */

function popover(anchor, items) {
  removeOverlay('pop');
  const pop = el('div', 'matrix-pop');
  pop.setAttribute('role', 'menu');
  for (const item of items) {
    const btn = el('button', 'matrix-pop-item' + (item.className ? ' ' + item.className : ''));
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    if (item.badge) btn.appendChild(badge(item.badge));
    if (item.dot) btn.appendChild(el('span', 'matrix-dot ' + item.dot));
    if (item.icon) {
      const mark = el('span', 'matrix-pop-icon');
      mark.innerHTML = svgIcon(item.icon, 18);
      btn.appendChild(mark);
    }
    btn.appendChild(el('span', 'matrix-pop-label', item.label));
    if (item.trailing) btn.appendChild(el('span', 'matrix-pop-trailing', item.trailing));
    btn.addEventListener('click', () => {
      removeOverlay('pop');
      item.onPick();
    });
    pop.appendChild(btn);
  }
  const layer = pushOverlay({
    id: 'pop', kind: 'pop', node: pop, panel: pop,
    onEscape: () => removeOverlay('pop'),
  });
  if (!layer) return null;
  // Позиция считается по прямоугольнику якоря, а не задана на глаз: меню
  // открывается и над пилюлей в листе, и в полноэкранном виде, а координаты
  // там разные.
  const box = pop.getBoundingClientRect();
  const at = anchor.getBoundingClientRect();
  let top = at.top - box.height - 8;
  if (top < 8) top = Math.min(at.bottom + 8, window.innerHeight - box.height - 8);
  let left = at.left;
  if (left + box.width > window.innerWidth - 12) {
    left = Math.max(12, window.innerWidth - box.width - 12);
  }
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
  return pop;
}

function openQuadrantMenu(anchor) {
  popover(anchor, QUADRANTS.map(q => ({
    label: q.title,
    badge: q,
    className: 'q-' + q.id + (q.id === draft.quadrant ? ' is-current' : ''),
    onPick: () => {
      pickDraftQuadrant(q.id);
      focusComposer();
    },
  })));
}

function openPriorityMenu(anchor) {
  const order = [PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW, PRIORITY_NONE];
  popover(anchor, order.map(value => ({
    label: PRIORITY_LABEL[value],
    dot: 'p' + value,
    className: value === draft.priority ? ' is-current' : '',
    onPick: () => { draft.priority = value; refreshComposer(); },
  })));
}

// Лист срока — календарь на месяц, как в эталоне, плюс три быстрых дня и
// красное «Очистить». Неделя начинается с понедельника — так же, как во всей
// таблице приложения (getWeekStart в js/core/dates.js), иначе два календаря
// спорили бы друг с другом. Поле «Срок» и его содержимое — зона Воркера 2;
// здесь лист подключён к общему стеку слоёв (parent — лист создания), чтобы
// закрытие черновика снимало и его.
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function openDateSheet() {
  removeOverlay('date');
  const base = draft.due ? parseISODate(draft.due) : today();
  calCursor = new Date(base.getFullYear(), base.getMonth(), 1);

  const backdrop = el('div', 'matrix-sheet-backdrop is-date');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Срок исполнения');
  const panel = el('div', 'matrix-sheet is-date');
  backdrop.appendChild(panel);

  const closeDate = () => {
    removeOverlay('date');
    refreshComposer();
  };
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeDate();
  });

  const redraw = () => {
    panel.textContent = '';
    panel.appendChild(el('div', 'matrix-sheet-grabber'));

    const head = el('div', 'matrix-sheet-head');
    const cancel = iconButton('close', 'matrix-sheet-x', 'Закрыть');
    cancel.addEventListener('click', closeDate);
    head.appendChild(cancel);
    head.appendChild(el('p', 'matrix-date-title', 'Срок исполнения'));
    const ok = el('button', 'matrix-sheet-ok');
    ok.type = 'button';
    ok.setAttribute('aria-label', 'Готово');
    ok.innerHTML = svgIcon('check', 22);
    ok.addEventListener('click', closeDate);
    head.appendChild(ok);
    panel.appendChild(head);

    const month = el('div', 'matrix-cal-month');
    const prev = iconButton('back', 'matrix-cal-nav', 'Предыдущий месяц', 18);
    prev.addEventListener('click', () => {
      calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
      redraw();
    });
    // Месяц строчными и без «г.»: так пишет русская типографика, а
    // toLocaleDateString с year:'numeric' выдаёт «ноябрь 2026 г.».
    const label = el('span', 'matrix-cal-label',
      calCursor.toLocaleDateString('ru-RU', { month: 'long' }) + ' ' + calCursor.getFullYear());
    const next = iconButton('back', 'matrix-cal-nav is-next', 'Следующий месяц', 18);
    next.addEventListener('click', () => {
      calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
      redraw();
    });
    month.append(prev, label, next);
    panel.appendChild(month);

    const grid = el('div', 'matrix-cal-grid');
    grid.setAttribute('role', 'grid');
    for (const wd of WEEKDAYS) grid.appendChild(el('span', 'matrix-cal-wd', wd));
    const first = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) grid.appendChild(el('span', 'matrix-cal-pad'));
    const daysInMonth = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 0).getDate();
    const todayIso = toISODate(today());
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = toISODate(new Date(calCursor.getFullYear(), calCursor.getMonth(), day));
      const cell = el('button', 'matrix-cal-day'
        + (iso === todayIso ? ' is-today' : '')
        + (iso === draft.due ? ' is-selected' : ''));
      cell.type = 'button';
      cell.textContent = String(day);
      cell.setAttribute('aria-label', iso);
      if (iso === draft.due) cell.setAttribute('aria-pressed', 'true');
      cell.addEventListener('click', () => {
        draft.due = iso;
        refreshComposer();
        redraw();
      });
      grid.appendChild(cell);
    }
    panel.appendChild(grid);

    const now = today();
    const chips = [
      { label: 'Сегодня', due: toISODate(now) },
      { label: 'Завтра', due: toISODate(addDays(now, 1)) },
      { label: 'Через неделю', due: toISODate(addDays(now, 7)) },
    ];
    const row = el('div', 'matrix-chips');
    for (const chip of chips) {
      const btn = el('button', 'matrix-chip' + (chip.due === draft.due ? ' is-current' : ''));
      btn.type = 'button';
      btn.textContent = chip.label;
      btn.addEventListener('click', () => {
        const picked = parseISODate(chip.due);
        calCursor = new Date(picked.getFullYear(), picked.getMonth(), 1);
        draft.due = chip.due;
        refreshComposer();
        redraw();
      });
      row.appendChild(btn);
    }
    panel.appendChild(row);

    const clear = el('button', 'matrix-clear', 'Очистить');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      draft.due = null;
      refreshComposer();
      redraw();
    });
    panel.appendChild(clear);
  };

  pushOverlay({
    id: 'date', kind: 'sheet', parent: 'composer', node: backdrop, panel,
    onEscape: closeDate,
  });
  trapTab(panel);
  redraw();
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
  panel.appendChild(el('div', 'matrix-sheet-grabber'));
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
      if (moveToQuadrant(task.id, q.id)) closeMove();
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
    return true;
  }
  tasks = previous;
  showErrorToast(SAVE_ERROR_TEXT);
  return false;
}

export function addTask(quadrantId, fields) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const task = createTask({
    title: source.title,
    notes: source.notes,
    due: source.due,
    priority: source.priority,
  });
  if (!task) return null;
  // Квадрант — намерение, а не метка: превращаем его в причину тем же
  // move-правилом, что и перенос карточки.
  const shaped = applyQuadrantMove(task, quadrantId, today()) || task;
  // null = «задачи нет ни в хранилище, ни на экране»: по этому ответу
  // вызывающий код не имеет права рапортовать добавление.
  return commitTasks([shaped].concat(tasks)) ? shaped : null;
}

export function toggleDone(taskId) {
  let doneNow = false;
  const next = tasks.map(t => {
    if (t.id !== taskId) return t;
    doneNow = !t.done;
    return markDone(t, !t.done);
  });
  if (!commitTasks(next)) return false;
  if (doneNow && !showDone) showToast('Выполнено');
  else if (doneNow) showToast('Выполнено — осталось в списке');
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

// Для тестов и для будущего экрана «Важные»: состояние модуля наружу копией.
export function matrixDebugState() {
  return {
    tasks: tasks.slice(),
    showDone,
    openQuadrant,
    archiveOpen,
    returnView,
    composerOpen: isTaskComposerOpen(),
    draft: draft ? Object.assign({}, draft) : null,
    priorityLabels: Object.assign({}, PRIORITY_LABEL),
  };
}
