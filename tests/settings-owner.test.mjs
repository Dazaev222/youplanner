// Проводка аккаунта владельца в Настройках (js/app.js + index.html).
//
// Правила базы привязаны к auth.uid владельца (database.rules.json), поэтому
// вход — единственный способ включить синхронизацию, а UID — единственная
// строка, которую человек переносит в Firebase Console. Тесты проверяют
// интерфейс вокруг этого: поля входа прячутся после входа, пароль не остаётся
// в поле, выход возвращает анонимный режим, а отказ по правам объяснен, а не
// молчит. Сетевой протокол (signUp/обмен/signInWithPassword) проверяется
// отдельно — в tests/firebase-auth.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const KEY = 'AIzaSyTestKeyForUnit';
const AUTH_REFRESH_KEY = 'youplanner.fb.refresh';
const OWNER_IDS = ['settings-owner-status', 'settings-owner-email',
  'settings-owner-password', 'settings-owner-signin', 'settings-owner-signout'];

function makeNode() {
  return {
    hidden: false, disabled: false, textContent: '', value: '', type: '',
    handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
  };
}

// Узлы Настроек по списку id; остальной DOM — null, как в настоящем
// sandbox-документе: каждая привязка в bindEvents защищена проверкой на null.
function stubSettingsDom(app, ids) {
  const nodes = {};
  ids.forEach((id) => { nodes[id] = makeNode(); });
  app.sandbox.document.getElementById = (id) => nodes[id] || null;
  app.sandbox.document.querySelectorAll = () => [];
  return nodes;
}

const LOGIN_OK = {
  ok: true, status: 200,
  json: () => Promise.resolve({
    idToken: 'tok-owner', refreshToken: 'r-owner', expiresIn: '3600',
    localId: 'UID-1234', email: 'owner@example.com',
  }),
};

function always(response) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    return Promise.resolve(response);
  };
  fn.calls = calls;
  return fn;
}

test('вход из Настроек: UID показан, поля скрыты, пароль из поля стёрт', async () => {
  const app = loadApp({ fetchImpl: always(LOGIN_OK) });
  app.context.setFirebaseApiKey(KEY);
  const nodes = stubSettingsDom(app, OWNER_IDS);
  app.context.bindEvents();
  app.context.renderOwnerSettings();

  // До входа — анонимный режим: поля и «Войти» видны, «Выйти» нет
  assert.equal(nodes['settings-owner-signin'].hidden, false);
  assert.equal(nodes['settings-owner-signout'].hidden, true);
  assert.match(nodes['settings-owner-status'].textContent, /Анонимный режим/);

  nodes['settings-owner-email'].value = 'owner@example.com';
  nodes['settings-owner-password'].value = 'secret-pw';
  nodes['settings-owner-signin'].handlers.click();
  await new Promise(setImmediate); // then → renderOwnerSettings, finally → disabled

  assert.match(nodes['settings-owner-status'].textContent, /UID-1234/,
    'UID не показан: вписать его в database.rules.json нечем');
  assert.match(nodes['settings-owner-status'].textContent, /owner@example\.com/);
  assert.equal(nodes['settings-owner-password'].value, '',
    'поле пароля осталось набранным после входа');
  assert.equal(nodes['settings-owner-signin'].hidden, true);
  assert.equal(nodes['settings-owner-signout'].hidden, false);
  assert.equal(nodes['settings-owner-signin'].disabled, false,
    'кнопка «Войти» не вернулась в finally');
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'r-owner',
    'вход не сохранил refresh-токен');
});

test('выход из Настроек: анонимный режим вернулся, сессия стёрта', async () => {
  const app = loadApp({ fetchImpl: always(LOGIN_OK) });
  app.context.setFirebaseApiKey(KEY);
  const nodes = stubSettingsDom(app, OWNER_IDS);
  app.context.bindEvents();

  nodes['settings-owner-email'].value = 'owner@example.com';
  nodes['settings-owner-password'].value = 'secret-pw';
  nodes['settings-owner-signin'].handlers.click();
  await new Promise(setImmediate);
  assert.equal(nodes['settings-owner-signout'].hidden, false);

  nodes['settings-owner-signout'].handlers.click();
  assert.equal(app.sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null,
    'выход оставил refresh-токен: устройство ходит в базу чужим uid');
  assert.match(nodes['settings-owner-status'].textContent, /Анонимный режим/);
  assert.equal(nodes['settings-owner-signin'].hidden, false);
  assert.equal(nodes['settings-owner-signout'].hidden, true);
});

test('отказ входа: причина с сервера, сессия не тронута', async () => {
  const denied = {
    ok: false, status: 400,
    json: () => Promise.resolve({ error: { message: 'INVALID_PASSWORD' } }),
  };
  const app = loadApp({ fetchImpl: always(denied) });
  app.context.setFirebaseApiKey(KEY);
  const nodes = stubSettingsDom(app, OWNER_IDS);

  const toasts = [];
  app.sandbox.showErrorToast = (text) => { toasts.push(String(text)); };
  app.context.bindEvents();

  nodes['settings-owner-email'].value = 'owner@example.com';
  nodes['settings-owner-password'].value = 'wrong-pass';
  nodes['settings-owner-signin'].handlers.click();
  await new Promise(setImmediate);

  assert.equal(toasts.length, 1, 'отказ входа остался без объяснения');
  assert.match(toasts[0], /INVALID_PASSWORD/, 'причина сервера не передана');
  assert.doesNotMatch(toasts[0], /wrong-pass/, 'тост содержит пароль');
  assert.equal(nodes['settings-owner-password'].value, '',
    'поле пароля не стёрто после отказа');
  assert.match(nodes['settings-owner-status'].textContent, /Анонимный режим/,
    'неудачный вход вывел приложение в режим владельца');
});

// Отказ по правам (опубликованные правила + устройство без входа) выглядит в
// интерфейсе как сетевая ошибка, и человек ищет сеть. Проверяется сквозняком:
// настоящий 403 от syncFromCloud, а не руками вызванный bus.emit.
test('403 от сервера: Настройки называют причину и не мигают тостом', async () => {
  const forbidden = {
    ok: false, status: 403,
    json: () => Promise.resolve({ error: 'Permission denied' }),
  };
  const app = loadApp({ fetchImpl: always(forbidden) });
  const nodes = stubSettingsDom(app, OWNER_IDS.concat(['settings-sync-status']));
  const toasts = [];
  app.sandbox.showToast = (text) => { toasts.push(String(text)); };
  app.context.bindEvents();

  await app.context.syncFromCloud();
  assert.match(nodes['settings-owner-status'].textContent, /403/,
    'строка Настроек не сообщает код отказа');
  assert.equal(toasts.length, 1, 'тостов про отказ больше одного');

  await app.context.syncFromCloud();
  await app.context.syncFromCloud();
  assert.equal(toasts.length, 1,
    'тост повторяется на каждом обмене и перекрывает интерфейс');
});
