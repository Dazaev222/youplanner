// A7.2/A7.3/A7.4.8/A7.9 (Раздел 7 ТЗ): контракт access-v1. Тесты пишутся ДО
// реализации (RED): js/harness/access.js и access-view.js ещё не существуют.
//
// access.js — чистая валидация policy/status по строгой схеме + контроллер
// с ВНЕДРЯЕМЫМ транспортом (readPolicy/writePolicy/readStatus) + билдер
// access для команд. Сеть — подмена, DOM — заглушки: тесты на фейках.
//
// Источник контракта: docs/CONTRACT-0.5-harness-firebase.md §10 и
// tests/access-v1-fixture.json (одинаков с BR-воркером).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCESS_PATH = join(ROOT, 'js', 'harness', 'access.js');
const VIEW_PATH = join(ROOT, 'js', 'harness', 'access-view.js');
const FIREBASE_PATH = join(ROOT, 'js', 'harness', 'firebase.js');
const COMMANDS_PATH = join(ROOT, 'js', 'harness', 'commands.js');
const INDEX_PATH = join(ROOT, 'js', 'harness', 'index.js');
const SW_PATH = join(ROOT, 'sw.js');
const CSS_PATH = join(ROOT, 'styles', 'harness.css');
const FIXTURE_PATH = join(ROOT, 'tests', 'access-v1-fixture.json');

assert.ok(existsSync(ACCESS_PATH),
  'js/harness/access.js не существует — реализация не начата (ожидаются RED)');
assert.ok(existsSync(VIEW_PATH),
  'js/harness/access-view.js не существует — реализация не начата (ожидаются RED)');
assert.ok(existsSync(FIXTURE_PATH), 'tests/access-v1-fixture.json не существует');

const access = await import('file://' + ACCESS_PATH);
const viewModule = await import('file://' + VIEW_PATH);
const firebaseModule = await import('file://' + FIREBASE_PATH);
const commands = await import('file://' + COMMANDS_PATH);

const {
  validateAccessPolicy, validateAccessStatus,
  describeAccessStatus, createAccessController,
} = access;
const { createAccessView } = viewModule;
const { createHarnessFirebase } = firebaseModule;
const { buildModelTaskParams, buildVerificationParams, createTaskSender } = commands;

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const FRESH_MS = 30000;

/* --- Валидация policy ------------------------------------------------------------------- */

test('A7.2: fixture — policy safe/medium/unrestricted проходят валидацию', () => {
  for (const mode of ['safe', 'medium', 'unrestricted']) {
    const result = validateAccessPolicy(FIXTURE.policy[mode]);
    assert.equal(result.ok, true, mode + ': ' + JSON.stringify(result));
  }
});

test('A7.2: fixture — status applied/blocked/beforeFirstApply проходят валидацию', () => {
  for (const key of ['applied', 'blocked', 'beforeFirstApply']) {
    const result = validateAccessStatus(FIXTURE.status[key]);
    assert.equal(result.ok, true, key + ': ' + JSON.stringify(result));
  }
});

test('A7.2: неизвестные поля policy отклоняются (строгая схема)', () => {
  const bad = Object.assign({}, FIXTURE.policy.medium, { surprise: 1 });
  assert.equal(validateAccessPolicy(bad).ok, false);
  // Маршрут исполнения вычисляет агент: поле route от клиента запрещено.
  const route = Object.assign({}, FIXTURE.policy.medium, { route: 'windows' });
  assert.equal(validateAccessPolicy(route).ok, false);
  const badConfirm = Object.assign({}, FIXTURE.policy.unrestricted);
  badConfirm.confirmation = Object.assign({}, badConfirm.confirmation, { route: 'x' });
  assert.equal(validateAccessPolicy(badConfirm).ok, false);
});

test('A7.2: bool вместо числа отклоняется (version/requestedAt)', () => {
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { version: true })).ok, false);
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { requestedAt: false })).ok, false);
  const u = Object.assign({}, FIXTURE.policy.unrestricted);
  u.confirmation = Object.assign({}, u.confirmation, { confirmedAt: true });
  assert.equal(validateAccessPolicy(u).ok, false);
});

test('A7.2: неверный mode/version/requestId отклоняются', () => {
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { mode: 'Safe' })).ok, false,
    'mode чувствителен к регистру');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { mode: 'unrestricted_x' })).ok, false);
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { version: 0 })).ok, false,
    'version начинается с 1');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { version: 1.5 })).ok, false,
    'version — целое');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { version: 9007199254740992 })).ok, false,
    'version не превышает 9007199254740991');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { requestId: 'плохой id' })).ok, false,
    'requestId — алфавит [A-Za-z0-9_-]');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { requestId: '' })).ok, false);
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium,
      { requestId: 'x'.repeat(129) })).ok, false, 'requestId ≤ 128');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { requestedBy: '' })).ok, false);
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { requestedBy: 42 })).ok, false);
  assert.equal(validateAccessPolicy(null).ok, false);
  assert.equal(validateAccessPolicy('строка').ok, false);
});

test('A7.2: confirmation обязателен в unrestricted и запрещён в safe/medium', () => {
  const noConfirm = Object.assign({}, FIXTURE.policy.unrestricted);
  delete noConfirm.confirmation;
  assert.equal(validateAccessPolicy(noConfirm).ok, false,
    'unrestricted без confirmation отклоняется');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.safe, { confirmation: {
      kind: 'unrestricted_windows_v1', requestId: FIXTURE.policy.safe.requestId,
      confirmedBy: FIXTURE.policy.safe.requestedBy,
      confirmedAt: FIXTURE.policy.safe.requestedAt,
    } })).ok, false, 'confirmation в safe запрещён');
  assert.equal(validateAccessPolicy(
    Object.assign({}, FIXTURE.policy.medium, { confirmation: {
      kind: 'unrestricted_windows_v1', requestId: FIXTURE.policy.medium.requestId,
      confirmedBy: FIXTURE.policy.medium.requestedBy,
      confirmedAt: FIXTURE.policy.medium.requestedAt,
    } })).ok, false, 'confirmation в medium запрещён');
});

test('A7.2: confirmation с неверным kind/requestId/confirmedBy отклоняется', () => {
  const base = FIXTURE.policy.unrestricted;
  const wrongKind = Object.assign({}, base, { confirmation: Object.assign(
    {}, base.confirmation, { kind: 'unrestricted_windows_v2' }) });
  assert.equal(validateAccessPolicy(wrongKind).ok, false);
  const wrongRequestId = Object.assign({}, base, { confirmation: Object.assign(
    {}, base.confirmation, { requestId: 'другой' }) });
  assert.equal(validateAccessPolicy(wrongRequestId).ok, false);
  const wrongBy = Object.assign({}, base, { confirmation: Object.assign(
    {}, base.confirmation, { confirmedBy: 'uid-другой' }) });
  assert.equal(validateAccessPolicy(wrongBy).ok, false);
});

