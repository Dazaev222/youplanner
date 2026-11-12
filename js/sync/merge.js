// Слияние облачного снимка с локальным состоянием. Гонка бэкапов двух
// устройств (аудит 2026-10-31): PUT затирает узел целиком, и правки, которые
// другое устройство записало после нашей последней сверки, гибли молча.
// Теперь перед отправкой снимок с сервера сливается с локальным состоянием,
// и наверх уходит объединение, а не перезапись.
//
// Правила по разделам:
//   habits, records, sleep.history, qazaLog.entries — коллекции с ключами
//   (id привычки, дата дня, тройка записи журнала): сливаются аддитивно,
//   локальные элементы не пропадают никогда;
//   habits особая оговорка: привычка, чьё надгробие удаления (tombstones)
//   не старше метки раздела habits снимка, в ветке extra не привозится —
//   иначе удаление отменялось бы каждой сверкой (B.3);
//   qaza, prayer, fast, schedule — цельные объекты в конвертах {v, ts}
//   (P1-3): применяются с сервера, только если метка записи раздела строго
//   новее локальной (opts.sectionWrites, js/data/storage.js); при равенстве
//   побеждает локальная версия, раздел без конверта — прежнее правило
//   (метка раздела sectionTs, fallback updatedAt, против последней сверки)
//   и только когда нет правки, которой сервер ещё не видел (pending);
//   скаляры сна — по метке раздела (sectionTs, fallback updatedAt) против
//   последней сверки;
//   archive — производные месячные сводки: объединение по месяцам;
//   tombstones — надгробия удалённых привычек: слияние по max(ts) на id,
//   аддитивно, метка раздела не участвует (надгробие не воскрешается).
//
// При pending (правка ещё не уезжала наверх) слияние консервативнее: коллекции
// только «заполняют дыры» (день/привычка/день сна, которых локально нет),
// цельные разделы и журнал каза не трогаются вовсе — иначе серверное снятое
// состояние стёр бы несработавшую локальную правку или вернул бы отменённую
// запись журнала (dropLastQazaLog). Модуль чистый: ни bus, ни хранилища —
// только функции над данными; записи делает applyMergedFromCloud (sync.js).
import { hasData, mergeTombstonesById } from './core.js';
import { CLOUD_SECTIONS } from './sections.js';
import { validQazaLogEntries } from '../data/qaza.js';
import { validSleepHistory } from '../data/sleep.js';

// ── plannerV1: ядро слияния области планирования (ТЗ §1.3) ─────────────────
// Узел plannerV1 = {schemaVersion, entries, settings, tombstones}: Матрица и
// настройки календаря поверх per-field Lamport-версий {counter, actorId}.
// Правила контракта:
//   * сравнение версий — ЛЕКСИКОГРАФИЧЕСКОЕ (counter, actorId); настенные
//     часы в нём не участвуют (deletedAt — только отображение);
//   * одинаковая версия с разным значением — детерминированный выбор по
//     канонической JSON-строке (меньше — побеждает) плюс диагностика в
//     report.conflicts БЕЗ содержимого;
//   * удаление — delete-wins навсегда для id: любой tombstone скрывает
//     запись и не снимается обычным put/merge; возврат из удаления —
//     копия с НОВЫМ id на уровне адаптера, здесь скрытого снятия нет;
//   * merge коммутативен, ассоциативен, идемпотентен: merge(x,x)=x
//     побайтово по канонической форме;
//   * автоматического GC, TTL и вытеснения tombstones нет;
//   * неизвестная schemaVersion НЕ удаляется молча: normalize возвращает
//     unsupported, вызывающий обязан отказаться применять снимок как есть.
// Чистые функции: ни bus, ни хранилища — только данные (как merge.js выше).

export const PLANNER_SCHEMA_VERSION = 1;

const PLANNER_ID_MAX = 256;
const PLANNER_ACTOR_MAX = 128;

function plannerPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function plannerValidId(value) {
  return typeof value === 'string' && value !== '' && value.length <= PLANNER_ID_MAX;
}

// Глубокая JSON-безопасная копия: функции, циклы и undefined не попадают в
// снимок (глубина 12 — как jsonClone в matrix-schedule.js, но имя своё,
// песочница склеивает все модули в одну область видимости).
function plannerJsonSafe(value, depth) {
  const level = depth || 0;
  if (level > 12) return null;
  const type = typeof value;
  if (value === null || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'string') return value;
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) out.push(plannerJsonSafe(value[i], level + 1));
    return out;
  }
  if (type === 'object') {
    const out = {};
    const keys = Object.keys(value).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (value[key] === undefined) continue;
      out[key] = plannerJsonSafe(value[key], level + 1);
    }
    return out;
  }
  return null;
}

// Каноническая JSON-строка со SORTED ключами: байтовое сравнение снимков
// (повторные доставки, round-trip backup) не должно зависеть от порядка
// вставки.
export function plannerCanonicalJson(value) {
  const safe = plannerJsonSafe(value, 0);
  return JSON.stringify(safe === undefined ? null : safe);
}

function plannerValidVersion(version) {
  return plannerPlainObject(version) &&
    typeof version.counter === 'number' && Number.isInteger(version.counter) &&
    version.counter >= 0 &&
    typeof version.actorId === 'string' && version.actorId !== '' &&
    version.actorId.length <= PLANNER_ACTOR_MAX;
}

export function cmpPlannerVersion(a, b) {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actorId !== b.actorId) return a.actorId < b.actorId ? -1 : 1;
  return 0;
}

function plannerFieldVersion(version) {
  return { counter: version.counter, actorId: version.actorId };
}

