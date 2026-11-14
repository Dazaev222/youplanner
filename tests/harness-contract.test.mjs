// F6.3 (Раздел 6 ТЗ): контракт task vs actions. Тесты пишутся ДО реализации
// (RED): js/harness/commands.js ещё нет.
//
// Источник истины — согласованный контракт координатора
// (_ci/contract/contract.json): fixtures с эталонными digest (проверочный
// 5a6b…, model_task ee004fd4…), digest = canonicalJson({schemaVersion, type,
// params, deviceId}) → SHA-256 hex. makeCommand (firebase.js) остаётся
// единственным владельцем envelope+digest; builder — чистая функция params.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS_PATH = join(ROOT, 'js', 'harness', 'commands.js');
const FIREBASE_PATH = join(ROOT, 'js', 'harness', 'firebase.js');
const INDEX_PATH = join(ROOT, 'js', 'harness', 'index.js');

assert.ok(existsSync(COMMANDS_PATH),
  'js/harness/commands.js не существует — реализация не начата (ожидаются RED)');

const commands = await import('file://' + COMMANDS_PATH);
const firebase = await import('file://' + FIREBASE_PATH);

const { canonicalJson } = firebase;
const {
  VERIFICATION_LABEL, buildModelTaskParams, buildVerificationParams,
  textFromCommandParams, freezeSettingsSnapshot, createPendingCommandStore,
  createTaskSender,
} = commands;

const CONTRACT_PATH = join('C:', 'Users', 'Admin', '.zcode', 'workspace',
  'draft-5a1189e6-9e65-44be-af5b-e40246c98ac4', '_ci', 'contract', 'contract.json');
const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const DEVICE_ID = CONTRACT.deviceId;

// Тот же алгоритм, что в firebase.js: canonicalJson → SHA-256 hex.
function digestOf(params) {
  return createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, type: 'run_task', params, deviceId: DEVICE_ID }))
    .digest('hex');
}

/* --- Эталонные digest контракта ------------------------------------------------- */

test('F6.3: проверочный fixture — digest совпадает с контрактом (5a6b4653…)', () => {
  const params = CONTRACT.fixtures['проверочный'].params;
  assert.equal(digestOf(params),
    '5a6b4653644737eeffbfff1d6a1b8620c5e09874666dc46799609a7422bcebf0');
  const built = buildVerificationParams();
  assert.deepEqual(built, params,
    'builder проверочного режима даёт ровно fixture-параметры');
  assert.equal(digestOf(built), CONTRACT.fixtures['проверочный'].digest);
});

test('F6.3: fixture model_task — digest совпадает с контрактом (ee004fd4…)', () => {
  const fixtureParams = CONTRACT.fixtures.model_task.params;
  const settings = JSON.parse(JSON.stringify(
    fixtureParams.actions[0].params.settings));
  const built = buildModelTaskParams({
    text: fixtureParams.actions[0].params.text,
    settings,
  });
  assert.deepEqual(built, fixtureParams,
    'builder обычной задачи даёт ровно fixture-параметры (кириллица/persona)');
  assert.equal(digestOf(built),
    'ee004fd4b8f5d46aa040b1a0fcd67c1fb9c5a62fcfb2a184e5490a332d8ea284');
});

/* --- Builder обычной задачи --------------------------------------------------------- */

const SETTINGS = {
  schemaVersion: 1,
  revision: '00000000-0000-4000-8000-000000000000',
  provider: 'opencode',
  modelId: 'tooken/glm-5.3-flash',
  reasoning: 'medium',
  contextTokens: 32000,
  maxOutputTokens: 2048,
  persona: { preferredName: 'Хозяин', about: '', responseStyle: '' },
};

test('F6.3: builder — params.actions с model_task, params.task отсутствует', () => {
  const params = buildModelTaskParams({ text: 'Собери статистику', settings: SETTINGS });
  assert.equal(params.task, undefined, 'params.task как отправляемое удалено');
  assert.equal(params.actions.length, 1);
  const action = params.actions[0];
  assert.equal(action.actionId, 'act-1');
  assert.equal(action.tool, 'model_task');
  assert.equal(action.params.text, 'Собери статистику');
  assert.deepEqual(action.params.settings, SETTINGS,
    'в params уходит снимок настроек формата F6.2.5 целиком');
});