test('A7.2: плейсхолдер {".sv":"timestamp"} допустим только для времён владельца', () => {
  const placeholder = { '.sv': 'timestamp' };
  const withPlaceholder = Object.assign({}, FIXTURE.policy.medium,
    { requestedAt: placeholder });
  assert.equal(validateAccessPolicy(withPlaceholder).ok, true,
    'requestedAt уходит на сервер плейсхолдером');
  const u = Object.assign({}, FIXTURE.policy.unrestricted, { requestedAt: placeholder });
  u.confirmation = Object.assign({}, u.confirmation, { confirmedAt: placeholder });
  assert.equal(validateAccessPolicy(u).ok, true);
  // Плейсхолдер в чужом поле — не время: отклоняется
  assert.equal(validateAccessPolicy(Object.assign({}, FIXTURE.policy.medium,
    { version: placeholder })).ok, false);
  // Частичный плейсхолдер — не плейсхолдер
  assert.equal(validateAccessPolicy(Object.assign({}, FIXTURE.policy.medium,
    { requestedAt: { '.sv': 'now' } })).ok, false);
});

/* --- Валидация status -------------------------------------------------------------------- */

test('A7.2: неизвестные поля status отклоняются; неверные enum-поля тоже', () => {
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied, { route: 'docker' })).ok, false);
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied, { state: 'done' })).ok, false);
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied, { reason: 'fine' })).ok, false);
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied,
      { docker: { state: 'warm', checkedAt: 1 } })).ok, false);
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied, { updatedAt: true })).ok, false,
    'bool вместо числа отклоняется');
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied, { observedVersion: -1 })).ok, false);
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied,
      { observedVersion: 3, appliedVersion: 4 })).ok, false,
    'appliedVersion не превышает observedVersion');
  assert.equal(validateAccessStatus(
    Object.assign({}, FIXTURE.status.applied, { agentSessionId: '' })).ok, false);
});

/* --- Контроллер: CAS и конкурентные записи ------------------------------------------------ */

const NOW = 1763000500000;

function makeTransportServer(initialPolicy, initialEtag) {
  // Сервер-фейк с честной условной записью: PUT с чужим If-Match → 412.
  const server = {
    policy: initialPolicy || null,
    etag: initialEtag || null,
    writes: [],
    reads: 0,
    deadNetwork: false,
    async readPolicy() {
      if (server.deadNetwork) {
        const err = new Error('нет сети');
        err.code = 'network';
        throw err;
      }
      server.reads += 1;
      return { ok: true, data: server.policy, etag: server.etag };
    },
    async readStatus() {
      if (server.deadNetwork) {
        const err = new Error('нет сети');
        err.code = 'network';
        throw err;
      }
      return { ok: true, data: server.status || null };
    },
    async writePolicy({ expectedEtag, policy }) {
      if (server.deadNetwork) {
        const err = new Error('запрос прерван по таймауту');
        err.code = 'timeout';
        throw err;
      }
      if (server.etag === null || expectedEtag !== server.etag) {
        const err = new Error('HTTP 412');
        err.status = 412;
        err.code = 'conflict';
        throw err;
      }
      server.writes.push(JSON.parse(JSON.stringify(policy)));
      server.policy = JSON.parse(JSON.stringify(policy));
      server.etag = 'etag-' + server.writes.length;
      return { ok: true, etag: server.etag };
    },
  };
  return server;
}

let requestSeq = 0;
function makeRequestId() {
  requestSeq += 1;
  return 'pol-test-' + String(requestSeq).padStart(4, '0');
}

function makeController(server, extra = {}) {
  return createAccessController(Object.assign({
    transport: server,
    ownerUid: 'uid-owner-1',
    deviceId: 'pc-main-01',
    serverNow: () => NOW,
    makeRequestId,
  }, extra));
}

test('A7.3.4: CAS — конкурентные PUT: побеждает один, второй видит 412 и перечитывает', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const a = makeController(server);
  const b = makeController(server);
  await a.refresh();
  await b.refresh();
  a.setDraft('medium');
  b.setDraft('medium');
  const ra = await a.applyDraft();
  assert.equal(ra.ok, true, JSON.stringify(ra));
  // B читал ту же etag-0: его PUT обязан отклониться 412.
  const rb = await b.applyDraft();
  assert.equal(rb.ok, false);
  assert.equal(rb.reason, 'conflict');
  // Успешный PUT один (A); попытка B отклонена и записана НЕ была,
  // повторного повышения B не делал — только перечитывание.
  assert.equal(server.writes.length, 1, 'только PUT A');
  assert.equal(server.writes[0].version, 2);
  assert.equal(server.policy.version, 2, 'второй PUT не записан');
  assert.notEqual(a.state().etag, 'etag-0', 'A перечитал свежий etag');
  assert.equal(b.state().etag, server.etag, 'B перечитал и знает актуальную версию');
});

test('A7.3.5: timeout — исход разрешается сверкой прежнего requestId, без новой версии', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  // Детерминированный requestId, чтобы тест знал, что сверять.
  const ids = ['pol-test-abc1', 'pol-test-abc2'];
  let idIndex = 0;
  const c = makeController(server, {
    makeRequestId: () => ids[idIndex++] || ('pol-test-x' + idIndex),
  });
  await c.refresh();
  c.setDraft('medium');
  const submittedRequestId = 'pol-test-abc1';
  server.deadNetwork = true;
  const result = await c.applyDraft();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-outcome');
  // Сеть вернулась: чтение того же узла показывает НАШ requestId —
  // запись дошла, вторая версия не создаётся.
  server.deadNetwork = false;
  server.policy = Object.assign({}, FIXTURE.policy.medium,
    { version: 2, requestId: submittedRequestId, requestedAt: NOW });
  const reconciled = await c.resolveUnknownOutcome();
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true, 'сверка по requestId признала запись');
  assert.equal(server.writes.length, 0, 'повторного PUT не было');
  assert.equal(c.state().policy.requestId, submittedRequestId);
});

test('A7.3.5: timeout и чтение невозможно — попытка остаётся заблокированной, не успех', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  await c.refresh();
  c.setDraft('medium');
  server.deadNetwork = true;
  const result = await c.applyDraft();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-outcome');
  const resolved = await c.resolveUnknownOutcome();
  assert.equal(resolved.ok, false, 'прочитать не удалось — исход не признан');
  assert.equal(c.state().unknownOutcome, true,
    'попытка остаётся с неизвестным исходом');
  assert.equal(describeAccessStatus(c.state().describeInput(), {
    serverNow: () => NOW, freshMs: FRESH_MS,
  }).text, 'Исход изменения неизвестен');
});

test('A7.3.5: двойной тап при submitting не создаёт вторую версию', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  let release;
  const gate = new Promise((res) => { release = res; });
  const slowServer = Object.assign({}, server, {
    async writePolicy(args) {
      await gate;
      return server.writePolicy(args);
    },
  });
  const c = makeController(slowServer);
  await c.refresh();
  c.setDraft('medium');
  c.beginSubmit();   // синхронный флаг ДО первого await (A7.3.5)
  const first = c.applyDraft();
  const second = await c.applyDraft();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy', 'второй тап отклонён, пока идёт запись');
  assert.deepEqual(server.writes, []);
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(server.writes.length, 1, 'ровно одна запись');
});

