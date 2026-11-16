// Правила RTDB для diaryV1 (ТЗ §3, §4, §11).
//
// Эмулятор здесь не запускается: в окружении нет Java, а ставить системный
// runtime без согласия владельца нельзя. Тест проверяет именно текст
// опубликованных правил, чтобы нельзя было молча ослабить create-only,
// открыть запись на предке или потерять проверку цепочки правок.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = '$ownerUid';
const JOURNAL = '$journalId';

function readRulesFile(name) {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8')).rules;
}

function diaryRulesOf(rules) {
  const diary = rules.diaryV1;
  assert.ok(diary && typeof diary === 'object', 'в правилах нет узла diaryV1');
  const owner = diary[OWNER];
  assert.ok(owner && typeof owner === 'object', `diaryV1/${OWNER} отсутствует`);
  const journal = owner.journals && owner.journals[JOURNAL];
  assert.ok(journal && typeof journal === 'object', `diaryV1/${OWNER}/journals/${JOURNAL} отсутствует`);
  return { diary, owner, journal };
}

function hasGrant(node, effect) {
  return node && Object.prototype.hasOwnProperty.call(node, effect);
}

function writeRule(node) {
  assert.ok(hasGrant(node, '.write'), 'у листа нет .write');
  return String(node['.write']);
}

test('removeTrigger разрешён только как true в editEvent без triggerId', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const changes = journal.mutations.$entityKey.$predecessorOperationId.changes;
  assert.ok(changes['.validate'].includes("newData.hasChild('removeTrigger')"));
  assert.equal(changes.removeTrigger?.['.validate'], "newData.val() === true && newData.parent().parent().child('type').val() === 'editEvent' && !newData.parent().hasChild('triggerId')");
});

test('diaryV1 существует в публичных и локальных правилах', () => {
  for (const name of ['database.rules.json', 'database.rules.local.json']) {
    const rules = readRulesFile(name);
    const { diary } = diaryRulesOf(rules);
    assert.ok(diary, `${name}: diaryV1 не найден`);
  }
});

test('на diaryV1, ownerUid, journals и journalId нет разрешающей .write', () => {
  const { diary, owner, journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  for (const [node, value] of [
    ['diaryV1', diary],
    [`diaryV1/${OWNER}`, owner],
    [`diaryV1/${OWNER}/journals`, owner.journals],
    [`diaryV1/${OWNER}/journals/${JOURNAL}`, journal],
  ]) {
    assert.equal(hasGrant(value, '.write'), false,
      `${node}: разрешающая .write на предке наследуется вниз и не отменяется дочерним запретом`);
  }
});

test('чтение diaryV1 разрешено только владельцу и только на его uid', () => {
  const { diary, owner } = diaryRulesOf(readRulesFile('database.rules.json'));
  assert.equal(hasGrant(diary, '.read'), false,
    'read на diaryV1 открыл бы перебор чужих uid');
  assert.equal(owner['.read'],
    'auth != null && auth.uid === $ownerUid && auth.uid === "OWNER_UID"',
    'read владельца обязан сравнивать auth.uid с $ownerUid и с закреплённым uid');
});

test('каждый лист пишется только create-only и только владельцем', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const leaves = [
    ['initialization', journal.initialization],
    [`events/$eventId`, journal.events && journal.events.$eventId],
    [`triggerCreations/$triggerId`, journal.triggerCreations && journal.triggerCreations.$triggerId],
    [`mutations/$entityKey/$predecessorOperationId`,
      journal.mutations && journal.mutations.$entityKey
      && journal.mutations.$entityKey.$predecessorOperationId],
    [`analyses/$analysisId`, journal.analyses && journal.analyses.$analysisId],
  ];
  for (const [name, node] of leaves) {
    assert.ok(node && typeof node === 'object', `нет листа ${name}`);
    const expression = writeRule(node);
    assert.match(expression, /auth\s*!=\s*null/, `${name}: нет проверки сессии`);
    assert.match(expression, /auth\.uid\s*===\s*\$(ownerUid|ownerUid)/,
      `${name}: запись не привязана к $ownerUid`);
    assert.match(expression, /!data\.exists\(\)/, `${name}: нет запрета перезаписи`);
    assert.match(expression, /newData\.exists\(\)/, `${name}: нет запрета удаления`);
  }
});

test('initialization проверяет id, версию, время и серверный timestamp', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const node = journal.initialization;
  const text = String(node['.validate']);
  for (const fragment of [
    "newData.child('schemaVersion').val() === 1",
    "newData.child('journalId').val() === $journalId",
    "newData.child('startedAtMs').isNumber()",
    "newData.child('initialDurationMs').isNumber()",
    "newData.child('createdAtMs').isNumber()",
    "newData.child('acceptedAtMs').val() === now",
  ]) {
    assert.ok(text.includes(fragment), `initialization.validate: нет «${fragment}»`);
  }
});

test('events проверяют путь, причину/триггер и запрет категории без политики', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const text = String(journal.events.$eventId['.validate']);
  for (const fragment of [
    "newData.child('eventId').val() === $eventId",
    "newData.child('schemaVersion').val() === 1",
    "newData.child('acceptedAtMs').val() === now",
    "newData.child('triggerId').exists()",
    "newData.child('reason').val().length > 0",
    "newData.child('categoryPolicyOperationId').val() !== 'initial'",
  ]) {
    assert.ok(text.includes(fragment), `events.$eventId.validate: нет «${fragment}»`);
  }
});

