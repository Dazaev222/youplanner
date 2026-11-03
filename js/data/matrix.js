/* Матрица Эйзенхауэра: задачи и их квадранты.

   Квадрант НЕ хранится — он ВЫЧИСЛЯЕТСЯ из двух независимых осей (план
   `_orchestra_tasks/ARCH_PLANS.md` §1, решение Р1): срок `due` даёт срочность,
   `priority` даёт важность. Хранить «квадрант» означало бы через неделю иметь
   рассинхрон с календарём: завтрашняя задача сегодня стала бы «срочной» сама,
   без участия человека.

   Раздел ПОКА не в STORAGE_KEYS и не в снимке синхронизации: слияние задач
   требует правил по `updatedAt` в `js/sync/merge.js` и надгробий (механизм
   привычек), а без них второе устройство вернёт удалённое. До этого данные
   живут на устройстве — ключ ниже это честно говорит. */

import { safeSetItem } from '../core/storage.js';
import { addDays, isDateLike, parseISODate, toISODate } from '../core/dates.js';

export const MATRIX_STORAGE_KEY = 'youplanner.matrix.tasks';

export const TITLE_MAX = 200;
export const NOTES_MAX = 2000;
// Приоритет — числом, как в TickTick (там high/medium/low/none): булево
// «важно» не даёт ни сортировки внутри квадранта, ни честной цветовой точки.
export const PRIORITY_NONE = 0;
export const PRIORITY_LOW = 1;
export const PRIORITY_MEDIUM = 2;
export const PRIORITY_HIGH = 3;
export const PRIORITY_VALUES = [PRIORITY_NONE, PRIORITY_LOW, PRIORITY_MEDIUM, PRIORITY_HIGH];
// Порог срочности: «срок через 48 часов» ещё срочно, через три — нет.
export const URGENT_WITHIN_DAYS = 2;

// Квадранты. Порядок — обход по часовой стрелке от «срочно и важно», подписи
// и римские цифры — как в эталоне TickTick; цвета берутся из токенов
// (--matrix-qN в styles/tokens.css), здесь только идентификаторы и текст.
export const QUADRANTS = [
  { id: 'q1', numeral: 'I', title: 'Срочно и важно', hint: 'срок близок, важно' },
  { id: 'q2', numeral: 'II', title: 'Не срочно, но важно', hint: 'спешить некуда' },
  { id: 'q3', numeral: 'III', title: 'Срочно, но не важно', hint: 'горит срок' },
  { id: 'q4', numeral: 'IV', title: 'Не срочно и не важно', hint: 'ни то, ни другое' },
];

// Дата-строка или null. Проверка кругом: parseISODate на мусоре возвращает
// Invalid Date (объект, а не false), а '2026-13-45' Date разворачивает в
// другую дату. Без этого битая строка из хранилиса оседала бы в модели и
// рисовалась в карточке.
function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const parsed = parseISODate(value);
  return isDateLike(parsed) && toISODate(parsed) === value ? value : null;
}

// «Сегодня» приходит аргументом, чтобы квадрант можно было проверить без
// часов машины. isDateLike — из js/core/dates.js: в песочнице node:vm Date из
// чужого реалма не проходит `instanceof`, и проверка молча сбрасывала бы
// переданную дату на «используй сегодня» — тест проходил бы, проверяя другое
// (тот же дефект, что уже чинили в js/ui/assistant-analysis.js).
function startOfDay(value) {
  const base = isDateLike(value) ? value : new Date();
  return new Date(base.getFullYear(), base.getMonth(), base.getDate());
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Переносы в заголовке ломают строку карточки; в заметке они смысл
  const collapsed = value.replace(/[\r\n\t]+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

// Копия только известных полей: мусор из localStorage или чужой снимок не
// должны приносить в карточку то, чего модель не предполагает (та же
// дисциплина, что у `defaultHabit` в js/data/habits.js).
export function sanitizeTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const title = cleanText(raw.title, TITLE_MAX);
  if (!title) return null;
  const priority = PRIORITY_VALUES.indexOf(raw.priority) >= 0 ? raw.priority : PRIORITY_NONE;
  const nowIso = new Date().toISOString();
  const task = {
    id: raw.id,
    title,
    notes: cleanText(raw.notes, NOTES_MAX),
    due: isoOrNull(raw.due),
    doDate: isoOrNull(raw.doDate),
    priority,
    done: raw.done === true,
    doneAt: raw.done === true && typeof raw.doneAt === 'string' ? raw.doneAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso,
    order: Number.isFinite(raw.order) ? raw.order : 0,
    archived: raw.archived === true,
  };
  return task;
}

export function newTaskId() {
  // Тот же стиль id, что у привычек: префикс + время основания + случай,
  // чтобы два устройства, создавшие задачу в одну миллисекунду, не спорили.
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createTask(fields) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const nowIso = new Date().toISOString();
  const task = sanitizeTask({
    id: source.id || newTaskId(),
    title: source.title,
    notes: source.notes,
    due: source.due,
    doDate: source.doDate,
    priority: source.priority,
    done: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    order: Number.isFinite(source.order) ? source.order : Date.now(),
  });
  return task;
}

export function loadTasks() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(MATRIX_STORAGE_KEY) || '[]');
  } catch (e) {
    // Битая строка не должна ронять экран: раздел начинается с чистого листа
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < parsed.length; i++) {
    const task = sanitizeTask(parsed[i]);
    if (!task || seen[task.id]) continue;
    seen[task.id] = true;
    out.push(task);
  }
  return out;
}