/* --- Контроллер: unrestricted ------------------------------------------------------------- */

test('A7.3.4: Apply unrestricted без подтверждения ничего не пишет', async () => {
  const server = makeTransportServer(FIXTURE.policy.medium, 'etag-0');
  const c = makeController(server);
  await c.refresh();
  c.setDraft('unrestricted');
  const result = await c.applyDraft();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'confirm-required');
  assert.deepEqual(server.writes, [], 'ни одного PUT');
  assert.equal(c.state().confirmationOpen, true, 'открыт шаг предупреждения');
});

test('A7.3.4: checkbox без второго нажатия ничего не включает', async () => {
  const server = makeTransportServer(FIXTURE.policy.medium, 'etag-0');
  const c = makeController(server);
  await c.refresh();
  c.setDraft('unrestricted');
  await c.applyDraft();   // открыл предупреждение
  c.setConfirmationChecked(true);   // только галочка
  assert.deepEqual(server.writes, [], 'галочка сама ничего не пишет');
});

test('A7.3.4: confirm-submit с checkbox — один CAS с confirmation и НОВЫМ requestId', async () => {
  const server = makeTransportServer(FIXTURE.policy.medium, 'etag-0');
  const c = makeController(server);
  await c.refresh();
  c.setDraft('unrestricted');
  await c.applyDraft();
  c.setConfirmationChecked(true);
  const readsBefore = server.reads;
  const result = await c.confirmUnrestricted();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(server.writes.length, 1);
  const written = server.writes[0];
  assert.equal(written.mode, 'unrestricted');
  assert.equal(written.version, FIXTURE.policy.medium.version + 1,
    'версия = заново сверенная + 1');
  assert.notEqual(written.requestId, FIXTURE.policy.medium.requestId,
    'новый requestId');
  assert.equal(written.confirmation.kind, 'unrestricted_windows_v1');
  assert.equal(written.confirmation.requestId, written.requestId,
    'confirmation.requestId совпадает с policy.requestId');
  assert.equal(written.confirmation.confirmedBy, written.requestedBy);
  assert.ok(server.reads > readsBefore,
    'перед PUT сверка свежей версии (перечитывание)');
});

test('A7.3.4: изменилась версия между предупреждением и подтверждением — сброс', async () => {
  const server = makeTransportServer(FIXTURE.policy.medium, 'etag-0');
  const c = makeController(server);
  await c.refresh();
  c.setDraft('unrestricted');
  await c.applyDraft();   // открыли предупреждение на версии 7 (baseVersion=7)
  // Другая вкладка повысила версию на сервере (SSE в другом окне):
  // валидный unrestricted v8 с СВОИМ согласованным confirmation.
  server.policy = {
    schemaVersion: 1,
    version: FIXTURE.policy.medium.version + 1,
    requestId: 'pol-other-v8',
    mode: 'unrestricted',
    requestedBy: 'uid-owner-1',
    requestedAt: NOW,
    confirmation: {
      kind: 'unrestricted_windows_v1',
      requestId: 'pol-other-v8',
      confirmedBy: 'uid-owner-1',
      confirmedAt: NOW,
    },
  };
  server.etag = 'etag-другое';
  c.setConfirmationChecked(true);
  const result = await c.confirmUnrestricted();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'version-changed',
    'confirmUnrestricted сверяет базу со ЗАНОВО прочитанной версией');
  assert.deepEqual(server.writes, [], 'ничего не записано');
  assert.equal(c.state().confirmationOpen, false,
    'подтверждение сброшено, нужен новый ручной проход');
});

test('A7.3.4: подтверждение не переживает смену версии/сессию (не хранится между сессиями)', async () => {
  const server = makeTransportServer(FIXTURE.policy.medium, 'etag-0');
  const c = makeController(server);
  await c.refresh();
  c.setDraft('unrestricted');
  await c.applyDraft();
  c.setConfirmationChecked(true);
  // SSE-наблюдение смены версии в этой же сессии закрывает подтверждение
  // (валидный unrestricted v8 со своим согласованным confirmation).
  const next = {
    schemaVersion: 1,
    version: FIXTURE.policy.medium.version + 1,
    requestId: 'pol-other-v8',
    mode: 'unrestricted',
    requestedBy: 'uid-owner-1',
    requestedAt: NOW,
    confirmation: {
      kind: 'unrestricted_windows_v1',
      requestId: 'pol-other-v8',
      confirmedBy: 'uid-owner-1',
      confirmedAt: NOW,
    },
  };
  c.observePolicy(next);
  assert.equal(c.state().confirmationOpen, false,
    'смена версии закрывает открытое подтверждение');
  const result = await c.confirmUnrestricted();
  assert.equal(result.ok, false, 'без нового ручного прохода — отказ');
  assert.deepEqual(server.writes, []);
  // Новая сессия = новый контроллер: черновик/подтверждение в памяти не живут.
  const fresh = makeController(server);
  assert.equal(fresh.state().confirmationOpen, false);
  assert.equal(fresh.state().draftMode, null);
  assert.equal(fresh.state().confirmationChecked, false);
  const freshResult = await fresh.confirmUnrestricted();
  assert.equal(freshResult.ok, false, 'без повторного ручного прохода — отказ');
  assert.deepEqual(server.writes, []);
});

/* --- Билдер access для команд (A7.4.8/A7.9.1) ---------------------------------------------- */

function freshStatus() {
  return Object.assign({}, FIXTURE.status.applied, { updatedAt: NOW - 5000 });
}
function freshPresence() {
  return { deviceId: 'pc-main-01', heartbeatAt: NOW - 4000, agentSessionId: 'boot-19c2' };
}

test('A7.4.8: свежий совпавший ack даёт access для команды', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  c.observePolicy(FIXTURE.policy.medium);
  c.observeStatus(freshStatus());
  c.observePresence(freshPresence());
  const built = c.buildCommandAccess();
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.deepEqual(built.access, { policyVersion: 7, policyRequestId: 'pol-7f24' });
});

test('A7.4.8: запреты билдера — stale/нет ack/чужая сессия/не applied', () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  c.observePolicy(FIXTURE.policy.medium);
  c.observePresence(freshPresence());

  assert.equal(c.buildCommandAccess().ok, false, 'нет status — запрет');
  assert.equal(c.buildCommandAccess().reason, 'no-status');

  const applying = Object.assign({}, freshStatus(), { state: 'applying' });
  c.observeStatus(applying);
  assert.equal(c.buildCommandAccess().ok, false);
  assert.equal(c.buildCommandAccess().reason, 'not-applied');

  const mismatch = Object.assign({}, freshStatus(),
    { appliedVersion: 6, appliedRequestId: 'pol-old-6' });
  c.observeStatus(mismatch);
  assert.equal(c.buildCommandAccess().ok, false);
  assert.equal(c.buildCommandAccess().reason, 'version-mismatch');

  c.observeStatus(freshStatus());
  c.observePresence(Object.assign({}, freshPresence(), { agentSessionId: 'boot-другой' }));
  assert.equal(c.buildCommandAccess().ok, false);
  assert.equal(c.buildCommandAccess().reason, 'session-mismatch');

  c.observePresence(Object.assign({}, freshPresence(),
    { heartbeatAt: NOW - FRESH_MS - 1 }));
  assert.equal(c.buildCommandAccess().ok, false);
  assert.equal(c.buildCommandAccess().reason, 'stale-presence');

  c.observePresence(freshPresence());
  c.observeStatus(Object.assign({}, freshStatus(),
    { updatedAt: NOW - FRESH_MS - 1 }));
  assert.equal(c.buildCommandAccess().ok, false);
  assert.equal(c.buildCommandAccess().reason, 'stale-status');
});

