// Тесты debounce (js/core/debounce.js) — аудит 2026-10-31.
//
// Контракт: серия вызовов даёт один вызов функции — через wait мс после
// ПОСЛЕДНЕГО события, с аргументами последнего вызова. flush() выполняет
// отложенный вызов немедленно (уход со вкладки: страница могут закрыть
// раньше таймера), cancel() снимает без выполнения. Без отложенного вызова
// обе операции — тихий no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debounce } from '../js/core/debounce.js';

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test('серия вызовов даёт один вызов после паузы, с последними аргументами', async () => {
  const calls = [];
  const debounced = debounce(function (a, b) { calls.push([a, b]); }, 25);

  debounced(1, 'a');
  debounced(2, 'b');
  debounced(3, 'c');
  assert.deepEqual(calls, [], 'вызов случился до истечения задержки');

  await sleep(60);
  assert.deepEqual(calls, [[3, 'c']], 'вызов не с последними аргументами или не один');
});

test('пауза между вызовами больше wait — каждый вызов срабатывает отдельно', async () => {
  const calls = [];
  const debounced = debounce(function (x) { calls.push(x); }, 15);

  debounced('first');
  await sleep(40);
  debounced('second');
  await sleep(40);

  assert.deepEqual(calls, ['first', 'second']);
});

test('flush выполняет отложенный вызов немедленно и не оставляет таймер', async () => {
  const calls = [];
  const debounced = debounce(function (x) { calls.push(x); }, 25);

  debounced('pending');
  debounced.flush();
  assert.deepEqual(calls, ['pending'], 'flush не выполнил отложенный вызов');

  await sleep(50);
  assert.deepEqual(calls, ['pending'], 'после flush таймер сработал ещё раз');
});

test('flush без отложенного вызова — no-op', () => {
  const calls = [];
  const debounced = debounce(function (x) { calls.push(x); }, 25);

  debounced.flush();
  assert.deepEqual(calls, []);
});

test('cancel снимает отложенный вызов без выполнения', async () => {
  const calls = [];
  const debounced = debounce(function (x) { calls.push(x); }, 25);

  debounced('dropped');
  debounced.cancel();
  await sleep(50);

  assert.deepEqual(calls, [], 'cancel не снял отложенный вызов');
});

test('после cancel можно планировать заново', async () => {
  const calls = [];
  const debounced = debounce(function (x) { calls.push(x); }, 15);

  debounced('cancelled');
  debounced.cancel();
  debounced('kept');
  await sleep(40);

  assert.deepEqual(calls, ['kept']);
});
