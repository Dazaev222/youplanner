// Часы домена (ТЗ §6): внедряемые wall/monotonic, оценка смещения сервера,
// интерполяция внутри сессии и честное качество времени.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClock, syncClock } from '../js/harness/diary/clock.js';

function makeClock(overrides = {}) {
  let wall = 1790000000000;
  let mono = 1000;
  return {
    clock: createClock({
      wallNow: () => wall,
      monotonicNow: () => mono,
      offsetSource: async () => ({ serverOffsetMs: 5000 }),
      staleAfterMs: 60000,
      ...overrides,
    }),
    setWall: (value) => { wall = value; },
    advanceMono: (value) => { mono += value; },
  };
}

test('до синхронизации качество unknown и смещение ноль', () => {
  const { clock } = makeClock();
  assert.equal(clock.now(), 1790000000000);
  const quality = clock.getQuality();
  assert.equal(quality.quality, 'unknown');
  assert.equal(quality.offsetMs, 0);
  assert.equal(quality.lastSyncAtMs, null);
});

test('syncClock применяет серверное смещение', async () => {
  const { clock } = makeClock();
  const result = await syncClock(clock);
  assert.equal(result.ok, true);
  assert.equal(clock.now(), 1790000005000);

  const quality = clock.getQuality();
  assert.equal(quality.quality, 'good');
  assert.equal(quality.offsetMs, 5000);
  assert.equal(quality.lastSyncAtMs, 1790000005000);
});

test('внутри сессии время идёт по monotonic, а не по прыгающим wall-часам', async () => {
  const h = makeClock();
  await syncClock(h.clock);
  h.setWall(1790000000000 + 60 * 60 * 1000); // пользователь перевёл часы на час вперёд
  h.advanceMono(1000);
  assert.equal(h.clock.now(), 1790000001000 + 5000,
    'wall-прыжок не должен влиять на интерполяцию открытой сессии');
});

test('после staleAfterMs качество stale, смещение сохраняется', async () => {
  const h = makeClock();
  await syncClock(h.clock);
  h.advanceMono(60001);
  const quality = h.clock.getQuality();
  assert.equal(quality.quality, 'stale');
  assert.equal(quality.offsetMs, 5000);
  assert.equal(quality.ageMs, 60001);
});

test('syncClock возвращает ONLINE_REQUIRED при недоступном источнике и не врёт о качестве', async () => {
  const clock = createClock({
    wallNow: () => 1000,
    monotonicNow: () => 0,
    offsetSource: async () => { throw new Error('offline'); },
  });
  const result = await syncClock(clock);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ONLINE_REQUIRED');
  assert.equal(clock.getQuality().quality, 'unknown');
});

test('отрицательное смещение допустимо, now не становится NaN', async () => {
  const clock = createClock({
    wallNow: () => 10000,
    monotonicNow: () => 0,
    offsetSource: async () => ({ serverOffsetMs: -3000 }),
  });
  await syncClock(clock);
  assert.equal(clock.now(), 7000);
});