/* --- Статусы (A7.3.6) ---------------------------------------------------------------------- */

function describe(state) {
  return describeAccessStatus(state, { serverNow: () => NOW, freshMs: FRESH_MS });
}

test('A7.3.6: «Выбран Medium — ожидаем ПК» после подтверждённого PUT до ack', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  await c.refresh();
  c.observePresence(freshPresence());
  c.setDraft('medium');
  const result = await c.applyDraft();
  assert.equal(result.ok, true, JSON.stringify(result));
  const out = describe(c.state().describeInput());
  assert.equal(out.text, 'Выбран Medium — ожидаем ПК');
});

test('A7.3.6: «Medium активен» только по свежему совпавшему ack', () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  c.observePolicy(FIXTURE.policy.medium);
  c.observeStatus(freshStatus());
  c.observePresence(freshPresence());
  const result = describe(c.state().describeInput());
  assert.equal(result.text, 'Medium активен');
  // Устаревший ack (старше 30 с) НЕ даёт «активен».
  c.observeStatus(Object.assign({}, freshStatus(),
    { updatedAt: NOW - FRESH_MS - 1 }));
  assert.notEqual(describe(c.state().describeInput()).text, 'Medium активен');
  // Чужая сессия в presence — тоже не «активен».
  c.observeStatus(freshStatus());
  c.observePresence(Object.assign({}, freshPresence(), { agentSessionId: 'boot-x' }));
  assert.notEqual(describe(c.state().describeInput()).text, 'Medium активен');
});

test('A7.3.6: «Safe активен; запуск Python недоступен: Docker не отвечает»', () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  c.observePolicy(FIXTURE.policy.safe);
  const status = Object.assign({}, freshStatus(),
    { effectiveMode: 'safe',
      observedVersion: FIXTURE.policy.safe.version,
      observedRequestId: FIXTURE.policy.safe.requestId,
      appliedVersion: FIXTURE.policy.safe.version,
      appliedRequestId: FIXTURE.policy.safe.requestId,
      docker: { state: 'unavailable', checkedAt: NOW - 1000 } });
  c.observeStatus(status);
  c.observePresence(freshPresence());
  const result = describe(c.state().describeInput());
  assert.equal(result.text, 'Safe активен; запуск Python недоступен: Docker не отвечает');
});

test('A7.3.6: устаревший heartbeat — «ПК не на связи; состояние применения неизвестно»', () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  c.observePolicy(FIXTURE.policy.medium);
  c.observeStatus(freshStatus());
  c.observePresence(Object.assign({}, freshPresence(),
    { heartbeatAt: NOW - FRESH_MS - 5000 }));
  const result = describe(c.state().describeInput());
  assert.equal(result.text, 'ПК не на связи; состояние применения неизвестно');
});

test('A7.3.7: нет политики — «Доступ не настроен»', () => {
  const server = makeTransportServer(null, null);
  const c = makeController(server);
  const result = describe(c.state().describeInput());
  assert.equal(result.text, 'Доступ не настроен');
  assert.equal(result.suggestSafe, true, 'предложен ручной выбор Safe');
});

test('A7.3.6: unsupported_contract — «Нужно обновление приложения» (старая offline PWA)', () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const c = makeController(server);
  c.observePolicy(FIXTURE.policy.safe);
  c.observeStatus(Object.assign({}, freshStatus(), { state: 'error', reason: 'unsupported_contract' }));
  c.observePresence(freshPresence());
  const result = describe(c.state().describeInput());
  assert.equal(result.text, 'Нужно обновление приложения');
});

/* --- Транспорт в firebase.js (A7.2.5) ------------------------------------------------------- */

function makeFirebase({ fetchImpl, now } = {}) {
  return createHarnessFirebase({
    config: {
      apiKey: 'test-api-key',
      databaseURL: 'https://telegram-claude-tunnel-default-rtdb.europe-west1.firebasedatabase.app',
      authDomain: 'telegram-claude-tunnel.firebaseapp.com',
      projectId: 'telegram-claude-tunnel',
    },
    fetchImpl: fetchImpl || (() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(null),
      headers: { get: () => null },
    })),
    storage: { _map: new Map(), getItem() { return null; }, setItem() {}, removeItem() {} },
    now,
  });
}

test('A7.2.5: readAccessPolicy — GET с заголовком X-Firebase-ETag:true', async () => {
  const calls = [];
  const fb = makeFirebase({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options: options || {} });
      return {
        ok: true, status: 200, json: () => Promise.resolve(FIXTURE.policy.medium),
        headers: { get: (n) => (String(n).toLowerCase() === 'etag' ? 'etag-42' : null) },
      };
    },
  });
  fb.setAccessTokenForTests('token-abc');
  const result = await fb.readAccessPolicy({ ownerUid: 'uid-owner-1', deviceId: 'pc-main-01' });
  assert.equal(result.ok, true);
  assert.equal(result.data.mode, 'medium');
  assert.equal(result.etag, 'etag-42');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /bridge\/access_policy\/uid-owner-1\/pc-main-01\.json/);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers['X-Firebase-ETag'], 'true');
});

test('A7.2.5: writeAccessPolicy — PUT+If-Match, НИКОГДА PATCH', async () => {
  const calls = [];
  const fb = makeFirebase({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options: options || {} });
      return {
        ok: true, status: 200, json: () => Promise.resolve(null),
        headers: { get: () => 'etag-next' },
      };
    },
  });
  fb.setAccessTokenForTests('token-abc');
  await fb.writeAccessPolicy({
    ownerUid: 'uid-owner-1', deviceId: 'pc-main-01',
    expectedEtag: 'etag-42', policy: FIXTURE.policy.medium,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'PUT', 'CAS — только PUT');
  assert.equal(calls[0].options.headers['If-Match'], 'etag-42');
  assert.match(calls[0].url, /bridge\/access_policy\/uid-owner-1\/pc-main-01\.json/);
  assert.match(calls[0].options.body, /"mode":"medium"/);
  // Без expectedEtag (первое создание) — всё равно PUT, без If-Match.
  await fb.writeAccessPolicy({
    ownerUid: 'uid-owner-1', deviceId: 'pc-main-01', policy: FIXTURE.policy.safe,
  });
  assert.equal(calls[1].options.method, 'PUT');
  assert.ok(!calls[1].options.headers['If-Match']);
});