// {value, version} → годный поле-объект или null (причина — в issues вызывающего)
function plannerNormalizeValueVersion(raw, issues, where) {
  if (!plannerPlainObject(raw) || !plannerValidVersion(raw.version)) {
    issues.push({ where: where, code: 'broken-field' });
    return null;
  }
  return { value: plannerJsonSafe(raw.value, 0), version: plannerFieldVersion(raw.version) };
}

function plannerSortedMap(source) {
  const out = {};
  const keys = Object.keys(source).sort();
  for (let i = 0; i < keys.length; i++) out[keys[i]] = source[keys[i]];
  return out;
}

export function normalizePlannerV1(raw) {
  const issues = [];
  if (!plannerPlainObject(raw)) {
    return { ok: false, unsupported: false, snapshot: null, issues: [{ where: 'root', code: 'not-object' }] };
  }
  if (raw.schemaVersion !== PLANNER_SCHEMA_VERSION) {
    const known = typeof raw.schemaVersion === 'number' &&
      Number.isInteger(raw.schemaVersion) && raw.schemaVersion > PLANNER_SCHEMA_VERSION;
    issues.push({ where: 'schemaVersion', code: known ? 'unsupported-version' : 'broken-version' });
    // неизвестная версия НЕ «чишится» до знакомой: snapshot остаётся null,
    // вызывающий обязан отказаться менять локальное состояние
    return { ok: false, unsupported: known, snapshot: null, issues: issues };
  }

  const snapshot = { schemaVersion: PLANNER_SCHEMA_VERSION, entries: {}, settings: {}, tombstones: {} };

  if (raw.entries !== undefined) {
    if (!plannerPlainObject(raw.entries)) {
      issues.push({ where: 'entries', code: 'broken-map' });
    } else {
      const ids = Object.keys(raw.entries).sort();
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const source = raw.entries[id];
        if (!plannerValidId(id) || !plannerPlainObject(source) || source.id !== id ||
            !plannerPlainObject(source.fields)) {
          issues.push({ where: 'entries.' + id, code: 'broken-entry' });
          continue;
        }
        const names = Object.keys(source.fields).sort();
        const fields = {};
        let broke = false;
        for (let j = 0; j < names.length; j++) {
          const name = names[j];
          if (name === '' || name.length > PLANNER_ID_MAX) {
            issues.push({ where: 'entries.' + id + '.' + name, code: 'broken-field-name' });
            broke = true;
            continue;
          }
          const cleaned = plannerNormalizeValueVersion(source.fields[name], issues, 'entries.' + id + '.' + name);
          if (!cleaned) { broke = true; continue; }
          fields[name] = cleaned;
        }
        if (!plannerPlainObject(source.fields)) broke = true;
        if (broke && Object.keys(fields).length === 0) continue;
        snapshot.entries[id] = { id: id, fields: plannerSortedMap(fields) };
      }
    }
  }

  if (raw.settings !== undefined) {
    if (!plannerPlainObject(raw.settings)) {
      issues.push({ where: 'settings', code: 'broken-map' });
    } else {
      const keys = Object.keys(raw.settings).sort();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === '' || key.length > PLANNER_ID_MAX) {
          issues.push({ where: 'settings.' + key, code: 'broken-key' });
          continue;
        }
        const cleaned = plannerNormalizeValueVersion(raw.settings[key], issues, 'settings.' + key);
        if (!cleaned) continue;
        snapshot.settings[key] = cleaned;
      }
    }
  }

  if (raw.tombstones !== undefined) {
    if (!plannerPlainObject(raw.tombstones)) {
      issues.push({ where: 'tombstones', code: 'broken-map' });
    } else {
      const ids = Object.keys(raw.tombstones).sort();
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const source = raw.tombstones[id];
        if (!plannerValidId(id) || !plannerPlainObject(source) ||
            !plannerValidVersion(source.version) ||
            typeof source.deletedAt !== 'string' || source.deletedAt === '') {
          issues.push({ where: 'tombstones.' + id, code: 'broken-tombstone' });
          continue;
        }
        snapshot.tombstones[id] = { version: plannerFieldVersion(source.version), deletedAt: source.deletedAt };
      }
    }
  }

  snapshot.entries = plannerSortedMap(snapshot.entries);
  snapshot.settings = plannerSortedMap(snapshot.settings);
  snapshot.tombstones = plannerSortedMap(snapshot.tombstones);
  return { ok: true, unsupported: false, snapshot: snapshot, issues: issues };
}

function plannerMergeSide(value, report, where) {
  const result = normalizePlannerV1(value);
  if (result.ok) return result.snapshot;
  if (report) {
    report.conflicts = report.conflicts || [];
    report.conflicts.push({ kind: 'planner-' + (result.unsupported ? 'unsupported' : 'invalid') + '-side', where: where });
  }
  return null;
}

// Победитель пары {value, version}: большая версия; равная версия с разным
// значением — меньшая каноническая строка (порядок аргументов не важен).
function plannerPickWinner(nameA, a, nameB, b) {
  const cmp = cmpPlannerVersion(a.version, b.version);
  if (cmp > 0) return { chosen: a, other: b, from: nameA };
  if (cmp < 0) return { chosen: b, other: a, from: nameB };
  const canonA = plannerCanonicalJson(a.value);
  const canonB = plannerCanonicalJson(b.value);
  if (canonA === canonB) return { chosen: a, other: a, from: nameA, equal: true };
  const left = canonA <= canonB ? a : b;
  const right = canonA <= canonB ? b : a;
  return { chosen: left, other: right, from: canonA <= canonB ? nameA : nameB, tieBreak: true };
}

