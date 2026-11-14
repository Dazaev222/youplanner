// Тесты B4 (ТЗ Mobile Harness V2, §1.B4): ошибки writeStaged, ETag и локальных
// часов в CAS-цикле условной записи (js/sync/sync.js: syncToCloudNow и
// publishPlannerSnapshot).
//
// Дефект (аудит ТЗ V2, 2026-11-14): в 412-ветке CAS-цикла результат
// applyMergedFromCloud(refetch) игнорировался. При отказе записи
// (QuotaExceededError) слияние молча не применялось (merge-engine выходил
// обычным return), fetchCloudNode к этому моменту обновлял lastCloudEtag,
// тело следующего PUT перечитывало хранилище со СТАРЫМ состоянием — и сервер
// затирался устаревшим снимком с НОВОЙ If-Match, а обмен рапортовал об
// успехе (sync.ts сдвинут, pending сброшен). Тот же класс дефекта — в цикле
// публикации planner-узла (applyPlannerNodeFromCloud игнорировался) и в
// разрешении конфликта по локальным часам: часы, стоящие далеко впереди,
// делали сверку «сервер не новее последней сверки» ложной, и перечитанный
// после 412 авторитетный снимок отбрасывался только из-за updatedAt.
//
// RED на коде без фикса: тесты A (отказ записи), B (часы вперёд) и D
// (planner-цикл) падают на «успешный PUT со старым телом». Тесты C1/C2 —
// приёмка-регрессия: повторные 412 и отказ чтения сходятся и на старом коде.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const HABITS_KEY = 'youplanner.habits';
const RECORDS_KEY = 'youplanner.records';
const SYNC_TS_KEY = 'youplanner.sync.ts';
const OWNER_KEY = 'youplanner.fb.owner';
const ENVELOPE_KEY = 'youplanner.planner.v1';

function habit(id, name) {
  return { id: id, name: name, type: 'boolean' };
}

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

// «Чужое устройство»: снимок, который оказывается на сервере между нашим GET
// и нашим PUT — источник 412. updatedTs — его собственные часы (по умолчанию
// нормальные).
function foreignSnapshot(updatedTs, habits, records) {
  const ts = updatedTs === undefined ? 5000 : updatedTs;
  return {
    habits: habits || [habit('fx', 'ЧУЖАЯ-ПРИВЫЧКА')],
    records: records || { '2026-11-14': { fx: true } },
    updatedAt: ts,
    sectionTs: { habits: ts, records: ts },
  };
}

// Локальное состояние: своя привычка и своя запись за другой день.
function seedLocal(app) {
  assert.equal(app.context.saveHabits([habit('hA', 'МОЯ-ПРИВЫЧКА')]), true);
  assert.equal(app.context.saveRecords({ '2026-11-10': { hA: true } }), true);
  app.sandbox.localStorage.setItem(SYNC_TS_KEY, '1');
}

function seedOwner(app) {
  app.sandbox.localStorage.setItem(
    OWNER_KEY,
    JSON.stringify({ email: 'o@e', uid: 'uid-A' }),
  );
}

// «Переполненный localStorage»: setItem бросает QuotaExceededError, когда в
// значении встречается маркер — содержимое, которое приносит только слитый
// снимок чужой правки. Состояние хранилища при этом остаётся прежним: ровно
// так ведёт себя настоящая квота (запись не проходит частично).
function armQuota(app, marker) {
  const storage = app.sandbox.localStorage;
  const real = storage.setItem;
  const state = { armed: true };
  storage.setItem = function (key, value) {
    if (state.armed && String(value).indexOf(marker) !== -1) {
      const err = new Error('достигнут лимит localStorage (тест)');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return real.call(storage, key, value);
  };
  state.disarm = function () {
    state.armed = false;
    storage.setItem = real;
  };
  return state;
}

function countStorageErrors(app) {
  return app.run('window.__b4StorageErrors');
}

function watchStorageErrors(app) {
  app.run('window.__b4StorageErrors = 0; ' +
    'bus.on("storage:error", function () { window.__b4StorageErrors += 1; });');
}

function rootPutAttempts(fetchImpl) {
  return fetchImpl.calls.filter(function (c) {
    return c.method === 'PUT' && c.url.includes('firebaseio.com') &&
      !c.url.includes('backups') && !c.url.includes('-planner');
  });
}

function plannerPutAttempts(fetchImpl) {
  return fetchImpl.calls.filter(function (c) {
    return c.method === 'PUT' && c.url.includes('-planner');
  });
}

// Поллинг вместо одного длинного sleep: условие проверяем часто, как только
// выполнено — выходим. Таймаут — страховка от вечного ожидания на красном коде.
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = predicate();
  while (!last && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = predicate();
  }
  return last;
}

