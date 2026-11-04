// ТЗ Воркера 1 («Фабрика», ночная смена): синхронизация Матрицы узлом
// plannerV1 внутри существующего снимка владельца.
//
// Контракт (§1.3 ТЗ): аддитивный узел plannerV1 = {schemaVersion, entries,
// settings, tombstones}; каждое предметное поле — {value, version} с
// Lamport {counter, actorId}; сравнение лексикографическое (counter, actorId);
// одинаковая версия с разным значением — детерминированный выбор по
// канонической JSON-строке плюс диагностика без содержимого; удаление —
// delete-wins навсегда, надгробие не снимается обычным update/merge/import;
// автоматического GC, TTL и вытеснения нет; настенные часы — только
// отображение, не арбитр конфликта.
//
// Размещение: четыре чистые функции живут в js/sync/merge.js, а НЕ в
// js/sync/planner-merge.js: подключение нового файла в граф приложения
// требует правки sw.js (ASSETS + версия кэша), а service worker — zona
// запрещённая этому воркеру (шлюз 1.1, факт передан оркестратору).
// Тесты зовут функции напрямую как ES-модули; транспортные проверки —
// ниже, через песочницу tests/helpers/load-app.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANNER_SCHEMA_VERSION,
  plannerCanonicalJson,
  cmpPlannerVersion,
  normalizePlannerV1,
  mergePlannerV1,
  applyPlannerOperation,
  migratePlannerV1,
} from '../js/sync/merge.js';

// ── Фабрики ─────────────────────────────────────────────────────────────────

function v(counter, actor) {
  return { counter: counter, actorId: actor };
}

function fld(value, counter, actor) {
  return { value: value, version: v(counter, actor) };
}

function entry(id, fields) {
  return { id: id, fields: fields };
}

function snap(entries, settings, tombstones) {
  return {
    schemaVersion: PLANNER_SCHEMA_VERSION,
    entries: entries || {},
    settings: settings || {},
    tombstones: tombstones || {},
  };
}

function canon(value) {
  return plannerCanonicalJson(value);
}

// ── normalizePlannerV1 ──────────────────────────────────────────────────────

