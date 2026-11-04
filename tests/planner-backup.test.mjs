// ТЗ Воркера 1, §1.4.6: версия backup повышается ОТ реально найденной (в
// коде это 11 → 12), экспорт включает plannerV1 с его tombstones и прежние
// разделы привычек/календаря; outbox и device credentials не экспортируются.
// Импорт старой версии — миграция+merge, отсутствие plannerV1 в файле НЕ
// очищает текущий; старый backup не воскрешает удалённые id; некорректный и
// будущий формат отвергается без частичного применения; импорт до первого
// соединения не отправляет замену облака (сначала pull+merge).
//
// Данные синтетические; хранилище и сеть изолированы песочницей loadApp,
// живого Firebase нет.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { defaultBackup } from './helpers/fixtures.mjs';
// BACKUP_VERSION читаем из модуля: в vm-песочнице const-экспорты не ложятся
// на globalThis (только function-объявления), а ESM-импорт бэкапа side-effect
// на загрузке не имеет
import { BACKUP_VERSION, BACKUP_LEGACY_VERSION } from '../js/data/backup.js';

const MATRIX_KEY = 'youplanner.matrix.tasks';
const ENVELOPE_KEY = 'youplanner.planner.v1';

function fld(value, counter, actor) {
  return { value: value, version: { counter: counter, actorId: actor } };
}

function entry(id, fields) {
  return { id: id, fields: fields };
}

function snap(entries, settings, tombstones) {
  return {
    schemaVersion: 1,
    entries: entries || {},
    settings: settings || {},
    tombstones: tombstones || {},
  };
}

function fullFields(title, counter, actor) {
  return {
    title: fld(title, counter, actor),
    notes: fld('', counter, actor),
    priority: fld(2, counter, actor),
    doDate: fld(null, counter, actor),
    order: fld(1, counter, actor),
    archived: fld(false, counter, actor),
    schedule: fld(null, counter, actor),
    completion: fld({ done: false, doneAt: null }, counter, actor),
    provenance: fld({
      createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z',
      generatedAt: null, previousOccurrenceId: null,
    }, counter, actor),
  };
}

function mkTask(id, overrides) {
  return Object.assign({
    id: id, title: 'Задача ' + id, notes: '', due: '2026-11-05', doDate: null,
    priority: 2, done: false, doneAt: null,
    createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z',
    order: 1, archived: false, schedule: null, scheduleUnsupported: false,
    previousOccurrenceId: null, generatedAt: null,
  }, overrides || {});
}

