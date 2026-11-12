// Регресс владельца 2026-11-12: на новом устройстве (чистый localStorage)
// счётчики каза остаются стартовыми 305/306/306/305/305 (DEFAULT_QAZA) вместо
// серверных.
//
// Причина — не «мердж не умеет qaza», а глобальный флаг pending:
//   • scheduleSync() взводит syncPending на любое событие, включая 'online'
//     (правки нет вовсе);
//   • cloudSnapshotWins() при pending отвергает ВЕСЬ серверный снимок;
//   • догоняющий PUT идёт через mergeCloudIntoLocal(), который при pending
//     пропускает все конвертные разделы — qaza остаётся дефолтом, а
//     syncBody() публикует его как голый объект (метки записи на чистом
//     устройстве нет), затирая серверный конверт {v, ts}.
//
// Контракт: pending защищает только раздел, у которого есть НЕОТПРАВЛЕННАЯ
// локальная правка (метка записи section-writes). Раздел без такой метки —
// дефолт первого запуска, а не правка, — обязан принять серверный конверт.
// 'online' не правка и не должен взводить pending.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCloudIntoLocal } from '../js/sync/merge.js';
import { loadApp } from './helpers/load-app.mjs';

const QAZA_KEY = 'youplanner.qaza';
const LOCAL_TS = 1000;
const CLOUD_TS = 5000;

// Серверный qaza-A «айфона»: заведомо не дефолт (дефолт 305/306/306/305/305).
const QAZA_A = {
  version: 3,
  cursor: 1,
  remaining: { fajr: 11, zuhr: 22, asr: 33, maghrib: 44, isha: 55 },
  history: [],
};

function baseLocalQaza() {
  return {
    version: 3,
    cursor: 3,
    remaining: { fajr: 305, zuhr: 306, asr: 306, maghrib: 305, isha: 305 },
    history: [],
  };
}

function cloudWithQaza() {
  return {
    updatedAt: CLOUD_TS,
    sectionTs: { qaza: CLOUD_TS },
    habits: [{ id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null }],
    records: {},
    qaza: { v: QAZA_A, ts: CLOUD_TS },
    prayer: null,
    fast: null,
    qazaLog: null,
    sleep: null,
    schedule: null,
    archive: null,
    tombstones: {},
  };
}

function cloudMerge(localQaza, opts) {
  const local = {
    habits: [],
    records: {},
    qaza: localQaza,
    prayer: {},
    fast: null,
    qazaLog: null,
    sleep: null,
    schedule: { weekday: [], weekend: [], fasting: [], physical: [] },
    archive: null,
    tombstones: {},
  };
  return mergeCloudIntoLocal(local, cloudWithQaza(), Object.assign({
    pending: true,
    localTs: LOCAL_TS,
  }, opts));
}

// ── Слияние: pending не защищает раздел, которого локально не правили ──────

test('pending без локальной метки записи: серверный конверт qaza побеждает', () => {
  const merged = cloudMerge(baseLocalQaza());
  assert.deepEqual(merged.qaza, QAZA_A,
    'дефолт первого запуска не должен перекрывать серверный qaza');
});

test('pending с локальной меткой записи: неотправленная правка qaza не теряется', () => {
  const merged = cloudMerge(baseLocalQaza(), { sectionWrites: { qaza: LOCAL_TS + 500 } });
  assert.deepEqual(merged.qaza, baseLocalQaza(),
    'правку, которой сервер не видел, слияние обязано сохранить');
});

test('pending: серверный журнал qaza применяется, если локального журнала нет', () => {
  const cloud = cloudWithQaza();
  cloud.qazaLog = { version: 1, since: '2026-11-01', entries: [] };
  const local = {
    habits: [], records: {}, qaza: baseLocalQaza(), prayer: {}, fast: null,
    qazaLog: null, sleep: null,
    schedule: { weekday: [], weekend: [], fasting: [], physical: [] },
    archive: null, tombstones: {},
  };
  const merged = mergeCloudIntoLocal(local, cloud, { pending: true, localTs: LOCAL_TS });
  assert.deepEqual(merged.qazaLog, cloud.qazaLog,
    'на чистом устройстве журнала нет — серверный обязан приехать');
});

// ── Интеграция: чистый старт + pending + обмен ─────────────────────────────

function mockCloud(serverRef) {
  const calls = [];
  function response(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }
  const fetchImpl = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (url.includes('-planner')) return response(null);
    if (url.includes('backups')) return response([]);
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      calls.push({ method, url, body });
      serverRef.snapshot = body;
      return response(null);
    }
    calls.push({ method, url });
    return response(serverRef.snapshot);
  };
  return { fetchImpl, calls };
}

test('чистое устройство: pending-правка в другом разделе не затирает серверный qaza и не портит сервер', async () => {
  const serverRef = { snapshot: cloudWithQaza() };
  const { fetchImpl, calls } = mockCloud(serverRef);
  const app = loadApp({ fetchImpl });

  // Первый запуск: дефолт пишется под saveNormalized — метки записи нет.
  app.context.loadQaza();
  assert.equal(app.sandbox.localStorage.getItem('youplanner.sync.section-writes'), null,
    'стартовая запись дефолта не должна ставить метку раздела');

  // Пользователь успел что-то сделать до первой сверки (или сеть мигнула):
  // pending взведён, но qaza локально не правили.
  app.run('markSyncPending()');

  // Ручная сверка при pending отвергает снимок целиком — так и задумано.
  await app.context.syncFromCloud();

  // Догоняющая отправка (её ставит сам pending) обязана слить qaza с сервера.
  await app.context.syncToCloud();

  const local = JSON.parse(app.sandbox.localStorage.getItem(QAZA_KEY));
  assert.deepEqual(local, QAZA_A,
    'после отправки локальный qaza обязан стать серверным');

  const put = calls.filter((c) => c.method === 'PUT').pop();
  assert.ok(put, 'PUT не ушёл');
  assert.deepEqual(put.body.qaza, { v: QAZA_A, ts: CLOUD_TS },
    'PUT обязан сохранить серверный конверт qaza, а не опубликовать голый дефолт');
});

test('online не взводит pending: событие сети — не правка данных', () => {
  // Слушатель 'online' навешивается на загрузке модуля (app.js), init не нужен.
  const app = loadApp();
  assert.equal(app.run('syncPending'), false);
  app.dispatchWindowEvent('online');
  assert.equal(app.run('syncPending'), false,
    'online без локальной правки не должен запирать серверный снимок');
});
