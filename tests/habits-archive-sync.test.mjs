// Архив привычек в синхронизации: пара состояния и версии сливается
// независимо от того, чьи остальные поля победили. Проверяются обе
// перестановки, legacy-снимок, версии/actorId, повреждённая пара,
// идемпотентность, tombstone и фактический PUT без рабочей сети.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCloudIntoLocal, mergeHabitsById } from '../js/sync/merge.js';
import { validCloudHabits } from '../js/sync/core.js';
import { loadApp } from './helpers/load-app.mjs';
import { habit } from './helpers/fixtures.mjs';

const LOCAL_TS = 1000;
const CLOUD_TS = 5000;

function pair(counter, actorId) {
  return { counter, actorId };
}

function archived(id, counter, actorId, extra) {
  return habit(Object.assign({
    id,
    isArchived: true,
    archiveVersion: pair(counter, actorId),
  }, extra || {}));
}

function localBase(habits) {
  return {
    habits,
    records: {},
    tombstones: {},
    qaza: null,
    prayer: null,
    fast: null,
    qazaLog: null,
    sleep: null,
    schedule: null,
    archive: null,
  };
}

function cloudBase(habits) {
  return {
    updatedAt: CLOUD_TS,
    sectionTs: { habits: CLOUD_TS },
    habits,
  };
}

test('слияние коммутативно для пары архива при равных версиях', () => {
  const local = [archived('h1', 3, 'dev-a')];
  const cloud = [archived('h1', 3, 'dev-b')];

  const a = mergeHabitsById(local, cloud, true);
  const b = mergeHabitsById(cloud, local, true);

  assert.deepEqual(a[0].isArchived, true);
  assert.deepEqual(a[0].archiveVersion, pair(3, 'dev-b'), 'больший actorId побеждает');
  assert.deepEqual(b[0].archiveVersion, pair(3, 'dev-b'), 'порядок сторон не важен');
});

test('больший counter побеждает независимо от actorId и победителя полей', () => {
  const cloud = [archived('h1', 2, 'zzz', { name: 'Сервер' })];
  const local = [archived('h1', 9, 'aaa', { name: 'Локально' })];

  const merged = mergeHabitsById(local, cloud, true);

  assert.equal(merged[0].name, 'Сервер', 'остальные поля — по cloudWins');
  assert.deepEqual(merged[0].archiveVersion, pair(9, 'aaa'), 'пара — по версии');
  assert.equal(merged[0].isArchived, true);
});

test('legacy-снимок не отменяет версионированный архив при cloudWins=false', () => {
  const local = [archived('h1', 5, 'dev')];
  const cloud = [habit({ name: 'Старое имя' })];

  const merged = mergeHabitsById(local, cloud, false);

  assert.equal(merged[0].name, 'Фаджр', 'локальные поля остаются');
  assert.equal(merged[0].isArchived, true, 'архив не теряется');
  assert.deepEqual(merged[0].archiveVersion, pair(5, 'dev'));
});

test('архив с сервера применяется, даже когда локальные поля побеждают', () => {
  const local = [habit({ name: 'Локально' })];
  const cloud = [archived('h1', 4, 'cloud', { name: 'Сервер' })];

  const merged = mergeHabitsById(local, cloud, false);

  assert.equal(merged[0].name, 'Локально');
  assert.equal(merged[0].isArchived, true);
  assert.deepEqual(merged[0].archiveVersion, pair(4, 'cloud'));
});

test('равная версия и разные флаги: true побеждает', () => {
  const local = [habit({ isArchived: false, archiveVersion: pair(6, 'dev') })];
  const cloud = [habit({ isArchived: true, archiveVersion: pair(6, 'dev') })];

  assert.equal(mergeHabitsById(local, cloud, false)[0].isArchived, true);
  assert.equal(mergeHabitsById(cloud, local, false)[0].isArchived, true);
});