function readEnvelope(app) {
  const raw = app.sandbox.localStorage.getItem(ENVELOPE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

// Копия версии 11 из общего фикстуры-фабрики + plannerV1: те же привычки/
// записи/каза/сон/расписание, новый аддитивный узел
function backupV12(plannerV1) {
  const backup = defaultBackup();
  backup.version = 12;
  if (plannerV1) backup.plannerV1 = plannerV1;
  return backup;
}

// Обёртка setItem: k-й вызов бросает QuotaExceededError (тот же приём, что
// в backup.test.mjs — песочница и инъекция совпадают с прежним контрактом)
function failOnNthSetItem(storage, n) {
  const original = storage.setItem;
  const state = { calls: 0 };
  storage.setItem = function (key, value) {
    state.calls += 1;
    if (state.calls === n) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(key, value);
  };
  return state;
}

// ── версия и экспорт ────────────────────────────────────────────────────────

test('BACKUP_VERSION повышена от реально найденной 11 до 12; v11-файл продолжает разбираться (миграция, а не отказ)', () => {
  const app = loadApp();
  assert.equal(BACKUP_VERSION, 12);
  assert.equal(BACKUP_LEGACY_VERSION, 11);
  const legacy = app.context.parseBackup(JSON.stringify(defaultBackup()));
  assert.ok(legacy, 'копия версии 11 отвергнута — импорт старой копии сломан');
  assert.equal(legacy.version, 11);
  // будущая версия — отказ без частичного применения
  const future = defaultBackup();
  future.version = 13;
  assert.equal(app.context.parseBackup(JSON.stringify(future)), null);
});

test('buildBackup включает plannerV1 с tombstones и НЕ включает outbox/владелец/credentials', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.fb.owner', JSON.stringify({ email: 'o@e', uid: 'uid-A' }));
  assert.equal(app.context.saveTasks([mkTask('t1'), mkTask('t2')]), true);
  app.context.saveTasks([mkTask('t2')]); // purge t1 → tombstone
  const envBefore = readEnvelope(app);
  assert.ok(envBefore.outbox.length >= 3, 'ожидание: в outbox есть неподтверждённые операции');

  const backup = app.context.buildBackup();
  assert.equal(backup.version, 12);
  assert.ok(backup.plannerV1, 'plannerV1 не экспортирован');
  assert.ok(backup.plannerV1.tombstones.t1, 'tombstones не переживают экспорт');
  assert.ok(backup.plannerV1.entries.t2);
  assert.equal(backup.plannerV1.outbox, undefined, 'outbox уехал в файл копии');
  assert.equal(backup.plannerV1.ownerUid, undefined, 'привязка владельца уехала в файл');
  assert.equal(JSON.stringify(backup).includes('uid-A'), false, 'uid владельца протёк в planner-узел');
  // прежние разделы на месте (контракт привычек сохранён: раздел есть всегда)
  assert.ok(Array.isArray(backup.habits), 'раздел habits пропал из экспорта');
  assert.equal(backup.tasks, undefined);
});

test('backup round-trip: export → parse → apply на втором устройстве, tombstones и записи восстановлены, привычки целы', () => {
  const source = loadApp();
  source.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));
  source.context.saveTasks([mkTask('t1'), mkTask('t2')]);
  source.context.saveTasks([mkTask('t2')]);
  const text = JSON.stringify(source.context.buildBackup());

  const target = loadApp();
  target.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));
  // чужое локальное состояние: своя запись + свой удалённый id
  target.context.saveTasks([mkTask('t3'), mkTask('gone')]);
  target.context.saveTasks([mkTask('t3')]);

  const data = target.context.parseBackup(text);
  assert.ok(data, 'round-trip копия отвергнута');
  assert.equal(target.context.applyBackup(data), true);

  const env = readEnvelope(target);
  assert.ok(env.snapshot.entries.t2, 'импорт не принёс запись t2');
  assert.ok(env.snapshot.entries.t3, 'локальная запись t3 пропала — импорт заменил, а не слил');
  assert.ok(env.snapshot.tombstones.t1, 'чужой tombstone не долетел');
  assert.ok(env.snapshot.tombstones.gone, 'локальный tombstone стёрт импортом');
  const tasks = Array.from(target.context.loadTasks().map(function (t) { return t.id; }));
  assert.ok(tasks.indexOf('t1') === -1, 'удалённый id воскрес из копии');
  assert.ok(tasks.indexOf('gone') === -1, 'локально удалённый id воскрес');
  assert.ok(tasks.indexOf('t2') !== -1 && tasks.indexOf('t3') !== -1);
  // прежний контракт привычек: список приехал из файла целым
  assert.deepEqual(JSON.parse(target.sandbox.localStorage.getItem('youplanner.habits')),
    JSON.parse(source.sandbox.localStorage.getItem('youplanner.habits')));
});

test('старый backup без plannerV1 (v11): импорт сохраняет текущий envelope побайтно', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));
  app.context.saveTasks([mkTask('t1')]);
  const envBytes = app.sandbox.localStorage.getItem(ENVELOPE_KEY);

  const data = app.context.parseBackup(JSON.stringify(defaultBackup()));
  assert.ok(data, 'v11-копия не разбирается');
  assert.equal(app.context.applyBackup(data), true);
  assert.equal(app.sandbox.localStorage.getItem(ENVELOPE_KEY), envBytes,
    'импорт без plannerV1 тронул или стёр envelope');
  assert.ok(readEnvelope(app).snapshot.entries.t1, 'plannerV1 очищен импортом без узла');
});

test('старый backup НЕ воскрешает удалённые id: копия до удаления + tombstone на устройстве', () => {
  const app = loadApp();
  app.context.saveTasks([mkTask('t1')]);
  // копия «до удаления»: в envelope ещё жив t1, tombstone появится позже
  const oldText = JSON.stringify(app.context.buildBackup());
  app.context.saveTasks([]); // purge t1 → delete-wins
  assert.ok(readEnvelope(app).snapshot.tombstones.t1);

  const data = app.context.parseBackup(oldText);
  assert.ok(data);
  assert.equal(app.context.applyBackup(data), true);
  const env = readEnvelope(app);
  assert.equal(env.snapshot.entries.t1, undefined, 'удалённый id воскрес из старой копии');
  assert.ok(env.snapshot.tombstones.t1, 'надгробие потеряно при импорте');
});