// Мок Firebase с честной условной записью: GET отдаёт ETag, PUT со свежим
// If-Match пишет узел и возвращает новую метку, PUT с чужой меткой — 412.
// rootConflicts/plannerConflicts: первые N PUT узла имитируют «чужое
// устройство успело записать между нашим GET и PUT» — на сервер ложится
// очередной снимок из foreignRoot/foreignPlanner, клиенту отвечает 412.
// failRootGet: сколько следующих GET корня ронять сетевой ошибкой.
function makeCasFetch(cfg) {
  const options = cfg || {};
  const calls = [];
  const nodes = {
    root: { data: null, etag: 'etag-root-0' },
    planner: { data: null, etag: 'etag-planner-0' },
    backups: { data: null, etag: 'etag-backups-0' },
  };
  let seq = 0;
  const state = {
    rootConflicts: options.rootConflicts || 0,
    plannerConflicts: options.plannerConflicts || 0,
    failRootGet: options.failRootGet || 0,
  };
  const foreignRoot = Array.isArray(options.foreignRoot)
    ? options.foreignRoot.slice()
    : (options.foreignRoot ? [options.foreignRoot] : []);
  const foreignPlanner = Array.isArray(options.foreignPlanner)
    ? options.foreignPlanner.slice()
    : (options.foreignPlanner ? [options.foreignPlanner] : []);
  const okRootPuts = [];
  const okPlannerPuts = [];
  let conflictsGiven = 0;

  function etagHeaders(node) {
    return { get: function (name) { return String(name).toLowerCase() === 'etag' ? node.etag : null; } };
  }

  function respond(url, opts) {
    const method = (opts && opts.method) || 'GET';
    const headers = (opts && opts.headers) || {};
    calls.push({ url: String(url), method: method, headers: headers, body: opts && opts.body });
    const isPlanner = String(url).indexOf('-planner') !== -1;
    const isBackups = String(url).indexOf('-backups') !== -1;
    const node = isPlanner ? nodes.planner : isBackups ? nodes.backups : nodes.root;

    if (method === 'GET') {
      // failRootGet роняет только GET, пришедший ПОСЛЕ конфликта 412 —
      // то есть именно перечитывание из ветки 412 (сверочный GET до PUT
      // всегда проходит)
      if (!isPlanner && !isBackups && state.failRootGet > 0 && conflictsGiven > 0) {
        state.failRootGet -= 1;
        return Promise.reject(new Error('сеть отвалилась (тест)'));
      }
      // shallow-список ключей бэкапов: пустой узел — null
      if (isBackups) {
        return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(null); } });
      }
      return Promise.resolve({
        ok: true, status: 200, headers: etagHeaders(node),
        json: function () { return Promise.resolve(node.data); },
      });
    }

    // PUT: копия в бэкапы — безусловная, её условность не предмет теста
    if (isBackups) {
      node.data = JSON.parse(opts.body);
      node.etag = 'etag-backups-' + (++seq);
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(null); } });
    }

    if (isPlanner) {
      if (state.plannerConflicts > 0) {
        state.plannerConflicts -= 1;
        nodes.planner.data = foreignPlanner.shift() || null;
        nodes.planner.etag = 'etag-planner-' + (++seq);
        if (typeof options.onPlannerConflict === 'function') options.onPlannerConflict();
        return Promise.resolve({ ok: false, status: 412, json: function () { return Promise.resolve({ error: 'conflict' }); } });
      }
      const ifMatch = headers['If-Match'];
      if (ifMatch !== undefined && ifMatch !== nodes.planner.etag) {
        return Promise.resolve({ ok: false, status: 412, json: function () { return Promise.resolve({ error: 'conflict' }); } });
      }
      nodes.planner.data = JSON.parse(opts.body);
      nodes.planner.etag = 'etag-planner-' + (++seq);
      okPlannerPuts.push({ body: nodes.planner.data, ifMatch: ifMatch === undefined ? null : ifMatch });
      return Promise.resolve({
        ok: true, status: 200, headers: etagHeaders(nodes.planner),
        json: function () { return Promise.resolve(null); },
      });
    }

    // Корневой PUT
    if (state.rootConflicts > 0) {
      state.rootConflicts -= 1;
      conflictsGiven += 1;
      nodes.root.data = foreignRoot.shift() || null;
      nodes.root.etag = 'etag-root-' + (++seq);
      return Promise.resolve({ ok: false, status: 412, json: function () { return Promise.resolve({ error: 'conflict' }); } });
    }
    const ifMatch = headers['If-Match'];
    if (ifMatch !== undefined && ifMatch !== nodes.root.etag) {
      return Promise.resolve({ ok: false, status: 412, json: function () { return Promise.resolve({ error: 'conflict' }); } });
    }
    nodes.root.data = JSON.parse(opts.body);
    nodes.root.etag = 'etag-root-' + (++seq);
    okRootPuts.push({ body: nodes.root.data, ifMatch: ifMatch === undefined ? null : ifMatch });
    return Promise.resolve({
      ok: true, status: 200, headers: etagHeaders(nodes.root),
      json: function () { return Promise.resolve(null); },
    });
  }
  respond.calls = calls;
  respond.nodes = nodes;
  respond.okRootPuts = okRootPuts;
  respond.okPlannerPuts = okPlannerPuts;
  respond.state = state;
  return respond;
}