export function saveTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  return safeSetItem(MATRIX_STORAGE_KEY, JSON.stringify(list));
}

// Срочность — функция от даты, а не от настроения: просрочено, сегодня или
// в пределах порога. `today` приходит аргументом, поэтому тесты не зависят от
// часов машины (тот же приём, что у qazaStreak в js/data/stats.js).
//
// Разница считается целыми днями (dayNumber), а не делением миллисекунд на
// 86400000: в зоне с переводом часов «срок через двое суток» давал бы 2.04
// или 1.96 суток, и порог срочности скакал бы вместе с календарём.
function dayNumber(d) {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

export function isUrgent(task, today) {
  if (!task || !task.due) return false;
  const due = parseISODate(task.due);
  if (!isDateLike(due)) return false;
  return dayNumber(due) - dayNumber(startOfDay(today)) <= URGENT_WITHIN_DAYS;
}

export function isImportant(task) {
  return !!task && Number(task.priority) >= PRIORITY_MEDIUM;
}

export function quadrantOf(task, today) {
  const important = isImportant(task);
  const urgent = isUrgent(task, today);
  if (important && urgent) return 'q1';
  if (important) return 'q2';
  if (urgent) return 'q3';
  return 'q4';
}

// Порядок внутри квадранта: сначала просроченные, затем по приоритету,
// затем по сроку, затем ручной `order`. Так «сделать сразу» не превращается
// в список, который человек листает в поисках горящего.
export function compareTasks(a, b, today) {
  const overdueA = isOverdue(a, today) ? 0 : 1;
  const overdueB = isOverdue(b, today) ? 0 : 1;
  if (overdueA !== overdueB) return overdueA - overdueB;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const dueA = a.due || '9999-12-31';
  const dueB = b.due || '9999-12-31';
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  // Полная ничья — ноль, а не «1»: компаратор, враньём разводящий равные
  // элементы, превращает стабильную сортировку в перестановку на пустом месте.
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt < b.createdAt ? -1 : 1;
}

export function isOverdue(task, today) {
  if (!task || !task.due || task.done) return false;
  const due = parseISODate(task.due);
  if (!isDateLike(due)) return false;
  return dayNumber(due) < dayNumber(startOfDay(today));
}

// Активные задачи: сделанные и снятые в архив уходят из матрицы, но остаются
// в хранилище — история «что было» дешевле, чем молча удалённая запись.
export function activeTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(t => t && !t.done && !t.archived);
}

// Сделанные задачи видны только по просьбе: отметка «выполнено» убирает их из
// матрицы, и без этой выборки человек теряет всякий след о том, куда делись
// строки. Архивные живут своей списочной выборкой (см. archiveTasks).
export function doneTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter(t => t && t.done && !t.archived);
}

export function archiveTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(t => t && t.archived);
}

