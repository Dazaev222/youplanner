// Статистика и месячные сегменты (ТЗ §2, §6, §9): интервалы, текущая серия,
// рекорд, точность до миллисекунд, IANA-пояс, DST и граница года.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIntervals,
  calculateStatistics,
  splitIntervalByMonth,
  calculateFrequencies,
} from '../js/harness/diary/statistics.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-01T10:00:00+03:00');

function event(eventId, occurredAtMs, extra = {}) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAtMs,
    reason: 'Стресс',
    categoryPolicyOperationId: 'initial',
    deviceId: 'd',
    createdAtMs: occurredAtMs,
    ...extra,
  };
}

function stats(overrides = {}) {
  return calculateStatistics({
    startedAtMs: START,
    events: [],
    nowMs: START,
    timeZone: 'Europe/Moscow',
    ...overrides,
  });
}

test('без срывов текущая серия идёт от старта и участвует в рекорде', () => {
  const result = stats({ nowMs: START + 2 * HOUR });
  assert.equal(result.currentMs, 2 * HOUR);
  assert.equal(result.bestMs, 2 * HOUR);
  assert.equal(result.relapseCount, 0);
  assert.deepEqual(result.intervals.map((item) => item.kind), ['current']);
});

test('нулевой старт не создаёт ложную завершённую серию и рекорд', () => {
  const result = stats({ nowMs: START });
  assert.equal(result.currentMs, 0);
  assert.equal(result.bestMs, 0);
  assert.deepEqual(
    result.intervals.map((item) => [item.startMs, item.endMs, item.kind]),
    [[START, START, 'current']],
  );
});

test('два срыва через минуты и секунды: интервалы и счётчик уникальных событий', () => {
  const first = START + 5 * MINUTE;
  const second = first + 90 * 1000;
  const result = stats({
    events: [event('event-a', first), event('event-b', second)],
    nowMs: second + 30 * 1000,
  });
  assert.equal(result.relapseCount, 2);
  assert.deepEqual(result.intervals.map((item) => item.durationMs),
    [5 * MINUTE, 90 * 1000, 30 * 1000]);
  assert.equal(result.bestMs, 5 * MINUTE);
  assert.equal(result.currentMs, 30 * 1000);
});

test('текущая серия становится рекордом, если она больше прошлых', () => {
  const first = START + 1 * DAY;
  const second = first + HOUR;
  const result = stats({
    events: [event('event-a', first), event('event-b', second)],
    nowMs: second + 3 * DAY,
  });
  assert.equal(result.currentMs, 3 * DAY);
  assert.equal(result.bestMs, 3 * DAY);
});

test('равные времена сохраняются: между ними нулевая серия, счётчик не схлопывается', () => {
  const at = START + HOUR;
  const result = stats({
    events: [event('event-b', at), event('event-a', at)],
    nowMs: at + HOUR,
  });
  assert.equal(result.relapseCount, 2);
  assert.deepEqual(result.intervals.map((item) => item.durationMs),
    [HOUR, 0, HOUR]);
  assert.deepEqual(result.events.map((item) => item.eventId), ['event-a', 'event-b']);
});

test('позднее событие не вытесняется ранним; текущая серия от самого позднего', () => {
  const late = START + 10 * HOUR;
  const early = START + 1 * HOUR;
  const result = stats({
    events: [event('event-late', late), event('event-early', early)],
    nowMs: late + 2 * HOUR,
  });
  assert.equal(result.currentMs, 2 * HOUR);
  assert.equal(result.events.at(-1).eventId, 'event-late');
});

test('серия 10 дней октября + 5 ноября: полная 15 дней, сегменты 10 и 5', () => {
  const start = Date.parse('2026-10-22T00:00:00+03:00');
  const relapse = Date.parse('2026-11-06T00:00:00+03:00');
  const result = calculateStatistics({
    startedAtMs: start,
    events: [event('event-a', relapse)],
    nowMs: relapse,
    timeZone: 'Europe/Moscow',
  });
  assert.equal(result.intervals[0].durationMs, 15 * DAY);
  const october = result.segmentsByMonth.find((item) => item.month === '2026-10');
  const november = result.segmentsByMonth.find((item) => item.month === '2026-11');
  assert.equal(october.totalMs, 10 * DAY);
  assert.equal(november.totalMs, 5 * DAY);
  assert.equal(october.bestFullMs, 15 * DAY);
  assert.equal(october.bestPortionMs, 10 * DAY);
  assert.equal(november.bestPortionMs, 5 * DAY);
});

