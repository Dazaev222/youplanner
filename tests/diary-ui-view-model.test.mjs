import { test } from 'node:test';
import assert from 'node:assert/strict';
const vm = await import('../js/harness/diary-ui/view-model.js').catch(() => ({}));
const months = await import('../js/harness/diary-ui/milestones.js').catch(() => ({}));
test('представление: ноль, сутки, >99 дней, актуальные последние четыре', () => {
  assert.equal(typeof vm.durationParts, 'function');
  assert.deepEqual(vm.durationParts(0), ['0','00','00','00']);
  assert.deepEqual(vm.durationParts(100*86400000+3661000), ['100','01','01','01']);
  assert.deepEqual(vm.selectRecentEvents([{eventId:'a',occurredAtMs:1},{eventId:'b',occurredAtMs:2}]).map(e=>e.eventId), ['b','a']);
});
test('diaryDate: строгий формат «16 ноября 2026, 14:35», без «г.» и «в»', () => {
  assert.equal(typeof vm.diaryDate, 'function');
  assert.equal(vm.diaryDate(Date.parse('2026-11-16T14:35:00Z'), 'UTC'), '16 ноября 2026, 14:35');
  assert.equal(vm.diaryDate(Date.parse('2026-11-16T02:05:00Z'), 'UTC'), '16 ноября 2026, 02:05');
  assert.equal(vm.diaryDate(Date.parse('2026-11-16T14:35:07Z'), 'UTC', true), '16 ноября 2026, 14:35:07');
  assert.equal(vm.diaryDate(Date.parse('2026-11-16T22:30:00Z'), 'Asia/Yekaterinburg'), '17 ноября 2026, 03:30');
});
test('календарные границы от исходной даты: февраль, март, DST и четвёртый месяц', () => {
  assert.equal(typeof months.calendarBoundary, 'function');
  const start = Date.parse('2024-01-31T12:00:00Z');
  assert.equal(months.calendarBoundary(start,1,'UTC'), Date.parse('2024-02-29T12:00:00Z'));
  assert.equal(months.calendarBoundary(start,2,'UTC'), Date.parse('2024-03-31T12:00:00Z'));
  assert.equal(months.calculateRingProgress(start,Date.parse('2024-05-31T12:00:00Z'),'UTC').months,4);
  assert.equal(months.calendarBoundary(Date.parse('2024-02-10T17:00:00Z'),1,'America/New_York'),Date.parse('2024-03-10T16:00:00Z'));
});