test('повреждённая пара не затирает валидную пару другой стороны', () => {
  const local = [habit({ isArchived: true, archiveVersion: pair(1, 'a') })];
  const cloud = [habit({ isArchived: true, archiveVersion: { counter: 0, actorId: 'a' } })];

  const merged = mergeHabitsById(local, cloud, true);

  assert.equal(merged[0].isArchived, true);
  assert.deepEqual(merged[0].archiveVersion, pair(1, 'a'));
});

test('пара снимается, если обе стороны legacy', () => {
  const merged = mergeHabitsById([habit()], [habit({ name: 'Новое' })], true);
  assert.equal(merged[0].isArchived, undefined);
  assert.equal(merged[0].archiveVersion, undefined);
});

test('слияние идемпотентно и не создаёт новую версию', () => {
  const local = [archived('h1', 2, 'dev')];
  const cloud = [archived('h1', 2, 'dev', { name: 'Имя' })];

  const once = mergeHabitsById(local, cloud, true);
  const twice = mergeHabitsById(once, cloud, true);

  assert.deepEqual(twice, once);
  assert.deepEqual(once[0].archiveVersion, pair(2, 'dev'));
});

test('tombstone не воскрешает архивную привычку', () => {
  const local = [];
  const cloud = [archived('h1', 3, 'dev')];

  const merged = mergeHabitsById(local, cloud, true, {
    tombstones: { h1: CLOUD_TS },
    sectionTs: 0,
  });

  assert.deepEqual(merged, []);
});

test('mergeCloudIntoLocal переносит пару в итоговый снимок', () => {
  const merged = mergeCloudIntoLocal(
    localBase([habit()]),
    cloudBase([archived('h1', 7, 'cloud')]),
    { pending: false, localTs: LOCAL_TS }
  );

  assert.equal(merged.habits[0].isArchived, true);
  assert.deepEqual(merged.habits[0].archiveVersion, pair(7, 'cloud'));
});

test('validCloudHabits принимает legacy и архивные поля, отвергает битую базу', () => {
  assert.equal(validCloudHabits([habit()]), true, 'legacy');
  assert.equal(validCloudHabits([archived('h1', 1, 'dev')]), true, 'архив');
  assert.equal(validCloudHabits([habit({ isArchived: 'true' })]), true,
    'невалидная пара — забота нормализации, база цела');
  assert.equal(validCloudHabits([habit({ type: 'чужой' })]), false);
  assert.equal(validCloudHabits([habit({ id: '' })]), false);
});

test('applyCloudData нормализует пару при записи и сохраняет валидную', () => {
  const app = loadApp();
  const ok = app.context.applyCloudData({
    habits: [
      archived('h1', 2, 'dev'),
      habit({ id: 'h2', name: 'Битый', isArchived: true }),
    ],
  }, Date.now());

  assert.equal(ok, true);
  const stored = JSON.parse(app.sandbox.localStorage.getItem('youplanner.habits'));
  assert.deepEqual(stored[0].archiveVersion, pair(2, 'dev'));
  assert.equal(stored[0].isArchived, true);
  assert.equal(stored[1].isArchived, undefined, 'повреждённая пара снята');
  assert.equal(stored[1].archiveVersion, undefined);
});

test('исходящий PUT содержит архивную пару', async () => {
  const calls = [];
  const fetchImpl = function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: String(url), method, body: (opts && opts.body) || null });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(method === 'GET' ? { updatedAt: 42 } : {}),
      text: () => Promise.resolve(''),
    });
  };
  const app = loadApp({ fetchImpl });
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([
    archived('h1', 4, 'device-a'),
  ]));

  await app.context.syncToCloud();

  const put = calls.find(function (call) {
    return call.method === 'PUT' && call.url.includes('firebaseio.com') &&
      !call.url.includes('backups');
  });
  assert.ok(put, 'корневой PUT должен быть');
  const body = JSON.parse(put.body);
  assert.equal(body.habits[0].isArchived, true);
  assert.deepEqual(body.habits[0].archiveVersion, pair(4, 'device-a'));
});