export function mergePlannerV1(left, right, report) {
  const leftSnapshot = plannerMergeSide(left, report, 'left');
  const rightSnapshot = plannerMergeSide(right, report, 'right');
  if (!leftSnapshot && !rightSnapshot) {
    return { schemaVersion: PLANNER_SCHEMA_VERSION, entries: {}, settings: {}, tombstones: {} };
  }
  if (!leftSnapshot) return rightSnapshot;
  if (!rightSnapshot) return leftSnapshot;

  const merged = { schemaVersion: PLANNER_SCHEMA_VERSION, entries: {}, settings: {}, tombstones: {} };

  // tombstones: объединение с максимальной версией; delete-wins навсегда —
  // ни одна правка обеих сторон не снимает надгробие
  const tombIds = {};
  const collectTomb = [leftSnapshot.tombstones, rightSnapshot.tombstones];
  for (let s = 0; s < collectTomb.length; s++) {
    const ids = Object.keys(collectTomb[s]);
    for (let i = 0; i < ids.length; i++) tombIds[ids[i]] = true;
  }
  Object.keys(tombIds).sort().forEach(function (id) {
    const a = leftSnapshot.tombstones[id];
    const b = rightSnapshot.tombstones[id];
    let winner = a || b;
    if (a && b) {
      const cmp = cmpPlannerVersion(a.version, b.version);
      if (cmp < 0) winner = b;
      else if (cmp === 0 && plannerCanonicalJson(b) < plannerCanonicalJson(a)) winner = b;
    }
    merged.tombstones[id] = { version: plannerFieldVersion(winner.version), deletedAt: winner.deletedAt };
  });

  function live(id) {
    return !Object.prototype.hasOwnProperty.call(merged.tombstones, id);
  }

  const entryIds = {};
  const sides = [leftSnapshot.entries, rightSnapshot.entries];
  for (let s = 0; s < sides.length; s++) {
    const ids = Object.keys(sides[s]);
    for (let i = 0; i < ids.length; i++) entryIds[ids[i]] = true;
  }
  Object.keys(entryIds).sort().forEach(function (id) {
    if (!live(id)) return;
    const a = leftSnapshot.entries[id];
    const b = rightSnapshot.entries[id];
    if (!a || !b) {
      const only = (a || b);
      merged.entries[id] = { id: id, fields: plannerSortedMap(only.fields) };
      return;
    }
    const fields = {};
    const names = {};
    Object.keys(a.fields).forEach(function (n) { names[n] = true; });
    Object.keys(b.fields).forEach(function (n) { names[n] = true; });
    Object.keys(names).sort().forEach(function (name) {
      const fa = a.fields[name];
      const fb = b.fields[name];
      if (!fa || !fb) { fields[name] = fa || fb; return; }
      const pick = plannerPickWinner('left', fa, 'right', fb);
      fields[name] = { value: pick.chosen.value, version: plannerFieldVersion(pick.chosen.version) };
      if (pick.tieBreak && report) {
        report.conflicts = report.conflicts || [];
        // без содержимого: названы только координаты конфликта
        report.conflicts.push({ kind: 'same-version-different-value', entryId: id, field: name });
      }
    });
    merged.entries[id] = { id: id, fields: plannerSortedMap(fields) };
  });

  const settingKeys = {};
  Object.keys(leftSnapshot.settings).forEach(function (k) { settingKeys[k] = true; });
  Object.keys(rightSnapshot.settings).forEach(function (k) { settingKeys[k] = true; });
  Object.keys(settingKeys).sort().forEach(function (key) {
    const a = leftSnapshot.settings[key];
    const b = rightSnapshot.settings[key];
    if (!a || !b) { merged.settings[key] = a || b; return; }
    const pick = plannerPickWinner('left', a, 'right', b);
    merged.settings[key] = { value: pick.chosen.value, version: plannerFieldVersion(pick.chosen.version) };
    if (pick.tieBreak && report) {
      report.conflicts = report.conflicts || [];
      report.conflicts.push({ kind: 'same-version-different-value', setting: key });
    }
  });

  merged.entries = plannerSortedMap(merged.entries);
  merged.settings = plannerSortedMap(merged.settings);
  merged.tombstones = plannerSortedMap(merged.tombstones);
  return merged;
}

function plannerValidateOperation(operation) {
  if (!plannerPlainObject(operation)) return 'invalid-operation';
  if (!plannerValidId(operation.opId)) return 'invalid-operation';
  if (!plannerValidId(operation.entryId)) return 'invalid-operation';
  if (operation.type !== 'put' && operation.type !== 'delete') return 'invalid-operation';
  return null;
}