// ── A. Отказ записи слияния в 412-ветке ─────────────────────────────────────
// PUT → 412 → перечитывание (новая ETag) → слияние не сохраняется (квота) →
// повторный PUT старого тела с новой If-Match запрещён; ложного «синхронизи-
// ровано» нет; частичная запись откатывается; после снятия квоты обмен
// сходится к слитому состоянию.
test('A. 412 → отказ записи слияния: PUT старого снимка с новой ETag не уходит, ложного успеха нет', async () => {
  const fetchImpl = makeCasFetch({ rootConflicts: 1, foreignRoot: foreignSnapshot() });
  const app = loadApp({ fetchImpl });
  app.context.setCASRetryBaseMs(30);
  watchStorageErrors(app);
  seedLocal(app);
  app.run('markSyncPending()');
  // Квота бьёт по разделу записей: запись привычек (первый ключ stage)
  // проходит, запись записей падает — частичная запись, которую обязан
  // откатить writeStaged
  const quota = armQuota(app, '2026-11-14');
  const habitsBefore = app.sandbox.localStorage.getItem(HABITS_KEY);
  const recordsBefore = app.sandbox.localStorage.getItem(RECORDS_KEY);
  assert.ok(habitsBefore && recordsBefore);

  await app.context.syncToCloud();

  // 1) корневой PUT был один (тот самый 412), успешных нет
  assert.equal(rootPutAttempts(fetchImpl).length, 1,
    'после отказа слияния уехал повторный корневой PUT: попыток ' +
    rootPutAttempts(fetchImpl).length);
  assert.equal(fetchImpl.okRootPuts.length, 0,
    'сервер затёрт устаревшим снимком: успешных корневых PUT ' +
    fetchImpl.okRootPuts.length);

  // 2) частичная запись откатилась: хранилище в прежнем согласованном виде
  assert.equal(app.sandbox.localStorage.getItem(HABITS_KEY), habitsBefore,
    'записанная до сбоя привычка не откатилась');
  assert.equal(app.sandbox.localStorage.getItem(RECORDS_KEY), recordsBefore,
    'локальные записи изменились');

  // 3) ложного «синхронизировано» нет: метка сверки не сдвинута, pending стоит
  assert.equal(app.sandbox.localStorage.getItem(SYNC_TS_KEY), '1',
    'SYNC_TS сдвинут несостоявшимся обменом');
  assert.equal(app.run('syncPending'), true, 'pending сброшен без успешного PUT');

  // 4) ошибка видна: storage:error дошёл до шины
  assert.ok(countStorageErrors(app) >= 1,
    'storage:error не emitted при отказе записи слияния');

  // 5) фоновые ретраи при той же квоте тоже не уезжают старым телом
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fetchImpl.okRootPuts.length, 0,
    'фоновый ретрай отправил PUT старого снимка при неработающем хранилище');

  // 6) квота отпущена — обмен сходится к слитому состоянию: и своё, и чужое
  quota.disarm();
  await app.context.syncToCloud();
  assert.equal(fetchImpl.okRootPuts.length, 1, 'после снятия квоты успешного PUT нет');
  const body = fetchImpl.okRootPuts[0].body;
  const habitNames = (body.habits || []).map(function (h) { return h.name; });
  assert.ok(habitNames.indexOf('МОЯ-ПРИВЫЧКА') !== -1, 'своя привычка потерялась: ' + habitNames);
  assert.ok(habitNames.indexOf('ЧУЖАЯ-ПРИВЫЧКА') !== -1, 'чужая привычка потерялась: ' + habitNames);
  assert.ok(body.records && body.records['2026-11-14'], 'чужая запись не доехала в PUT');
  assert.ok(body.records && body.records['2026-11-10'], 'своя запись потерялась в PUT');
  assert.notEqual(app.sandbox.localStorage.getItem(SYNC_TS_KEY), '1',
    'успешный обмен не сдвинул метку сверки');
  assert.equal(app.run('syncPending'), false, 'успешный обмен не снял pending');

  // страховка: погасить фоновый дожим, если его взвёл кто-то из обменов
  app.run('if (casRetryTimer) { clearTimeout(casRetryTimer); casRetryTimer = null; }');
});