test('A7.2.5: 412 — нормализованный конфликт, не молчаливый повтор', async () => {
  const fb = makeFirebase({
    fetchImpl: async () => ({
      ok: false, status: 412, json: () => Promise.resolve({ error: 'Precondition' }),
      headers: { get: () => null },
    }),
  });
  fb.setAccessTokenForTests('token-abc');
  await assert.rejects(
    () => fb.writeAccessPolicy({
      ownerUid: 'u', deviceId: 'd', expectedEtag: 'x', policy: FIXTURE.policy.safe,
    }),
    (err) => {
      assert.equal(err.code, 'conflict');
      return true;
    },
  );
});

test('A7.2.5: readAccessStatus — чтение узла устройства', async () => {
  const calls = [];
  const fb = makeFirebase({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true, status: 200, json: () => Promise.resolve(FIXTURE.status.applied),
        headers: { get: () => null },
      };
    },
  });
  fb.setAccessTokenForTests('token-abc');
  const result = await fb.readAccessStatus({ ownerUid: 'uid-owner-1', deviceId: 'pc-main-01' });
  assert.equal(result.ok, true);
  assert.equal(result.data.state, 'applied');
  assert.match(calls[0], /bridge\/access_status\/uid-owner-1\/pc-main-01\.json/);
});

/* --- SSE: put/patch/cancel/auth_revoked (A7.2.7) ---------------------------------------------- */

class FakeSSE {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = {};
    FakeSSE.sources.push(this);
  }
  close() { this.closed = true; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, payload) {
    for (const fn of this.listeners[type] || []) {
      fn({ data: JSON.stringify(payload) });
    }
  }
}
FakeSSE.sources = [];

test('A7.2.7: SSE put/patch — reducer {path,data} собирает полный снимок', async () => {
  FakeSSE.sources = [];
  const fb = makeFirebase();
  fb.setEventSourceImpl(FakeSSE);
  fb.setAccessTokenForTests('token-abc');
  const seen = [];
  const unsubscribe = fb.subscribe(
    { kind: 'access_policy', ownerUid: 'uid-owner-1', deviceId: 'pc-main-01' },
    (data) => seen.push(data),
  );
  assert.match(FakeSSE.sources[0].url, /bridge\/access_policy\/uid-owner-1\/pc-main-01\.json/);
  // put корня — snapshot-replacement
  FakeSSE.sources[0].emit('put', { path: '/', data: { version: 7 } });
  assert.deepEqual(seen[0], { version: 7 });
  // put ребёнка — точечная вставка, не замена всего
  FakeSSE.sources[0].emit('put', { path: '/extra', data: { deep: 1 } });
  assert.deepEqual(seen[1], { version: 7, extra: { deep: 1 } });
  // patch корня — слияние, не замена
  FakeSSE.sources[0].emit('patch', { path: '/', data: { version: 8 } });
  assert.deepEqual(seen[2], { version: 8, extra: { deep: 1 } });
  // patch ребёнка — слияние внутрь узла
  FakeSSE.sources[0].emit('patch', { path: '/extra', data: { deep: 2 } });
  assert.deepEqual(seen[3], { version: 8, extra: { deep: 2 } });
  // put null ребёнка — удаление
  FakeSSE.sources[0].emit('put', { path: '/extra', data: null });
  assert.deepEqual(seen[4], { version: 8 });
  unsubscribe();
  assert.equal(FakeSSE.sources[0].closed, true);
});

test('A7.2.7: SSE cancel/auth_revoked доходят до onError с кодом', async () => {
  FakeSSE.sources = [];
  const fb = makeFirebase();
  fb.setEventSourceImpl(FakeSSE);
  fb.setAccessTokenForTests('token-abc');
  const errors = [];
  fb.subscribe(
    { kind: 'access_status', ownerUid: 'uid-owner-1', deviceId: 'pc-main-01' },
    () => {},
    (err) => errors.push(err && err.code),
  );
  assert.match(FakeSSE.sources[0].url, /bridge\/access_status\/uid-owner-1\/pc-main-01\.json/);
  FakeSSE.sources[0].emit('cancel', { path: '/', data: 'Permission denied' });
  FakeSSE.sources[0].listeners['auth_revoked'][0]({ data: '{}' });
  assert.deepEqual(errors, ['cancel', 'auth_revoked']);
});

test('A7.2.7: совместимость — старый onmessage-фейк продолжает работать', async () => {
  FakeSSE.sources = [];
  const fb = makeFirebase();
  // Фейк БЕЗ addEventListener — как в существующих тестах harness-firebase.
  class LegacySSE {
    constructor(url) { this.url = url; this.closed = false; LegacySSE.sources.push(this); }
    close() { this.closed = true; }
  }
  LegacySSE.sources = [];
  fb.setEventSourceImpl(LegacySSE);
  fb.setAccessTokenForTests('token-abc');
  const seen = [];
  const unsubscribe = fb.subscribe(
    { kind: 'commands', ownerUid: 'uid-owner-1', deviceId: 'pc-main-01' },
    (data) => seen.push(data),
  );
  LegacySSE.sources[0].onmessage({ data: JSON.stringify({ cmd1: { type: 'run_task' } }) });
  assert.deepEqual(seen, [{ cmd1: { type: 'run_task' } }]);
  unsubscribe();
});

/* --- Команды: builders с access (A7.4.7/A7.4.8) ------------------------------------------- */

test('A7.4.7: run_task.params — ровно {actions, access}', () => {
  const accessCtx = { policyVersion: 7, policyRequestId: 'pol-7f24' };
  const params = buildModelTaskParams({
    text: 'Задача', settings: { a: 1 }, access: accessCtx,
  });
  assert.deepEqual(Object.keys(params).sort(), ['access', 'actions']);
  assert.deepEqual(params.access, accessCtx);
  assert.equal(params.access.policyVersion, 7, 'policyVersion — целое число');
  assert.equal(params.actions.length, 1);
  const verification = buildVerificationParams(accessCtx);
  assert.deepEqual(Object.keys(verification).sort(), ['access', 'actions']);
  assert.deepEqual(verification.access, accessCtx);
});

test('A7.4.8: без access — прежняя форма fixture (совместимость существующих callers)', () => {
  const verification = buildVerificationParams();
  assert.deepEqual(Object.keys(verification), ['actions'],
    'вызов без access сохраняет эталонный fixture-вид');
  const task = buildModelTaskParams({ text: 'x', settings: {} });
  assert.deepEqual(Object.keys(task), ['actions']);
});

