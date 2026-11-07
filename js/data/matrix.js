/* Матрица Эйзенхауэра: задачи и их квадранты.

   Квадрант НЕ хранится — он ВЫЧИСЛЯЕТСЯ из двух независимых осей (план
   `_orchestra_tasks/ARCH_PLANS.md` §1, решение Р1): срок `due` даёт срочность,
   `priority` даёт важность. Хранить «квадрант» означало бы через неделю иметь
   рассинхрон с календарём: завтрашняя задача сегодня стала бы «срочной» сама,
   без участия человека.

   С ТЗ Воркера 1 («Фабрика») раздел синхронизируется аддитивным узлом
   plannerV1 (ТЗ §1.3): локальный список живёт по-прежнему под
   MATRIX_STORAGE_KEY, а поверх него — атомарный envelope
   STORAGE_KEYS.plannerEnvelope (js/data/storage.js): снимок entries/settings/
   tombstones с per-field Lamport-версиями, outbox операций и наблюдаемые
   счётчики. saveTasks остаётся ЕДИНСТВЕННОЙ точкой записи экрана
   (commitTasks вызывает её без изменений сигнатуры): адаптер снимает diff
   старого и нового списков в операции applyPlannerOperation, сначала честно
   сохраняет envelope, потом список; отказ хранилища на любом шаге — прежнее
   состояние целиком. Предметные поля plannerV1 — только существующие поля
   задачи (title, notes, priority, doDate, order, archived, schedule —
   атомарно: дата+время+зона+повтор+напоминания, completion {done, doneAt},
   provenance {createdAt, updatedAt, generatedAt, previousOccurrenceId});
   `due` и квадрант остаются производными от расписания/приоритета и вторым
   источником истины не заводятся. */

import { bus } from '../core/bus.js';
import { getOwnerAccount } from './firebase-auth.js';
import {
  normalizePlannerV1, applyPlannerOperation, migratePlannerV1,
  plannerCanonicalJson,
} from '../sync/merge.js';
import {
  STORAGE_KEYS, loadPlannerEnvelope, savePlannerEnvelope, createPlannerEnvelope,
  plannerNewActorId, plannerNextVersion, plannerNextOpId,
  plannerObserveVersions,
} from './storage.js';
import { safeSetItem } from '../core/storage.js';
import { DAY_MS, addDays, isDateLike, parseISODate, toISODate } from '../core/dates.js';
import {
  SCHEDULE_VERSION,
  cloneSchedule,
  emptySchedule,
  nextOccurrence,
  normalizeSchedule,
  scheduleToDue,
  seriesAnchor,
  validateSchedule,
} from './matrix-schedule.js';

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

/* Поле `schedule` (ТЗ Б3) — вложенный объект версии 1, а не пять несвязанных
   полей. Три случая чтения:

   1. ключа нет вообще → миграция из legacy `due`: all-day startDate=endDate=due;
   2. версия 1 → нормализация; корректная `endDate` приоритетнее несовпадающего
      `due`, после чего `due` синхронизируется (одна истина — расписание);
   3. версия неизвестна → запись защищается: сохраняется ДОСЛОВНО (jsonClone),
      помечается `scheduleUnsupported` и не исполняется нигде, включая scheduler.
      Иначе сохранение списка после правки ДРУГОЙ задачи стёрло бы данные
      будущей версии, а это ровно то, чего требовало Б3.3. */
function sanitizeScheduleField(raw, legacyDue) {
  const result = normalizeSchedule(raw, { legacyDue });
  return result;
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
  const legacyDue = isoOrNull(raw.due);
  const scheduleResult = sanitizeScheduleField(
    raw.schedule === undefined || raw.schedule === null ? null : raw.schedule, legacyDue);
  const unsupported = scheduleResult.unsupported === true;
  const task = {
    id: raw.id,
    title,
    notes: cleanText(raw.notes, NOTES_MAX),
    due: unsupported ? legacyDue : scheduleToDue(scheduleResult.schedule),
    doDate: isoOrNull(raw.doDate),
    priority,
    done: raw.done === true,
    doneAt: raw.done === true && typeof raw.doneAt === 'string' ? raw.doneAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso,
    order: Number.isFinite(raw.order) ? raw.order : 0,
    archived: raw.archived === true,
    schedule: scheduleResult.schedule,
    scheduleUnsupported: unsupported,
    // Б7.7: связь следующего экземпляра с предыдущим входит в whitelist,
    // иначе она теряется при первой же пересборке списка.
    previousOccurrenceId: typeof raw.previousOccurrenceId === 'string'
      && raw.previousOccurrenceId !== '' ? raw.previousOccurrenceId : null,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
  };
  return task;
}