// `showDone` — единственный случай, когда список матрицы включает выполненное:
// молча менять состав выборки в одном месте и не менять в другом — классика
// расхождения, поэтому форма списка задаётся здесь, а не на вызовах.
export function listForQuadrant(tasks, quadrant, today, showDone) {
  const list = (showDone ? activeTasks(tasks).concat(doneTasks(tasks)) : activeTasks(tasks))
    .filter(t => quadrantOf(t, today) === quadrant);
  return list.sort((a, b) => compareTasks(a, b, today));
}

export function groupByQuadrant(tasks, today, showDone) {
  const groups = { q1: [], q2: [], q3: [], q4: [] };
  const list = showDone
    ? activeTasks(tasks).concat(doneTasks(tasks))
    : activeTasks(tasks);
  for (let i = 0; i < list.length; i++) {
    groups[quadrantOf(list[i], today)].push(list[i]);
  }
  for (const id of Object.keys(groups)) groups[id].sort((a, b) => compareTasks(a, b, today));
  return groups;
}

// Причина, по которой задача попадает в квадрант: срок и приоритет. Вынесено
// из переноса, потому что его используют двое — перенос карточки и выбор
// квадранта в форме добавления. Расхождение этих двух мест означало бы, что
// «срочно и важно» из drag и из формы означает разное.
//
// Срок ставится ТОЛЬКО если он не делает квадрант сам: у задачи «важно, срок
// через неделю» перенос в q1 обязан перенести и срок на сегодня, иначе
// карточка уедет в q1 по анимации и вернётся в q2 при первой же перерисовке.
export function quadrantShape(quadrant, source, today) {
  const base = isDateLike(today) ? today : new Date();
  const raw = source && typeof source === 'object' ? source : {};
  const due = isoOrNull(raw.due);
  const priority = PRIORITY_VALUES.indexOf(raw.priority) >= 0
    ? raw.priority : PRIORITY_NONE;
  const urgent = isUrgent({ due }, base);

  if (quadrant === 'q1') {
    return { priority: Math.max(PRIORITY_MEDIUM, priority), due: urgent ? due : toISODate(base) };
  }
  if (quadrant === 'q2') {
    return { priority: Math.max(PRIORITY_MEDIUM, priority), due: null };
  }
  if (quadrant === 'q3') {
    return { priority: Math.min(PRIORITY_LOW, priority), due: urgent ? due : toISODate(addDays(base, 1)) };
  }
  if (quadrant === 'q4') {
    return { priority: Math.min(PRIORITY_LOW, priority), due: null };
  }
  return null;
}

// Перенос карточки между квадрантами меняет ПРИЧИНУ, а не «квадрант»:
// в срочные ставим близкий срок, из срочных — снимаем. Иначе drag стал бы
// второй легендой правды, расходящейся с датой.
//
// Архив — НЕ следствие квадранта. «Не срочно и не важно» — настоящий
// четвёртый квадрант, и перенос в него обязан оставить задачу видимой:
// иначе форма добавления, где человек выбрал именно этот квадрант, прятала
// бы задачу в архив молча. Снятие в архив — отдельное действие (archiveTask).
export function applyQuadrantMove(task, quadrant, today) {
  const shape = quadrantShape(quadrant, task, today);
  if (!shape) return null;
  const next = Object.assign({}, task, shape, {
    archived: task && task.archived === true,
    updatedAt: new Date().toISOString(),
  });
  return sanitizeTask(next);
}

export function markDone(task, done) {
  const next = Object.assign({}, task, {
    done: !!done,
    doneAt: done ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  });
  return sanitizeTask(next);
}

// Возврат из архива и удаление безвозвратное — два разных действия, и оба
// должны быть в данных, а не в экране: экран обязан показывать архив, прежде
// чем предлагать его очистить.
export function restoreTask(task) {
  const next = Object.assign({}, task, { archived: false, done: false, doneAt: null });
  next.updatedAt = new Date().toISOString();
  return sanitizeTask(next);
}

export function purgeTask(tasks, taskId) {
  const list = Array.isArray(tasks) ? tasks : [];
  const out = list.filter(t => t && t.id !== taskId);
  return out.length === list.length ? list : out;
}

// Сколько задач в квадранте и сколько из них горит — для подписи заголовка.
export function quadrantStats(tasks, today) {
  const groups = groupByQuadrant(tasks, today);
  const out = {};
  for (const id of Object.keys(groups)) {
    out[id] = { total: groups[id].length, overdue: groups[id].filter(t => isOverdue(t, today)).length };
  }
  return out;
}