test('normalizePlannerV1: канонизация с сортировкой ключей и достройкой пустых карт', () => {
  const result = normalizePlannerV1({
    schemaVersion: 1,
    entries: {
      b: entry('b', { title: fld('Вторая', 1, 'a1') }),
      a: entry('a', { title: fld('Первая', 2, 'a1'), notes: fld('', 1, 'a1') }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.unsupported, false);
  // ключи верхнего уровня и полей — поCanonical-порядку: байтовое сравнение
  // снимков (snapshotDiffers в sync.js) не должно зависеть от порядка вставки
  assert.deepEqual(Object.keys(result.snapshot.entries), ['a', 'b']);
  assert.deepEqual(Object.keys(result.snapshot.entries.a.fields), ['notes', 'title']);
  assert.deepEqual(result.snapshot.settings, {});
  assert.deepEqual(result.snapshot.tombstones, {});
});

test('normalizePlannerV1: неизвестная версия НЕ удаляется молча', () => {
  const future = { schemaVersion: 2, entries: { x: entry('x', {}) } };
  const result = normalizePlannerV1(future);
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.equal(result.snapshot, null);
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0,
    'unsupported без причин — вызывающий не сможет отличить отказ от мусора');
});

test('normalizePlannerV1: мусор отвергается целиком, битые записи отбрасываются с causes', () => {
  assert.equal(normalizePlannerV1(null).ok, false);
  assert.equal(normalizePlannerV1('мусор').ok, false);
  assert.equal(normalizePlannerV1([1, 2]).ok, false);
  const dirty = normalizePlannerV1({
    schemaVersion: 1,
    entries: {
      good: entry('good', { title: fld('Есть', 1, 'a1') }),
      badVersion: entry('badVersion', { title: { value: 'x', version: { counter: 'не число', actorId: 'a1' } } }),
      noId: { fields: {} },
    },
  });
  assert.equal(dirty.ok, true, 'один битый элемент не роняет раздел целиком');
  assert.deepEqual(Object.keys(dirty.snapshot.entries), ['good']);
  assert.ok(dirty.issues.length >= 2, 'отбрасывание без причины — молчаливая потеря');
});

// ── cmpPlannerVersion ───────────────────────────────────────────────────────

test('cmpPlannerVersion: лексикографически (counter, actorId), часы не при чём', () => {
  assert.equal(cmpPlannerVersion(v(1, 'a'), v(2, 'a')), -1);
  assert.equal(cmpPlannerVersion(v(2, 'a'), v(2, 'b')), -1);
  assert.equal(cmpPlannerVersion(v(9, 'b'), v(9, 'a')), 1);
  assert.equal(cmpPlannerVersion(v(3, 'x'), v(3, 'x')), 0);
});

// ── RED-строка 1: независимые поля одной записи, оба порядка ───────────────

test('mergePlannerV1: A и B правят разные поля offline — обе правки, итог одинаков в обоих порядках', () => {
  const base = snap({ t1: entry('t1', { title: fld('Общее', 1, 'A'), notes: fld('Общие', 1, 'A') }) });
  const left = snap({ t1: entry('t1', { title: fld('Заголовок A', 2, 'A'), notes: fld('Общие', 1, 'A') }) });
  const right = snap({ t1: entry('t1', { title: fld('Общее', 1, 'A'), notes: fld('Заметка B', 2, 'B') }) });

  const ab = mergePlannerV1(left, right);
  const ba = mergePlannerV1(right, left);

  assert.equal(ab.entries.t1.fields.title.value, 'Заголовок A');
  assert.equal(ab.entries.t1.fields.notes.value, 'Заметка B');
  assert.equal(canon(ab), canon(ba), 'merge не коммутативен по канонической форме');
});

// ── RED-строка 2: одинаковые counter и разные actorId ───────────────────────
// Контракт §1.3: сравнение версий лексикографическое (counter, actorId),
// поэтому «одинаковый counter, разные actorId» разрешается САМИМ порядком
// сравнения — победитель детерминирован и не зависит от того, какое устройство
// пришло первым. Отдельный tie-break по канонической строке нужен лишь при
// ПОЛНОСТЬЮ равной версии (тот же counter и тот же actorId) с разным
// значением: он тоже детерминирован и сопровождается диагностикой без
// содержимого.

test('mergePlannerV1: одинаковый counter и разные actorId — победитель по (counter, actorId), перестановка устройств не меняет итог', () => {
  const conflictA = snap({ t1: entry('t1', { title: fld('ВариантdeviceA', 5, 'deviceA') }) });
  const conflictB = snap({ t1: entry('t1', { title: fld('ВариантdeviceB', 5, 'deviceB') }) });

  const first = mergePlannerV1(conflictA, conflictB);
  const second = mergePlannerV1(conflictB, conflictA);

  // (5,'deviceA') < (5,'deviceB') лексикографически: deviceB побеждает в
  // обоих порядках прихода
  assert.equal(first.entries.t1.fields.title.value, 'ВариантdeviceB');
  assert.deepEqual(first.entries, second.entries, 'перестановка устройств меняет итог');
  assert.deepEqual(first.entries.t1.fields.title.version, v(5, 'deviceB'));
});

test('mergePlannerV1: полностью равная версия с разным значением — канонический победитель и диагностика без содержимого', () => {
  const sideA = snap({ t1: entry('t1', { title: fld('яблочный', 6, 'shared') }) });
  const sideB = snap({ t1: entry('t1', { title: fld('апельсиновый', 6, 'shared') }) });

  const report1 = { conflicts: [] };
  const report2 = { conflicts: [] };
  const first = mergePlannerV1(sideA, sideB, report1);
  const second = mergePlannerV1(sideB, sideA, report2);

  assert.deepEqual(first.entries, second.entries, 'перестановка сторон меняет итог при равной версии');
  assert.equal(first.entries.t1.fields.title.value, 'апельсиновый',
    'при равной версии обязан побеждать меньший канонический JSON');
  assert.equal(report1.conflicts.length, 1,
    'конфликт равных версий с разным значением обязан быть зафиксирован в отчёте');
  assert.equal(report2.conflicts.length, 1);
  // диагностика без содержимого: в конфликтах нет значений
  assert.equal(JSON.stringify(report1.conflicts).includes('апельсин'), false,
    'отчёт о конфликте протёк содержимым');
  assert.equal(report1.conflicts[0].entryId, 't1');
  assert.equal(report1.conflicts[0].field, 'title');
});

// ── RED-строка 3: delete-wins навсегда ──────────────────────────────────────

test('mergePlannerV1: tombstone переживает и старую, и более свежую правку, в обоих порядках', () => {
  const deleted = snap({}, {}, { t1: { version: v(9, 'A'), deletedAt: '2026-11-04T12:00:00Z' } });
  const staleEdit = snap({ t1: entry('t1', { title: fld('Старая правка', 3, 'B') }) });
  const newerEdit = snap({ t1: entry('t1', { title: fld('Новая правка', 40, 'B') }) });

  for (const other of [staleEdit, newerEdit]) {
    for (const order of [[deleted, other], [other, deleted]]) {
      const merged = mergePlannerV1(order[0], order[1]);
      assert.equal(merged.entries.t1, undefined, 'удалённый id ожил при merge');
      assert.ok(merged.tombstones.t1, 'tombstone потерян при merge');
    }
  }
  // tombstones сливаются по максимальной версии
  const weaker = snap({}, {}, { t1: { version: v(4, 'C'), deletedAt: '2026-01-01T00:00:00Z' } });
  const mergedT = mergePlannerV1(deleted, weaker);
  assert.deepEqual(mergedT.tombstones.t1.version, v(9, 'A'));
});

// ── RED-строка 4: идемпотентность ───────────────────────────────────────────

test('mergePlannerV1: merge(x,x)=x; повторная доставка снимка не плодит дубликаты и не растит версии', () => {
  const x = normalizePlannerV1(snap({
    t1: entry('t1', { title: fld('Раз', 3, 'A'), schedule: fld({ startDate: '2026-11-05' }, 4, 'B') }),
    t2: entry('t2', { title: fld('Два', 1, 'A') }),
  }, { weekStart: fld(1, 2, 'A') }, { gone: { version: v(5, 'A'), deletedAt: '2026-10-01T00:00:00Z' } })).snapshot;

  const once = mergePlannerV1(x, x);
  const twice = mergePlannerV1(once, once);
  assert.equal(canon(once), canon(x), 'merge(x,x) обязан совпадать с x побайтово');
  assert.equal(canon(twice), canon(x));
});

test('mergePlannerV1: ассоциативность на трёх устройствах', () => {
  const a = normalizePlannerV1(snap({ t1: entry('t1', { title: fld('от A', 7, 'A'), notes: fld('заметка A', 2, 'A') }) })).snapshot;
  const b = normalizePlannerV1(snap({ t1: entry('t1', { title: fld('общее', 3, 'A'), due: fld('2026-12-01', 6, 'B') }), t2: entry('t2', { title: fld('от B', 4, 'B') }) })).snapshot;
  const c = normalizePlannerV1(snap({ t1: entry('t1', { priority: fld(3, 8, 'C') }) }, {}, { t2: { version: v(2, 'C'), deletedAt: '2026-11-01T00:00:00Z' } })).snapshot;

  const abC = mergePlannerV1(mergePlannerV1(a, b), c);
  const aBC = mergePlannerV1(a, mergePlannerV1(b, c));
  assert.equal(canon(abC), canon(aBC), 'merge не ассоциативен');
  // независимые правки полей a и b сохранены обе, удаление t2 — delete-wins
  assert.equal(abC.entries.t1.fields.title.value, 'от A');
  assert.equal(abC.entries.t1.fields.due.value, '2026-12-01');
  assert.equal(abC.entries.t1.fields.priority.value, 3);
  assert.equal(abC.entries.t2, undefined);
  assert.ok(abC.tombstones.t2);
});

test('mergePlannerV1: отсутствие узла у старой стороны — не удаление (аддитивность)', () => {
  const withPlanner = snap({ t1: entry('t1', { title: fld('Есть', 1, 'A') }) });
  const empty = snap();
  assert.equal(canon(mergePlannerV1(withPlanner, empty)), canon(withPlanner));
  assert.equal(canon(mergePlannerV1(empty, withPlanner)), canon(withPlanner));
});

// ── applyPlannerOperation ───────────────────────────────────────────────────

test('applyPlannerOperation: put создаёт запись с версией поля; повтор той же операции — no-op без роста версии', () => {
  const start = snap();
  const op = {
    opId: 'op-1', type: 'put', entryId: 't1',
    fields: { title: fld('Новая задача', 1, 'A') },
  };
  const applied = applyPlannerOperation(start, op);
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.snapshot.entries.t1.fields.title, fld('Новая задача', 1, 'A'));

  const repeat = applyPlannerOperation(applied.snapshot, op);
  assert.equal(repeat.applied, false, 'повтор операции не должен считаться новым результатом');
  assert.equal(canon(repeat.snapshot), canon(applied.snapshot),
    'повтор той же opId/версии изменил снимок: версия выросла от доставки');
});

test('applyPlannerOperation: put по tombstoned id отвергается, надгробие остаётся', () => {
  const report = { conflicts: [] };
  const tombstoned = snap({}, {}, { gone: { version: v(9, 'A'), deletedAt: '2026-11-04T12:00:00Z' } });
  const result = applyPlannerOperation(tombstoned, {
    opId: 'op-2', type: 'put', entryId: 'gone', fields: { title: fld('Воскреси', 10, 'B') },
  }, report);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'tombstoned');
  assert.equal(result.snapshot.entries.gone, undefined);
  assert.deepEqual(result.snapshot.tombstones.gone.version, v(9, 'A'));
});