/* Что именно пришлось починить при чтении — отдельный отчёт (Б3.6): молча
   «восстановить» данные означало бы потерять доверие человека к списку.
   Issues считаются из СЫРЫХ записей, потому что нормализация повреждённые
   опции уже отбросила. */
export function loadTasksReport() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(MATRIX_STORAGE_KEY) || '[]');
  } catch (e) {
    return { tasks: [], issues: [{ taskId: null, codes: ['broken-json'] }], broken: true };
  }
  if (!Array.isArray(parsed)) return { tasks: [], issues: [], broken: false };

  const issues = [];
  const tasks = [];
  const seen = Object.create(null);
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    const task = sanitizeTask(entry);
    if (!task) continue;
    if (seen[task.id]) continue;
    seen[task.id] = true;
    tasks.push(task);
    if (plainObject(entry) && entry.schedule !== undefined && entry.schedule !== null) {
      const result = normalizeSchedule(entry.schedule, {});
      if (result.issues.length) {
        issues.push({
          taskId: task.id,
          unsupported: result.unsupported === true,
          codes: result.issues.map(issue => issue.code),
          fields: result.issues.map(issue => issue.field),
        });
      }
    }
  }
  return { tasks, issues, broken: false };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
    schedule: source.schedule,
    previousOccurrenceId: source.previousOccurrenceId,
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

/* --- plannerV1: адаптер операций Матрицы к метаданным (ТЗ §1.3) ─────────── */

// uid подтверждённого владельца (постоянный аккаунт, js/data/firebase-auth.js)
// или null — анонимный режим. Операции в outbox помечаются этим ownerKey:
// при смене аккаунта чужой outbox не отправляется (ТЗ §1.4.4).
export function plannerOwnerUid() {
  const account = getOwnerAccount();
  return account && typeof account.uid === 'string' && account.uid !== '' ? account.uid : null;
}

// Предметные поля записи plannerV1 — РОВНО существующие поля задачи
// (шлюз 1.1: sanitizeTask). due/quadrant не проектируются: они производные.
function plannerProjectTaskFields(task) {
  return {
    title: task.title,
    notes: task.notes,
    priority: task.priority,
    doDate: task.doDate,
    order: task.order,
    archived: task.archived,
    // schedule — атомарное поле: все найденные связанные дата, время, часовой
    // пояс, повтор и локальное напоминание живут в одном value и правятся
    // только целиком (несовместимые независимые правки компонентов не
    // смешиваются в невозможное расписание)
    schedule: task.schedule === undefined ? null : task.schedule,
    completion: {
      done: task.done === true,
      doneAt: task.done === true ? task.doneAt : null,
    },
    provenance: {
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      generatedAt: task.generatedAt,
      previousOccurrenceId: task.previousOccurrenceId,
    },
  };
}

function plannerField(fields, name, fallback) {
  const holder = fields && fields[name];
  if (!holder || !('value' in holder)) return fallback;
  return holder.value;
}

// Снимок plannerV1 → список задач прежней формы. Tombstoned id никогда не
// материализуются (delete-wins); запись без title отбрасывается — sanitizeTask
// всё равно её не пропустил бы, а молчать о причине здесь негде.
export function materializePlannerTasks(snapshot) {
  const normalized = normalizePlannerV1(snapshot);
  if (!normalized.ok) return [];
  const snap = normalized.snapshot;
  const out = [];
  const ids = Object.keys(snap.entries);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (Object.prototype.hasOwnProperty.call(snap.tombstones, id)) continue;
    const fields = snap.entries[id].fields;
    if (!fields.title) continue;
    const completion = plannerField(fields, 'completion', {});
    const provenance = plannerField(fields, 'provenance', {});
    const task = sanitizeTask({
      id: id,
      title: fields.title.value,
      notes: plannerField(fields, 'notes', ''),
      priority: plannerField(fields, 'priority', PRIORITY_NONE),
      doDate: plannerField(fields, 'doDate', null),
      order: plannerField(fields, 'order', 0),
      archived: plannerField(fields, 'archived', false),
      schedule: plannerField(fields, 'schedule', null),
      done: completion.done === true,
      doneAt: completion.doneAt,
      createdAt: provenance.createdAt,
      updatedAt: provenance.updatedAt,
      generatedAt: provenance.generatedAt,
      previousOccurrenceId: provenance.previousOccurrenceId,
    });
    if (task) out.push(task);
  }
  return out;
}

