// Движок применения облачного снимка: описание разделов (js/sync/sections.js)
// + единственная атомарная запись stage. Выделен из sync.js (АДР
// 2026-11-08-applyCloudData-descriptors): generic-луп по таблице заменил
// одиннадцать одинаковых блоков, а фазы 2–3 остались ровно одни на всех
// потребителей — и applyCloudData, и будущие приёмы снимков.
import { bus } from '../core/bus.js';
import { rollbackStagedKeys } from '../core/storage.js';
import { SYNC_TS_KEY, hasData, setSyncing, syncPending } from './core.js';
import { SECTION_WRITE_TS_KEY, STORAGE_KEYS, loadSectionWriteTs, sectionWriteTsJson } from '../data/storage.js';
import { MATRIX_STORAGE_KEY, materializePlannerTasks, plannerLoadOrBuildEnvelope, plannerOwnerUid } from '../data/matrix.js';
import { plannerObserveVersions } from '../data/storage.js';
import { loadHabits, loadTombstones } from '../data/habits.js';
import { loadRecords } from '../data/records.js';
import { loadQaza, loadQazaLog } from '../data/qaza.js';
import { loadPrayer } from '../data/prayer.js';
import { loadFast } from '../data/fast.js';
import { loadSleep } from '../data/sleep.js';
import { loadSchedule } from '../data/schedule.js';
import { mergePlannerV1, normalizePlannerV1, plannerCanonicalJson, sectionEnvelopeWins, unwrapSection } from './merge.js';
import { CLOUD_SECTIONS, sectionByName } from './sections.js';

// Записывает stage целиком или не пишет ничего. Аргумент — массив
// { key, value, section }: section — имя раздела таблицы, чей onWrite
// вызывается сразу после успешной записи ключа (кэш записей и подобное);
// null — служебный ключ без раздела.
//
// Фаза 2: снимок предыдущего состояния каждого ключа — журнал отката.
// written отмечает уже записанные ключи (только они подлежат откату), had —
// существовал ли ключ до записи (стирать или восстанавливать).
// Фаза 3: запись; первая ошибка откатывает всё записанное и отдаёт наружу
// false. Предсказать квоту localStorage заранее нельзя: navigator.storage.
// estimate считает совсем другое, у строк своя цена в UTF-16 — поэтому
// гарантией целостности служит откат, а не предсказание места.
// Возвращает true — все ключи записаны; false — хранилище отвергло запись
// и применение откачено.
export function writeStaged(stage) {
  const appliedLog = [];
  for (let i = 0; i < stage.length; i++) {
    const previous = localStorage.getItem(stage[i].key);
    appliedLog.push({
      key: stage[i].key,
      value: stage[i].value,
      previous: previous,
      had: previous !== null,
      written: false,
    });
  }

  for (let i = 0; i < appliedLog.length; i++) {
    try {
      localStorage.setItem(appliedLog[i].key, appliedLog[i].value);
    } catch (e) {
      // QuotaExceededError или любая другая ошибка записи: применённое
      // до сбоя откатывается целиком (см. rollbackStagedKeys).
      // Практика сообщения о квоте в проекте одна: безопасная запись
      // эмитит storage:error, тост показывает подписчик в app.js.
      rollbackStagedKeys(appliedLog, 'apply-engine');
      bus.emit('storage:error');
      return false;
    }
    appliedLog[i].written = true;
    // Кэш раздела сбрасывается сразу после его записи, как раньше: при
    // последующем откате кэш просто перечитает прежнюю строку.
    const section = stage[i].section;
    if (section) {
      const row = sectionByName(section);
      if (row && typeof row.onWrite === 'function') row.onWrite();
    }
  }

  return true;
}

// plannerV1: подготовка применения чужого узла (без записей). Снимок
// merge-ится с envelope (замена целиком — ни одна сторона не теряет
// независимые поля; delete-wins проверяет mergePlannerV1), результат
// материализуется в список Матрицы. Отказы:
//   * узла нет / он пуст — ничего не меняем: отсутствие plannerV1 у
//     старого клиента ≠ удаление (ТЗ §1.4.1);
//   * schemaVersion неизвестен или мусор — локальное состояние целое,
//     уходит только диагностика без содержимого (ТЗ §1.3);
//   * envelope привязан к другому подтверждённому владельцу — блок в обе
//     стороны, межустройственное смешивание решает владелец (ТЗ §1.4.4).
// Возвращает пару значений для stage (envelope + список) или null.
export function planPlannerApply(cloudRaw) {
  if (cloudRaw === undefined || cloudRaw === null) return null;
  const normalized = normalizePlannerV1(cloudRaw);
  if (!normalized.ok) {
    bus.emit('planner:rejected', { unsupported: normalized.unsupported === true });
    return null;
  }
  const incoming = normalized.snapshot;
  if (!hasData(incoming.entries) && !hasData(incoming.settings) && !hasData(incoming.tombstones)) {
    return null;
  }
  const env = plannerLoadOrBuildEnvelope();
  if (env.ownerUid) {
    const uid = plannerOwnerUid();
    if (uid && uid !== env.ownerUid) return null;
  }
  const merged = mergePlannerV1(env.snapshot, incoming);
  if (plannerCanonicalJson(merged) === plannerCanonicalJson(env.snapshot)) return null;
  env.snapshot = merged;
  plannerObserveVersions(env, merged);
  const tasks = materializePlannerTasks(merged);
  return {
    envValue: JSON.stringify(env),
    tasksValue: JSON.stringify(tasks),
  };
}

