// Архивация историй (аудит 2026-10-31, рост без ограничения). Детальная
// история хранится с 1-го числа месяца, наступившего 12 месяцев назад:
// всё старше — в месячные сводки под ключом youplanner.archive. Граница —
// начало месяца, а не «сегодня минус 365 дней»: месяц либо полностью
// детальный, либо полностью заархивированный, и сводка месяца всегда
// пересчитывается по полному месяцу — повторный проход не удваивает суммы,
// а вернувшаяся синком старая детализация просто пересчитывает тот же месяц.
//
// Статистике агрегаты не нужны: все её окна смотрят максимум на 366 дней
// (stats.js, STATS_ALL_DAYS). Агрегаты нужны объёму хранилища, файлу копии
// и строке «История копится с» (fastHistorySince). Единственная видимая
// потеря — недели старше границы в навигации главной таблицы: их ячейки
// становятся пустыми, суммы месяцев остаются в архиве.
//
// Проход запускается после первой сверки и на каждом применении чужих данных
// (sync:applied / data:replaced): серверный снимок пишет разделы целиком
// и может привезти старую детализацию обратно. Проход идемпотентен: нечего
// срезать — ни записи, ни события.
import { bus } from '../core/bus.js';
import { toISODate } from '../core/dates.js';
import { safeSetItem } from '../core/storage.js';
import { FAST_KEY, FAST_VERSION, loadFast } from './fast.js';
import { QAZA_LOG_KEY, QAZA_LOG_VERSION, loadQazaLog } from './qaza.js';
import { loadRecords, saveRecords } from './records.js';
import { SLEEP_KEY, SLEEP_VERSION, loadSleep, saveSleepRecord } from './sleep.js';
import { STORAGE_KEYS } from './storage.js';

export const ARCHIVE_KEY = 'youplanner.archive';
export const ARCHIVE_VERSION = 1;
// Сколько календарных месяцев детальной истории остаётся, считая текущий:
// окно «последний год» = 12 месяцев, включая неполный текущий.
export const ARCHIVE_MONTHS = 12;

// Граница детализации: первое число месяца, открывающего окно
// (текущий месяц минус 11). Всё, что раньше, уходит в своды.
export function archiveCutoffISO(now) {
  const d = now || new Date();
  return toISODate(new Date(d.getFullYear(), d.getMonth() - (ARCHIVE_MONTHS - 1), 1));
}

// 'YYYY-MM-DD' → 'YYYY-MM'
function monthKey(date) {
  return String(date).slice(0, 7);
}

// Разрез истории по границе. Строки 'YYYY-MM-DD' сравниваются лексикографически.
function splitByDate(items, cutoff) {
  const kept = [];
  const archived = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && typeof item.date === 'string' && item.date < cutoff) archived.push(item);
    else kept.push(item);
  }
  return { kept: kept, archived: archived };
}

// ── Агрегаторы: элементы истории → карта месяцев ───────────────────────────

// Сон: дни с записью, минуты по правилу статистики (realSleepMin ?? sleepMin),
// отдельно — исключённые дни.
export function archiveSleepMonths(entries) {
  const months = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry.date !== 'string') continue;
    const month = monthKey(entry.date);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const total = entry.realSleepMin != null ? entry.realSleepMin : entry.sleepMin;
    const bucket = months[month] || { days: 0, totalMin: 0, excluded: 0 };
    bucket.days += 1;
    if (Number.isFinite(total)) bucket.totalMin += total;
    if (entry.excluded === true) bucket.excluded += 1;
    months[month] = bucket;
  }
  return months;
}

// Ураза: возмещённые и добавленные дни по месяцам (source 'set' в суммы
// не входит — это завод счётчика, не событие; так же считает fastPeriodStats).
export function archiveFastMonths(entries) {
  const months = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry.date !== 'string') continue;
    const month = monthKey(entry.date);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const count = Number.isFinite(entry.count) ? entry.count : 0;
    const bucket = months[month] || { done: 0, added: 0 };
    if (entry.source === 'done') bucket.done += count;
    if (entry.source === 'add') bucket.added += count;
    months[month] = bucket;
  }
  return months;
}