// Envelope из legacy-списка, лежащего в хранилище (ТЗ §1.4.5): старые id
// сохраняются, версии стартуют с 1, таблица соответствия для записей без id
// переживает повтор (детерминированный id без часов).
function plannerBuildEnvelopeFromLegacy() {
  const legacyTasks = loadTasks();
  const entries = [];
  for (let i = 0; i < legacyTasks.length; i++) {
    entries.push({ id: legacyTasks[i].id, fields: plannerProjectTaskFields(legacyTasks[i]) });
  }
  const actorId = plannerNewActorId();
  const migrated = migratePlannerV1(
    { entries: entries, settings: {} },
    { actorId: actorId, mapping: {} },
  );
  const env = createPlannerEnvelope(actorId, migrated.snapshot, migrated.mapping);
  env.lamport[actorId] = 1;
  return env;
}

// Повторяемая миграция «есть ли envelope» — публичный вход для
// js/data/migrations.js и для saveTasks. Существующий envelope НЕ трогается:
// отсутствие новой области у старого клиента/бэкапа — не удаление (ТЗ §1.4.1).
// Возвращает {env, created, saved}.
export function ensurePlannerEnvelope() {
  const existing = loadPlannerEnvelope();
  if (existing) return { env: existing, created: false, saved: true };
  const built = plannerBuildEnvelopeFromLegacy();
  const saved = savePlannerEnvelope(built);
  return { env: built, created: true, saved: saved };
}

// Только чтение: envelope или baseline из legacy-списка, БЕЗ записи. Нужен
// sync-слою, который собирает stage и пишет всё или ничего (три фазы
// applyCloudData), и saveTasks, которая откатывает envelope при отказе
// записи списка.
export function plannerLoadOrBuildEnvelope() {
  return loadPlannerEnvelope() || plannerBuildEnvelopeFromLegacy();
}

function plannerDiffOps(env, list) {
  const byId = Object.create(null);
  for (let i = 0; i < list.length; i++) {
    const task = sanitizeTask(list[i]);
    if (!task || byId[task.id]) continue;
    byId[task.id] = task;
  }
  const entries = env.snapshot.entries;
  const tombstones = env.snapshot.tombstones;
  const ops = [];
  const ids = Object.keys(byId);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    // tombstoned id не воскрешается молча: экран при желании возвращает
    // копию с НОВЫМ id (newTaskId), скрытого снятия надгробия нет
    if (Object.prototype.hasOwnProperty.call(tombstones, id)) continue;
    const fields = plannerProjectTaskFields(byId[id]);
    const existing = entries[id];
    const putFields = {};
    const names = Object.keys(fields);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const current = existing && existing.fields[name];
      if (current && plannerCanonicalJson(current.value) === plannerCanonicalJson(fields[name])) continue;
      putFields[name] = { value: fields[name], version: plannerNextVersion(env) };
    }
    if (Object.keys(putFields).length > 0) {
      ops.push({ opId: plannerNextOpId(env), type: 'put', entryId: id, fields: putFields });
    }
  }
  const entryIds = Object.keys(entries);
  for (let i = 0; i < entryIds.length; i++) {
    const id = entryIds[i];
    if (byId[id] || Object.prototype.hasOwnProperty.call(tombstones, id)) continue;
    ops.push({
      opId: plannerNextOpId(env),
      type: 'delete',
      entryId: id,
      version: plannerNextVersion(env),
      // настенные часы — только отображение; арбитр конфликта их не читает
      deletedAt: new Date().toISOString(),
    });
  }
  return ops;
}

