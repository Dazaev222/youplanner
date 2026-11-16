import test from 'node:test';
import assert from 'node:assert/strict';
const a = await import('../js/harness/diary-ui/analysis.js').catch(() => ({}));
test('PROVIDER_KEY_MISSING открывает настройки ключа и даёт понятное сообщение', () => {
  assert.equal(typeof a.analysisFailure, 'function');
  let opened = 0;
  const text = a.analysisFailure({ code: 'PROVIDER_KEY_MISSING' }, () => { opened++; });
  assert.equal(opened, 1);
  assert.match(text, /ключ/i);
  assert.match(text, /настройк/i);
});
test('другие ошибки настройки не открывают и пробрасываются дальше', () => {
  let opened = 0;
  const open = () => { opened++; };
  assert.equal(a.analysisFailure({ code: 'OFFLINE' }, open), null);
  assert.equal(a.analysisFailure(undefined, open), null);
  assert.equal(opened, 0);
});