// Журнал каза: выполненные и вручную добавленные намазы по месяцам.
export function archiveQazaLogMonths(entries) {
  const months = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry.date !== 'string') continue;
    const month = monthKey(entry.date);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const bucket = months[month] || { done: 0, manual: 0 };
    if (entry.source === 'manual') bucket.manual += 1;
    else bucket.done += 1;
    months[month] = bucket;
  }
  return months;
}

// Записи дней: сколько дней с данными и по каждой привычке — дней с true (t),
// сумма и число числовых значений (s и c; значения объектов вроде уровня
// корана считаются по полю value).
export function archiveRecordsMonths(records, dates) {
  const months = {};
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const day = records[date];
    if (!day || typeof day !== 'object' || Array.isArray(day)) continue;
    const month = monthKey(date);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const bucket = months[month] || { days: 0, habits: {} };
    bucket.days += 1;
    const ids = Object.keys(day);
    for (let j = 0; j < ids.length; j++) {
      const id = ids[j];
      const value = day[id];
      const stat = bucket.habits[id] || { t: 0, s: 0, c: 0 };
      if (value === true) {
        stat.t += 1;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        stat.s += value;
        stat.c += 1;
      } else if (value && typeof value === 'object' && Number.isFinite(value.value)) {
        stat.s += value.value;
        stat.c += 1;
      }
      bucket.habits[id] = stat;
    }
    months[month] = bucket;
  }
  return months;
}

// ── Хранилище архива ────────────────────────────────────────────────────────

// Приведение к форме: битые разделы и месяцы отбрасываются молча — архив
// производный, и испорченная сводка не стоит отката данных.
function normalizeMonthsPart(part) {
  const months = {};
  if (part && typeof part.months === 'object' && !Array.isArray(part.months)) {
    const keys = Object.keys(part.months);
    for (let i = 0; i < keys.length; i++) {
      if (!/^\d{4}-\d{2}$/.test(keys[i])) continue;
      const value = part.months[keys[i]];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        months[keys[i]] = value;
      }
    }
  }
  return { months: months };
}

function normalizeArchive(parsed) {
  const archive = {
    version: ARCHIVE_VERSION,
    sleep: normalizeMonthsPart(parsed.sleep),
    fast: normalizeMonthsPart(parsed.fast),
    qaza: normalizeMonthsPart(parsed.qaza),
    records: normalizeMonthsPart(parsed.records),
  };
  if (typeof parsed.fast === 'object' && parsed.fast && typeof parsed.fast.since === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.fast.since)) {
    archive.fast.since = parsed.fast.since;
  }
  return archive;
}

export function loadArchive() {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeArchive(parsed);
  } catch (e) {
    return null;
  }
}

export function saveArchive(archive) {
  if (!archive || typeof archive !== 'object') return false;
  return safeSetItem(ARCHIVE_KEY, JSON.stringify(archive));
}

function emptyArchive() {
  return {
    version: ARCHIVE_VERSION,
    sleep: { months: {} },
    fast: { months: {} },
    qaza: { months: {} },
    records: { months: {} },
  };
}

function mergeMonthMaps(existing, added) {
  return Object.assign({}, existing, added);
}

// ── Проход архивации ────────────────────────────────────────────────────────
// Каждый раздел: разрез по границе → сводки срезанных месяцев заменяют
// соответствующие месяцы архива (полный месяц пересчитывается целиком) →
// обрезанная детализация пишется на своё место. Разделы независимы: сбой
// одного не мешает остальным. Итог — один data:changed на все разделы, чтобы
// наверх уехал один PUT обрезанного состояния.

