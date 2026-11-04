/* Экран «Матрица Эйзенхауэра» — по эталону TickTick, включая его жесты.

   Что взято из эталона и почему именно так:

   * Сетка 2×2 белых карточек на сером холсте. Карточка отделяется заливкой и
     мягкой тенью, а не рамкой и не цветной полосой: полоса — «странная
     линия», которая не значит ничего. Опознаватель квадранта — бейдж с
     римской цифрой и цвет заголовка.
   * Тап по квадранту открывает ПОЛНОЭКРАННЫЙ вид этого квадранта: список
     задач, назад-стрелка слева, «⋯» справа, а внизу — инлайн-строка ввода,
     которая растёт вместе с клавиатурой. Это не «модалка поверх»: в эталоне
     добавление — часть экрана, и человек видит список, куда пишет.
   * Квадрант в строке ввода меняется пилюлей, из которой выпадает список
     четырёх — а не сеткой пилюль внутри модалки, как было у меня.
   * Пустой список — воронка с конфетти: большая в полноэкранном виде, маленькая
     в карточке сетки.
   * Срок — лист с быстрыми плашками («сегодня», «завтра», «через неделю») и
     календарём, а не голое нативное поле: в 90% случаев срок выбирают одним
     тапом.

   Перенос задачи — лист по «⋯» в строке, а не drag: на телефоне drag
   конфликтует с вертикальным скроллом, а его «призрак» на пол-экрана прячет
   тот самый квадрант, куда человек целится.

   Пользовательский текст уходит через textContent, разметка собирается из
   константных строк: `<img onerror>` в заголовке задачи не должен становиться
   разметкой.

   Правка матрицы считается сделанной ПОСЛЕ успешной записи, а не до неё
   (см. commitTasks): при переполненной квоте или в приватном режиме хранилище
   ничего не принимает, и «Добавлено» поверх несостоявшейся записи было бы
   ложью интерфейса о сохранности данных — черновик терялся бы вместе с ней. */

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

// Причина отказа записи называется вслух: «что-то не сохранилось» читают как
// «авось потом», а «память браузера занята» — как «надо почистить». Текст один
// на все правки, потому что важен не тип действия, а то, что правка до
// хранилища не дошла. showErrorToast — тот же единственный #toast, что у
// остальных экранов: второго слоя подсказок здесь нет.
const SAVE_ERROR_TEXT = 'Не удалось сохранить: память браузера занята, изменения не сохранены';

// Иконки — один набор, один штрих (1.6), одна сетка 24×24. Рисовать их «на
// глаз» в разных местах нельзя: разъехавшаяся толщина штриха читается сразу.
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
  dots: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/>'
    + '<circle cx="18.5" cy="12" r="1.4"/>',
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
let showDone = false;          // выполненные видны только по просьбе из «⋯»
let openQuadrant = null;       // id квадранта в полноэкранном виде, null — сетка
let archiveOpen = false;       // тот же экран, но список архива
let composerOpen = false;      // строка ввода открыта кнопкой «+»
let calCursor = null;          // первое число месяца в листе срока
let draft = null;              // черновик задачи в строке ввода
let sheet = null;              // { kind, taskId?, quadrant?, anchor? }

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
    drop.addEventListener('click', () => purgeArchived(task.id));
    row.append(restore, drop);
    return row;
  }

  row.appendChild(check);
  row.appendChild(body);
  const more = el('button', 'matrix-more', '⋯');
  more.type = 'button';
  more.setAttribute('aria-label', 'Перенести задачу: ' + task.title);
  more.addEventListener('click', () => openMoveSheet(task.id));
  row.appendChild(more);
  return row;
}

/* --- Сетка 2×2 ------------------------------------------------------------ */

