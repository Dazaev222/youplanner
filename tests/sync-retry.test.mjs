// Тесты фонового дожима после исчерпания CAS и при появлении сети.
//
// Баг: два устройства долго конфликтуют (сервер всё время 412). Клиент делает
// ровно PLANNER_CAS_ATTEMPTS попыток за один обмен и сдаётся; следующая
// попытка — только когда человек снова правит (scheduleSync) или перезагружает
// страницу. Сетевой сбой тоже не ретраился: window 'online' в sync-слое никто
// не слушал. Здесь проверяем модульный фоновый retry с экспоненциальным
// backoff: CAS-исчерпание дожимается само, пауза растёт вдвое после второй
// неудачи, 'online' начинает новый обмен немедленно.
//
// Тест A на коде без фонового ретрая падает: после 5 PUT никто не делает
// успешный шестой. Тест C падает: dispatch 'online' не начинает новый обмен.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const ENVELOPE_KEY = 'youplanner.planner.v1';

function mkTask(id, overrides) {
  return Object.assign({
    id: id,
    title: 'Задача ' + id,
    notes: '',
    due: '2026-11-05',
    doDate: null,
    priority: 2,
    done: false,
    doneAt: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    order: 1,
    archived: false,
    schedule: null,
    scheduleUnsupported: false,
    previousOccurrenceId: null,
    generatedAt: null,
  }, overrides || {});
}