// ── B. Локальные часы далеко впереди ────────────────────────────────────────
// syncTs огромный (часы устройства ушли вперёд), сервер между GET и PUT
// получил независимую правку с ОБЫЧНОЙ меткой → 412. Перечитанный снимок —
// авторитетный: слияние обязано пройти, несмотря на updatedAt <= syncTs.
test('B. 412 при часах далеко впереди: перечитанный снимок сливается, не отбрасывается по updatedAt', async () => {
  const now = Date.now();
  const fetchImpl = makeCasFetch({
    rootConflicts: 1,
    foreignRoot: foreignSnapshot(now),
  });
  const app = loadApp({ fetchImpl });
  app.context.setCASRetryBaseMs(30);
  seedLocal(app);
  // Часы «ушли вперёд» задолго до этого обмена: метка сверки на 5 лет впереди
  app.sandbox.localStorage.setItem(SYNC_TS_KEY, String(now + 5 * 365 * 24 * 3600 * 1000));

  await app.context.syncToCloud();

  assert.equal(fetchImpl.okRootPuts.length, 1,
    'успешных корневых PUT: ' + fetchImpl.okRootPuts.length +
    ' (ожидается один — со слитым телом)');
  const body = fetchImpl.okRootPuts[0].body;
  const habitNames = (body.habits || []).map(function (h) { return h.name; });
  assert.ok(habitNames.indexOf('ЧУЖАЯ-ПРИВЫЧКА') !== -1,
    'авторитетный снимок отброшен из-за updatedAt: чужой привычки в PUT нет (' +
    habitNames.join(', ') + ')');
  assert.ok(habitNames.indexOf('МОЯ-ПРИВЫЧКА') !== -1,
    'своя привычка потерялась при разрешении конфликта');
  assert.ok(body.records && body.records['2026-11-14'],
    'чужая запись потерялась при разрешении конфликта');
});

// B2. Зеркальный случай (часы позади) — регрессионная страховка: слияние
// обязано пройти и здесь.
test('B2. 412 при часах далеко позади: перечитанный снимок сливается', async () => {
  const fetchImpl = makeCasFetch({
    rootConflicts: 1,
    foreignRoot: foreignSnapshot(Date.now()),
  });
  const app = loadApp({ fetchImpl });
  app.context.setCASRetryBaseMs(30);
  seedLocal(app); // syncTs = 1 — далеко позади чужих часов
  app.run('markSyncPending()');

  await app.context.syncToCloud();

  assert.equal(fetchImpl.okRootPuts.length, 1);
  const body = fetchImpl.okRootPuts[0].body;
  const habitNames = (body.habits || []).map(function (h) { return h.name; });
  assert.ok(habitNames.indexOf('ЧУЖАЯ-ПРИВЫЧКА') !== -1,
    'чужой привычки в успешном PUT нет');
  assert.ok(habitNames.indexOf('МОЯ-ПРИВЫЧКА') !== -1, 'своя привычка потерялась');
  app.run('if (casRetryTimer) { clearTimeout(casRetryTimer); casRetryTimer = null; }');
});