// Локальная операция поверх снимка. Повтор той же opId/версии/значения —
// no-op без роста версии: доставка и retry безопасны. Надгробие не снимается
// никогда: put по tombstoned id отвергается (возврат — копия с НОВЫМ id на
// уровне адаптера).
export function applyPlannerOperation(snapshot, operation, report) {
  const fail = function (reason, source) {
    return { ok: false, applied: false, reason: reason, snapshot: source };
  };
  const normalized = normalizePlannerV1(snapshot);
  if (!normalized.ok) return fail('invalid-snapshot', snapshot);
  const out = mergePlannerV1(normalized.snapshot, { schemaVersion: PLANNER_SCHEMA_VERSION }, null);

  const bad = plannerValidateOperation(operation);
  if (bad) return fail(bad, out);

  if (operation.type === 'delete') {
    if (!plannerValidVersion(operation.version)) return fail('invalid-operation', out);
    if (typeof operation.deletedAt !== 'string' || operation.deletedAt === '') return fail('invalid-operation', out);
    const id = operation.entryId;
    const existing = out.tombstones[id];
    const wanted = { version: plannerFieldVersion(operation.version), deletedAt: operation.deletedAt };
    let changed = false;
    if (!existing) {
      out.tombstones[id] = wanted;
      changed = true;
    } else {
      const cmp = cmpPlannerVersion(wanted.version, existing.version);
      if (cmp > 0 || (cmp === 0 && plannerCanonicalJson(wanted) < plannerCanonicalJson(existing))) {
        out.tombstones[id] = wanted;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(out.entries, id)) {
      delete out.entries[id];
      changed = true;
    }
    out.tombstones = plannerSortedMap(out.tombstones);
    out.entries = plannerSortedMap(out.entries);
    return { ok: true, applied: changed, reason: changed ? null : 'noop', snapshot: out };
  }

  // put
  if (!plannerPlainObject(operation.fields) || Object.keys(operation.fields).length === 0) {
    return fail('invalid-operation', out);
  }
  const id = operation.entryId;
  if (Object.prototype.hasOwnProperty.call(out.tombstones, id)) {
    return { ok: true, applied: false, reason: 'tombstoned', snapshot: out };
  }
  const base = out.entries[id] || { id: id, fields: {} };
  const fields = {};
  Object.keys(base.fields).forEach(function (n) { fields[n] = base.fields[n]; });
  let changed = false;
  const names = Object.keys(operation.fields).sort();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === '' || name.length > PLANNER_ID_MAX) return fail('invalid-operation', out);
    const cleaned = plannerNormalizeValueVersion(operation.fields[name], [], 'operation.' + name);
    if (!cleaned) return fail('invalid-operation', out);
    const current = fields[name];
    if (!current) { fields[name] = cleaned; changed = true; continue; }
    const cmp = cmpPlannerVersion(cleaned.version, current.version);
    if (cmp > 0) { fields[name] = cleaned; changed = true; continue; }
    if (cmp === 0 && plannerCanonicalJson(cleaned.value) !== plannerCanonicalJson(current.value)) {
      // равная версия с разным значением — тот же детерминированный
      // победитель, что у merge: меньше канонической строки
      if (plannerCanonicalJson(cleaned.value) < plannerCanonicalJson(current.value)) {
        fields[name] = cleaned;
        changed = true;
      }
      if (report) {
        report.conflicts = report.conflicts || [];
        report.conflicts.push({ kind: 'same-version-different-value', entryId: id, field: name });
      }
    }
  }
  if (!changed) {
    return { ok: true, applied: false, reason: 'noop', snapshot: out };
  }
  out.entries[id] = { id: id, fields: plannerSortedMap(fields) };
  out.entries = plannerSortedMap(out.entries);
  return { ok: true, applied: true, reason: null, snapshot: out };
}

// Стабильный hash без часов и случайностей (FNV-1a, base36): повтор миграции
// той же legacy-записи обязан дать тот же id даже при потерянной таблице.
function plannerHash(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Детерминированная миграция legacy-списка в снимок plannerV1: старые id
// сохраняются, записи без id получают стабильный id через таблицу
// соответствия mapping (её повтор даёт ТЕ ЖЕ id, а не дубликаты). Версии
// полей — counter 1 от actorId установки. Никаких часов: два прогона —
// байт-в-байт один результат.
export function migratePlannerV1(legacy, migrationState) {
  const state = plannerPlainObject(migrationState) ? migrationState : {};
  const actorId = typeof state.actorId === 'string' && state.actorId !== '' ? state.actorId : 'migrate';
  const mapping = plannerPlainObject(state.mapping) ? Object.assign({}, state.mapping) : {};
  const snapshot = { schemaVersion: PLANNER_SCHEMA_VERSION, entries: {}, settings: {}, tombstones: {} };

  const source = plannerPlainObject(legacy) ? legacy : {};
  const list = Array.isArray(source.entries) ? source.entries : [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!plannerPlainObject(raw)) continue;
    const fields = plannerPlainObject(raw.fields) ? raw.fields : {};
    const key = 'm:' + i + ':' + plannerCanonicalJson(fields);
    let id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
    if (!id) {
      if (typeof mapping[key] === 'string' && mapping[key] !== '') {
        id = mapping[key];
      } else {
        id = 'm' + plannerHash(key);
        mapping[key] = id;
      }
    }
    if (!plannerValidId(id)) continue;
    const clean = {};
    const names = Object.keys(fields).sort();
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      if (name === '' || name.length > PLANNER_ID_MAX) continue;
      if (fields[name] === undefined) continue;
      clean[name] = { value: plannerJsonSafe(fields[name], 0), version: { counter: 1, actorId: actorId } };
    }
    snapshot.entries[id] = { id: id, fields: plannerSortedMap(clean) };
  }

  if (plannerPlainObject(source.settings)) {
    const keys = Object.keys(source.settings).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === '' || key.length > PLANNER_ID_MAX) continue;
      if (source.settings[key] === undefined) continue;
      snapshot.settings[key] = { value: plannerJsonSafe(source.settings[key], 0), version: { counter: 1, actorId: actorId } };
    }
  }

  if (plannerPlainObject(source.tombstones)) {
    const ids = Object.keys(source.tombstones).sort();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const raw = source.tombstones[id];
      if (!plannerValidId(id) || !plannerPlainObject(raw)) continue;
      if (typeof raw.deletedAt !== 'string' || raw.deletedAt === '') continue;
      snapshot.tombstones[id] = {
        version: plannerValidVersion(raw.version) ? plannerFieldVersion(raw.version) : { counter: 1, actorId: actorId },
        deletedAt: raw.deletedAt,
      };
    }
  }

  snapshot.entries = plannerSortedMap(snapshot.entries);
  snapshot.settings = plannerSortedMap(snapshot.settings);
  snapshot.tombstones = plannerSortedMap(snapshot.tombstones);
  return { snapshot: snapshot, mapping: plannerSortedMap(mapping) };
}