function readEnvelope(app) {
  const raw = app.sandbox.localStorage.getItem(ENVELOPE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

// Поллинг вместо одного длинного sleep: условие проверяем часто, как только
// выполнено — выходим. Таймаут — страховка от вечного ожидания на красном коде.
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = predicate();
  while (!last && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    last = predicate();
  }
  return last;
}

function mainPuts(fetchImpl) {
  return fetchImpl.calls.filter(function (c) {
    return c.method === 'PUT' && c.url.includes('firebaseio.com') &&
      !c.url.includes('backups') && !c.url.includes('-planner');
  });
}

function plannerPuts(fetchImpl) {
  return fetchImpl.calls.filter(function (c) {
    return c.method === 'PUT' && c.url.includes('-planner');
  });
}

// Первые 5 PUT в каждом узле — 412, дальше 200. Модель как makeCasServer
// в planner-sync.test.mjs: GET отдаёт ETag, PUT может отказать 412.
function makeCasThenOkFetch(rootConflicts, plannerConflicts) {
  const calls = [];
  let rootPuts = 0;
  let plannerPuts = 0;
  function respond(url, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    const headers = options.headers || {};
    calls.push({ url: String(url), method: method, headers: headers, body: options.body });
    const isBackups = String(url).includes('backups');
    const isPlanner = String(url).includes('-planner');
    if (method === 'GET') {
      if (isBackups) {
        return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve([]); } });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: function (name) { return String(name).toLowerCase() === 'etag' ? 'etag-1' : null; } },
        json: function () { return Promise.resolve({}); },
      });
    }
    if (isBackups) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
    }
    if (isPlanner) {
      plannerPuts += 1;
      if (plannerPuts <= (plannerConflicts || 0)) {
        return Promise.resolve({ ok: false, status: 412, json: function () { return Promise.resolve({ error: 'conflict' }); } });
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
    }
    rootPuts += 1;
    if (rootPuts <= (rootConflicts || 0)) {
      return Promise.resolve({ ok: false, status: 412, json: function () { return Promise.resolve({ error: 'conflict' }); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  }
  respond.calls = calls;
  return respond;
}

// Сеть вниз, потом вверх. Без owner: интересует корневой PUT, а не planner.
// Неудачные запросы в calls НЕ пишем: ассерт «PUT не ушёл при сети вниз»
// должен считывать отсутствие УСПЕШНОГО PUT, а не отсутствие попытки.
function makeFlakyFetch() {
  const calls = [];
  let up = false;
  function fetchImpl(url, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    if (!up) return Promise.reject(new Error('нет сети'));
    calls.push({ url: String(url), method: method });
    if (method === 'GET' && String(url).includes('backups')) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve([]); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  }
  fetchImpl.calls = calls;
  fetchImpl.setUp = function (v) { up = v; };
  return fetchImpl;
}

function seedOwnerAndSyncTs(app) {
  app.sandbox.localStorage.setItem(
    'youplanner.fb.owner',
    JSON.stringify({ email: 'o@e', uid: 'uid-A' }),
  );
  app.sandbox.localStorage.setItem('youplanner.sync.ts', '1');
}

test('A. CAS-исчерпание: фоновый retry сам делает успешный PUT, outbox пустеет без правки человека', async () => {
  const fetchImpl = makeCasThenOkFetch(5, 5);
  const app = loadApp({ fetchImpl });
  // Базу ускоряем, если сеттер уже есть (после фикса): красный прогон на
  // текущем коде подождёт реальную секунду и всё равно не увидит шестой PUT.
  if (typeof app.context.setCASRetryBaseMs === 'function') {
    app.context.setCASRetryBaseMs(150);
  }
  seedOwnerAndSyncTs(app);
  assert.equal(app.context.saveTasks([mkTask('t1')]), true);
  const envBefore = readEnvelope(app);
  assert.ok(envBefore && envBefore.outbox.length >= 1, 'outbox пуст ещё до обмена');

  await app.context.syncToCloud();

  // Один обмен — ровно PLANNER_CAS_ATTEMPTS попыток, дальше сдача
  assert.equal(mainPuts(fetchImpl).length, 5,
    'корневых PUT за первый обмен должно быть ровно 5: ' + mainPuts(fetchImpl).length);
  assert.equal(plannerPuts(fetchImpl).length, 5,
    'planner-PUT за первый обмен должно быть ровно 5: ' + plannerPuts(fetchImpl).length);
  assert.equal(app.sandbox.localStorage.getItem('youplanner.sync.ts'), '1',
    'SYNC_TS двинут на неудачном обмене');
  const envAfterFirst = readEnvelope(app);
  assert.equal(envAfterFirst.outbox.length, envBefore.outbox.length,
    'outbox стёрт без успешного CAS');
  assert.ok(envAfterFirst.outbox.length >= 1);

  // Никакой scheduleSync и никаких правок: дожим должен прийти сам
  const ok = await waitFor(function () {
    return mainPuts(fetchImpl).length > 5 &&
      readEnvelope(app).outbox.length === 0;
  }, 5000);
  assert.ok(ok,
    'фоновый retry не дожал: mainPuts=' + mainPuts(fetchImpl).length +
    ' outbox=' + (readEnvelope(app) || { outbox: [] }).outbox.length);
  assert.ok(mainPuts(fetchImpl).length >= 6, 'успешного корневого PUT не было');
  assert.equal(readEnvelope(app).outbox.length, 0, 'outbox не пуст после дожима');
  assert.notEqual(app.sandbox.localStorage.getItem('youplanner.sync.ts'), '1',
    'успешный PUT не записал новую метку сверки');
});

test('B. Экспоненциальный backoff: после второй неудачи delay = base*2, успех сбрасывает на базу', async () => {
  // База 4000: таймер первого ретрая не успевает сработать, пока тест
  // делает второй обмен и ассерты — мешать не будет
  let networkUp = false;
  const calls = [];
  const fetchImpl = function (url, opts) {
    const options = opts || {};
    const method = options.method || 'GET';
    calls.push({ url: String(url), method: method });
    if (!networkUp) return Promise.reject(new Error('нет сети'));
    if (method === 'GET' && String(url).includes('backups')) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve([]); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  };
  const app = loadApp({ fetchImpl });
  assert.equal(typeof app.context.setCASRetryBaseMs, 'function',
    'нет сеттера базы для тестов');
  app.context.setCASRetryBaseMs(4000);

  await app.context.syncToCloud();
  assert.equal(app.run('casRetryDelay'), 4000,
    'после первой неудачи delay уже удвоился (раньше времени)');
  assert.ok(app.run('casRetryTimer'), 'после первой неудачи таймер не взведён');

  await app.context.syncToCloud();
  assert.equal(app.run('casRetryDelay'), 8000,
    'после второй неудачи delay должен быть base*2');

  networkUp = true;
  await app.context.syncToCloud();
  assert.equal(app.run('casRetryDelay'), 4000, 'успех не сбросил delay на базу');
  assert.equal(app.run('casRetryTimer'), null, 'успех не погасил таймер');
});

test('B2. Успешный обмен не взводит фоновый retry', async () => {
  const fetchImpl = makeCasThenOkFetch(0, 0);
  const app = loadApp({ fetchImpl });
  if (typeof app.context.setCASRetryBaseMs === 'function') {
    app.context.setCASRetryBaseMs(150);
  }
  seedOwnerAndSyncTs(app);
  assert.equal(app.context.saveTasks([mkTask('t1')]), true);

  await app.context.syncToCloud();

  assert.equal(mainPuts(fetchImpl).length, 1);
  assert.equal(app.run('casRetryTimer'), null, 'успех взвёл фоновый таймер');
  if (typeof app.context.setCASRetryBaseMs === 'function') {
    assert.equal(app.run('casRetryDelay'), 150, 'delay не на базе после успеха');
  }
  // короткая пауза: если таймер всё же взведён, он бы успел
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mainPuts(fetchImpl).length, 1, 'успешный обмен породил лишний фоновый PUT');
});

test('C. online после сетевого сбоя: начинается новый обмен, данные уезжают', async () => {
  const fetchImpl = makeFlakyFetch();
  const app = loadApp({ fetchImpl });
  // init в приложении взводит cloudReady после первой сверки (даже офлайн):
  // без этого немедленный PUT до первой сверки опасен
  app.context.markCloudReady();
  app.sandbox.localStorage.setItem('youplanner.sync.ts', '1');

  await app.context.syncToCloud();
  assert.equal(mainPuts(fetchImpl).length, 0, 'при отказе сети корневой PUT не должен был уйти');
  assert.equal(app.sandbox.localStorage.getItem('youplanner.sync.ts'), '1',
    'SYNC_TS двинут на неудачном обмене');

  fetchImpl.setUp(true);
  app.dispatchWindowEvent('online');

  // Окно меньше SYNC_DEBOUNCE_MS (1500): на текущем коде app.js уже слушает
  // online через scheduleSync — тот сработал бы только через 1.5 с. Фикс
  // обязан начать обмен НЕМЕДЛЕННО, иначе тест красный.
  const ok = await waitFor(function () {
    return mainPuts(fetchImpl).length >= 1 &&
      app.sandbox.localStorage.getItem('youplanner.sync.ts') !== '1';
  }, 900);
  assert.ok(ok, 'после online обмен не начался: mainPuts=' + mainPuts(fetchImpl).length);
  assert.notEqual(app.sandbox.localStorage.getItem('youplanner.sync.ts'), '1',
    'метка сверки не записана после успешного online-обмена');

  // Гасим дебаунс app.js (scheduleSync на том же 'online'): он сделал бы
  // второй обмен через 1.5 с и удерживал бы процесс лишние полторы секунды
  app.run('if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }');
});