// ── отказ на битом/чужом формате ────────────────────────────────────────────

test('битый plannerV1 в v12-файле: parseBackup возвращает null, apply не вызывается, ничего не меняется', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));
  app.context.saveTasks([mkTask('mine')]);
  const before = app.sandbox.localStorage._dump();

  const broken = backupV12({ schemaVersion: 1, entries: 'мусор', settings: {}, tombstones: {} });
  assert.equal(app.context.parseBackup(JSON.stringify(broken)), null,
    'битый plannerV1 прошёл разбор');

  const unknown = backupV12({ schemaVersion: 99, entries: {}, settings: {}, tombstones: {} });
  assert.equal(app.context.parseBackup(JSON.stringify(unknown)), null,
    'plannerV1 неизвестной версии прошёл разбор');

  assert.deepEqual(app.sandbox.localStorage._dump(), before,
    'отвергнутый файл изменил хранилище');
});

test('квота посреди импорта v12 с plannerV1: откат всех ключей, включая envelope и список Матрицы', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));
  app.context.saveTasks([mkTask('mine')]);
  const before = app.sandbox.localStorage._dump();

  const file = backupV12(snap({ tF: entry('tF', fullFields('Из копии', 1, 'src')) }));
  const data = app.context.parseBackup(JSON.stringify(file));
  assert.ok(data, 'валидная v12-копия отвергнута до инъекции');

  // последний setItem — matrix-список или envelope: отказ где-то внутри
  // planner-пары обязан откатить и её, и прежние разделы
  const originalCalls = Object.keys(before).length;
  const patch = failOnNthSetItem(app.sandbox.localStorage, originalCalls + 4);
  const result = app.context.applyBackup(data);
  if (result === false) {
    assert.deepEqual(app.sandbox.localStorage._dump(), before,
      'откат не вернул все ключи побайтно');
  } else {
    // слишком короткий stage — инъекция должна попадать именно в planner-ключи
    assert.ok(patch.calls >= originalCalls + 4, 'инъекция мимо planner-записей');
    assert.fail('импорт с plannerV1 не написал envelope и список');
  }
});

// ── импорт до соединения: без «замены облака» ───────────────────────────────

test('applyBackup не дёргает сеть: публикация — только через pull+merge цикла sync', () => {
  const calls = [];
  const app = loadApp({ fetchImpl: function (url, opts) {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  } });
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));

  const file = backupV12(snap({ tF: entry('tF', fullFields('Из копии', 1, 'src')) }));
  const data = app.context.parseBackup(JSON.stringify(file));
  assert.ok(data);
  assert.equal(app.context.applyBackup(data), true);
  assert.equal(calls.length, 0, 'импорт ушёл в сеть вместо последующего pull+merge');
  // правка взводит pending-флаг: первый же обмен начнётся с GET (INIT), не с PUT-замены
  assert.equal(app.run('syncPending'), true);
});

// ── RED-строка 12: привычки параллельно planner-sync, затем backup round-trip ──

test('параллельная правка привычек и plannerV1, затем round-trip: старый контракт привычек и новый узел не выкинуты', async () => {
  const source = loadApp();
  source.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));
  source.sandbox.localStorage.setItem('youplanner.records', JSON.stringify({ '2026-11-04': { h1: true } }));
  source.context.saveTasks([mkTask('t1')]);

  const text = JSON.stringify(source.context.buildBackup());
  assert.ok(JSON.parse(text).habits.length === 1, 'привычки пропали из экспорта');

  const target = loadApp();
  target.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h9', name: 'Своё', type: 'number', goal: 3 }]));
  const data = target.context.parseBackup(text);
  assert.equal(target.context.applyBackup(data), true);
  // привычки: прежний контракт — замена целиком из файла (раздел есть в файле)
  assert.deepEqual(JSON.parse(target.sandbox.localStorage.getItem('youplanner.habits')),
    [{ id: 'h1', name: 'Фаджр', type: 'boolean' }]);
  assert.deepEqual(JSON.parse(target.sandbox.localStorage.getItem('youplanner.records')),
    { '2026-11-04': { h1: true } });
  // plannerV1: новые данные не выкинуты
  assert.ok(readEnvelope(target).snapshot.entries.t1, 'plannerV1 потерялся после round-trip');
});