function quadrantCard(quadrant, list, now) {
  const card = el('section', 'matrix-card q-' + quadrant.id);
  card.dataset.quadrant = quadrant.id;

  const head = el('button', 'matrix-card-head');
  head.type = 'button';
  head.setAttribute('aria-label', 'Открыть квадрант: ' + quadrant.title);
  head.appendChild(badge(quadrant));
  head.appendChild(el('span', 'matrix-card-title', quadrant.title));
  head.addEventListener('click', () => openQuadrantView(quadrant.id));
  card.appendChild(head);

  if (!list.length) {
    const empty = el('div', 'matrix-empty is-card');
    empty.innerHTML = FUNNEL_SVG + '<p class="matrix-empty-label">Нет задач</p>';
    card.appendChild(empty);
    return card;
  }

  const body = el('div', 'matrix-list');
  for (const task of list) body.appendChild(taskRow(task, now));
  card.appendChild(body);
  return card;
}

function renderGrid(host, now) {
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
  // Плашка стоит в шапке сетки и только в ней: полноэкранный вид квадранта —
  // свой экран, а квадрант от хранилища ничего не скрывает.
  head.appendChild(el('p', 'matrix-sync-note',
    'Задачи матрицы хранятся только на этом устройстве и не синхронизируются'));
  host.appendChild(head);

  const grid = el('div', 'matrix-grid');
  for (const q of QUADRANTS) grid.appendChild(quadrantCard(q, groups[q.id], now));
  host.appendChild(grid);

  const fab = el('button', 'matrix-fab');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Добавить задачу в матрицу');
  fab.innerHTML = svgIcon('plus', 24);
  fab.addEventListener('click', () => openQuadrantView('q1', true));
  host.appendChild(fab);

  const menu = iconButton('dots', 'matrix-head-menu', 'Меню матрицы', 20);
  menu.addEventListener('click', () => openMatrixMenu(menu));
  host.appendChild(menu);
}

/* --- Полноэкранный вид квадранта ----------------------------------------- */

function renderDetail(host, now) {
  const quadrant = quadrantById(openQuadrant);
  if (!quadrant) return;
  const wrap = el('div', 'matrix-detail q-' + quadrant.id);

  const head = el('header', 'matrix-detail-head');
  const back = iconButton('back', 'matrix-back', 'Назад к матрице');
  back.addEventListener('click', () => {
    openQuadrant = null;
    archiveOpen = false;
    composerOpen = false;
    renderMatrixView();
  });
  head.appendChild(back);
  head.appendChild(el('h2', 'matrix-detail-title',
    archiveOpen ? 'Архив' : quadrant.title));
  const menu = iconButton('dots', 'matrix-detail-menu', 'Ещё', 20);
  menu.addEventListener('click', () => openMatrixMenu(menu));
  head.appendChild(menu);
  wrap.appendChild(head);

  const body = el('div', 'matrix-detail-body');
  const list = archiveOpen
    ? archiveTasks(tasks)
    : listForQuadrant(tasks, quadrant.id, now, showDone);

  if (!list.length) {
    body.appendChild(emptyBlock('Нет задач',
      archiveOpen ? 'Здесь лежат снятые задачи' : 'Здесь появятся задачи'));
  } else {
    const rows = el('div', 'matrix-detail-list');
    for (const task of list) {
      const item = el('div', 'matrix-detail-item q-'
        + (archiveOpen ? quadrant.id : quadrantOf(task, now)));
      item.appendChild(taskRow(task, now, { plain: true, archive: archiveOpen }));
      rows.appendChild(item);
    }
    body.appendChild(rows);
  }
  wrap.appendChild(body);

  if (!archiveOpen) {
    if (composerOpen) {
      wrap.appendChild(composerBar(quadrant));
    } else {
      wrap.appendChild(detailFab());
    }
    // Тап мимо открытой строки закрывает её — но только если в ней ничего не
    // набрано: терять ввод из-за случайного касания списка нельзя.
    // «+» в списке исключён: собственный обработчик кнопки перерисовывает экран,
    // и событие долетает до ЭТОГО слушателя по старому (уже откреплённому) дереву,
    // где wrap ещё остаётся родителем кнопки — без исключения строка ввода
    // закрывалась в тот же миг, как открывалась.
    wrap.addEventListener('click', (event) => {
      if (!composerOpen || (draft.title || draft.notes)) return;
      if (event.target.closest('.matrix-composer, .matrix-fab, .matrix-pop, '
        + '.matrix-sheet-backdrop, .matrix-detail-head, .matrix-detail-item')) return;
      closeComposer();
    });
  }
  host.appendChild(wrap);
}