export function archiveHistories(now) {
  const cutoff = archiveCutoffISO(now);
  const archive = loadArchive() || emptyArchive();
  let changed = false;

  // Сон: история внутри ключа youplanner.sleep.
  try {
    const sleep = loadSleep();
    if (sleep && Array.isArray(sleep.history) && sleep.history.length > 0) {
      const parts = splitByDate(sleep.history, cutoff);
      if (parts.archived.length > 0) {
        archive.sleep = {
          months: mergeMonthMaps(archive.sleep && archive.sleep.months, archiveSleepMonths(parts.archived)),
        };
        const trimmed = Object.assign({}, sleep, { version: SLEEP_VERSION, history: parts.kept });
        if (saveSleepRecord(trimmed)) changed = true;
      }
    }
  } catch (e) {
    console.error('archiveHistories: сон не заархивирован', e);
  }

  // Ураза: история в ключе счётчика; заодно запоминаем самую раннюю
  // срезанную дату — строка «История копится с» читает её из архива.
  try {
    const fast = loadFast();
    if (fast && Array.isArray(fast.history) && fast.history.length > 0) {
      const parts = splitByDate(fast.history, cutoff);
      if (parts.archived.length > 0) {
        archive.fast = {
          months: mergeMonthMaps(archive.fast && archive.fast.months, archiveFastMonths(parts.archived)),
          since: archive.fast && archive.fast.since ? archive.fast.since : parts.archived[0].date,
        };
        for (let i = 0; i < parts.archived.length; i++) {
          if (parts.archived[i].date < archive.fast.since) archive.fast.since = parts.archived[i].date;
        }
        // Результат записи проверяется, как в ветке сна и записей: при отказе
        // квоты детализация остаётся на месте, и сводить её в архив нельзя —
        // иначе сводка задвоила бы ещё не срезанные месяцы
        if (safeSetItem(FAST_KEY, JSON.stringify({
          version: FAST_VERSION,
          remaining: fast.remaining,
          history: parts.kept,
        }))) changed = true;
      }
    }
  } catch (e) {
    console.error('archiveHistories: ураза не заархивирована', e);
  }

  // Журнал каза: записи срезаются, since не двигается — от него зависит
  // правило «журнал с since, до него h6» (§5).
  try {
    const log = loadQazaLog();
    if (log && Array.isArray(log.entries) && log.entries.length > 0) {
      const parts = splitByDate(log.entries, cutoff);
      if (parts.archived.length > 0) {
        archive.qaza = {
          months: mergeMonthMaps(archive.qaza && archive.qaza.months, archiveQazaLogMonths(parts.archived)),
        };
        // Результат записи проверяется, как в ветке сна и записей: при отказе
        // квоты журнал остаётся целиком, и сводить его в архив нельзя
        if (safeSetItem(QAZA_LOG_KEY, JSON.stringify({
          version: QAZA_LOG_VERSION,
          since: log.since,
          entries: parts.kept,
        }))) changed = true;
      }
    }
  } catch (e) {
    console.error('archiveHistories: журнал каза не заархивирован', e);
  }

  // Записи дней: даты старше границы уходят в сводки, остальное — как было.
  // Мусорные ключи (не даты) не трогаются.
  try {
    const records = loadRecords();
    const kept = {};
    const archivedDays = [];
    const dates = Object.keys(records);
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) archivedDays.push(date);
      else kept[date] = records[date];
    }
    if (archivedDays.length > 0) {
      archive.records = {
        months: mergeMonthMaps(archive.records && archive.records.months, archiveRecordsMonths(records, archivedDays)),
      };
      if (saveRecords(kept)) changed = true;
    }
  } catch (e) {
    console.error('archiveHistories: записи не заархивированы', e);
  }

  if (changed) {
    saveArchive(archive);
    // Одна правка на все разделы: подписчик поставит одну отложенную отправку
    bus.emit('data:changed');
  }
  return changed;
}

// Начало истории уразы для строки «История копится с»: минимум по оставшейся
// детализации и по архиву. fastPeriodStats не трогается — она считает
// период, а не начало (tests/fast.test.mjs не меняются).
export function fastHistorySince(fast) {
  let since = null;
  if (fast && Array.isArray(fast.history)) {
    for (let i = 0; i < fast.history.length; i++) {
      const entry = fast.history[i];
      if (entry && typeof entry.date === 'string' && (since === null || entry.date < since)) {
        since = entry.date;
      }
    }
  }
  const archive = loadArchive();
  const archived = archive && archive.fast && archive.fast.since;
  if (typeof archived === 'string' && (since === null || archived < since)) since = archived;
  return since;
}