test('applyPlannerOperation: delete пишет tombstone (max версии) и убирает запись; повтор delete идемпотентен', () => {
  const live = snap({ t1: entry('t1', { title: fld('Живая', 4, 'A') }) });
  const delOp = {
    opId: 'op-3', type: 'delete', entryId: 't1',
    version: v(5, 'A'), deletedAt: '2026-11-05T08:00:00Z',
  };
  const after = applyPlannerOperation(live, delOp);
  assert.equal(after.applied, true);
  assert.equal(after.snapshot.entries.t1, undefined);
  assert.deepEqual(after.snapshot.tombstones.t1.version, v(5, 'A'));

  const weaker = applyPlannerOperation(after.snapshot, {
    opId: 'op-4', type: 'delete', entryId: 't1', version: v(2, 'B'), deletedAt: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(weaker.snapshot.tombstones.t1.version, v(5, 'A'),
    'более старое удаление не должно двигать tombstone');
});

test('applyPlannerOperation: stale-правка (версия ниже существующей) не затирает значение', () => {
  const fresh = snap({ t1: entry('t1', { title: fld('Актуально', 7, 'B') }) });
  const result = applyPlannerOperation(fresh, {
    opId: 'op-5', type: 'put', entryId: 't1', fields: { title: fld('Устарело', 3, 'A') },
  });
  assert.equal(result.applied, false);
  assert.equal(result.snapshot.entries.t1.fields.title.value, 'Актуально');
});

// ── migratePlannerV1 ────────────────────────────────────────────────────────

test('migratePlannerV1: сохраняет старые id, версии начались с 1, повтор детерминирован', () => {
  const legacy = {
    entries: [
      { id: 't-а', fields: { title: 'Первая', priority: 2 } },
      { id: 't-б', fields: { title: 'Вторая' } },
    ],
    settings: {},
  };
  const state = { actorId: 'inst-A', mapping: {} };
  const first = migratePlannerV1(legacy, state);
  const second = migratePlannerV1(legacy, { actorId: 'inst-A', mapping: first.mapping });

  assert.deepEqual(Object.keys(first.snapshot.entries).sort(), ['t-а', 't-б']);
  assert.deepEqual(first.snapshot.entries['t-а'].fields.title, fld('Первая', 1, 'inst-A'));
  assert.equal(canon(second.snapshot), canon(first.snapshot),
    'повтор миграции дал другие записи/версии — дубликаты при сбое');
});

test('migratePlannerV1: записи без id получают стабильный id через таблицу соответствия', () => {
  const legacy = { entries: [{ fields: { title: 'Без идентификатора' } }], settings: {} };
  const first = migratePlannerV1(legacy, { actorId: 'inst-A', mapping: {} });
  const newIds = Object.keys(first.snapshot.entries);
  assert.equal(newIds.length, 1);
  assert.ok(first.mapping, 'миграция без id обязана вернуть таблицу соответствия');

  // повтор той же legacy-записи использует сохранённую таблицу, а не новый id
  const second = migratePlannerV1(legacy, { actorId: 'inst-A', mapping: first.mapping });
  assert.deepEqual(Object.keys(second.snapshot.entries), newIds,
    'повтор миграции создал дубль с новым id');
});

test('migratePlannerV1: пустое прошлое — пустой снимок, без выдуманных записей', () => {
  const result = migratePlannerV1({ entries: [], settings: {} }, { actorId: 'inst-A', mapping: {} });
  assert.equal(Object.keys(result.snapshot.entries).length, 0);
  assert.equal(result.snapshot.schemaVersion, PLANNER_SCHEMA_VERSION);
});

// ── Unit 2: локальный envelope и адаптер Матрицы (ТЗ §1.3–§1.4.3, §1.4.5) ───
// saveTasks — единственная запись Матрицы (её зовёт commitTasks экрана):
// адаптер обязан сохранить публичную сигнатуру и предметные поля, а поверх
// писать атомарный envelope {snapshot, outbox, lamport, actorId, ownerUid}.
// Сначала envelope, потом список; отказ хранилища — честное «нет» без
// частичного состояния. Повтор операции не дублирует outbox и не растит
// версии; tombstones без GC; миграция сохраняет id и не трогает привычки.

import { loadApp } from './helpers/load-app.mjs';

const MATRIX_KEY = 'youplanner.matrix.tasks';
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

test('saveTasks: пишет envelope plannerV1 поверх прежней записи списка, список круглится через loadTasks', () => {
  const app = loadApp();
  assert.equal(app.context.saveTasks([mkTask('t1'), mkTask('t2', { priority: 3 })]), true);

  const env = readEnvelope(app);
  assert.ok(env, 'envelope не записан');
  assert.equal(env.snapshot.schemaVersion, PLANNER_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(env.snapshot.entries).sort(), ['t1', 't2']);
  const title = env.snapshot.entries.t1.fields.title;
  assert.equal(title.value, 'Задача t1');
  assert.ok(Number.isInteger(title.version.counter) && title.version.counter >= 1,
    'у поля нет Lamport-версии');
  assert.equal(typeof title.version.actorId, 'string');
  assert.ok(title.version.actorId !== '');
  // schedule — атомарное поле: дата, время, часовой пояс, повтор и
  // напоминания живут в одном value
  assert.ok(env.snapshot.entries.t1.fields.schedule, 'поля schedule нет');

  // outbox: создание — это операция {opId, ownerKey, operation}
  assert.ok(Array.isArray(env.outbox) && env.outbox.length >= 1, 'outbox пуст при создании');
  const firstOp = env.outbox[0];
  assert.ok(typeof firstOp.opId === 'string' && firstOp.opId !== '');
  assert.ok('ownerKey' in firstOp, 'op без ownerKey');
  assert.ok(firstOp.operation.entryId === 't1' || firstOp.operation.entryId === 't2',
    'opIds не связаны с записями');

  assert.deepEqual(app.context.loadTasks().map(function (t) { return t.id; }), ['t1', 't2']);
});

test('saveTasks: правка одного поля двигает версию только у него; повтор той же правки не плодит операций', () => {
  const app = loadApp();
  app.context.saveTasks([mkTask('t1', { notes: 'важные заметки' })]);
  const env1 = readEnvelope(app);
  const notesVersion = env1.snapshot.entries.t1.fields.notes.version;
  const titleVersion = env1.snapshot.entries.t1.fields.title.version;

  app.context.saveTasks([mkTask('t1', { notes: 'важные заметки', title: 'Переименована' })]);
  const env2 = readEnvelope(app);
  assert.deepEqual(env2.snapshot.entries.t1.fields.notes.version, notesVersion,
    'заметка не менялась — версия не должна расти');
  assert.ok(cmpPlannerVersion(env2.snapshot.entries.t1.fields.title.version, titleVersion) > 0,
    'правка заголовка не получила новую версию');
  assert.equal(env2.outbox.length, env1.outbox.length + 1,
    'одна правка поля — одна операция в outbox');

  // повтор того же состояния: diff пуст → ни операций, ни роста версий
  app.context.saveTasks([mkTask('t1', { notes: 'важные заметки', title: 'Переименована' })]);
  const env3 = readEnvelope(app);
  assert.equal(env3.outbox.length, env2.outbox.length, 'пустой diff породил операцию');
  assert.equal(canon(env3.snapshot.entries), canon(env2.snapshot.entries));
});

test('saveTasks: purge записи пишет delete-tombstone; повторный put того же id не воскрешает запись', () => {
  const app = loadApp();
  app.context.saveTasks([mkTask('t1'), mkTask('t2')]);
  app.context.saveTasks([mkTask('t2')]);

  const env = readEnvelope(app);
  assert.equal(env.snapshot.entries.t1, undefined, 'удалённая запись осталась живой');
  assert.ok(env.snapshot.tombstones.t1, 'tombstone не записан');
  assert.ok(env.snapshot.tombstones.t1.deletedAt, 'tombstone без метки отображения');

  // «вернуть» тот же id прямой правкой списка нельзя: delete-wins навсегда
  app.context.saveTasks([mkTask('t1'), mkTask('t2')]);
  const env2 = readEnvelope(app);
  assert.equal(env2.snapshot.entries.t1, undefined, 'put снял tombstone — скрытое resurrection');
  assert.ok(env2.snapshot.tombstones.t1);
});

test('saveTasks при отказе хранилища: false, envelope и список остались побайтово прежними', () => {
  const app = loadApp();
  app.context.saveTasks([mkTask('t1')]);
  const envBefore = app.sandbox.localStorage.getItem(ENVELOPE_KEY);
  const listBefore = app.sandbox.localStorage.getItem(MATRIX_KEY);

  app.sandbox.localStorage.setItem = function () {
    const error = new Error('QuotaExceededError');
    error.name = 'QuotaExceededError';
    throw error;
  };
  assert.equal(app.context.saveTasks([mkTask('t1'), mkTask('t2')]), false,
    'отказ записи не притворился успехом');
  assert.equal(app.sandbox.localStorage.getItem(ENVELOPE_KEY), envBefore,
    'envelope тронут при отказе');
  assert.equal(app.sandbox.localStorage.getItem(MATRIX_KEY), listBefore,
    'список тронут при отказе');
});

test('migratePlanner: повторяемая миграция сохраняет старые id, не трогает привычки, повтор побайтово идентичен', () => {
  const app = loadApp();
  app.sandbox.localStorage.setItem(MATRIX_KEY, JSON.stringify([mkTask('t1'), mkTask('t2')]));
  app.sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([{ id: 'h1', name: 'Фаджр', type: 'boolean' }]));
  const habitsBefore = app.sandbox.localStorage.getItem('youplanner.habits');

  assert.equal(app.context.migratePlanner(), true, 'миграция не состоялась');
  const env1 = readEnvelope(app);
  assert.ok(env1, 'envelope не создан миграцией');
  assert.deepEqual(Object.keys(env1.snapshot.entries).sort(), ['t1', 't2'],
    'миграция потеряла или переименовала старые id');
  assert.equal(env1.snapshot.entries.t1.fields.title.version.counter, 1,
    'миграция обязана начать версии с 1');

  assert.equal(app.context.migratePlanner(), true);
  const env2 = app.sandbox.localStorage.getItem(ENVELOPE_KEY);
  assert.equal(env2, JSON.stringify(env1), 'повтор миграции изменил снимок — дубликаты/рост версий');
  assert.equal(app.sandbox.localStorage.getItem('youplanner.habits'), habitsBefore,
    'миграция тронула привычки');
});

test('migratePlanner: при уже существующем envelope — ничего не перетирает (без удаления новой области)', () => {
  const app = loadApp();
  app.context.saveTasks([mkTask('t1', { title: 'Актуальная' })]);
  const envBefore = app.sandbox.localStorage.getItem(ENVELOPE_KEY);
  // даже «старый» список не должен перебить живой envelope
  app.sandbox.localStorage.setItem(MATRIX_KEY, JSON.stringify([mkTask('tX', { title: 'Легаси' })]));
  assert.equal(app.context.migratePlanner(), true);
  assert.equal(app.sandbox.localStorage.getItem(ENVELOPE_KEY), envBefore,
    'повторная миграция затёрла существующий plannerV1');
});

test('materializePlannerTasks: schedule атомарен (дата+время+зона+повтор+напоминания), due выводится, unsupported сохраняется', () => {
  const schedule = {
    version: 1, allDay: false,
    startDate: '2026-11-05', endDate: '2026-11-05',
    startTime: '09:00', endTime: '09:45', timeZoneMode: 'device',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 30, date: null, time: null }],
    repeat: null, series: null,
  };
  const snapshot = snap({
    t1: entry('t1', {
      title: fld('Встреча', 1, 'a'),
      schedule: fld(schedule, 1, 'a'),
      completion: fld({ done: false, doneAt: null }, 1, 'a'),
      priority: fld(2, 1, 'a'),
      notes: fld('', 1, 'a'),
      doDate: fld(null, 1, 'a'),
      order: fld(1, 1, 'a'),
      archived: fld(false, 1, 'a'),
      provenance: fld({
        createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z',
        generatedAt: null, previousOccurrenceId: null,
      }, 1, 'a'),
    }),
    t2: entry('t2', {
      title: fld('Будущая версия', 1, 'a'),
      schedule: fld({ version: 2, whatever: 'сохранилось' }, 1, 'a'),
    }),
  });
  const app = loadApp();
  const tasks = app.context.materializePlannerTasks(snapshot);
  const t1 = tasks.find(function (t) { return t.id === 't1'; });
  assert.ok(t1, 'запись не материализовалась');
  assert.equal(t1.due, '2026-11-05', 'due не выведен из расписания');
  assert.equal(t1.schedule.startTime, '09:00');
  assert.equal(t1.schedule.reminders.length, 1, 'напоминание потерялось — расписание разбилось');
  assert.equal(t1.schedule.timeZoneMode, 'device');
  // unsupported-схема сохраняется дословно и помечается (прежнее поведение sanitizeTask)
  const t2 = tasks.find(function (t) { return t.id === 't2'; });
  assert.ok(t2, 'запись с неизвестной версией расписания потеряна');
  assert.equal(t2.scheduleUnsupported, true);
  assert.equal(t2.schedule.whatever, 'сохранилось');
});

test('envelope: много tombstones — ни GC, ни вытеснения при очередной правке', () => {
  const app = loadApp();
  const many = {};
  for (let i = 0; i < 600; i++) {
    many['g' + i] = { version: v(i + 1, 'a'), deletedAt: '2026-11-01T00:00:00Z' };
  }
  app.sandbox.localStorage.setItem(ENVELOPE_KEY, JSON.stringify({
    version: 1, actorId: 'inst-test', ownerUid: null, lamport: { a: 600 },
    snapshot: snap({}, {}, many), outbox: [], opSeq: 0, mapping: {},
  }));
  assert.equal(app.context.saveTasks([mkTask('alive')]), true);
  const env = readEnvelope(app);
  assert.equal(Object.keys(env.snapshot.tombstones).length, 600,
    'надгробия planner прорежаны — контракт «нет автоматического GC» нарушен');
});