test('F6.3: builder не даёт мутировать снимок после построения (deep copy)', () => {
  const settings = JSON.parse(JSON.stringify(SETTINGS));
  const params = buildModelTaskParams({ text: 'задача', settings });
  settings.persona.preferredName = 'Изменено после построения';
  settings.reasoning = 'high';
  assert.equal(params.actions[0].params.settings.persona.preferredName, 'Хозяин');
  assert.equal(params.actions[0].params.settings.reasoning, 'medium');
});

test('F6.3: freezeSettingsSnapshot — изменение active после снятия не меняет snapshot', () => {
  const active = JSON.parse(JSON.stringify(SETTINGS));
  const snapshot = freezeSettingsSnapshot(active);
  active.modelId = 'opencode/qwen3.8-flash';
  active.persona.about = 'поздняя правка';
  assert.equal(snapshot.modelId, 'tooken/glm-5.3-flash');
  assert.equal(snapshot.persona.about, '');
  assert.equal(JSON.stringify(snapshot), JSON.stringify(SETTINGS));
});

/* --- feedMessages: чтение текста -------------------------------------------------------- */

test('F6.3: feedMessages читает actions[].params.text у model_task', () => {
  const params = buildModelTaskParams({ text: 'Текст задачи', settings: SETTINGS });
  assert.equal(textFromCommandParams(params, 'run_task'), 'Текст задачи');
});

test('F6.3: проверочный показывается меткой «Проверка контура — запись строки»', () => {
  const params = buildVerificationParams();
  assert.equal(textFromCommandParams(params, 'run_task'), VERIFICATION_LABEL);
  assert.match(VERIFICATION_LABEL, /Проверка контура — запись строки/);
  assert.notEqual(textFromCommandParams(params, 'run_task'), 'Проверка контура Harness',
    'не голый текст заглушки и не ответ модели');
});

test('F6.3: legacy params.task отображается, но не переисполняется', () => {
  assert.equal(textFromCommandParams({ task: 'старая запись' }, 'run_task'), 'старая запись');
  assert.equal(textFromCommandParams({}, 'run_task'), 'run_task');
});

/* --- pending-made: память+localStorage ДО сетевого PUT ----------------------------------- */

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    _map: map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function makeMade(seq = 1) {
  return {
    commandId: 'cmd-' + seq,
    path: 'bridge/commands/uid-1/pc-main-01/cmd-' + seq,
    payload: {
      schemaVersion: 1, commandId: 'cmd-' + seq, ownerUid: 'uid-1',
      deviceId: 'pc-main-01', issuer: 'owner', type: 'run_task',
      params: buildVerificationParams(), createdAt: 1000, expiresAt: 91000,
      digest: 'a'.repeat(64),
    },
  };
}

test('F6.3: pending store — save/load/clear, ключ по owner/device', () => {
  const storage = makeStorage();
  const pending = createPendingCommandStore({
    storage, ownerUid: 'uid-1', deviceId: 'pc-main-01',
  });
  assert.match(pending.key(), /^harness\.pendingCommand\.uid-1\.pc-main-01$/);
  assert.equal(pending.load(), null, 'пусто без записи');
  const made = makeMade();
  assert.equal(pending.save(made), true);
  assert.deepEqual(pending.load(), made);
  pending.clear();
  assert.equal(pending.load(), null);
});

test('F6.3: pending store — другой владелец не видит чужую запись', () => {
  const storage = makeStorage();
  const a = createPendingCommandStore({ storage, ownerUid: 'uid-1', deviceId: 'pc-main-01' });
  const b = createPendingCommandStore({ storage, ownerUid: 'uid-2', deviceId: 'pc-main-01' });
  a.save(makeMade());
  assert.equal(b.load(), null);
});

test('F6.3: pending store — битая запись не принимается', () => {
  const storage = makeStorage();
  const pending = createPendingCommandStore({ storage, ownerUid: 'uid-1', deviceId: 'pc-main-01' });
  storage.setItem(pending.key(), '{битый json');
  assert.equal(pending.load(), null, 'битая запись отброшена');
  storage.setItem(pending.key(), JSON.stringify({ foo: 1 }));
  assert.equal(pending.load(), null, 'запись без commandId/payload отброшена');
});