// ── C. Приёмка: повторные 412 и отказ чтения ────────────────────────────────
test('C1. Повторные 412: два конфликта подряд — успешный PUT несёт обе чужие правки', async () => {
  const now = Date.now();
  const fetchImpl = makeCasFetch({
    rootConflicts: 2,
    foreignRoot: [
      foreignSnapshot(now - 1000, [habit('fx1', 'ЧУЖАЯ-ПЕРВАЯ')]),
      foreignSnapshot(now, [habit('fx1', 'ЧУЖАЯ-ПЕРВАЯ'), habit('fx2', 'ЧУЖАЯ-ВТОРАЯ')]),
    ],
  });
  const app = loadApp({ fetchImpl });
  app.context.setCASRetryBaseMs(30);
  seedLocal(app);

  await app.context.syncToCloud();

  assert.equal(rootPutAttempts(fetchImpl).length, 3,
    'за обмен должно уйти три PUT (2×412 + успех): ' + rootPutAttempts(fetchImpl).length);
  assert.equal(fetchImpl.okRootPuts.length, 1);
  const body = fetchImpl.okRootPuts[0].body;
  const habitNames = (body.habits || []).map(function (h) { return h.name; });
  for (const name of ['МОЯ-ПРИВЫЧКА', 'ЧУЖАЯ-ПЕРВАЯ', 'ЧУЖАЯ-ВТОРАЯ']) {
    assert.ok(habitNames.indexOf(name) !== -1,
      'в теле успешного PUT нет «' + name + '»: ' + habitNames.join(', '));
  }
  assert.notEqual(app.sandbox.localStorage.getItem(SYNC_TS_KEY), '1');
});

test('C2. Отказ перечитывания после 412: PUT вслепую не уходит, обмен провален честно', async () => {
  const fetchImpl = makeCasFetch({
    rootConflicts: 1,
    failRootGet: 1,
    foreignRoot: [foreignSnapshot()],
  });
  const app = loadApp({ fetchImpl });
  // Базу ретрая НЕ ускоряем: немедленные проверки ниже обязаны уложиться
  // до первого фонового дожима (1 с), чтобы считать именно тот же обмен
  seedLocal(app);
  app.run('markSyncPending()');

  await app.context.syncToCloud();

  assert.equal(rootPutAttempts(fetchImpl).length, 1,
    'после отказавшего перечитывания ушёл повторный PUT');
  assert.equal(fetchImpl.okRootPuts.length, 0, 'PUT вслепую достиг сервера');
  assert.equal(app.sandbox.localStorage.getItem(SYNC_TS_KEY), '1',
    'SYNC_TS сдвинут несостоявшимся обменом');
  assert.equal(app.run('syncPending'), true, 'pending сброшен без успешного PUT');

  // Сеть восстановилась — дожим сходится через новое чтение/слияние
  const ok = await waitFor(function () {
    return fetchImpl.okRootPuts.length === 1;
  }, 3000);
  assert.ok(ok, 'после восстановления сети обмен не сошёлся');
  const habitNames = (fetchImpl.okRootPuts[0].body.habits || []).map(function (h) { return h.name; });
  assert.ok(habitNames.indexOf('ЧУЖАЯ-ПРИВЫЧКА') !== -1,
    'повторившийся обмен ушёл без слитого состояния');
  app.run('if (casRetryTimer) { clearTimeout(casRetryTimer); casRetryTimer = null; }');
});

