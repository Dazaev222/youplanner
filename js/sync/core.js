// Ядро sync-слоя: константы Firebase, флаги состояния синхронизации и
// валидаторы облачного снимка. Жили тремя файлами — js/data/sync.js
// (константы), js/sync/state.js (флаги) и js/sync/validators.js
// (валидаторы) — и читались одним и тем же набором потребителей
// (sync/sync.js, app.js, merge.js, data/backup.js, миграции и qaza),
// поэтому слиты в один модуль (этап Y2).
//
// ВАЖНО про живые биндинги: export let syncPending / normalizing мутируются
// ТОЛЬКО своими функциями (markSyncPending / clearSyncPending /
// saveNormalized) здесь же, внутри модуля. Потребители получают живое
// чтение этих let — и оно работает, потому что мутация и чтение живут
// в одном файле.

import { PRAYER_MADHHABS, PRAYER_METHODS } from '../data/prayer.js';
import { NAMAZ_ORDER, QAZA_VERSION, validQazaLogDate } from '../data/qaza.js';
import { SLEEP_MAX_MINUTES, sleepDurationMinutes, sleepFallMinutes, sleepTimeMinutes } from '../data/sleep.js';
import { ARCHIVE_VERSION } from '../data/archive.js';
import { sanitizeTombstones } from '../data/habits.js';

// --- Константы Firebase и таймингов (бывший js/data/sync.js) -----------------

export const FIREBASE_URL = 'https://youplanner-5c2f5-default-rtdb.firebaseio.com/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9';
// Бэкапы живут ОТДЕЛЬНЫМ корнем, а не ребёнком синхронизируемого узла:
// PUT на FIREBASE_URL заменяет узел целиком вместе со всеми детьми,
// поэтому вложенный /backups стирался бы каждой же синхронизацией
// сразу после записи. Соседний корень основной PUT не трогает.
export const FIREBASE_BACKUPS_URL = 'https://youplanner-5c2f5-default-rtdb.firebaseio.com/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9-backups';
// Состояние планировщика (plannerV1) — СОСЕДНИЙ корень по той же причине, что
// и бэкапы выше: PUT на FIREBASE_URL заменяет узел целиком, и клиент на кэше
// ниже v43, не знающий ключа plannerV1, стирал бы Матрицу с сервера каждым
// корневым PUT (status.md, заходит 2026-11-05). Соседний корень старый клиент
// не адресует вовсе, поэтому данные переживают любой его PUT. Правила узла —
// в database.rules.json (запись только владельцу, валидатор схемы).
export const FIREBASE_PLANNER_URL = 'https://youplanner-5c2f5-default-rtdb.firebaseio.com/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9-planner';
export const SYNC_TS_KEY = 'youplanner.sync.ts';
// Идёт обмен с сервером. Свои же сохранения в этот момент не должны ставить
// встречную отправку: loadQaza() зовёт saveQaza(), а syncToCloud() зовёт
// loadQaza() — без флага каждая отправка планировала бы следующую. Флаг
// в core.js с 2026-11-08: его пишут и sync.js (syncToCloudNow), и
// apply-engine.js (applyCloudData), поэтому присваивание — только через
// setSyncing (импортированный let присваивать нельзя).
export let syncing = false;
export function setSyncing(v) { syncing = v; }
// Сколько версий держим в узле бэкапов (FIREBASE_BACKUPS_URL)
export const BACKUP_LIMIT = 10;
// Минимальная пауза между копиями в узел бэкапов (Г2): копия — самая тяжёлая
// часть обмена (GET списка снимков и PUT списка целиком), аудит мерил
// 3-7 МБ трафика на галочку. Дебаунс слепляет серию тапов в один PUT, но
// частые отметки всё равно платили бы копированием дерева на каждый обмен.
export const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;
// Отправка после правки откладывается: серия тапов по клеткам даёт один PUT
export const SYNC_DEBOUNCE_MS = 1500;
// Сколько держится надпись о ручной синхронизации
export const SYNC_STATUS_MS = 2000;

// --- Флаги состояния синхронизации (бывший js/sync/state.js) -----------------

// Правка, случившаяся до первой сверки: отправку не теряем, а откладываем
// до ответа сервера — иначе PUT ушёл бы раньше, чем мы узнали серверное.
// Флаг же говорит и обратное: пока он взведён, серверный снимок локальному
// не указ (см. cloudSnapshotWins).
export let syncPending = false;
export function markSyncPending() { syncPending = true; }
export function clearSyncPending() { syncPending = false; }
// Чтение приводит данные в порядок и пишет их обратно: дефолты привычек,
// миграция версии каза, обрезка истории, курсор. Это не правка пользователя,
// поэтому приоритета локальному состоянию такая запись не даёт и syncPending
// не взводит — иначе флаг стоял бы на каждом старте и снимок с сервера
// не применялся бы никогда.
export let normalizing = false;
// Единственный вход для записей при чтении: saveNormalized(() => saveX(...))
export function saveNormalized(write) {
  normalizing = true;
  try {
    return write();
  } finally {
    normalizing = false;
  }
}
// Время последней известной версии данных. Больше — свежее.
export function syncTs() {
  return Number(localStorage.getItem(SYNC_TS_KEY)) || 0;
}

