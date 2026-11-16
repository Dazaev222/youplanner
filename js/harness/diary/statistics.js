/* Производная статистика (ТЗ §2, §6, §9). Часы и timeZone — аргументы,
   никаких реальных Date.now и фиксированных 30-дневных месяцев. */

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

const formatters = new Map();

function formatterFor(timeZone) {
  const key = timeZone || 'UTC';
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat('en-GB', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }));
  }
  return formatters.get(key);
}

/** Календарный месяц (YYYY-MM) момента в сохранённом IANA-поясе. */
export function monthKeyAt(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  let year = '';
  let month = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    if (part.type === 'month') month = part.value;
  }
  return `${year}-${month}`;
}

function clampDuration(startMs, endMs) {
  return Math.max(0, endMs - startMs);
}

/** [старт, первый срыв), [предыдущий, следующий), текущий [последний, now). */
export function buildIntervals(startedAtMs, effectiveEvents = [], nowMs) {
  const events = [...effectiveEvents].sort((a, b) => {
    if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
    return String(a.eventId) < String(b.eventId) ? -1
      : String(a.eventId) > String(b.eventId) ? 1 : 0;
  });

  const intervals = [];
  let prev = startedAtMs;
  for (const event of events) {
    const end = Math.max(prev, event.occurredAtMs);
    intervals.push({
      startMs: prev,
      endMs: end,
      durationMs: clampDuration(prev, end),
      kind: 'completed',
      fromEventId: null,
      toEventId: event.eventId,
    });
    prev = end;
  }
  intervals.push({
    startMs: prev,
    endMs: nowMs,
    durationMs: clampDuration(prev, nowMs),
    kind: 'current',
    fromEventId: events.length > 0 ? events[events.length - 1].eventId : null,
    toEventId: null,
  });
  return intervals;
}

function findMonthBoundary(startMs, endMs, key, timeZone) {
  let lo = startMs;
  let hi = endMs;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (monthKeyAt(mid, timeZone) === key) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Фактическое пересечение интервала с календарными месяцами (с DST). */
export function splitIntervalByMonth(startMs, endMs, timeZone) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const segments = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs) {
    guard += 1;
    if (guard > 12000) break;
    const key = monthKeyAt(cursor, timeZone);
    const boundary = monthKeyAt(endMs, timeZone) === key
      ? endMs
      : findMonthBoundary(cursor, endMs, key, timeZone);
    segments.push({
      month: key,
      startMs: cursor,
      endMs: boundary,
      durationMs: boundary - cursor,
    });
    cursor = boundary;
  }
  return segments;
}

function fieldValue(event, field) {
  if (field === 'reason') return typeof event.reason === 'string' ? event.reason : null;
  if (field === 'triggerId') return typeof event.triggerId === 'string' ? event.triggerId : null;
  if (field === 'categoryId') return typeof event.categoryId === 'string' ? event.categoryId : null;
  return null;
}

/** Точные частоты исходных строк; без ИИ и без смысловых объединений. */
export function calculateFrequencies(events, field, { timeZone, fromMs, toMs } = {}) {
  const counts = new Map();
  for (const event of events || []) {
    if (fromMs !== undefined && event.occurredAtMs < fromMs) continue;
    if (toMs !== undefined && event.occurredAtMs >= toMs) continue;
    const value = fieldValue(event, field);
    if (value === null || value === '') continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

function sortEvents(events) {
  return [...(events || [])].sort((a, b) => {
    if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
    return String(a.eventId) < String(b.eventId) ? -1
      : String(a.eventId) > String(b.eventId) ? 1 : 0;
  });
}

/**
 * Статистика на один asOfMs. Не округляет интервалы перед сравнением,
 * серия от самого позднего события; нулевой старт не создаёт рекорд.
 */
export function calculateStatistics({
  startedAtMs,
  events = [],
  nowMs,
  timeZone,
} = {}) {
  if (!Number.isFinite(startedAtMs)) throw new TypeError('calculateStatistics: startedAtMs');
  if (!Number.isFinite(nowMs)) throw new TypeError('calculateStatistics: nowMs');

  const sorted = sortEvents(events);
  const intervals = buildIntervals(startedAtMs, sorted, nowMs);
  const completed = intervals.filter((item) => item.kind === 'completed');
  const current = intervals[intervals.length - 1];
  const currentMs = current ? current.durationMs : 0;
  const bestMs = Math.max(0, currentMs, ...completed.map((item) => item.durationMs));

  const byMonth = new Map();
  for (const interval of intervals) {
    if (interval.durationMs <= 0) continue;
    const segments = splitIntervalByMonth(interval.startMs, interval.endMs, timeZone);
    for (const segment of segments) {
      if (!byMonth.has(segment.month)) {
        byMonth.set(segment.month, {
          month: segment.month,
          totalMs: 0,
          bestFullMs: 0,
          bestPortionMs: 0,
          eventCount: 0,
          currentMs: 0,
        });
      }
      const entry = byMonth.get(segment.month);
      entry.totalMs += segment.durationMs;
      entry.bestPortionMs = Math.max(entry.bestPortionMs, segment.durationMs);
      entry.bestFullMs = Math.max(entry.bestFullMs, interval.durationMs);
      if (interval.kind === 'current') entry.currentMs += segment.durationMs;
    }
  }
  for (const event of sorted) {
    const key = monthKeyAt(event.occurredAtMs, timeZone);
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        month: key, totalMs: 0, bestFullMs: 0, bestPortionMs: 0, eventCount: 0, currentMs: 0,
      });
    }
    byMonth.get(key).eventCount += 1;
  }

  const segmentsByMonth = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  const nowMonth = monthKeyAt(nowMs, timeZone);
  const monthStartMs = monthStart(nowMs, timeZone);
  const monthEvents = sorted.filter((event) => monthKeyAt(event.occurredAtMs, timeZone) === nowMonth);

  return {
    schemaVersion: 1,
    asOfMs: nowMs,
    startedAtMs,
    timeZone,
    currentMs,
    bestMs,
    relapseCount: sorted.length,
    events: sorted,
    intervals,
    segmentsByMonth,
    triggerFrequencies: calculateFrequencies(sorted, 'triggerId'),
    reasonFrequencies: calculateFrequencies(sorted, 'reason'),
    categoryFrequencies: calculateFrequencies(sorted, 'categoryId'),
    periods: {
      allTime: {
        currentMs,
        bestMs,
        relapseCount: sorted.length,
        triggerFrequencies: calculateFrequencies(sorted, 'triggerId'),
        reasonFrequencies: calculateFrequencies(sorted, 'reason'),
        categoryFrequencies: calculateFrequencies(sorted, 'categoryId'),
      },
      currentMonth: {
        month: nowMonth,
        monthStartMs,
        relapseCount: monthEvents.length,
        triggerFrequencies: calculateFrequencies(monthEvents, 'triggerId'),
        reasonFrequencies: calculateFrequencies(monthEvents, 'reason'),
        categoryFrequencies: calculateFrequencies(monthEvents, 'categoryId'),
        segments: segmentsByMonth.filter((item) => item.month === nowMonth),
      },
    },
  };
}

// Начало календарного месяца в поясе (для отчётов; не фиксированные 30 дней).
function monthStart(ms, timeZone) {
  const key = monthKeyAt(ms, timeZone);
  let lo = ms - 32 * DAY;
  let hi = ms;
  if (monthKeyAt(lo, timeZone) === key) return lo;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (monthKeyAt(mid, timeZone) === key) hi = mid;
    else lo = mid;
  }
  return hi;
}

export { DAY, MINUTE };