// Метка свежести раздела из снимка. Снимки до введения sectionTs метки не
// несут — тогда свежесть раздела равна свежести всего снимка.
export function sectionTsOf(cloud, section, fallbackTs) {
  const map = cloud && cloud.sectionTs;
  const value = map && typeof map === 'object' ? Number(map[section]) : NaN;
  if (Number.isFinite(value)) return value;
  return Number(fallbackTs) || 0;
}

// ── Конверты цельных разделов {v, ts} (аудит P1-3) ──────────────────────────
// Цельные разделы qaza/prayer/fast/schedule ходят в снимке в конвертах:
// v — полезные данные раздела, ts — часы отправителя на момент записи раздела
// (метки записи живут соседним ключом — js/data/storage.js). Раздел старого
// клиента без конверта — ts=0: конверт побеждает его при первом же обмене,
// а голый раздел не затирает свежий конверт. Чистые функции: только данные.

// Похож на конверт: объект с полем v и ЧИСЛОВОЙ ts. Форма строгая не случайно:
// у полезных данных этих разделов поля v нет (qaza и fast несут version,
// prayer — lat/lng, schedule — типы дней), а «полуконверт» без числа-ts не
// даёт ничего, чем можно сравнивать.
export function isSectionEnvelope(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, 'v') &&
    typeof raw.ts === 'number' && Number.isFinite(raw.ts);
}

// Раздел снимка → {v, ts}: конверт разворачивается, legacy-раздел — как есть
// с нулевой меткой. null на входе (раздела нет) остаётся null: валидаторы
// разделов читают его как «раздела нет», как и раньше.
export function unwrapSection(raw) {
  if (isSectionEnvelope(raw)) return { v: raw.v, ts: raw.ts };
  return { v: raw === undefined ? null : raw, ts: 0 };
}

// Кто победил в паре конвертов. Больший ts — облако; равенство — локальная
// версия (детерминированно: обе стороны выберут одно и то же); оба ts=0 —
// пара без конвертов, решает прежнее правило вызывающего (legacyWins): у
// applyCloudData снимок уже прошёл общий гейт новизны, у слияния это метка
// раздела против последней сверки.
export function sectionEnvelopeWins(cloudTs, localTs, legacyWins) {
  const cloud = Number(cloudTs) || 0;
  const local = Number(localTs) || 0;
  if (cloud === 0 && local === 0) return !!legacyWins;
  return cloud > local;
}

// Надгробия удалённых привычек: функция слияния перенесена в js/sync/core.js
// (чистая функция, без циклической зависимости); здесь — чистый re-экспорт
// для существующего публичного API (js/sync/merge.js, js/sync/sections.js).
export { mergeTombstonesById };

// Чистит устаревший локальный кэш привычек: выбрасывает привычки, у которых
// есть надгробие, а в серверном списке их нет. Случай «релог после долгого
// офлайна» (баг владельца 2026-11-07): кэш устройства не видел удаления,
// объявляет привычку живой, а приехавший снимок — он новее последней сверки,
// иначе слияние не началось бы — уже содержит надгробие. Раньше слияние
// оставляло привычку в списке, pruneResolvedTombstones стирал «противоречащее»
// надгробие (js/data/habits.js), и PUT возвращал удалённую привычку на сервер:
// удаление отменялось первым же обменом.
// Метка раздела (sectionTs) здесь, в отличие от ветки extra ниже, не
// участвует: метка раздела habits — время ПУБЛИКАЦИИ снимка (syncBody), она
// всегда не старше его собственных надгробий, и guard «ts >= sectionTs»
// сделал бы очистку мёртвым кодом. Привычка, ВЕРНУВШАЯСЯ на сервер (есть в
// cloudHabits), не выбрасывается — её судьбу решает совпадение id по правилам
// cloudWins, как раньше. Правка без сети (pending) не спасает привычку от
// чужого надгробия: удаление — тоже правка, и спор решается в его пользу.
export function clearStaleCache(localHabits, tombstones, cloudHabits) {
  const list = Array.isArray(localHabits) ? localHabits : [];
  const graves = tombstones && typeof tombstones === 'object' && !Array.isArray(tombstones)
    ? tombstones
    : {};
  const cloud = Array.isArray(cloudHabits) ? cloudHabits : [];
  const onServer = {};
  for (let i = 0; i < cloud.length; i++) {
    const habit = cloud[i];
    if (habit && habit.id != null) onServer[habit.id] = true;
  }
  const kept = [];
  for (let i = 0; i < list.length; i++) {
    const habit = list[i];
    // Элементы без id проходят дальше без разбора: их судьбу решает
    // вызывающий (mergeHabitsById исключает их из результата как и раньше)
    if (!habit || habit.id == null) {
      kept.push(habit);
      continue;
    }
    const ts = graves[habit.id];
    const tombstoned = typeof ts === 'number' && Number.isFinite(ts);
    if (tombstoned && !onServer[habit.id]) continue;
    kept.push(habit);
  }
  return kept;
}

