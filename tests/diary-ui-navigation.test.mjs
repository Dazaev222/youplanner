import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

test('Дневник зарегистрирован и обе самостоятельные области скрывают таб-бар', () => {
  const { context: c } = loadApp();
  assert.ok(c.screenNames().includes('diary'));
  c.isMobileView = () => true;
  for (const name of ['diary', 'harness']) {
    const changes = [];
    c.setHidden = (id, value) => changes.push([id, value]);
    c.applyScreen(name, 'main');
    assert.ok(changes.some(([id, hidden]) => id === 'tab-bar' && hidden), name);
  }
});