// ── D. Тот же класс дефекта в CAS-цикле публикации planner-узла ─────────────
test('D. planner-узел: 412 → отказ записи слияния → PUT старого конверта с новой ETag не уходит', async () => {
  const foreign1 = {
    schemaVersion: 1,
    entries: {
      fx: { id: 'fx', fields: { title: { value: 'ЧУЖАЯ-ЗАДАЧА', version: { counter: 9, actorId: 'devB' } } } },
    },
    settings: {},
    tombstones: {},
  };
  const foreign2 = {
    schemaVersion: 1,
    entries: Object.assign({}, foreign1.entries, {
      fy: { id: 'fy', fields: { title: { value: 'ЧУЖАЯ-ВТОРАЯ', version: { counter: 9, actorId: 'devB' } } } },
    }),
    settings: {},
    tombstones: {},
  };
  const fetchImpl = makeCasFetch({
    // Два конфликта: первый 412 приносит foreign1 (слияние проходит), второй
    // — foreign2 с «ЧУЖАЯ-ВТОРАЯ»: именно на слиянии перечитанного после
    // 412 узла квота бьёт по записи конверта. Один конфликт не даёт такого
    // сценария: перечитанный узел (foreign1) сливается без отказа, и цикл
    // законно публикует объединение.
    plannerConflicts: 2,
    foreignPlanner: [foreign1, foreign2],
  });
  const app = loadApp({ fetchImpl });
  app.context.setCASRetryBaseMs(30);
  watchStorageErrors(app);
  seedOwner(app);
  app.sandbox.localStorage.setItem(SYNC_TS_KEY, '1');
  assert.equal(app.context.saveTasks([mkTask('t1')]), true, 'saveTasks не удался');
  const envBefore = JSON.parse(app.sandbox.localStorage.getItem(ENVELOPE_KEY));
  assert.ok(envBefore.outbox.length >= 1, 'outbox пуст ещё до обмена');
  // Квота бьёт по записи конверта, когда в нём появляется «ЧУЖАЯ-ВТОРАЯ» —
  // то есть только на слиянии перечитанного после 412 узла
  const quota = armQuota(app, 'ЧУЖАЯ-ВТОРАЯ');

  await app.context.syncToCloud();

  // 1) повторный PUT старого конверта не ушёл: успешных planner-PUT нет.
  // Два конфликта 412 — ровно две попытки, обе отказали; после отказа записи
  // слияния третьей попытки (уже старым телом с новой If-Match) быть не должно
  assert.equal(plannerPutAttempts(fetchImpl).length, 2,
    'planner-цикл уехал повторным PUT после отказа слияния: попыток ' +
    plannerPutAttempts(fetchImpl).length);
  assert.equal(fetchImpl.okPlannerPuts.length, 0,
    'planner-узел затёрт старым конвертом с новой ETag');

  // 2) outbox не подтверждён без успешного CAS
  let envAfter = JSON.parse(app.sandbox.localStorage.getItem(ENVELOPE_KEY));
  assert.equal(envAfter.outbox.length, envBefore.outbox.length,
    'outbox опустошён без успешного CAS planner-узла');

  // 3) фоновые ретраи тоже молчат, пока хранилище отказывает
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fetchImpl.okPlannerPuts.length, 0,
    'фоновый ретрай отправил planner-PUT старого конверта');
  envAfter = JSON.parse(app.sandbox.localStorage.getItem(ENVELOPE_KEY));
  assert.equal(envAfter.outbox.length, envBefore.outbox.length,
    'outbox опустошён фоновым ретраем');

  // 4) квота отпущена — публикация сходится к полному слиянию
  quota.disarm();
  await app.context.syncToCloud();
  assert.equal(fetchImpl.okPlannerPuts.length, 1, 'после снятия квоты успешного planner-PUT нет');
  const entries = Object.keys(fetchImpl.okPlannerPuts[0].body.entries || {});
  for (const id of ['t1', 'fx', 'fy']) {
    assert.ok(entries.indexOf(id) !== -1,
      'в опубликованном снимке нет записи «' + id + '»: ' + entries.join(', '));
  }
  const envFinal = JSON.parse(app.sandbox.localStorage.getItem(ENVELOPE_KEY));
  assert.equal(envFinal.outbox.length, 0, 'outbox не подтверждён после успешного CAS');
  assert.ok(countStorageErrors(app) >= 1, 'storage:error не emitted при отказе записи');

  app.run('if (casRetryTimer) { clearTimeout(casRetryTimer); casRetryTimer = null; }');
});