// Надгробия удалённых привычек: слияние по max(ts) на id, аддитивно.
// Надгробие никогда не «воскрешается»: отсутствие пары на чужой стороне
// локальную не отменяет — снятие метки локальное решение устройства
// (pruneResolvedTombstones), а не содержимое снимка. Обе стороны приходят
// уже очищенными (loadTombstones/validCloudTombstones), битые значения
// и здесь отбрасываются — защита от вызова с сырыми данными.
export function mergeTombstonesById(localTombstones, cloudTombstones) {
  const merged = {};
  const sides = [localTombstones, cloudTombstones];
  for (let s = 0; s < sides.length; s++) {
    const side = sides[s];
    if (!side || typeof side !== 'object' || Array.isArray(side)) continue;
    const ids = Object.keys(side);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const ts = side[id];
      // Только числа по типу: мягкое приведение сделало бы из null и ''
      // нулевую метку — надгробие «с самого начала времён»
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) continue;
      if (merged[id] === undefined || ts > merged[id]) merged[id] = ts;
    }
  }
  return merged;
}

// --- Валидаторы облачного снимка (бывший js/sync/validators.js) --------------

// Раздел с данными: непустой список или непустой объект.
export function hasData(value) {
  if (!value || typeof value !== 'object') return false;
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}
// Привычки: массив, каждый элемент — объект со строковыми id и name
// и типом из набора привычек (тот же, что у HABIT_TYPES формы)
export function validCloudHabits(habits) {
  if (!Array.isArray(habits)) return false;
  const types = ['boolean', 'number', 'choice'];
  for (let i = 0; i < habits.length; i++) {
    const habit = habits[i];
    if (!habit || typeof habit !== 'object' || Array.isArray(habit)) return false;
    if (typeof habit.id !== 'string' || habit.id === '') return false;
    if (typeof habit.name !== 'string') return false;
    if (types.indexOf(habit.type) === -1) return false;
  }
  return true;
}
// Записи: объект, ключи — даты 'YYYY-MM-DD' (тот же формат, что validQazaLogDate),
// значения — объекты записей за день
export function validCloudRecords(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) return false;
  const dates = Object.keys(records);
  for (let i = 0; i < dates.length; i++) {
    if (!validQazaLogDate(dates[i])) return false;
    const day = records[dates[i]];
    if (!day || typeof day !== 'object' || Array.isArray(day)) return false;
  }
  return true;
}
// Очередь каза: текущая версия схемы, курсор — целое в пределах очереди,
// остаток — ровно пять ключей NAMAZ_ORDER с целыми неотрицательными
// значениями, история — массив (записи при чтении отфильтрует copyQaza)
export function validCloudQaza(qaza) {
  if (!qaza || typeof qaza !== 'object' || Array.isArray(qaza)) return false;
  if (qaza.version !== QAZA_VERSION) return false;
  if (!Number.isInteger(qaza.cursor) ||
      qaza.cursor < 0 || qaza.cursor >= NAMAZ_ORDER.length) return false;
  const remaining = qaza.remaining;
  if (!remaining || typeof remaining !== 'object' || Array.isArray(remaining)) return false;
  if (Object.keys(remaining).length !== NAMAZ_ORDER.length) return false;
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const value = remaining[NAMAZ_ORDER[i]];
    if (!Number.isInteger(value) || value < 0) return false;
  }
  return Array.isArray(qaza.history);
}
// Молитвы: координаты числами в тех же пределах, что у loadPrayer,
// мазхаб и метод — из своих списков
export function validCloudPrayer(prayer) {
  if (!prayer || typeof prayer !== 'object' || Array.isArray(prayer)) return false;
  if (!Number.isFinite(prayer.lat) || prayer.lat < -89.8 || prayer.lat > 89.8) return false;
  if (!Number.isFinite(prayer.lng) || prayer.lng < -180 || prayer.lng > 180) return false;
  if (PRAYER_MADHHABS.indexOf(prayer.madhhab) === -1) return false;
  return PRAYER_METHODS.indexOf(prayer.method) !== -1;
}
// Счётчик уразы: остаток — целое неотрицательное, история — массив
// (записи при записи раздела почистит validFastHistory)
export function validCloudFast(fast) {
  if (!fast || typeof fast !== 'object' || Array.isArray(fast)) return false;
  if (!Number.isInteger(fast.remaining) || fast.remaining < 0) return false;
  return Array.isArray(fast.history);
}
// Журнал выполнений каза: since — дата 'YYYY-MM-DD', entries — массив
// (записи при записи раздела почистит validQazaLogEntries)
export function validCloudQazaLog(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return false;
  if (!validQazaLogDate(log.since)) return false;
  return Array.isArray(log.entries);
}
// Запись о сне: те же проверки, что в loadSleep. bed и wake — время суток,
// fall — целое 0…120 по sleepFallMinutes. Пара actualWake/sleepMin либо
// отсутствует целиком, либо сходится: время — 'HH:MM', длительность — целое
// 0…1439 и равна расчётной от bed и fall. Пара realWake/realSleepMin —
// по тому же правилу. excluded, если задан, — только булев. История —
// массив (записи при записи раздела почистит validSleepHistory)
export function validCloudSleep(sleep) {
  if (!sleep || typeof sleep !== 'object' || Array.isArray(sleep)) return false;
  if (sleepTimeMinutes(sleep.bed) === null) return false;
  if (sleepTimeMinutes(sleep.wake) === null) return false;
  const fall = sleepFallMinutes(sleep.fall);
  if (fall === null) return false;
  if (sleep.actualWake !== undefined || sleep.sleepMin !== undefined) {
    if (sleepTimeMinutes(sleep.actualWake) === null) return false;
    if (!Number.isInteger(sleep.sleepMin) ||
        sleep.sleepMin < 0 || sleep.sleepMin >= SLEEP_MAX_MINUTES) return false;
    if (sleepDurationMinutes(sleep.bed, fall, sleep.actualWake) !== sleep.sleepMin) return false;
  }
  const hasRealWake = sleep.realWake !== null && sleep.realWake !== undefined;
  const hasRealSleepMin = sleep.realSleepMin !== null && sleep.realSleepMin !== undefined;
  if (hasRealWake !== hasRealSleepMin) return false;
  if (hasRealWake) {
    if (sleepTimeMinutes(sleep.realWake) === null) return false;
    if (!Number.isInteger(sleep.realSleepMin) ||
        sleep.realSleepMin < 0 || sleep.realSleepMin >= SLEEP_MAX_MINUTES) return false;
    if (sleepDurationMinutes(sleep.bed, fall, sleep.realWake) !== sleep.realSleepMin) return false;
  }
  if (sleep.excluded !== undefined && typeof sleep.excluded !== 'boolean') return false;
  return Array.isArray(sleep.history);
}
// Расписание с сервера — один раздел, минимум: объект без массива, у которого
// все четыре типа дня — массивы. Пункты не глубже проверяются: битый пункт
// не должен терять раздел целиком, отбросить его при чтении может
// loadSchedule (как validSleepHistory), а повторно сохранённая копия пройдёт
// через saveSchedule. Раздел без ключа schedule (снимок старой версии)
// отвергается этим же правилом.
export function validCloudSchedule(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!Array.isArray(data.weekday) || !Array.isArray(data.weekend) ||
      !Array.isArray(data.fasting) || !Array.isArray(data.physical)) return false;
  return true;
}
// Архив: месячные сводки историй (js/data/archive.js). Форма: четыре раздела,
// у каждого — карта месяцев 'YYYY-MM' с объектами-суммами; у fast может быть
// since — дата начала срезанной истории. Проверка формы, не содержимого:
// сводки производные, пересчитываются заново при каждой архивации.
export function validCloudArchive(archive) {
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) return false;
  if (archive.version !== ARCHIVE_VERSION) return false;
  const parts = ['sleep', 'fast', 'qaza', 'records'];
  for (let i = 0; i < parts.length; i++) {
    const part = archive[parts[i]];
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
    if (!part.months || typeof part.months !== 'object' || Array.isArray(part.months)) return false;
    const months = Object.keys(part.months);
    for (let j = 0; j < months.length; j++) {
      if (!/^\d{4}-\d{2}$/.test(months[j])) return false;
      const value = part.months[months[j]];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    }
  }
  const since = archive.fast.since;
  if (since !== undefined && since !== null &&
      (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(since))) return false;
  return true;
}
// Надгробия удалённых привычек (js/data/habits.js): объект id → метка
// удаления. От остальных валидаторов отличается возвратом: раздел плоский,
// поэтому битые записи не роняют его целиком, а отбрасываются — возвращается
// ОЧИЩЕННЫЙ объект (sanitizeTombstones: лимит числа, конечные ts, строковые
// id); не-объект — раздела нет (null). Пустой объект валиден: «надгробий
// нет» — легальное содержимое раздела. Раздел необязателен: снимки до
// введения надгробий его не несут, и null потребители читают как «раздела
// в снимке нет».
export function validCloudTombstones(tombstones) {
  if (!tombstones || typeof tombstones !== 'object' || Array.isArray(tombstones)) return null;
  return sanitizeTombstones(tombstones);
}