test('triggerCreations проверяют id, имя, версию и timestamp', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const text = String(journal.triggerCreations.$triggerId['.validate']);
  for (const fragment of [
    "newData.child('triggerId').val() === $triggerId",
    "newData.child('schemaVersion').val() === 1",
    "newData.child('name').isString()",
    "newData.child('acceptedAtMs').val() === now",
    "matches(/^trigger-/)",
  ]) {
    assert.ok(text.includes(fragment), `triggerCreations.$triggerId.validate: нет «${fragment}»`);
  }
});

test('mutations доказывают непосредственного предшественника и запрещают initial', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const node = journal.mutations.$entityKey.$predecessorOperationId;
  const text = String(node['.validate']);
  for (const fragment of [
    "newData.child('predecessorOperationId').val() === $predecessorOperationId",
    "newData.child('operationId').val() !== 'initial'",
    "newData.child('operationId').val() !== $predecessorOperationId",
    "newData.child('entityKey').val() === $entityKey",
    "newData.child('predecessorSlot').exists()",
    "child(newData.child('predecessorSlot').val())",
    "child('operationId').val() === $predecessorOperationId",
    "root.child('diaryV1')",
  ]) {
    assert.ok(text.includes(fragment), `mutations.validate: нет «${fragment}»`);
  }
  assert.ok(text.includes("newData.child('type').val() === 'editEvent'"),
    'mutations.validate: нет связи entityKey event_ → editEvent');
  assert.ok(text.includes("newData.child('type').val() === 'renameTrigger'"),
    'mutations.validate: нет связи entityKey trigger_ → renameTrigger');
  assert.ok(text.includes("newData.child('type').val() === 'applyCategoryPolicy'"),
    'mutations.validate: нет связи entityKey categoryPolicy → applyCategoryPolicy');
});

test('mutations проверяют наличие целевой сущности и допустимый fingerprint', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const text = String(journal.mutations.$entityKey.$predecessorOperationId['.validate']);
  assert.ok(text.includes("child('events').child("),
    'mutations.validate: не проверяется наличие события');
  assert.ok(text.includes("child('triggerCreations').child("),
    'mutations.validate: не проверяется наличие триггера');
  assert.ok(text.includes('^sha256:[0-9a-f]{64}$'),
    'mutations.validate: нет проверки basisFingerprint');
});

test('analyses проверяют id, fingerprint источника и timestamp', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const text = String(journal.analyses.$analysisId['.validate']);
  for (const fragment of [
    "newData.child('analysisId').val() === $analysisId",
    "newData.child('schemaVersion').val() === 1",
    "newData.child('sourceFingerprint').val().matches(/^sha256:[0-9a-f]{64}$/)",
    "newData.child('coveredEventIds').hasChildren()",
    "newData.child('model').isString()",
    "newData.child('acceptedAtMs').val() === now",
  ]) {
    assert.ok(text.includes(fragment), `analyses.$analysisId.validate: нет «${fragment}»`);
  }
});

test('неизвестные поля запрещены на каждом уровне записи', () => {
  const { journal } = diaryRulesOf(readRulesFile('database.rules.json'));
  const records = [
    ['initialization', journal.initialization],
    ['events/$eventId', journal.events.$eventId],
    ['triggerCreations/$triggerId', journal.triggerCreations.$triggerId],
    ['mutations/$entityKey/$predecessorOperationId',
      journal.mutations.$entityKey.$predecessorOperationId],
    ['analyses/$analysisId', journal.analyses.$analysisId],
  ];
  for (const [name, node] of records) {
    assert.equal(node.$other && node.$other['.validate'], false,
      `${name}: нет $other.validate=false — неизвестные поля пройдут`);
  }
  const changes = journal.mutations.$entityKey.$predecessorOperationId.changes;
  assert.equal(changes && changes.$other && changes.$other['.validate'], false,
    'changes: неизвестное поле правки пройдёт');
});

test('ни один .write в diaryV1 не разрешает замену или удаление', () => {
  const { diary } = diaryRulesOf(readRulesFile('database.rules.json'));
  const writes = [];
  (function collect(node, prefix) {
    for (const [key, value] of Object.entries(node || {})) {
      if (key.startsWith('.')) continue;
      if (!value || typeof value !== 'object') continue;
      if (hasGrant(value, '.write')) writes.push([`${prefix}/${key}`, String(value['.write'])]);
      collect(value, `${prefix}/${key}`);
    }
  }(diary, 'diaryV1'));
  assert.ok(writes.length >= 5, 'в diaryV1 меньше пяти листовых .write');
  for (const [path, expression] of writes) {
    assert.match(expression, /!data\.exists\(\)/, `${path}: разрешает перезапись`);
    assert.match(expression, /newData\.exists\(\)/, `${path}: разрешает удаление`);
  }
});

test('локальные правила не расширяют diaryV1 относительно публичных', () => {
  const publicDiary = readRulesFile('database.rules.json').diaryV1;
  const localDiary = readRulesFile('database.rules.local.json').diaryV1;
  // В local живой uid подставлен скриптом; сравниваем структуру, вернув
  // заглушку, иначе тест запрещал бы сам способ публикации правил.
  const withPlaceholder = (node) => {
    if (Array.isArray(node)) return node.map(withPlaceholder);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(node)) out[key] = withPlaceholder(value);
      return out;
    }
    if (typeof node === 'string') {
      return node.replace(/auth\.uid === "[^"]+"/g, 'auth.uid === "OWNER_UID"');
    }
    return node;
  };
  assert.deepEqual(withPlaceholder(localDiary), withPlaceholder(publicDiary),
    'database.rules.local.json и database.rules.json разошлись по diaryV1');
});