// Привычки: объединение по id. Порядок локального списка сохраняется,
// чужие привычки дописываются в конец в своём порядке. Совпадающий id:
// при cloudWins объект сервера, иначе локальный — список и так видел
// серверную версию при прошлой сверке.
//
// opts.tombstones и opts.sectionTs (необязательно, B.3): ветка extra не
// привозит привычку, чьё надгробие не старше метки раздела habits снимка —
// иначе удалённая на этом устройстве привычка воскресала бы с сервера.
// Метка раздела НОВЕЕ надгробия — чужая правка привычки победила, привычка
// привозится как раньше; равные метки читаются консервативно — удаление
// считается последней известной правкой, привычка не привозится.
export function mergeHabitsById(localHabits, cloudHabits, cloudWins, opts) {
  const options = opts || {};
  const tombstones = options.tombstones || {};
  const sectionTs = Number(options.sectionTs) || 0;
  const tombstoned = function (id) {
    const ts = tombstones[id];
    // Мусорная метка (не число) не блокирует: блокирует только настоящая
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
    return ts >= sectionTs;
  };
  const local = Array.isArray(localHabits) ? localHabits : [];
  const cloud = Array.isArray(cloudHabits) ? cloudHabits : [];
  // Сначала чистка устаревшего кэша (см. clearStaleCache): надгробия здесь —
  // объединение локальных и приехавших со снимком (tombstonesForMerge в
  // mergeCloudIntoLocal), и привычка, удалённая на сервере позже нашей
  // последней сверки, из списка выбрасывается
  const alive = clearStaleCache(local, tombstones, cloud);
  const byId = {};
  const order = [];
  for (let i = 0; i < alive.length; i++) {
    const habit = alive[i];
    if (habit && habit.id != null && byId[habit.id] === undefined) {
      byId[habit.id] = habit;
      order.push(habit.id);
    }
  }
  const extra = [];
  for (let i = 0; i < cloud.length; i++) {
    const habit = cloud[i];
    if (!habit || habit.id == null) continue;
    if (byId[habit.id] !== undefined) {
      if (cloudWins) byId[habit.id] = habit;
    } else if (!tombstoned(habit.id)) {
      byId[habit.id] = habit;
      extra.push(habit.id);
    }
  }
  const merged = [];
  for (let i = 0; i < order.length; i++) merged.push(byId[order[i]]);
  for (let i = 0; i < extra.length; i++) merged.push(byId[extra[i]]);
  return merged;
}

// Записи по дням. День, которого локально нет, приезжает с сервера целиком;
// существующий день при pending не трогается (удаление поля на этом
// устройстве не должно воскрешаться), при !pending — слияние по полям:
// поле, которое есть только локально, сохраняется, разошедшиеся значения
// уходят серверной стороне (её снимок новее нашей последней сверки).
//
// opts.tombstones (необязательно): значения удалённой привычки (поле дня с
// именем привычки, чьё надгробие уже записано) не привозятся со старого
// снимка — иначе вычищенные removeHabit записи возвращаются при первой же
// сверке, и PUT кладёт их обратно на сервер (аудит 2026-10-31). Локальные
// поля не трогаются: слияние аддитивно и локальное не стирает.
export function mergeRecordsByDay(localRecords, cloudRecords, cloudWins, opts) {
  const tombstones = opts && opts.tombstones && typeof opts.tombstones === 'object'
    && !Array.isArray(opts.tombstones) ? opts.tombstones : null;
  const dead = function (field) {
    return tombstones !== null &&
      Object.prototype.hasOwnProperty.call(tombstones, field);
  };
  const merged = Object.assign({}, localRecords);
  const dates = Object.keys(cloudRecords);
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const cloudDay = cloudRecords[date];
    if (!cloudDay || typeof cloudDay !== 'object' || Array.isArray(cloudDay)) continue;
    if (!Object.prototype.hasOwnProperty.call(merged, date)) {
      if (tombstones === null) {
        merged[date] = cloudDay;
        continue;
      }
      // Новый день: привозим только значения живых привычек; день, весь
      // состоящий из значений удалённых, не нужен вовсе
      const day = {};
      const fields = Object.keys(cloudDay);
      for (let j = 0; j < fields.length; j++) {
        if (!dead(fields[j])) day[fields[j]] = cloudDay[fields[j]];
      }
      if (Object.keys(day).length > 0) merged[date] = day;
      continue;
    }
    if (!cloudWins) continue;
    const day = Object.assign({}, merged[date]);
    const fields = Object.keys(cloudDay);
    for (let j = 0; j < fields.length; j++) {
      const field = fields[j];
      if (dead(field)) continue;
      if (!Object.prototype.hasOwnProperty.call(day, field)) {
        day[field] = cloudDay[field];
        continue;
      }
      if (JSON.stringify(day[field]) !== JSON.stringify(cloudDay[field])) {
        day[field] = cloudDay[field];
      }
    }
    merged[date] = day;
  }
  return merged;
}

// История сна: одна запись на день, дни не удаляются. Совпадающий день:
// при cloudWins запись сервера, иначе локальная. Список сортируется по дате —
// детерминированный JSON, стабильные сравнения при следующем слиянии.
export function mergeSleepHistories(localHistory, cloudHistory, cloudWins) {
  const local = Array.isArray(localHistory) ? localHistory : [];
  const cloud = Array.isArray(cloudHistory) ? cloudHistory : [];
  const byDate = {};
  const order = [];
  for (let i = 0; i < local.length; i++) {
    const entry = local[i];
    if (entry && entry.date && byDate[entry.date] === undefined) {
      byDate[entry.date] = entry;
      order.push(entry.date);
    }
  }
  for (let i = 0; i < cloud.length; i++) {
    const entry = cloud[i];
    if (!entry || !entry.date) continue;
    if (byDate[entry.date] === undefined) {
      byDate[entry.date] = entry;
      order.push(entry.date);
    } else if (cloudWins) {
      byDate[entry.date] = entry;
    }
  }
  order.sort();
  const merged = [];
  for (let i = 0; i < order.length; i++) merged.push(byDate[order[i]]);
  return merged;
}