export function saveTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  let rawBefore = null;
  try {
    rawBefore = localStorage.getItem(STORAGE_KEYS.plannerEnvelope);
  } catch (e) {
    rawBefore = null;
  }
  const env = plannerLoadOrBuildEnvelope();
  const ops = plannerDiffOps(env, list);

  // Операции применяются к снимку в памяти и только потом уезжают в
  // envelope: отказ хранилища не оставляет ни частичного снимка, ни
  // «успешной» правки списка
  const queued = [];
  let snapshot = env.snapshot;
  const report = { conflicts: [] };
  for (let i = 0; i < ops.length; i++) {
    const result = applyPlannerOperation(snapshot, ops[i], report);
    if (result.ok && result.applied) {
      snapshot = result.snapshot;
      queued.push({ opId: ops[i].opId, ownerKey: plannerOwnerUid(), operation: ops[i] });
    }
  }
  env.snapshot = snapshot;
  plannerObserveVersions(env, snapshot);
  for (let i = 0; i < queued.length; i++) env.outbox.push(queued[i]);

  const needEnvelopeWrite = queued.length > 0 || rawBefore === null;
  const listValue = JSON.stringify(list);

  // Сначала envelope (снимок+outbox+счётчики), потом публикация и список:
  // ошибка квоты на envelope не даёт ложного успеха (ТЗ §1.4.3)
  if (needEnvelopeWrite && !savePlannerEnvelope(env)) return false;

  if (!safeSetItem(MATRIX_STORAGE_KEY, listValue)) {
    // список не лег — envelope откатываем к прежним байтам: у экрана ровно
    // прежнее состояние, операций наверх не уехало
    if (needEnvelopeWrite) {
      if (rawBefore === null) {
        try { localStorage.removeItem(STORAGE_KEYS.plannerEnvelope); } catch (e) { /* уже пусто */ }
      } else {
        safeSetItem(STORAGE_KEYS.plannerEnvelope, rawBefore);
      }
    }
    return false;
  }

  if (queued.length > 0) bus.emit('data:changed');
  return true;
}

