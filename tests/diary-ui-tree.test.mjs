import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateRingProgress } from '../js/harness/diary-ui/milestones.js';
import { buildDiaryViewModel } from '../js/harness/diary-ui/view-model.js';

test('дерево — чёрный силуэт с листвой, без прежних круглых крон; кольцо отдельно', async () => {
  const source = await readFile(new URL('../js/harness/diary-ui/index.js', import.meta.url), 'utf8');
  const markup = source.match(/graphic.innerHTML = '([^']+)';/)[1];
  assert.match(markup, /<image href="js\/harness\/diary-ui\/tree-reference.png" x="41" y="50" width="114" height="108"/);
  const image = await readFile(new URL('../js/harness/diary-ui/tree-reference.png', import.meta.url));
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.doesNotMatch(markup, /class="diary-leaf"/);
  assert.equal((markup.match(/<circle /g) || []).length, 2);
  assert.match(markup, /class="diary-progress" cx="100" cy="100" r="88"/);
  assert.match(source, /553 \* \(1 - progress.progress\)/);
});

test('кольцо: старт, середина календарного месяца и сброс после рецидива', () => {
  const start = Date.parse('2026-04-01T00:00:00Z');
  const now = Date.parse('2026-04-16T00:00:00Z');
  assert.equal(calculateRingProgress(start, start, 'UTC').progress, 0);
  assert.equal(calculateRingProgress(start, now, 'UTC').progress, 0.5);
  const vm = buildDiaryViewModel({ initialization: { startedAtMs: start }, events: [{ eventId: 'relapse', occurredAtMs: now }], intervals: [{ startMs: start, endMs: now }, { startMs: now, endMs: null }] }, now);
  assert.equal(vm.startMs, now);
  assert.equal(calculateRingProgress(vm.startMs, now, 'UTC').progress, 0);
  const next = calculateRingProgress(start, Date.parse('2026-05-01T00:00:00Z'), 'UTC');
  assert.equal(next.months, 1);
  assert.equal(next.progress, 0);
});