// Запись о сне: скаляры (bed/wake/fall и пары) по правилу цельных разделов,
// история — аддитивно при любом раскладе.
function mergeSleepEntry(localSleep, cloudSleep, cloudWinsCore, cloudWinsHistory) {
  if (!cloudSleep || typeof cloudSleep !== 'object' || Array.isArray(cloudSleep)) {
    return localSleep;
  }
  if (!localSleep || typeof localSleep !== 'object' || Array.isArray(localSleep)) {
    return cloudSleep;
  }
  const history = validSleepHistory(
    mergeSleepHistories(localSleep.history, cloudSleep.history, cloudWinsHistory)
  );
  const base = cloudWinsCore ? cloudSleep : localSleep;
  return Object.assign({}, base, { history: history });
}

// Журнал каза: записи аддитивны. Совпадение даты, намаза и источника в обеих
// сторонах — одна и та же запись, приехавшая синком: дубль не заводим. Ровно
// одинаковые записи внутри одной стороны сохраняются (два ручных добавления
// одного намаза за день — законная история). Окно журнала (since) не
// переезжает: правило «журнал с since, до него h6» привязано к нему, и сдвиг
// границы менял бы уже посчитанные дни (§5, qazaDayCounts).
export function mergeQazaLogEntries(localEntries, cloudEntries) {
  const local = Array.isArray(localEntries) ? localEntries : [];
  const cloud = Array.isArray(cloudEntries) ? cloudEntries : [];
  const localKeys = {};
  for (let i = 0; i < local.length; i++) {
    const entry = local[i];
    if (entry) localKeys[entry.date + '|' + entry.namaz + '|' + entry.source] = true;
  }
  const merged = local.slice();
  const addedKeys = {};
  for (let i = 0; i < cloud.length; i++) {
    const entry = cloud[i];
    if (!entry) continue;
    const key = entry.date + '|' + entry.namaz + '|' + entry.source;
    if (localKeys[key] || addedKeys[key]) continue;
    addedKeys[key] = true;
    merged.push(entry);
  }
  merged.sort(function (a, b) {
    if (!a || !b) return 0;
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });
  return merged;
}

// ── Архив: объединение месячных сводок ──────────────────────────────────────
// Сводки — производные данные (пересчитываются при каждой архивации),
// поэтому месяц с сервера заменяет локальный месяц без разбору: расхождение
// возможно только у устройств с разными поколениями детализации.

function mergeMonthsPart(localPart, cloudPart) {
  return {
    months: Object.assign(
      {},
      localPart && localPart.months,
      cloudPart && cloudPart.months
    ),
  };
}

function mergeFastArchive(localPart, cloudPart) {
  const merged = mergeMonthsPart(localPart, cloudPart);
  const candidates = [];
  if (localPart && typeof localPart.since === 'string') candidates.push(localPart.since);
  if (cloudPart && typeof cloudPart.since === 'string') candidates.push(cloudPart.since);
  candidates.sort();
  if (candidates.length > 0) merged.since = candidates[0];
  return merged;
}

function mergeArchive(localArchive, cloudArchive) {
  if (!cloudArchive || typeof cloudArchive !== 'object' || Array.isArray(cloudArchive)) {
    return localArchive;
  }
  if (!localArchive || typeof localArchive !== 'object' || Array.isArray(localArchive)) {
    return cloudArchive;
  }
  return {
    version: typeof localArchive.version === 'number' ? localArchive.version : 1,
    sleep: mergeMonthsPart(localArchive.sleep, cloudArchive.sleep),
    fast: mergeFastArchive(localArchive.fast, cloudArchive.fast),
    qaza: mergeMonthsPart(localArchive.qaza, cloudArchive.qaza),
    records: mergeMonthsPart(localArchive.records, cloudArchive.records),
  };
}

