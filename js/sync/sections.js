// Дескрипторная таблица облачных разделов (АДР 2026-11-08, §3.1, воркер A).
// Единственный источник правды о том, как раздел облачного снимка ложится
// в хранилище: оба применения (путь снимка applyCloudSnapshot и путь гонки
// applyMergedFromCloud) читают таблицу как данные вместо 11 inline-блоков
// applyCloudData (js/sync/sync.js) и по-блочного хардкода mergeCloudIntoLocal
// (js/sync/merge.js). Порядок строк = порядок нынешних блоков applyCloudData:
// порядок stage могут читать тесты, он сохраняется.
//
// Оси дескриптора:
//   name            — имя раздела в снимке (ключ в data и в local);
//   key             — ключ хранилища (замена switch mergeSectionKey);
//   validate        — (value) => bool, значение БЕЗ конверта {v, ts};
//   envelope        — true: раздел ходит в конверте {v, ts} (unwrapSection);
//   emptyWins       — что делает пустое значение с сервера:
//                       'ifLocalEmpty' — применяется только если есть данные
//                         ИЛИ локальный пуст (след неполного снимка, а не
//                         осознанное удаление, не затирает непустой локальный);
//                       'always' — применяется всегда при валидности;
//                       'never' — пустое значение не применяется вовсе;
//   skipWhenPending — true: раздел пропускается, пока есть неотправленная
//                     правка (серверной копии она ещё не видела, снимок
//                     затёр бы её молча);
//   normalize       — (value) => stored: перестройка значения перед записью;
//   snapshotMerge   — (localValue, cloudValue) => stored: слияние с локальным
//                     уже в snapshot-пути (tombstones — серверные надгробия
//                     не заменяют локальные, а сливаются по max(ts));
//   raceMerge       — стратегия слияния при гонке двух устройств
//                     (диспетчер merge-engine: 'collection:*' — слияния
//                     merge.js с tombstones-контекстом, 'envelope' — правило
//                     конверта sectionEnvelopeWins, 'sleep' — mergeSleepEntry,
//                     'qazaLog' — аддитивное слияние, 'archive' — mergeArchive,
//                     'tombstones' — mergeTombstonesById);
//   onWrite         — fn() сразу после записи ключа (records — сброс кэша);
//   writeTs         — true: конвертная метка записи переносится в карту
//                     SECTION_WRITE_TS (та же атомарная порция).
//
// Файл — чистые данные: хранилище не читает и не пишет. Валидаторы
// (js/sync/core.js) и mergeTombstonesById (js/sync/merge.js) не переписаны —
// переиспользованы как есть; invalidateRecordsCache передана значением.

import { ARCHIVE_KEY } from '../data/archive.js';
import { FAST_KEY, FAST_VERSION, validFastHistory } from '../data/fast.js';
import { invalidateRecordsCache } from '../data/records.js';
import { PRAYER_KEY } from '../data/prayer.js';
import { QAZA_LOG_KEY, QAZA_LOG_VERSION, QAZA_STORAGE_KEY, validQazaLogEntries } from '../data/qaza.js';
import { SLEEP_KEY, validSleepHistory } from '../data/sleep.js';
import { STORAGE_KEYS } from '../data/storage.js';
import { mergeTombstonesById, validCloudArchive, validCloudFast, validCloudHabits, validCloudPrayer, validCloudQaza, validCloudQazaLog, validCloudRecords, validCloudSchedule, validCloudSleep, validCloudTombstones } from './core.js';

// Перестройки перед записью. Чистые функции: значение приходит уже
// провалидированным, хранилище не трогают. Функции-декларации, как в
// окружении. ВАЖНО: извлекать их в общий код applyCloudData нельзя до
// перепайки движков — здесь они служат источником того же литерала.
// 1) Счётчик уразы: история из снимка чистится, но раздел из-за битой
//    записи не отклоняется — битая запись не повод терять счётчик
//    (§5, validFastHistory).
function normalizeFast(value) {
  return { version: FAST_VERSION, remaining: value.remaining, history: validFastHistory(value.history) };
}

// 2) Журнал выполнений каза: битый since раздел не пропускает (иначе журнал
//    записался бы и при следующем чтении пропал бы вовсе — §5, loadQazaLog).
function normalizeQazaLog(value) {
  return { version: QAZA_LOG_VERSION, since: value.since, entries: validQazaLogEntries(value.entries) };
}

// 3) Запись о сне: история чистится, остальное (включая будущие поля)
//    переносится как есть.
function normalizeSleep(value) {
  return Object.assign({}, value, { history: validSleepHistory(value.history) });
}