/* --- Отправка: pending ДО PUT, неизвестный исход, повтор ---------------------------------- */

function makeSenderHarness({ putResult, readResult, now = () => 5000 } = {}) {
  const calls = [];
  let seq = 0;
  const storage = makeStorage();
  const pending = createPendingCommandStore({
    storage, ownerUid: 'uid-1', deviceId: 'pc-main-01',
  });
  const sender = createTaskSender({
    now,
    pending,
    makeCommand: async ({ ownerUid, deviceId, type, params, serverTime }) => {
      seq += 1;
      calls.push(['make', seq]);
      return makeMade(seq);
    },
    sendCommand: async (made) => {
      calls.push(['put', made.commandId]);
      if (putResult === 'error') throw new Error('нет связи');
    },
    readCommand: async (path) => {
      calls.push(['read', path]);
      return readResult || { ok: false, data: null };
    },
  });
  return { sender, calls, pending, storage };
}

test('F6.3: send — pending сохранён ДО сетевого PUT', async () => {
  const h = makeSenderHarness();
  const result = await h.sender.send({
    ownerUid: 'uid-1', deviceId: 'pc-main-01', params: buildVerificationParams(),
    serverTime: 1000,
  });
  assert.equal(result.ok, true);
  const putAt = h.calls.findIndex(([kind]) => kind === 'put');
  const pendingAt = h.calls.findIndex(([kind]) => kind === 'make');
  assert.ok(pendingAt !== -1 && putAt !== -1 && pendingAt < putAt,
    'makeCommand до PUT; pending сохраняется до сети');
  assert.equal(h.pending.load(), null,
    'после успешной отправки pending снят');
});

test('F6.3: отказ записи pending блокирует начало отправки (без PUT, без потери ID)', async () => {
  const h = makeSenderHarness();
  h.storage.setItem = () => {
    const err = new Error('quota');
    err.name = 'QuotaExceededError';
    throw err;
  };
  await assert.rejects(
    () => h.sender.send({ ownerUid: 'uid-1', deviceId: 'pc-main-01',
      params: buildVerificationParams(), serverTime: 1000 }),
    (err) => {
      assert.match(err.message, /Не удалось сохранить|отправка не начата/);
      return true;
    },
  );
  assert.equal(h.calls.some(([kind]) => kind === 'put'), false,
    'PUT не начат без сохранённого pending');
});

