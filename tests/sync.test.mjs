// Тесты синхронизации: single-flight вокруг syncToCloud.
//
// Аудит 2026-10-23: флаг syncing защищал только синхронные участки, но не
// держался во время await fetch. Два параллельных обмена (debounce-таймер +
// уход со вкладки) konkурирующе делали GET→PUT узла бэкапов — терялись
// записи истории, SYNC_TS мог уехать назад. Ожидание: обмены строго
// последовательны, правка во время обмена доезжает повторным обменом.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

function makeFetch() {
  const calls = [];
  let active = 0;
  let maxActive = 0;

  function responseBody(url, method) {
    if (method === 'GET' && String(url).includes('backups')) return [];
    if (method === 'GET') return {};
    return {};
  }

  function fetchImpl(url, opts = {}) {
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: String(url), method });
    active += 1;
    if (active > maxActive) maxActive = active;
    return Promise.resolve().then(() => {
      active -= 1;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(responseBody(url, method)),
      };
    });
  }

  fetchImpl.stats = {
    calls,
    get maxActive() { return maxActive; },
    mainPuts: () => calls.filter(function (c) {
      return c.method === 'PUT' && c.url.includes('firebaseio.com') &&
        !c.url.includes('backups');
    }).length,
    mainGets: () => calls.filter(function (c) {
      return c.method === 'GET' && c.url.includes('firebaseio.com') &&
        !c.url.includes('backups');
    }).length,
  };
  return fetchImpl;
}

test('одиночная отправка делает один PUT и пишет метку времени', async () => {
  const fetchImpl = makeFetch();
  const { context, sandbox } = loadApp({ fetchImpl });
  await context.syncToCloud();
  assert.equal(fetchImpl.stats.mainPuts(), 1);
  assert.ok(sandbox.localStorage.getItem('youplanner.sync.ts'),
    'SYNC_TS не записан');
});

test('параллельные вызовы не перекрываются: обмены строго по одному', async () => {
  const fetchImpl = makeFetch();
  const { context } = loadApp({ fetchImpl });

  const first = context.syncToCloud();
  const second = context.syncToCloud();
  await Promise.all([first, second]);
  // очередь разбирается в микрозадачах; даём им доджойниться
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(fetchImpl.stats.maxActive, 1,
    'обмены с сервером выполнялись параллельно');
});

test('вызов во время обмена доезжает повторным обменом, а не теряется', async () => {
  const fetchImpl = makeFetch();
  const { context } = loadApp({ fetchImpl });

  const first = context.syncToCloud();
  context.syncToCloud(); // «правка» пришла, пока первый обмен в полёте
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(fetchImpl.stats.mainGets(), 2,
    'повторный обмен после очереди не состоялся');
  assert.equal(fetchImpl.stats.mainPuts(), 2);
});
