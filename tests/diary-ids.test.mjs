// ID домена «Дневник» (ТЗ §3, §9): криптографически случайные UUID,
// допустимые ключи RTDB, ключ initial зарезервирован.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newId, assertFirebaseKey, isFirebaseKey, RESERVED_OPERATION_ID } from '../js/harness/diary/ids.js';

const UUID_SOURCE = {
  randomUUID: () => '00000000-1111-4222-8333-444444444444',
};

test('newId использует crypto.randomUUID и префикс сущности', () => {
  assert.equal(newId('event', UUID_SOURCE), 'event-00000000-1111-4222-8333-444444444444');
  assert.equal(newId('trigger', UUID_SOURCE), 'trigger-00000000-1111-4222-8333-444444444444');
  assert.equal(newId('operation', UUID_SOURCE), 'operation-00000000-1111-4222-8333-444444444444');
});

test('newId без randomUUID падает, а не подменяет криптографию Math.random', () => {
  assert.throws(() => newId('event', { getRandomValues: undefined }), /INVALID_DATA|crypto/i);
});

test('newId отказывается от неизвестного префикса и пустого источника', () => {
  assert.throws(() => newId('', UUID_SOURCE), /префикс|INVALID_DATA|prefix/i);
  assert.throws(() => newId('event', {}), /INVALID_DATA|crypto/i);
});

test('assertFirebaseKey пропускает UUID-подобные ключи и отклоняет служебные символы', () => {
  assert.doesNotThrow(() => assertFirebaseKey('event-00000000-1111-4222-8333-444444444444'));
  assert.equal(isFirebaseKey('trigger-abc'), true);
  for (const bad of ['', 'a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a b', '__proto__',
    'constructor', 'prototype', 'x'.repeat(769), 42, null, undefined]) {
    assert.equal(isFirebaseKey(bad), false, `ключ должен быть отклонён: ${String(bad)}`);
    assert.throws(() => assertFirebaseKey(bad), /INVALID_DATA|ключ|key/i);
  }
});

test('initial зарезервирован и не может быть operationId', () => {
  assert.equal(RESERVED_OPERATION_ID, 'initial');
  assert.throws(() => assertFirebaseKey('initial', { operationId: true }),
    /INVALID_DATA|initial/i);
  assert.doesNotThrow(() => assertFirebaseKey('initial', { slot: true }));
});