// Кнопка «+» в полноэкранном виде квадранта: строка ввода не висит на экране
// постоянно — в покое виден список и воронка, а ввод открывается по тапу.
function detailFab() {
  const fab = el('button', 'matrix-fab');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Добавить задачу');
  fab.innerHTML = svgIcon('plus', 24);
  fab.addEventListener('click', () => {
    composerOpen = true;
    renderMatrixView();
    focusComposer();
  });
  return fab;
}

function focusComposer() {
  const node = document.querySelector('#matrix-view .matrix-composer-title');
  if (node) node.focus();
}

function closeComposer() {
  composerOpen = false;
  renderMatrixView();
}

/* --- Инлайн-строка ввода -------------------------------------------------- */

function newDraft(quadrantId) {
  const now = today();
  return {
    quadrant: quadrantId || 'q1',
    title: '',
    notes: '',
    due: quadrantId === 'q1' || quadrantId === 'q3' ? toISODate(now) : null,
    priority: PRIORITY_MEDIUM,
  };
}

// Выбор квадранта в строке ввода — это выбор ПРИЧИНЫ: срок и приоритет
// переставляются тем же правилом, что и перенос карточки (quadrantShape),
// иначе форма и drag означали бы разное. Экран следует за выбором: строка
// ввода живёт только в полноэкранном виде квадранта, и без этого карточка
// улетала бы в список, которого пользователь не видит.
export function pickDraftQuadrant(quadrantId) {
  if (!quadrantById(quadrantId)) return false;
  if (!draft) draft = newDraft(quadrantId);
  draft.quadrant = quadrantId;
  openQuadrant = quadrantId;
  archiveOpen = false;
  const shape = quadrantShape(quadrantId, draft, today());
  if (shape) {
    draft.due = shape.due;
    draft.priority = shape.priority;
  }
  renderMatrixView();
  return true;
}

function composerBar(quadrant) {
  if (!draft) draft = newDraft(quadrant.id);
  const form = el('form', 'matrix-composer');

  const title = el('textarea', 'matrix-composer-title');
  title.name = 'title';
  title.rows = 1;
  title.maxLength = 200;
  title.placeholder = 'Что бы вы хотели сделать?';
  title.value = draft.title;
  title.addEventListener('input', () => {
    draft.title = title.value;
    autoGrow(title);
  });

  const notes = el('input', 'matrix-composer-notes');
  notes.type = 'text';
  notes.name = 'notes';
  notes.maxLength = 2000;
  notes.placeholder = 'Описание';
  notes.value = draft.notes;
  notes.addEventListener('input', () => { draft.notes = notes.value; });

  const line = el('div', 'matrix-composer-line');

  const pill = el('button', 'matrix-quad-pill q-' + draft.quadrant);
  pill.type = 'button';
  const picked = quadrantById(draft.quadrant) || quadrant;
  pill.appendChild(badge(picked));
  pill.appendChild(el('span', null, picked.title));
  pill.addEventListener('click', () => openQuadrantMenu(pill));
  line.appendChild(pill);

  const due = el('button', 'matrix-attr' + (draft.due ? ' is-set' : ''));
  due.type = 'button';
  due.innerHTML = svgIcon('calendar', 18);
  const dueLabelNode = el('span', 'matrix-attr-label',
    draft.due ? dueLabel({ due: draft.due }, today()) : 'Срок');
  due.appendChild(dueLabelNode);
  due.setAttribute('aria-label', 'Срок исполнения');
  due.addEventListener('click', () => openDateSheet());

  const flag = el('button', 'matrix-attr' + (draft.priority !== PRIORITY_NONE ? ' is-set p' + draft.priority : ''));
  flag.type = 'button';
  flag.innerHTML = svgIcon('flag', 18);
  flag.appendChild(el('span', 'matrix-attr-label',
    draft.priority === PRIORITY_NONE ? 'Приоритет' : PRIORITY_LABEL[draft.priority]));
  flag.setAttribute('aria-label', 'Приоритет');
  flag.addEventListener('click', () => openPriorityMenu(flag));

  line.append(due, flag);

  const send = el('button', 'matrix-send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Добавить задачу');
  send.innerHTML = svgIcon('check', 22);
  line.appendChild(send);

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
  return form;
}