test('A7.4.8: retry pending сохраняет СТАРЫЙ access-снимок (не повышает до новой версии)', async () => {
  const storageMap = new Map();
  const pending = {
    key: () => 'k',
    save: (made) => { storageMap.set('k', JSON.stringify(made)); return true; },
    load: () => {
      const raw = storageMap.get('k');
      return raw ? JSON.parse(raw) : null;
    },
    clear: () => storageMap.delete('k'),
  };
  const sentPayloads = [];
  let failSend = true;
  const sender = createTaskSender({
    makeCommand: async ({ ownerUid, deviceId, type, params }) => ({
      commandId: 'cmd-1',
      path: 'bridge/commands/' + ownerUid + '/' + deviceId + '/cmd-1',
      payload: { schemaVersion: 1, commandId: 'cmd-1', ownerUid, deviceId,
        issuer: 'owner', type, params, createdAt: 1, expiresAt: NOW + 60000,
        digest: 'd' },
    }),
    sendCommand: async (made) => {
      if (failSend) {
        failSend = false;
        throw new Error('сеть пропала');
      }
      sentPayloads.push(JSON.parse(JSON.stringify(made.payload)));
      return { ok: true };
    },
    readCommand: async () => ({ ok: false }),   // достоверно нет записи
    pending,
    now: () => NOW,
  });
  const oldAccess = { policyVersion: 7, policyRequestId: 'pol-7f24' };
  const first = await sender.send({
    ownerUid: 'u', deviceId: 'd', type: 'run_task',
    params: buildVerificationParams(oldAccess),
  });
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'failed', 'записи достоверно нет');
  assert.ok(!first.outcomeUnknown, 'исход известен: отказ');
  // Пока задача не отправлена, контроллер увидел НОВЫЙ ack (v8). Повтор
  // обязан отправить сохранённый made со старым access, не пересобрать.
  const newAccess = { policyVersion: 8, policyRequestId: 'pol-new-8' };
  const retried = await sender.retry();
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(sentPayloads.length, 1, 'повтор отправил сохранённый made');
  assert.deepEqual(sentPayloads[0].params.access, oldAccess,
    'повтор ушёл со старым снимком access');
  assert.notDeepEqual(sentPayloads[0].params.access, newAccess,
    'pending не повышен до новой версии');
});

/* --- View (A7.3) ---------------------------------------------------------------------------- */

function makeControl(extra = {}) {
  const listeners = {};
  const children = [];
  let ownText = '';
  const el = Object.assign({
    tagName: 'DIV',
    value: '',
    disabled: false,
    hidden: true,
    type: null,
    checked: false,
    listeners,
    children,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    appendChild(node) { children.push(node); node.parentNode = el; return node; },
    removeChild(node) {
      const i = children.indexOf(node);
      if (i !== -1) children.splice(i, 1);
      node.parentNode = null;
      return node;
    },
    insertBefore(node, ref) {
      const i = ref ? children.indexOf(ref) : -1;
      if (i === -1) children.push(node);
      else children.splice(i, 0, node);
      node.parentNode = el;
      return node;
    },
    get firstChild() { return children[0] || null; },
    get nextSibling() {
      if (!el.parentNode) return null;
      const siblings = el.parentNode.children;
      const i = siblings.indexOf(el);
      return siblings[i + 1] || null;
    },
    get textContent() {
      let out = ownText;
      for (const child of children) out += String(child.textContent || '');
      return out;
    },
    set textContent(v) { ownText = String(v); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (list) { const i = list.indexOf(fn); if (i !== -1) list.splice(i, 1); }
    },
    dispatch(type, event = {}) {
      event.target = event.target || el;
      event.preventDefault = event.preventDefault || (() => {});
      event.stopPropagation = event.stopPropagation ||
        (() => { event.stopped = true; });
      for (const fn of (listeners[type] || []).slice()) fn(event);
      // Всплытие к родителю, если слушатель не остановил распространение.
      if (!event.stopped && el.parentNode && el.parentNode.dispatch &&
          el.parentNode !== el) {
        const parentEvent = Object.assign({}, event, { target: el });
        el.parentNode.dispatch(type, parentEvent);
      }
    },
    setAttribute(name, value) { (el.attrs ||= {})[name] = String(value); },
    getAttribute(name) { return (el.attrs || {})[name] || null; },
    focus() { el.focused = true; },
    blur() {},
    focused: false,
  }, extra);
  return el;
}

function makeDoc() {
  return {
    createElement(tag) { return makeControl({ tagName: String(tag).toUpperCase() }); },
    activeElement: null,
  };
}

function makeViewHarness({ server, offline = false, authOk = true } = {}) {
  const doc = makeDoc();
  const form = makeControl({ tagName: 'FORM' });
  // Первая группа формы — «Модель» (field insertBefore целился ДО неё).
  const modelGroup = makeControl({ tagName: 'FIELDSET' });
  modelGroup.appendChild(makeControl({ tagName: 'LEGEND' }));
  form.appendChild(modelGroup);
  const chatHead = makeControl({ tagName: 'HEADER' });
  chatHead.appendChild(makeControl({ tagName: 'BUTTON' }));

  // Шпион на УСПЕШНУЮ запись: контроллер держит ссылку на server, подмена
  // свойства видна ему при каждом вызове; отклонённый PUT не записан.
  const writes = [];
  const originalWrite = server.writePolicy.bind(server);
  server.writePolicy = async function (args) {
    const result = await originalWrite(args);
    writes.push(JSON.parse(JSON.stringify(args.policy)));
    return result;
  };

  const controller = createAccessController({
    transport: server,
    ownerUid: 'uid-owner-1',
    deviceId: 'pc-main-01',
    serverNow: () => NOW,
    makeRequestId,
  });

  const announces = [];
  const openedSettings = [];
  const view = createAccessView({
    elements: { form, chatHead },
    deps: {
      doc,
      controller,
      isOffline: () => offline,
      isAuthOk: () => authOk,
      announce: (t) => announces.push(t),
      openSettings: () => openedSettings.push(1),
      serverNow: () => NOW,
    },
  });
  return { view, form, chatHead, controller, doc, writes, announces, openedSettings, modelGroup };
}

function findIn(root, id, out = []) {
  if (root.id === id) out.push(root);
  for (const child of root.children || []) findIn(child, id, out);
  return out;
}

test('A7.3.1: fieldset#harness-access-group построен ПЕРЕД группой моделей', () => {
  const h = makeViewHarness({ server: makeTransportServer(null, null) });
  h.view.mount();
  const group = findIn(h.form, 'harness-access-group')[0];
  assert.ok(group, 'fieldset#harness-access-group существует');
  assert.ok(group.classList.contains('harness-settings-group'),
    'класс harness-settings-group');
  assert.equal(h.form.children.indexOf(group), 0,
    'группа доступа стоит ПЕРЕД группой моделей');
  const legend = findIn(group, null)[0];
  const legends = group.children.filter((c) => c.tagName === 'LEGEND');
  assert.equal(legends.length, 1);
  assert.equal(legends[0].textContent, 'Доступ к ПК');
  for (const [id, text] of [
    ['harness-access-safe', 'Safe — спрашивать о каждом действии'],
    ['harness-access-medium', 'Medium — читать самостоятельно'],
    ['harness-access-unrestricted', 'Unrestricted — полный доступ без запросов'],
  ]) {
    const radios = findIn(group, id);
    assert.equal(radios.length, 1, id);
    const radio = radios[0];
    assert.equal(radio.tagName, 'INPUT');
    assert.equal(radio.type, 'radio');
    assert.equal(radio.name, 'harness-access-mode');
    const label = radio.parentNode;
    assert.ok(label.textContent.includes(text), text);
  }
  const status = findIn(group, 'harness-access-status')[0];
  assert.ok(status, 'p#harness-access-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  const error = findIn(group, 'harness-access-error')[0];
  assert.ok(error, 'p#harness-access-error');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.hidden, true, 'ошибка скрыта');
  const apply = findIn(group, 'harness-access-apply')[0];
  assert.ok(apply, 'button#harness-access-apply');
  assert.equal(apply.type, 'button');
  assert.equal(apply.textContent, 'Применить режим');
});