// Срочность — функция от даты, а не от настроения: просрочено, сегодня или
// в пределах порога. `today` приходит аргументом, поэтому тесты не зависят от
// часов машины (тот же приём, что у qazaStreak в js/data/stats.js).
//
// Разница считается целыми днями (dayNumber), а не делением миллисекунд на
// 86400000: в зоне с переводом часов «срок через двое суток» давал бы 2.04
// или 1.96 суток, и порог срочности скакал бы вместе с календарём.
function dayNumber(d) {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
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
// четвертый квадрант, и перенос в него обязан оставить задачу видимой:
// иначе форма добавления, где человек выбрал именно этот квадрант, прятала
// бы задачу в архив молча. Снятие в архив — отдельное действие (archiveTask).
//
// Задачи с НАЗНАЧЕННЫМ интервалом (timed, многодневный или повторяющийся —
// Б6.4) переносятся по календарному правилу сдвигa: endDate становится сегодня
// (q1), завтра (q3) или сегодня+3 (q2/q4 при близком сроке), а часы и
// календарная длина сохраняются. Остальные сохраняют прежнюю семантику shape
// (Б6.3: «legacy без нового интервала» — включая due=null в q2 и q4).
export function isAppointedSchedule(schedule) {
  if (!plainObject(schedule)) return false;
  if (schedule.allDay === false && schedule.startTime && schedule.endTime) return true;
  if (schedule.repeat) return true;
  return !!(schedule.startDate && schedule.endDate && schedule.startDate !== schedule.endDate);
}

/* Носитель интервала при переносе: сдвигаем ВСЮ дату-пару, а не только конец,
   иначе «трёхдневная встреча» превратилась бы в однодневную. */
function shiftScheduleEnd(schedule, endDateIso, today) {
  const lengthDays = Math.max(0, daySpan(schedule.startDate, schedule.endDate));
  const start = addDays(parseISODate(endDateIso), -lengthDays);
  return Object.assign({}, schedule, {
    startDate: toISODate(start),
    endDate: endDateIso,
  });
}

function daySpan(fromIso, toIso) {
  const a = parseISODate(fromIso);
  const b = parseISODate(toIso);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
    - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}

// Candidate + список конфликтов (Б6.6): решение о подтверждении принимает
// экран, а не данные — confirm и DOM из модуля данных недоступны по построению.
export function prepareQuadrantMove(task, quadrant, today) {
  const moved = applyQuadrantMove(task, quadrant, today);
  if (!moved) return null;
  const conflicts = [];
  if (isAppointedSchedule(task.schedule) && plainObject(task.schedule)) {
    conflicts.push({
      code: 'interval-shift',
      from: task.schedule.endDate,
      to: moved.schedule.endDate,
      message: 'Срок интервала изменится: ' + task.schedule.endDate + ' → ' + moved.schedule.endDate,
    });
    const absolute = (task.schedule.reminders || []).filter(r => r && r.anchor === 'absolute');
    if (absolute.length) {
      conflicts.push({
        code: 'absolute-reminder',
        ids: absolute.map(r => r.id),
        message: 'Абсолютное напоминание не следует за интервалом — его надо сохранить или удалить',
      });
    }
    if (task.schedule.repeat) {
      conflicts.push({
        code: 'series-anchor',
        message: 'Изменится дату текущего экземпляра; правило серии сохранится',
      });
    }
  }
  return { candidate: moved, conflicts };
}

export function applyQuadrantMove(task, quadrant, today) {
  const shape = quadrantShape(quadrant, task, today);
  if (!shape) return null;
  const base = task && typeof task === 'object' ? task : {};
  const now = isDateLike(today) ? today : new Date();
  let next = Object.assign({}, base, shape, {
    archived: base.archived === true,
    updatedAt: new Date().toISOString(),
  });

  if (isAppointedSchedule(base.schedule)) {
    const schedule = Object.assign({}, base.schedule);
    const urgent = isUrgent({ due: base.schedule.endDate }, now);
    if (quadrant === 'q1') {
      next.schedule = shiftScheduleEnd(schedule, toISODate(now), now);
    } else if (quadrant === 'q3') {
      next.schedule = shiftScheduleEnd(schedule, toISODate(addDays(now, 1)), now);
    } else if (quadrant === 'q2' || quadrant === 'q4') {
      next.schedule = urgent
        ? shiftScheduleEnd(schedule, toISODate(addDays(now, 3)), now)
        : schedule;
    } else {
      next.schedule = schedule;
    }
    // due выводится из расписания — иначе sanitizeTask «вернул» бы старый срок
    next.due = scheduleToDue(next.schedule);
  } else if (plainObject(base.schedule) || base.schedule === undefined || base.schedule === null) {
    // Legacy-путь: даты следуют за сроком, расписание не хранит вторую истину.
    // Настроенные напоминания при этом НЕ стираются: относительные следуют
    // за новой датой, абсолютные остаются на своём моменте (Б5) — иначе
    // перенос молча снимал бы «За 1 день» вместе со сменой квадранта.
    const previous = plainObject(base.schedule) ? base.schedule : emptySchedule();
    const reminders = Array.isArray(previous.reminders) ? previous.reminders : [];
    next.schedule = shape.due
      ? Object.assign({}, emptySchedule(), { startDate: shape.due, endDate: shape.due, reminders })
      : Object.assign({}, emptySchedule(), { reminders });
  }
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

/* --- Экземпляры серии (Б7.6 — Б7.9) ---------------------------------------

   Всё, что связано с повтором, собирается ЧИСТЫМ списком-кандидатом: экран
   записывает его одним commitTasks, а значит отказ хранилища не оставляет
   ни «выполненной» задачи, ни сиротского следующего экземпляра. */

export function newSeriesId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Расписание из одного legacy-срока: общий мост для черновика и миграции.
export function scheduleFromDue(due) {
  const iso = isoOrNull(due);
  return iso
    ? Object.assign({}, emptySchedule(), { startDate: iso, endDate: iso })
    : emptySchedule();
}

// Включение правила: series.id создаётся ОДИН РАЗ здесь, а не на каждом
// render/sanitize (Б7.7).
export function startSeries(task, today) {
  const base = task && typeof task === 'object' ? task : null;
  if (!base) return null;
  const schedule = plainObject(base.schedule) ? cloneSchedule(base.schedule) : emptySchedule();
  if (!schedule.repeat) return sanitizeTask(base);
  if (schedule.series) return sanitizeTask(base);
  schedule.series = seriesAnchor(schedule.startDate, newSeriesId());
  if (!schedule.series) return sanitizeTask(base);
  return sanitizeTask(Object.assign({}, base, {
    schedule,
    updatedAt: new Date(isDateLike(today) ? today : new Date()).toISOString(),
  }));
}

/* Смена правила повтора (Б7.9): то же правило — та же серия; другое — новая
   series.id и index=1, а выполненные экземпляры истории не переписываются.
   Снятие правила обнуляет series, срок остаётся. */
export function setTaskRepeat(task, repeat, today) {
  const base = task && typeof task === 'object' ? task : null;
  if (!base) return null;
  const schedule = plainObject(base.schedule) ? cloneSchedule(base.schedule) : emptySchedule();
  const incoming = normalizeSchedule(Object.assign({}, schedule, {
    repeat: repeat === undefined ? null : repeat,
    series: null,
  }), {}).schedule.repeat;

  const same = JSON.stringify(incoming) === JSON.stringify(schedule.repeat);
  if (same) return sanitizeTask(base);

  schedule.repeat = incoming;
  schedule.series = incoming ? seriesAnchor(schedule.startDate, newSeriesId()) : null;
  const next = Object.assign({}, base, {
    schedule,
    due: scheduleToDue(schedule),
    updatedAt: new Date(isDateLike(today) ? today : new Date()).toISOString(),
  });
  return sanitizeTask(next);
}

/* Правка расписания существующей задачи из листа (Б4.10). Значение сначала
   проверяется, потом нормализуется, и только затем пересобирается series по
   правилу Б7.9. Экран вызывает это на копии и записывает одним commitTasks,
   поэтому здесь нет ни DOM, ни откатов — только честный кандидат. */
export function editSchedule(task, value, today) {
  const base = plainObject(task) ? task : null;
  if (!base || !plainObject(value)) return null;
  if (validateSchedule(value).ok === false) return null;

  const normalized = normalizeSchedule(value, {
    legacyDue: typeof value.due === 'string' ? value.due : null,
  }).schedule;
  const previousRepeat = plainObject(base.schedule) ? base.schedule.repeat : null;
  // Сменное правило — новая серия (Б7.9); прежнюю серию пересчитывать
  // нельзя, поэтому series обнуляется и создаётся заново с index=1.
  if (JSON.stringify(normalized.repeat) !== JSON.stringify(previousRepeat)) normalized.series = null;

  const next = Object.assign({}, base, {
    schedule: normalized,
    due: scheduleToDue(normalized),
    updatedAt: new Date(isDateLike(today) ? today : new Date()).toISOString(),
  });
  return startSeries(next, today);
}

/* Выполнение повторяющейся задачи = completed copy + ровно один следующий
   активный экземпляр ОДНИМ списком (Б7.6). Повторной click по уже выполненному
   экземпляру — no-op, а не «отменить выполнение»: отмена — отдельное
   намерение (reopenOccurrence). */
export function completeOccurrence(tasks, taskId, completionDate) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const index = list.findIndex(t => t.id === taskId);
  if (index < 0) return { ok: false, status: 'missing', tasks: list, completed: null, next: null };

  const source = list[index];
  if (source.done) return { ok: false, status: 'noop', tasks: list, completed: null, next: null };
  if (source.archived) return { ok: false, status: 'archived', tasks: list, completed: null, next: null };
  if (source.scheduleUnsupported) {
    return { ok: false, status: 'unsupported', tasks: list, completed: null, next: null };
  }

  const when = isDateLike(completionDate) ? completionDate : new Date();
  const completed = markDone(source, true);
  completed.schedule = cloneSchedule(source.schedule);
  const withoutSource = list.slice(0, index).concat(list.slice(index + 1));

  const schedule = plainObject(source.schedule) ? source.schedule : emptySchedule();
  if (!schedule.repeat) {
    return { ok: true, status: 'done', tasks: [completed].concat(withoutSource), completed, next: null };
  }

  const result = nextOccurrence(Object.assign({}, schedule, {
    series: schedule.series || seriesAnchor(schedule.startDate, newSeriesId()),
  }), { completionDate: when });

  if (result.status !== 'ok' || !result.occurrence) {
    return {
      ok: true,
      status: result.status === 'invalid' ? 'invalid-rule' : 'series-end',
      reason: result.reason,
      tasks: [completed].concat(withoutSource),
      completed,
      next: null,
    };
  }

  const seriesId = result.series.id || newSeriesId();
  // Детерминированная защита от второго «next» той же пары series+index
  const already = list.some(t => plainObject(t.schedule) && plainObject(t.schedule.series)
    && t.schedule.series.id === seriesId && t.schedule.series.index === result.series.index);
  if (already) {
    return { ok: false, status: 'duplicate-occurrence', tasks: list, completed: null, next: null };
  }

  const nowIso = when.toISOString();
  const nextSchedule = cloneSchedule(Object.assign({}, schedule, {
    allDay: result.occurrence.allDay !== false ? schedule.allDay : false,
    startDate: result.occurrence.startDate,
    endDate: result.occurrence.endDate,
    startTime: schedule.allDay ? null : result.occurrence.startTime,
    endTime: schedule.allDay ? null : result.occurrence.endTime,
    reminders: result.occurrence.reminders,
    repeat: schedule.repeat,
    series: Object.assign({}, result.series, { id: seriesId }),
  }));

  const nextTask = sanitizeTask({
    id: newTaskId(),
    title: source.title,
    notes: source.notes,
    due: scheduleToDue(nextSchedule),
    doDate: source.doDate,
    priority: source.priority,
    order: source.order,
    done: false,
    createdAt: source.createdAt,
    // Б7.6: generatedAt = initial updatedAt, иначе «не редактировали ли
    // следующий» нельзя проверить однозначно.
    updatedAt: nowIso,
    generatedAt: nowIso,
    previousOccurrenceId: source.id,
    schedule: nextSchedule,
  });
  if (!nextTask) {
    return { ok: true, status: 'done', tasks: [completed].concat(withoutSource), completed, next: null };
  }
  return {
    ok: true,
    status: 'recurring',
    tasks: [completed, nextTask].concat(withoutSource),
    completed,
    next: nextTask,
  };
}

/* «Вернуть в работу» последнего завершённого экземпляра (Б7.8): если
   сгенерированный следующий ещё существует, не выполнен и не правился после
   генерации — одним списком снимаем его и возвращаем текущий. Если он уже
   изменён или завершён — удалять его молча нельзя, и экран обязан предложить
   «Восстановить как отдельную задачу без повтора». */
export function reopenOccurrence(tasks, taskId) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const index = list.findIndex(t => t.id === taskId);
  if (index < 0) return { ok: false, status: 'missing', tasks: list, removedId: null, needsNewTask: false };

  const source = list[index];
  const schedule = plainObject(source.schedule) ? source.schedule : null;
  if (!schedule || !plainObject(schedule.series)) {
    return { ok: false, status: 'no-series', tasks: list, removedId: null, needsNewTask: false };
  }
  const expectedIndex = (Number(schedule.series.index) || 1) + 1;

  const nextTask = list.find(t => t.id !== taskId
    && plainObject(t.schedule) && plainObject(t.schedule.series)
    && t.schedule.series.id === schedule.series.id
    && Number(t.schedule.series.index) === expectedIndex);

  if (!nextTask) {
    const back = markDone(source, false);
    return { ok: true, status: 'reopened-no-generation', tasks: [back].concat(list.slice(0, index).concat(list.slice(index + 1))), removedId: null, needsNewTask: false };
  }
  const untouched = nextTask.generatedAt && nextTask.updatedAt === nextTask.generatedAt;
  if (nextTask.done || !untouched) {
    return {
      ok: false,
      status: nextTask.done ? 'next-completed' : 'next-edited',
      tasks: list,
      removedId: null,
      needsNewTask: true,
    };
  }
  const back = markDone(source, false);
  const withoutBoth = list.filter(t => t.id !== taskId && t.id !== nextTask.id);
  return {
    ok: true,
    status: 'reopened',
    tasks: [back].concat(withoutBoth),
    removedId: nextTask.id,
    needsNewTask: false,
  };
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