test('граница года: декабрь и январь делятся по календарю, а не 30 дням', () => {
  const start = Date.parse('2025-12-20T12:00:00+03:00');
  const end = Date.parse('2026-01-03T12:00:00+03:00');
  const segments = splitIntervalByMonth(start, end, 'Europe/Moscow');
  assert.deepEqual(segments.map((item) => item.month), ['2025-12', '2026-01']);
  assert.equal(segments[0].endMs, Date.parse('2026-01-01T00:00:00+03:00'));
  assert.equal(segments[1].startMs, Date.parse('2026-01-01T00:00:00+03:00'));
  assert.equal(segments.reduce((sum, item) => sum + item.durationMs, 0), end - start);
});

test('DST: март в America/New_York короче на час, сумма сегментов точна', () => {
  const start = Date.parse('2026-03-01T00:00:00-05:00');
  const end = Date.parse('2026-04-02T00:00:00-04:00');
  const segments = splitIntervalByMonth(start, end, 'America/New_York');
  const march = segments.find((item) => item.month === '2026-03');
  const april = segments.find((item) => item.month === '2026-04');
  assert.equal(march.durationMs, 31 * DAY - HOUR);
  assert.equal(april.durationMs, 24 * HOUR);
  assert.equal(march.durationMs + april.durationMs, end - start);
});

test('смена пояса телефона не меняет границы: пояс передан аргументом', () => {
  const start = Date.parse('2026-10-22T00:00:00+03:00');
  const relapse = Date.parse('2026-11-06T00:00:00+03:00');
  const moscow = calculateStatistics({
    startedAtMs: start, events: [event('event-a', relapse)], nowMs: relapse,
    timeZone: 'Europe/Moscow',
  });
  const tokyo = calculateStatistics({
    startedAtMs: start, events: [event('event-a', relapse)], nowMs: relapse,
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(moscow.currentMs, tokyo.currentMs);
  assert.notDeepEqual(
    moscow.segmentsByMonth.map((item) => item.month),
    [],
  );
  assert.equal(tokyo.segmentsByMonth.reduce((sum, item) => sum + item.totalMs, 0),
    moscow.segmentsByMonth.reduce((sum, item) => sum + item.totalMs, 0));
});

test('частоты: точные строки причин и категории отдельно', () => {
  const events = [
    event('event-a', START + HOUR, { reason: 'Стресс', categoryId: 'cat-1' }),
    event('event-b', START + 2 * HOUR, { reason: 'Стресс', categoryId: 'cat-1' }),
    event('event-c', START + 3 * HOUR, { reason: 'Усталость' }),
  ];
  const reasons = calculateFrequencies(events, 'reason', { timeZone: 'Europe/Moscow' });
  assert.deepEqual(reasons, [
    { value: 'Стресс', count: 2 },
    { value: 'Усталость', count: 1 },
  ]);
  const categories = calculateFrequencies(events, 'categoryId', { timeZone: 'Europe/Moscow' });
  assert.deepEqual(categories, [
    { value: 'cat-1', count: 2 },
  ]);
  assert.deepEqual(calculateFrequencies(events, 'reason', {
    timeZone: 'Europe/Moscow',
    fromMs: START + 90 * MINUTE,
    toMs: START + 150 * MINUTE,
  }), [{ value: 'Стресс', count: 1 }]);
});

test('buildIntervals не возвращает отрицательных длительностей', () => {
  const intervals = buildIntervals(START, [event('event-a', START - HOUR)], START);
  for (const interval of intervals) assert.equal(interval.durationMs >= 0, true);
  const result = stats({ nowMs: START - HOUR, events: [event('event-a', START - 2 * HOUR)] });
  assert.equal(result.currentMs, 0);
});