// Применяет данные с сервера. Пишем прямо в localStorage: saveHabits/saveQaza
// поставили бы отправку и вернули бы на сервер только что полученное.
// Пустой раздел на сервере не затирает непустой локальный: это след неполного
// снимка, а не осознанное удаление — иначе чужая пустая копия съест записи.
//
// Применение устроено «всё или ничего» (аудит 2026-10-31): раньше каждый
// прошедший проверку раздел писался сразу, и QuotaExceededError посреди
// применения оставлял половину разделов — данные пользователя смешивались
// с серверными, а UI рисовал половину. Теперь три фазы:
//   1) валидация всех разделов и сбор stage — пар «ключ, готовая строка» —
//      без единой записи в хранилище;
//   2) снимок предыдущего состояния каждого ключа stage;
//   3) запись; первая ошибка — откат уже записанных ключей (rollbackStagedKeys).
// Предсказать квоту localStorage заранее нельзя: navigator.storage.estimate
// считает совсем другое (кэш и диски, а не лимит ключей), у строк своя цена
// в UTF-16 — поэтому гарантией целостности служит откат фаз 2–3, а не
// предсказание места.
// Результат: true — снимок применён целиком; false — хранилище отвергло
// запись и применение откачено (потребитель обязан считать снимок
// неприменённым); применять было нечего — undefined, как раньше.
export function applyCloudData(data, ts) {
  setSyncing(true);
  let cloudApplied = false;
  try {
    const local = {
      habits: loadHabits(),
      records: loadRecords(),
      qaza: loadQaza(true),
      prayer: loadPrayer() || {},
      fast: loadFast() || null,
      qazaLog: loadQazaLog() || null,
      sleep: loadSleep() || null,
      schedule: loadSchedule(),
      tombstones: loadTombstones(),
    };
    const sectionWrites = loadSectionWriteTs();
    const writeTsUpdates = {};
    const stage = [];
    for (let i = 0; i < CLOUD_SECTIONS.length; i++) {
      const row = CLOUD_SECTIONS[i];
      let value = data[row.name];
      let envelopeTs = 0;
      if (row.envelope) {
        const unwrapped = unwrapSection(data[row.name]);
        value = unwrapped.v;
        envelopeTs = unwrapped.ts;
      }
      if (!row.validate(value)) continue;
      if (row.skipWhenPending && syncPending) continue;
      // Нормализация ДО гейтов пустоты: у tombstones валидатор возвращает
      // уже очищенный объект, и прежний гейт шёл по очищенному значению
      // (гейт в applyCloudData). Для fast/qazaLog/sleep порядок не меняет ничего:
      // их нормализованные объекты непусты тогда же, когда и сырые.
      let stored = row.normalize ? row.normalize(value) : value;
      if (row.emptyWins === 'ifLocalEmpty' && !(hasData(stored) || !hasData(local[row.name]))) continue;
      if (row.emptyWins === 'never' && !hasData(stored)) continue;
      if (row.envelope && !sectionEnvelopeWins(envelopeTs, sectionWrites[row.name], true)) continue;
      if (row.snapshotMerge) stored = row.snapshotMerge(local[row.name], stored);
      stage.push({ key: row.key, value: JSON.stringify(stored), section: row.name });
      if (row.writeTs && envelopeTs > 0) writeTsUpdates[row.name] = envelopeTs;
    }
    const plannerStage = planPlannerApply(data.plannerV1);
    if (plannerStage) {
      stage.push({ key: STORAGE_KEYS.plannerEnvelope, value: plannerStage.envValue, section: null });
      stage.push({ key: MATRIX_STORAGE_KEY, value: plannerStage.tasksValue, section: null });
    }
    if (stage.length === 0) return;
    const writeTsJson = sectionWriteTsJson(writeTsUpdates);
    if (writeTsJson) stage.push({ key: SECTION_WRITE_TS_KEY, value: writeTsJson, section: null });
    stage.push({ key: SYNC_TS_KEY, value: String(ts), section: null });
    if (!writeStaged(stage)) return false;
    cloudApplied = true;
  } finally {
    setSyncing(false);
  }
  if (cloudApplied) bus.emit('sync:applied');
  return true;
}
