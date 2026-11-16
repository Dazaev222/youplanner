/* Часы домена (ТЗ §6). Оценка смещения сервера — не криптографическая
   гарантия времени. Внутри открытой сессии время интерполируется по
   monotonic-часам; wall-прыжки не переписывают уже записанные события. */

import { fail, ok, sanitizeMessage } from './errors.js';

const DEFAULT_STALE_AFTER_MS = 120000;

export function createClock({
  wallNow = () => Date.now(),
  monotonicNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  offsetSource = null,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
} = {}) {
  if (typeof wallNow !== 'function' || typeof monotonicNow !== 'function') {
    throw new TypeError('createClock: wallNow/monotonicNow должны быть функциями');
  }

  let offsetMs = 0;
  let lastSyncAtMs = null;
  let lastSyncMono = null;
  let lastSyncWall = null;

  function now() {
    if (lastSyncMono === null || lastSyncWall === null) {
      return wallNow() + offsetMs;
    }
    const elapsed = Math.max(0, monotonicNow() - lastSyncMono);
    return lastSyncWall + offsetMs + elapsed;
  }

  function getQuality() {
    if (lastSyncMono === null || lastSyncAtMs === null) {
      return {
        quality: 'unknown',
        offsetMs,
        lastSyncAtMs: null,
        ageMs: null,
        uncertaintyMs: null,
      };
    }
    const ageMs = Math.max(0, monotonicNow() - lastSyncMono);
    return {
      quality: ageMs > staleAfterMs ? 'stale' : 'good',
      offsetMs,
      lastSyncAtMs,
      ageMs,
      uncertaintyMs: ageMs,
    };
  }

  async function sync() {
    if (typeof offsetSource !== 'function') {
      return fail('ONLINE_REQUIRED', 'Нет источника серверного времени', {
        reason: 'offset-source-missing',
      });
    }
    const wall = wallNow();
    const mono = monotonicNow();
    let source;
    try {
      source = await offsetSource();
    } catch (error) {
      return fail('ONLINE_REQUIRED', sanitizeMessage(error && error.message), {
        reason: 'clock-source-unreachable',
      });
    }
    const nextOffset = typeof source === 'number'
      ? source
      : source && Number.isFinite(source.serverOffsetMs)
        ? source.serverOffsetMs
        : source && Number.isFinite(source.serverNowMs)
          ? source.serverNowMs - wall
          : null;
    if (nextOffset === null || !Number.isFinite(nextOffset)) {
      return fail('ONLINE_REQUIRED', 'Источник времени вернул некорректное смещение');
    }
    offsetMs = nextOffset;
    lastSyncWall = wall;
    lastSyncMono = mono;
    lastSyncAtMs = wall + offsetMs;
    return ok({ offsetMs, nowMs: lastSyncAtMs, quality: getQuality() });
  }

  return { now, getQuality, sync, getOffsetMs: () => offsetMs };
}

/** Синхронизация часов с источником серверного времени. */
export async function syncClock(clock) {
  if (!clock || typeof clock.sync !== 'function') {
    return fail('INVALID_DATA', 'Ожидается часы createClock');
  }
  return clock.sync();
}
