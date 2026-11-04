// Ключи localStorage. Реестр — только разделы ДАННЫХ: они синхронизируются
// с сервером и уходят в файловые копии. Девайс-локальные настройки и секреты
// (youplanner.api_key, youplanner.assistant_persona, youplanner.assistant_history,
// youplanner.assistant_model и пр.) сюда сознательно не входят: ключ нейросети
// не должен покидать устройство, а поведение ассистента — настройка конкретного
// устройства (обоснование — в шапке js/ui/assistant-view.js).
import { safeSetItem } from '../core/storage.js';

export const STORAGE_KEYS = {
  habits: 'youplanner.habits',
  records: 'youplanner.records',
  // Ключ снятого раздела задач: нужен только миграции migrateDropTasks(),
  // которая один раз удаляет старые данные задач с устройства.
  tasks: 'youplanner.tasks',
  schedule: 'youplanner.schedule',
  migrations: 'youplanner.migrations',
  // Месячные сводки историй старше года (js/data/archive.js)
  archive: 'youplanner.archive',
  // Надгробия удалённых привычек: { habitId: ts } — привычка удалена в
  // момент ts (js/data/habits.js). След удаления нужен аддитивному слиянию
  // (js/sync/merge.js): без него удалённая на одном устройстве привычка
  // воскресает с сервера. Раздел снимка синхронизации; в файловые бэкапы
  // не входит (buildBackup), поэтому разбор копий его никогда не видит.
  tombstones: 'youplanner.tombstones',
  // Локальный envelope области плани plannerV1 (ТЗ §1.4.3): снимок
  // entries/settings/tombstones с per-field Lamport-версиями, outbox
  // неподтверждённых операций {opId, ownerKey, operation} и Lamport-счётчики
  // по актёрам. В облако уезжает ТОЛЬКО snapshot узлом plannerV1 (sync.js);
  // сам envelope — состояние устройства, из него нельзя восстановить чужой
  // outbox или креды.
  plannerEnvelope: 'youplanner.planner.v1',
};

// ── plannerV1: атомарный локальный envelope (ТЗ §1.4.3) ─────────────────────
// Envelope читается целиком: битая строка или чужая форма — это «envelope
// нет» (null), вызывающий перестраивает его из данных Матрицы (повторяемая
// миграция), а не работает с наполовину разобранным состоянием. Запись —
// одна строка целиком через safeSetItem: либо всё, либо ничего; false
// означает «хранилище отвергло, прежние байты не тронуты».

function plannerPlainObj(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Случайный стабильный идентификатор установки — НЕ пользовательские данные.
// crypto.randomUUID есть не везде (Safari < 16.4, песочница node:vm),
// фолбэк — тот же стиль, что newTaskId() в js/data/matrix.js.
export function plannerNewActorId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (e) { /* песочницы без crypto — уходим в фолбэк */ }
  return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function plannerEmptySnapshot() {
  return { schemaVersion: 1, entries: {}, settings: {}, tombstones: {} };
}

export function loadPlannerEnvelope() {
  let raw = null;
  try {
    raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEYS.plannerEnvelope);
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!plannerPlainObj(parsed) || parsed.version !== 1) return null;
  if (typeof parsed.actorId !== 'string' || parsed.actorId === '') return null;
  if (!plannerPlainObj(parsed.snapshot)) return null;
  if (!Array.isArray(parsed.outbox)) return null;
  if (!plannerPlainObj(parsed.lamport)) parsed.lamport = {};
  if (typeof parsed.opSeq !== 'number' || !Number.isFinite(parsed.opSeq) || parsed.opSeq < 0) parsed.opSeq = 0;
  if (!plannerPlainObj(parsed.mapping)) parsed.mapping = {};
  parsed.ownerUid = typeof parsed.ownerUid === 'string' && parsed.ownerUid !== '' ? parsed.ownerUid : null;
  return parsed;
}

export function savePlannerEnvelope(env) {
  return safeSetItem(STORAGE_KEYS.plannerEnvelope, JSON.stringify(env));
}

export function createPlannerEnvelope(actorId, snapshot, mapping) {
  return {
    version: 1,
    actorId: typeof actorId === 'string' && actorId !== '' ? actorId : plannerNewActorId(),
    ownerUid: null,
    lamport: {},
    snapshot: snapshot || plannerEmptySnapshot(),
    outbox: [],
    opSeq: 0,
    mapping: mapping || {},
  };
}

// Новый Lamport-перед-записью: max(локальный, все увиденные counter)+1.
// Увиденные счётчики наблюдаются plannerObserveVersions при каждом принятии
// чужого снимка, поэтому локальная правка всегда строго свежее всего, что
// устройство когда-либо видело.
export function plannerNextVersion(env) {
  let max = 0;
  const actors = Object.keys(env.lamport);
  for (let i = 0; i < actors.length; i++) {
    const value = env.lamport[actors[i]];
    if (typeof value === 'number' && Number.isFinite(value) && value > max) max = value;
  }
  const counter = max + 1;
  env.lamport[env.actorId] = counter;
  return { counter: counter, actorId: env.actorId };
}

// Стабильный opId: повтор после сбоя использует ТОТ ЖЕ opId/версию, а не
// заводит новый (ТЗ §1.4.3) — последовательность живёт в envelope.
export function plannerNextOpId(env) {
  env.opSeq = (Number.isFinite(env.opSeq) ? env.opSeq : 0) + 1;
  return 'o-' + env.actorId + '-' + env.opSeq;
}

// Observed-max по всем версиям снимка (entries/settings/tombstones).
export function plannerObserveVersions(env, snapshot) {
  function observe(version) {
    if (!plannerPlainObj(version)) return;
    if (typeof version.counter !== 'number' || !Number.isFinite(version.counter)) return;
    if (typeof version.actorId !== 'string' || version.actorId === '') return;
    const current = env.lamport[version.actorId];
    if (typeof current !== 'number' || version.counter > current) env.lamport[version.actorId] = version.counter;
  }
  if (!plannerPlainObj(snapshot)) return env;
  const entries = plannerPlainObj(snapshot.entries) ? snapshot.entries : {};
  Object.keys(entries).forEach(function (id) {
    const fields = plannerPlainObj(entries[id]) && plannerPlainObj(entries[id].fields) ? entries[id].fields : {};
    Object.keys(fields).forEach(function (name) {
      if (plannerPlainObj(fields[name])) observe(fields[name].version);
    });
  });
  const settings = plannerPlainObj(snapshot.settings) ? snapshot.settings : {};
  Object.keys(settings).forEach(function (key) {
    if (plannerPlainObj(settings[key])) observe(settings[key].version);
  });
  const tombstones = plannerPlainObj(snapshot.tombstones) ? snapshot.tombstones : {};
  Object.keys(tombstones).forEach(function (key) {
    if (plannerPlainObj(tombstones[key])) observe(tombstones[key].version);
  });
  return env;
}