export const CLOUD_SECTIONS = [
  // Привычки: без конверта; пустой раздел сервера не затирает непустой
  // локальный. Гонка — mergeHabitsById с tombstones-контекстом.
  {
    name: 'habits',
    key: STORAGE_KEYS.habits,
    validate: validCloudHabits,
    envelope: false,
    emptyWins: 'ifLocalEmpty',
    skipWhenPending: false,
    normalize: null,
    snapshotMerge: null,
    raceMerge: 'collection:habits',
    onWrite: null,
    writeTs: false,
  },
  // Записи: как привычки; после записи ключа кэш записей сбрасывается сразу.
  {
    name: 'records',
    key: STORAGE_KEYS.records,
    validate: validCloudRecords,
    envelope: false,
    emptyWins: 'ifLocalEmpty',
    skipWhenPending: false,
    normalize: null,
    snapshotMerge: null,
    raceMerge: 'collection:records',
    onWrite: invalidateRecordsCache,
    writeTs: false,
  },
  // Счётчик каза: конверт {v, ts}; НЕ применяется, пока есть неотправленная
  // правка; метка конверта (>0) уезжает в карту SECTION_WRITE_TS.
  {
    name: 'qaza',
    key: QAZA_STORAGE_KEY,
    validate: validCloudQaza,
    envelope: true,
    emptyWins: 'ifLocalEmpty',
    skipWhenPending: true,
    normalize: null,
    snapshotMerge: null,
    raceMerge: 'envelope',
    onWrite: null,
    writeTs: true,
  },
  // Координаты: конверт {v, ts}; пустой объект с сервера не затирает
  // заданные координаты.
  {
    name: 'prayer',
    key: PRAYER_KEY,
    validate: validCloudPrayer,
    envelope: true,
    emptyWins: 'ifLocalEmpty',
    skipWhenPending: false,
    normalize: null,
    snapshotMerge: null,
    raceMerge: 'envelope',
    onWrite: null,
    writeTs: true,
  },
  // Счётчик уразы: конверт {v, ts}; remaining: 0 — значимое значение
  // (hasData даёт true), «счётчика нет» — только null.
  {
    name: 'fast',
    key: FAST_KEY,
    validate: validCloudFast,
    envelope: true,
    emptyWins: 'ifLocalEmpty',
    skipWhenPending: false,
    normalize: normalizeFast,
    snapshotMerge: null,
    raceMerge: 'envelope',
    onWrite: null,
    writeTs: true,
  },
  // Журнал выполнений каза: без конверта; entries:[] ключами непуст и
  // ПРИМЕНЯЕТСЯ, затирая локальный («журнала нет» выражается только null);
  // НЕ применяется при неотправленной правке — отмена записи дороже.
  {
    name: 'qazaLog',
    key: QAZA_LOG_KEY,
    validate: validCloudQazaLog,
    envelope: false,
    emptyWins: 'ifLocalEmpty',
    skipWhenPending: true,
    normalize: normalizeQazaLog,
    snapshotMerge: null,
    raceMerge: 'qazaLog',
    onWrite: null,
    writeTs: false,
  },
  // Запись о сне: без конверта; пустой объект не затирает заведённую запись.
  {
    name: 'sleep',
    key: SLEEP_KEY,
    validate: validCloudSleep,
    envelope: false,
    emptyWins: 'ifLocalEmpty',
    skipWhenPending: false,
    normalize: normalizeSleep,
    snapshotMerge: null,
    raceMerge: 'sleep',
    onWrite: null,
    writeTs: false,
  },
  // Расписание: конверт {v, ts}; применяется всегда при валидности — пустым
  // быть не может, дефолты подставляет loadSchedule.
  {
    name: 'schedule',
    key: STORAGE_KEYS.schedule,
    validate: validCloudSchedule,
    envelope: true,
    emptyWins: 'always',
    skipWhenPending: false,
    normalize: null,
    snapshotMerge: null,
    raceMerge: 'envelope',
    onWrite: null,
    writeTs: true,
  },
  // Архив: заменяет локальный целиком — сводки производные, месяцы
  // пересчитываются при каждой архивации. Раздела в снимке нет — локальный
  // не трогается.
  {
    name: 'archive',
    key: ARCHIVE_KEY,
    validate: validCloudArchive,
    envelope: false,
    emptyWins: 'always',
    skipWhenPending: false,
    normalize: null,
    snapshotMerge: null,
    raceMerge: 'archive',
    onWrite: null,
    writeTs: false,
  },
  // Надгробия: пустое значение НЕ применяется вовсе; серверные не заменяют
  // локальные, а сливаются по max(ts) уже в snapshot-пути (иначе ещё не
  // отправленная метка удаления исчезла бы и привычка воскресла бы).
  // normalize — сам валидатор: validCloudTombstones возвращает ОЧИЩЕННЫЙ
  // объект (sanitizeTombstones: лимит, конечные ts, строковые id), и прежний
  // гейт и слияние шли по очищенному значению (гейт и слияние в
  // applyCloudData), а не по
  // сырому снимку.
  {
    name: 'tombstones',
    key: STORAGE_KEYS.tombstones,
    validate: validCloudTombstones,
    envelope: false,
    emptyWins: 'never',
    skipWhenPending: false,
    normalize: validCloudTombstones,
    snapshotMerge: mergeTombstonesById,
    raceMerge: 'tombstones',
    onWrite: null,
    writeTs: false,
  },
];

// Раздел по имени раздела снимка (ключ в data). Нет такого — null:
// снимок старого клиента несёт не все разделы, это легальный случай.
export function sectionByName(name) {
  for (let i = 0; i < CLOUD_SECTIONS.length; i++) {
    if (CLOUD_SECTIONS[i].name === name) return CLOUD_SECTIONS[i];
  }
  return null;
}