function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = Math.min(120, node.scrollHeight) + 'px';
}

function submitDraft() {
  const name = (draft.title || '').trim();
  if (!name) {
    showToast('Нужно название задачи');
    return;
  }
  const quadrant = draft.quadrant;
  const fields = {
    title: name,
    notes: draft.notes,
    due: draft.due,
    priority: draft.priority,
  };
  // Черновик сбрасывается ДО записи — единственная перерисовка (внутри addTask)
  // показывает уже пустую строку. Не состоялась запись — черновик возвращается
  // на место и экран перерисовывается с ним: набранный текст обязан остаться в
  // поле, а причину отказа уже назвал commitTasks.
  const typed = draft;
  draft = newDraft(quadrant);
  if (addTask(quadrant, fields)) {
    showToast('Добавлено');
    return;
  }
  draft = typed;
  renderMatrixView();
}

/* --- Меню и листы --------------------------------------------------------- */

function closeSheet() {
  sheet = null;
  const old = document.querySelector('.matrix-pop, .matrix-sheet-backdrop');
  if (old) old.remove();
}

function popover(anchor, items) {
  closeSheet();
  const host = document.getElementById('matrix-view');
  if (!host) return null;
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
      closeSheet();
      item.onPick();
    });
    pop.appendChild(btn);
  }
  host.appendChild(pop);
  // Позиция считается по прямоугольнику якоря, а не задана на глаз: меню
  // открывается и над пилюлей в строке ввода, и над «⋯» в шапке, а координаты
  // там разные, и полноэкранный вид их ещё и сдвигает.
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
    onPick: () => { draft.priority = value; renderMatrixView(); },
  })));
}

// Лист срока — календарь на месяц, как в эталоне, плюс три быстрых дня и
// красное «Очистить». Голое нативное поле `type=date` оставаться не может:
// срок выбирают одним тапом, а не разворачиванием системного виджета.
// Неделя начинается с понедельника — так же, как во всей таблице приложения
// (getWeekStart в js/core/dates.js), иначе два календаря спорили бы друг с
// другом.
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function openDateSheet() {
  closeSheet();
  const host = document.getElementById('matrix-view');
  if (!host) return;

  const base = draft.due ? parseISODate(draft.due) : today();
  calCursor = new Date(base.getFullYear(), base.getMonth(), 1);

  const backdrop = el('div', 'matrix-sheet-backdrop');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Срок исполнения');
  const panel = el('div', 'matrix-sheet is-date');
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) { closeSheet(); renderMatrixView(); }
  });
  host.appendChild(backdrop);

  const redraw = () => {
    panel.textContent = '';
    panel.appendChild(el('div', 'matrix-sheet-grabber'));

    const head = el('div', 'matrix-sheet-head');
    const cancel = iconButton('close', 'matrix-sheet-x', 'Закрыть');
    cancel.addEventListener('click', () => { closeSheet(); renderMatrixView(); });
    head.appendChild(cancel);
    head.appendChild(el('p', 'matrix-date-title', 'Срок исполнения'));
    const ok = el('button', 'matrix-sheet-ok');
    ok.type = 'button';
    ok.setAttribute('aria-label', 'Готово');
    ok.innerHTML = svgIcon('check', 22);
    ok.addEventListener('click', () => { closeSheet(); renderMatrixView(); });
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
        redraw();
      });
      row.appendChild(btn);
    }
    panel.appendChild(row);

    const clear = el('button', 'matrix-clear', 'Очистить');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      draft.due = null;
      redraw();
    });
    panel.appendChild(clear);
  };

  redraw();
}