test('F6.3: потерянный ответ PUT + чтение подтверждает — тот же commandId', async () => {
  const h = makeSenderHarness();
  let seq = 0;
  const made = makeMade(1);
  const sender = createTaskSender({
    now: () => 5000,
    pending: h.pending,
    makeCommand: async () => { seq += 1; return made; },
    sendCommand: async () => { throw new Error('запрос прерван по таймауту'); },
    readCommand: async () => ({ ok: true, data: made.payload }),
  });
  const result = await sender.send({
    ownerUid: 'uid-1', deviceId: 'pc-main-01',
    params: buildVerificationParams(), serverTime: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.commandId, made.commandId, 'новый ID не создаётся');
  assert.equal(h.pending.load(), null);
});

test('F6.3: неизвестный исход — pending сохранён, карточка unknown, ID не удалён', async () => {
  const h = makeSenderHarness({
    putResult: 'error',
    readResult: { ok: false, error: new Error('нет связи') },
  });
  const result = await h.sender.send({
    ownerUid: 'uid-1', deviceId: 'pc-main-01',
    params: buildVerificationParams(), serverTime: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcomeUnknown, true);
  assert.ok(result.made && result.made.commandId, 'made возвращён — единственный ID не потерян');
  assert.ok(h.pending.load(), 'pending не удалён в catch');
});

test('F6.3: чтение доказало отсутствие записи — честный отказ (draft остаётся)', async () => {
  const h = makeSenderHarness({
    putResult: 'error',
    readResult: { ok: false, data: null },
  });
  const result = await h.sender.send({
    ownerUid: 'uid-1', deviceId: 'pc-main-01',
    params: buildVerificationParams(), serverTime: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.ok(result.error, 'причина показывается наверху');
});

/* --- Повтор: readCommand того же path/digest ---------------------------------------------- */

test('F6.3: retry — запись найдена → сверка digest, новый PUT не нужен', async () => {
  const made = makeMade();
  const h = makeSenderHarness({
    readResult: { ok: true, data: made.payload },
  });
  h.pending.save(made);
  const result = await h.sender.retry();
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.commandId, made.commandId);
  assert.equal(h.calls.some(([kind]) => kind === 'put'), false,
    'повтор при найденной записи не пишет заново');
  assert.equal(h.pending.load(), null);
});

test('F6.3: retry — достоверно нет записи → повтор ТОГО ЖЕ made, не новый ID', async () => {
  const made = makeMade();
  const h = makeSenderHarness({
    readResult: { ok: false, data: null },
  });
  h.pending.save(made);
  const result = await h.sender.retry();
  assert.equal(result.ok, true);
  assert.equal(result.resent, true);
  assert.equal(result.commandId, made.commandId, 'commandId прежний');
  const putCalls = h.calls.filter(([kind]) => kind === 'put');
  assert.equal(putCalls.length, 1);
  assert.equal(h.pending.load(), null);
});

test('F6.3: retry при сетевой ошибке чтения — исход остаётся неизвестным', async () => {
  const made = makeMade();
  const h = makeSenderHarness({
    readResult: { ok: false, error: new Error('нет связи') },
  });
  h.pending.save(made);
  const result = await h.sender.retry();
  assert.equal(result.ok, false);
  assert.equal(result.outcomeUnknown, true);
  assert.ok(h.pending.load(), 'pending сохранён до подтверждённого исхода');
});

test('F6.3: retry после expiresAt — повтор отказан, автоповтора нет', async () => {
  const made = makeMade();
  const h = makeSenderHarness({ now: () => made.payload.expiresAt + 1 });
  h.pending.save(made);
  const result = await h.sender.retry();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
  assert.equal(h.calls.some(([kind]) => kind === 'put'), false);
});

test('F6.3: retry без pending — отказ', async () => {
  const h = makeSenderHarness();
  const result = await h.sender.retry();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

/* --- Проводка index.js --------------------------------------------------------------------- */

test('F6.3: index.js — params.task как отправляемое удалено, builder подключён', () => {
  const source = readFileSync(INDEX_PATH, 'utf8');
  assert.doesNotMatch(source, /params:\s*\{\s*task:/,
    'sendTask больше не строит params.task');
  assert.match(source, /buildModelTaskParams/, 'обычная задача через builder model_task');
  assert.match(source, /buildVerificationParams/, 'проверочный режим через builder');
  assert.match(source, /createTaskSender/, 'sendTask идёт через sender (pending ДО PUT)');
  assert.match(source, /createPendingCommandStore/, 'pending-made по owner/device');
  assert.match(source, /freezeSettingsSnapshot/, 'deep-copy снимка настроек');
  assert.match(source, /UNKNOWN_OUTCOME_TEXT|Исход отправки неизвестен/,
    'карточка неизвестного исхода');
  assert.ok(source.includes(VERIFICATION_LABEL),
    'метка проверочного режима в меню устройств');
});

test('F6.3: sendTask — снимок настроек снимается ДО первого await', () => {
  const source = readFileSync(INDEX_PATH, 'utf8');
  const sendAt = source.indexOf('async function sendTask');
  const nextMatch = /\n  (?:async )?function /.exec(source.slice(sendAt + 10));
  const body = source.slice(sendAt,
    nextMatch ? sendAt + 10 + nextMatch.index : source.length);
  const snapshotAt = body.search(/freezeSettingsSnapshot|activeSettingsSnapshot|buildModelTaskParams/);
  assert.ok(snapshotAt !== -1, 'в sendTask нет снятия снимка');
  // Асинхронных шагов до снятия снимка быть не должно: ни одного await
  // раньше строки снимка (если await вообще есть в теле sendTask).
  const bodyBeforeSnapshot = body.slice(0, snapshotAt);
  assert.doesNotMatch(bodyBeforeSnapshot, /\bawait\b/,
    'deep-copy настроек ДО первого await (F6.3.7)');
});

test('F6.3: кнопка повтора отправки в dock (index.html + проводка)', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="harness-retry-send"/,
    'в dock есть кнопка повторной отправки для неизвестного исхода');
  const source = readFileSync(INDEX_PATH, 'utf8');
  assert.match(source, /harness-retry-send/);
});