// Главная точка входа. Возвращает слитый снимок той же формы, что local, или
// null, если сливать нечего: сервер не новее последней сверки — всё, что на
// нём было к прошлому обмену, локально уже есть, и PUT уходит как раньше.
// Тело — диспетчер-луп по дескрипторам разделов из единственной матрицы
// CLOUD_SECTIONS (js/sync/sections.js, АДР §2): каждый раздел читает из
// строки дескриптора валидатор (row.validate), форму хранения
// (row.envelope — конверт {v, ts}) и pending-запрет (row.skipWhenPending),
// форма слияния — switch по row.raceMerge.
export function mergeCloudIntoLocal(local, cloud, opts) {
  const options = opts || {};
  const pending = !!options.pending;
  const localTs = Number(options.localTs) || 0;
  if (!cloud || typeof cloud !== 'object' || Array.isArray(cloud)) return null;
  const cloudTs = Number(cloud.updatedAt) || 0;
  if (cloudTs <= localTs) return null;

  const merged = {
    habits: local.habits,
    records: local.records,
    qaza: local.qaza,
    prayer: local.prayer,
    fast: local.fast,
    qazaLog: local.qazaLog,
    sleep: local.sleep,
    schedule: local.schedule,
    archive: local.archive,
    tombstones: local.tombstones,
  };

  // Цельные разделы сливаются по конвертам: локальные метки записи слияющий
  // берёт из opts.sectionWrites — модуль чистый, хранилище читает вызывающий
  // (applyMergedFromCloud). Общее правило гонки (метка раздела/снимка против
  // последней сверки) одно на луп.
  const writes = options.sectionWrites && typeof options.sectionWrites === 'object'
    ? options.sectionWrites : {};
  const cloudWins = function (section) {
    return sectionTsOf(cloud, section, cloudTs) > localTs;
  };

  // Надгробия для слияния коллекций: заполняет первая строка петли
  // (raceMerge 'tombstones'), до неё коллекции не доходят.
  let tombstonesForMerge = local.tombstones;

  // Дескрипторы — из единственной матрицы CLOUD_SECTIONS (js/sync/sections.js,
  // АДР §2): validate, envelope и pending-запрет читаются из строки таблицы.
  // ПОРЯДОК ОБРАБОТКИ задаёт этот движок, не матрица: надгробия первыми —
  // они нужны и себе, и коллекциям (habits, records); archive — производные
  // месячные сводки, применяется всегда и в луп не входит.
  const rows = [];
  for (let i = 0; i < CLOUD_SECTIONS.length; i++) {
    if (CLOUD_SECTIONS[i].raceMerge === 'tombstones') rows.push(CLOUD_SECTIONS[i]);
  }
  for (let i = 0; i < CLOUD_SECTIONS.length; i++) {
    const row = CLOUD_SECTIONS[i];
    if (row.raceMerge !== 'tombstones' && row.raceMerge !== 'archive') rows.push(row);
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    switch (row.raceMerge) {
      case 'tombstones': {
        // Надгробия приезжают вместе со снимком и нужны дважды: слиянию
        // привычек и записей ниже (не вернуть удалённое) и самому разделу
        // (слияние по max(ts)). Снимки до введения надгробий раздела не
        // несут — тогда слияние идёт только с локальными.
        const cloudTombstones = row.validate(cloud[row.name]);
        if (cloudTombstones && hasData(cloudTombstones)) {
          merged.tombstones = mergeTombstonesById(local.tombstones, cloudTombstones);
        }
        tombstonesForMerge = cloudTombstones
          ? mergeTombstonesById(local.tombstones, cloudTombstones)
          : local.tombstones;
        break;
      }
      case 'collection:habits': {
        // Коллекции с ключами: аддитивное слияние при любом раскладе;
        // при pending — только «заполнение дыр» (cloudWins=false):
        // существующие локально элементы не трогаются. Обеим коллекциям
        // нужны надгробия с двух сторон: и локальные, и приехавшие с этим
        // снимком — он только что принят к слиянию, его метки — часть
        // одного решения.
        const value = cloud[row.name];
        if (row.validate(value) && hasData(value)) {
          merged[row.name] = mergeHabitsById(local.habits, value, !pending, {
            tombstones: tombstonesForMerge,
            sectionTs: sectionTsOf(cloud, row.name, cloudTs),
          });
        }
        break;
      }
      case 'collection:records': {
        // Записям надгробия нужны так же, как привычкам: значения удалённой
        // привычки не привозятся со старого снимка (см. mergeRecordsByDay)
        const value = cloud[row.name];
        if (row.validate(value) && hasData(value)) {
          merged[row.name] = mergeRecordsByDay(local.records, value, !pending, {
            tombstones: tombstonesForMerge,
          });
        }
        break;
      }
      case 'envelope': {
        // Цельные разделы приходят в конвертах {v, ts}: ts — метка записи
        // раздела на отправителе (P1-3). Раздел без конверта — старый
        // клиент: решает cloudWins (метка раздела/снимка против последней
        // сверки), он же работает, когда обе стороны без конвертов.
        // Правка, которой сервер не видел (pending), не затирается — но
        // только если раздел ДЕЙСТВИТЕЛЬНО правили локально. Метка записи
        // (section-writes) ставится saveX вне нормализующего чтения; у дефолта
        // первого запуска её нет, и это не правка. Глобальный pending при этом
        // мог прийти из другого раздела (или из события 'online') — пропускать
        // из-за него весь конверт значит оставить дефолт и затереть сервер
        // (баг владельца 2026-11-12: на новом устройстве qaza оставался
        // 305/306/306/305/305 вместо серверных чисел).
        if (!row.envelope) break;
        const incoming = unwrapSection(cloud[row.name]);
        if (pending && (Number(writes[row.name]) || 0) > 0) break;
        // emptyWins 'always' (schedule): гейта hasData исторически нет —
        // пустой календарь тоже состояние, которое должно приехать.
        if (row.validate(incoming.v) && (row.emptyWins === 'always' || hasData(incoming.v)) &&
            sectionEnvelopeWins(incoming.ts, writes[row.name], cloudWins(row.name))) {
          merged[row.name] = incoming.v;
        }
        break;
      }
      case 'sleep': {
        // Скаляры сна — по метке раздела против последней сверки. При
        // pending правка, которой сервер не видел: сну хватает «заполнения
        // дыр» по истории (cloudWins=false, без отступления истории).
        const value = cloud[row.name];
        if (!row.validate(value) || !hasData(value)) break;
        merged.sleep = pending
          ? mergeSleepEntry(local.sleep, value, false, false)
          : mergeSleepEntry(local.sleep, value, cloudWins(row.name), true);
        break;
      }
      case 'qazaLog': {
        // Журнал каза: аддитивное слияние только без pending
        // (skipWhenPending) — pending-правка может быть отменой записи
        // (dropLastQazaLog), и возврат записи с сервера сломал бы отмену.
        // Но pending защищает только СВОЙ журнал: если локального нет
        // (чистое устройство), серверный обязан приехать — иначе отмена
        // записи на новом устройстве недоступна, а PUT затрёт серверный
        // журнал пустотой.
        if (pending && row.skipWhenPending && hasData(local[row.name])) break;
        const value = cloud[row.name];
        if (!row.validate(value) || !hasData(value)) break;
        merged.qazaLog = local.qazaLog
          ? {
            version: local.qazaLog.version,
            since: local.qazaLog.since,
            entries: validQazaLogEntries(
              mergeQazaLogEntries(local.qazaLog.entries, value.entries)
            ),
          }
          : value;
        break;
      }
    }
  }

  // Archive — производные месячные сводки: объединение по месяцам всегда.
  merged.archive = mergeArchive(local.archive, cloud.archive);
  return merged;
}