function openMatrixMenu(anchor) {
  const archived = archiveTasks(tasks).length;
  const items = [{
    label: showDone ? 'Скрыть выполненные' : 'Показать выполненные',
    icon: 'check',
    trailing: showDone ? 'вкл' : '',
    onPick: () => { showDone = !showDone; renderMatrixView(); },
  }];
  if (archived) {
    items.push({
      label: 'Архив',
      icon: 'archive',
      trailing: String(archived),
      onPick: () => {
        archiveOpen = true;
        openQuadrant = openQuadrant || 'q1';
        renderMatrixView();
      },
    });
  }
  popover(anchor, items);
}

function openMoveSheet(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  closeSheet();
  const host = document.getElementById('matrix-view');
  if (!host) return;

  const backdrop = el('div', 'matrix-sheet-backdrop');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Перенести задачу');
  const panel = el('div', 'matrix-sheet');
  panel.appendChild(el('div', 'matrix-sheet-grabber'));
  panel.appendChild(el('p', 'matrix-sheet-title', task.title.length > 44
    ? task.title.slice(0, 44) + '…' : task.title));
  panel.appendChild(el('p', 'matrix-sheet-sub',
    'Сейчас: ' + ((quadrantById(quadrantOf(task, today())) || {}).title || '—')));

  for (const q of moveOptions(task, today())) {
    const item = el('button', 'matrix-sheet-item q-' + q.id);
    item.type = 'button';
    item.appendChild(badge(q));
    item.appendChild(el('span', 'matrix-sheet-name', q.title));
    item.appendChild(el('span', 'matrix-sheet-hint', q.hint));
    item.addEventListener('click', () => { moveToQuadrant(task.id, q.id); closeSheet(); });
    panel.appendChild(item);
  }

  const archive = el('button', 'matrix-sheet-item is-archive');
  archive.type = 'button';
  const archiveMark = el('span', 'matrix-pop-icon');
  archiveMark.innerHTML = svgIcon('archive', 18);
  archive.appendChild(archiveMark);
  archive.appendChild(el('span', 'matrix-sheet-name', 'В архив'));
  archive.addEventListener('click', () => { archiveTask(task.id); closeSheet(); });
  panel.appendChild(archive);

  const cancel = el('button', 'matrix-sheet-cancel', 'Отмена');
  cancel.type = 'button';
  cancel.addEventListener('click', () => { closeSheet(); renderMatrixView(); });
  panel.appendChild(cancel);

  backdrop.appendChild(panel);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) { closeSheet(); renderMatrixView(); }
  });
  host.appendChild(backdrop);
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
  composerOpen = !!withComposer;
  if (!draft || draft.quadrant !== quadrantId) draft = newDraft(quadrantId);
  renderMatrixView();
  if (composerOpen) focusComposer();
}

export function matrixTasks() {
  return activeTasks(tasks);
}

/* --- Экран ---------------------------------------------------------------- */

export function renderMatrixView() {
  const host = document.getElementById('matrix-view');
  if (!host) return;
  tasks = loadTasks();
  const now = today();

  // Листы и меню живут внутри #matrix-view, поэтому перерисовка снимает их
  // сама.
  host.textContent = '';
  sheet = null;

  if (openQuadrant) renderDetail(host, now);
  else renderGrid(host, now);
}

// Для тестов и для будущего экрана «Важные»: состояние модуля наружу копией.
export function matrixDebugState() {
  return {
    tasks: tasks.slice(),
    showDone,
    openQuadrant,
    archiveOpen,
    draft: draft ? Object.assign({}, draft) : null,
    priorityLabels: Object.assign({}, PRIORITY_LABEL),
  };
}