test('A7.3.3: скрытый div#harness-access-confirm с предупреждением и кнопками', () => {
  const h = makeViewHarness({ server: makeTransportServer(null, null) });
  h.view.mount();
  const group = findIn(h.form, 'harness-access-group')[0];
  const confirm = findIn(group, 'harness-access-confirm')[0];
  assert.ok(confirm, 'div#harness-access-confirm внутри fieldset');
  assert.equal(confirm.hidden, true, 'изначально скрыт');
  assert.ok(confirm.textContent.includes(
    'Код сможет работать напрямую в Windows с правами пользователя'), 'текст предупреждения');
  assert.ok(confirm.textContent.includes(
    'Запросов разрешения на действия не будет'));
  assert.ok(confirm.textContent.includes(
    'Уже выполненные действия нельзя отменить сменой режима'));
  const check = findIn(confirm, 'harness-access-confirm-check')[0];
  assert.equal(check.tagName, 'INPUT');
  assert.equal(check.type, 'checkbox');
  assert.ok(findIn(confirm, 'harness-access-confirm-check')[0].parentNode
    .textContent.includes('Понимаю риск прямого доступа к Windows'));
  const submit = findIn(confirm, 'harness-access-confirm-submit')[0];
  assert.equal(submit.type, 'button');
  assert.equal(submit.textContent, 'Включить полный доступ');
  const cancel = findIn(confirm, 'harness-access-confirm-cancel')[0];
  assert.equal(cancel.type, 'button');
  assert.equal(cancel.textContent, 'Отмена');
});

test('A7.3.2: шапка чата — button#harness-access-open.harness-secondary', () => {
  const h = makeViewHarness({ server: makeTransportServer(null, null) });
  h.view.mount();
  const open = findIn(h.chatHead, 'harness-access-open')[0];
  assert.ok(open, 'кнопка в шапке');
  assert.equal(open.type, 'button');
  assert.ok(open.classList.contains('harness-secondary'));
  // Открывает настройки с фокусом на legend (tabindex=-1).
  open.dispatch('click');
  assert.equal(h.openedSettings.length, 1);
  const group = findIn(h.form, 'harness-access-group')[0];
  const legend = group.children.filter((c) => c.tagName === 'LEGEND')[0];
  assert.equal(legend.focused, true, 'фокус на legend после открытия');
});

test('A7.3.4: radio меняет ТОЛЬКО черновик — записей нет', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const h = makeViewHarness({ server });
  h.view.mount();
  const group = findIn(h.form, 'harness-access-group')[0];
  const medium = findIn(group, 'harness-access-medium')[0];
  medium.checked = true;
  medium.dispatch('change');
  assert.equal(h.controller.state().draftMode, 'medium', 'черновик изменён');
  assert.deepEqual(h.writes, [], 'radio не пишет ничего');
  const status = findIn(group, 'harness-access-status')[0];
  assert.ok(status.textContent.length > 0, 'после выбора есть статус-текст');
});

test('A7.3.4: Apply safe — один CAS PUT', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const h = makeViewHarness({ server });
  h.view.mount();
  const group = findIn(h.form, 'harness-access-group')[0];
  const medium = findIn(group, 'harness-access-medium')[0];
  medium.checked = true;
  medium.dispatch('change');
  const apply = findIn(group, 'harness-access-apply')[0];
  apply.dispatch('click');
  await h.view.waitForIdle();
  assert.equal(h.writes.length, 1, 'один CAS PUT');
  assert.equal(h.writes[0].mode, 'medium');
  assert.equal(h.writes[0].version, FIXTURE.policy.safe.version + 1);
  const status = findIn(group, 'harness-access-status')[0];
  assert.equal(status.textContent, 'Выбран Medium — ожидаем ПК');
});

test('A7.3.4: Apply unrestricted — открывает предупреждение и НИЧЕГО не пишет', async () => {
  const server = makeTransportServer(FIXTURE.policy.medium, 'etag-0');
  const h = makeViewHarness({ server });
  h.view.mount();
  await h.view.waitForIdle();   // mount-read завершён: база для подтверждения
  const group = findIn(h.form, 'harness-access-group')[0];
  const unrestricted = findIn(group, 'harness-access-unrestricted')[0];
  unrestricted.checked = true;
  unrestricted.dispatch('change');
  const apply = findIn(group, 'harness-access-apply')[0];
  apply.dispatch('click');
  await h.view.waitForIdle();
  assert.deepEqual(h.writes, [], 'Apply unrestricted не пишет');
  const confirm = findIn(group, 'harness-access-confirm')[0];
  assert.equal(confirm.hidden, false, 'предупреждение открыто');
  // confirm-submit без галочки — отказ без записей
  const submit = findIn(confirm, 'harness-access-confirm-submit')[0];
  submit.dispatch('click');
  await h.view.waitForIdle();
  assert.deepEqual(h.writes, []);
  const error = findIn(group, 'harness-access-error')[0];
  assert.equal(error.hidden, false, 'показана ошибка');
  // С галочкой и вторым нажатием — CAS PUT с confirmation
  const check = findIn(confirm, 'harness-access-confirm-check')[0];
  check.checked = true;
  check.dispatch('change');
  submit.dispatch('click');
  await h.view.waitForIdle();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].mode, 'unrestricted');
  assert.equal(h.writes[0].confirmation.kind, 'unrestricted_windows_v1');
  assert.equal(confirm.hidden, true, 'блок закрыт после успеха');
});

test('A7.3.5: submitting — кнопки disabled до сверки ответа', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  let release;
  const gate = new Promise((res) => { release = res; });
  const slowServer = Object.assign({}, server, {
    async writePolicy(args) {
      await gate;
      return server.writePolicy(args);
    },
  });
  const h = makeViewHarness({ server: slowServer });
  h.view.mount();
  const group = findIn(h.form, 'harness-access-group')[0];
  const medium = findIn(group, 'harness-access-medium')[0];
  medium.checked = true;
  medium.dispatch('change');
  const apply = findIn(group, 'harness-access-apply')[0];
  apply.dispatch('click');
  // Синхронно после клика (до первого await): кнопки уже disabled.
  assert.equal(apply.disabled, true, 'Apply disabled синхронно');
  assert.equal(findIn(group, 'harness-access-confirm-submit')[0].disabled, true,
    'confirm-submit disabled');
  release();
  await h.view.waitForIdle();
  assert.equal(apply.disabled, false, 'после ответа кнопки разблокированы');
});

test('A7.3.5: offline запрещает применение без записи', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const h = makeViewHarness({ server, offline: true });
  h.view.mount();
  const group = findIn(h.form, 'harness-access-group')[0];
  const medium = findIn(group, 'harness-access-medium')[0];
  medium.checked = true;
  medium.dispatch('change');
  const apply = findIn(group, 'harness-access-apply')[0];
  apply.dispatch('click');
  await h.view.waitForIdle();
  assert.deepEqual(h.writes, [], 'offline — ни одной записи');
  const error = findIn(group, 'harness-access-error')[0];
  assert.equal(error.hidden, false);
  assert.ok(error.textContent.length > 0);
});

test('A7.3.5: auth-expired запрещает применение', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const h = makeViewHarness({ server, authOk: false });
  h.view.mount();
  const group = findIn(h.form, 'harness-access-group')[0];
  const medium = findIn(group, 'harness-access-medium')[0];
  medium.checked = true;
  medium.dispatch('change');
  findIn(group, 'harness-access-apply')[0].dispatch('click');
  await h.view.waitForIdle();
  assert.deepEqual(h.writes, []);
  assert.equal(findIn(group, 'harness-access-error')[0].hidden, false);
});

test('A7.3.7: mount — только чтение; unrestricted не затирается safe', async () => {
  const server = makeTransportServer(FIXTURE.policy.unrestricted, 'etag-0');
  const h = makeViewHarness({ server });
  h.view.mount();
  await h.view.waitForIdle();   // render после mount-read
  assert.deepEqual(h.writes, [], 'mount не пишет ничего');
  const group = findIn(h.form, 'harness-access-group')[0];
  assert.equal(findIn(group, 'harness-access-unrestricted')[0].checked, true,
    'radio отражает текущую политику');
  assert.equal(findIn(group, 'harness-access-safe')[0].checked, false,
    'mount НЕ выбирает safe поверх unrestricted');
  assert.equal(findIn(group, 'harness-access-status')[0].textContent,
    'Политика задана: Unrestricted; состояние применения неизвестно',
    'без свежего ack статус честный — «активен» не заявляется');
});

test('A7.3.7: mount без политики — «Доступ не настроен», radio не выбраны', async () => {
  const server = makeTransportServer(null, null);
  const h = makeViewHarness({ server });
  h.view.mount();
  await h.view.waitForIdle();   // render после mount-read
  const group = findIn(h.form, 'harness-access-group')[0];
  const status = findIn(group, 'harness-access-status')[0];
  assert.equal(status.textContent, 'Доступ не настроен');
  for (const id of ['harness-access-safe', 'harness-access-medium',
    'harness-access-unrestricted']) {
    assert.equal(findIn(group, id)[0].checked, false);
  }
});

test('A7.3.6: view показывает «Medium активен» по свежему ack', async () => {
  const server = makeTransportServer(FIXTURE.policy.medium, 'etag-0');
  const h = makeViewHarness({ server });
  h.view.mount();
  await h.view.waitForIdle();   // mount-read завершён до наблюдений
  h.controller.observeStatus(freshStatus());
  h.controller.observePresence(freshPresence());
  const group = findIn(h.form, 'harness-access-group')[0];
  assert.equal(findIn(group, 'harness-access-status')[0].textContent,
    'Medium активен');
  assert.equal(findIn(group, 'harness-access-medium')[0].checked, true);
});

test('A7.3.5: timeout в view — «Исход изменения неизвестен»', async () => {
  const server = makeTransportServer(FIXTURE.policy.safe, 'etag-0');
  const h = makeViewHarness({ server });
  h.view.mount();
  await h.view.waitForIdle();   // mount-read успешен, затем сеть пропала
  server.deadNetwork = true;
  const group = findIn(h.form, 'harness-access-group')[0];
  const medium = findIn(group, 'harness-access-medium')[0];
  medium.checked = true;
  medium.dispatch('change');
  findIn(group, 'harness-access-apply')[0].dispatch('click');
  await h.view.waitForIdle();
  const status = findIn(group, 'harness-access-status')[0];
  assert.equal(status.textContent, 'Исход изменения неизвестен');
  assert.equal(h.writes.length, 0, 'запись не прошла (сеть мертва)');
});

/* --- sw.js и стили (A7.9.4/A7.3.8) ----------------------------------------------------------- */

test('A7.9.4: sw.js — версия кеша v63, access.js/access-view.js в ASSETS', () => {
  const source = readFileSync(SW_PATH, 'utf8');
  assert.match(source, /const CACHE = 'youplanner-v63';/);
  assert.match(source, /v62 \(v61 -> v62\)/, 'комментарий по конвенции версий');
  assert.match(source, /'\.\/js\/harness\/access\.js'/, 'access.js в precache');
  assert.match(source, /'\.\/js\/harness\/access-view\.js'/, 'access-view.js в precache');
});

test('A7.3.8: стили группы доступа в styles/harness.css по токенам', () => {
  const source = readFileSync(CSS_PATH, 'utf8');
  for (const selector of ['#harness-access-group', '#harness-access-status',
    '#harness-access-error', '#harness-access-apply', '#harness-access-confirm',
    '#harness-access-open']) {
    assert.ok(source.includes(selector), 'стиль для ' + selector);
  }
  assert.match(source, /#harness-access-group[\s\S]*?--text[\s\S]*?--surface-card/,
    'токены --text/--surface-card в группе');
  assert.match(source, /#harness-access-confirm\s*\{[^}]*--surface-muted/,
    'предупреждение на --surface-muted');
  assert.match(source, /#harness-access-apply\s*\{[^}]*--accent[^}]*--on-accent/,
    'primary — --accent/--on-accent');
  // touch-зоны 44px для радио-подписей и кнопок группы
  assert.match(source, /min-height:\s*44px/);
});

/* --- Привязка в index.js (A7.4.8, статические проверки) -------------------------------------- */

test('A7.4.8: index.js — access фиксируется со settings до первого await', () => {
  const source = readFileSync(INDEX_PATH, 'utf8');
  assert.match(source, /buildCommandAccess|accessForCommand/,
    'index.js получает access от контроллера');
  const sendTask = source.match(/async function sendTask\([\s\S]*?\n  \}/);
  assert.ok(sendTask, 'sendTask найдена');
  const body = sendTask[0];
  const accessPos = body.search(/buildCommandAccess|accessForCommand|accessSnapshot/);
  const awaitPos = body.indexOf('await');
  assert.ok(accessPos !== -1, 'в sendTask есть снимок access');
  assert.ok(awaitPos === -1 || accessPos < awaitPos,
    'access строится ДО первого await');
  assert.match(source, /kind: 'access_policy'/, 'подписка на access_policy');
  assert.match(source, /kind: 'access_status'/, 'подписка на access_status');
  assert.match(source, /agentSessionId/, 'проверка сессии presence');
});
