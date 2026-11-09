// Гонка «войти во время refresh» и обратная «refresh во время входа».
//
// Баг: ownerSignIn не наращивал authSession, поэтому проверка
// authSession !== sessionAtStart в exchangeRefreshToken / requestFreshToken
// не срабатывала. Опоздавший ответ СТАРОГО обмена (анонимного refresh)
// перезаписывал НОВУЮ владельческую сессию: saveRefreshToken(old) затирал
// владельческий refresh в AUTH_REFRESH_KEY, authCache получал старый idToken.
// Второй подслучай: обмен стартует ВО ВРЕМЯ network-фазы ownerSignIn —
// первый инкремент (до сети) его не видит, нужен второй (после записи токенов).
//
// Стиль и помощники — те же, что в tests/firebase-auth.test.mjs: loadApp,
// makeAuthFetch-подобная заглушка, node:test + assert/strict. Тестируемые
// функции (ownerSignIn / getAuthToken / exchangeRefreshToken) НЕ мокаются —
// сетевая задержка только в fetchImpl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const KEY = 'AIzaSyTestKeyForUnit';
const AUTH_REFRESH_KEY = 'youplanner.fb.refresh';
const AUTH_OWNER_KEY = 'youplanner.fb.owner';
const OWNER_UID = 'OWNER-UID';

function okJson(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function ownerResponse(email) {
  return okJson({
    kind: 'identitytoolkit#VerifyPasswordResponse',
    idToken: 'owner-tok', refreshToken: 'owner-r', expiresIn: '3600',
    localId: OWNER_UID, email: email || 'owner@example.com',
  });
}

function anonRefreshResponse() {
  // Формат securetoken: snake_case
  return okJson({ id_token: 'anon-tok2', refresh_token: 'anon-r2', expires_in: 3600 });
}

// Анонимный refresh-токен, лежавший в хранилище до входа.
const ANON_R = 'anon-r';

test('вход во время обмена: опоздавший анонимный ответ не затирает владельческую сессию', async () => {
  // securetoken висит 50 мс: обмен анонимного refresh начинается раньше входа
  // и заканчивается ПОСЛЕ того, как ownerSignIn уже записал владельческие токены.
  const calls = [];
  const fetchImpl = (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, body: typeof opts.body === 'string' ? opts.body : null });
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(anonRefreshResponse()), 50);
      });
    }
    if (u.indexOf('signInWithPassword') !== -1) {
      return Promise.resolve(ownerResponse());
    }
    return Promise.resolve(okJson({}));
  };

  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, ANON_R);

  // (3) НЕ await getAuthToken() — только запустить обмен старой сессии
  const pending = context.getAuthToken();
  // (4) вход владельца: signInWithPassword отвечает сразу
  await context.ownerSignIn('owner@example.com', 'pw');
  // (5) дождаться завершения запущенного обмена
  await pending;

  // (6) ПОСЛЕ входа сохранён именно owner-r, а не anon-r2
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'owner-r',
    'опоздавший ответ обмена затёр владельческий refresh-токен');
  assert.equal(await context.getAuthToken(), 'owner-tok',
    'опоздавший ответ обмена затёр кэш id-токена владельца');
  const stored = JSON.parse(sandbox.localStorage.getItem(AUTH_OWNER_KEY) || 'null');
  assert.ok(stored && stored.uid === OWNER_UID, 'запись владельца потерялась');

  // Обмен по старому анонимному refresh мог быть — ровно один, до входа
  const securetoken = calls.filter((c) => c.url.indexOf('securetoken') !== -1);
  assert.ok(securetoken.length >= 1, 'обмен анонимного refresh не начинался вовсе');
  if (securetoken[0].body) {
    const body = JSON.parse(securetoken[0].body);
    assert.equal(body.refresh_token, ANON_R,
      'обмен должен был идти по старому анонимному refresh-токену');
  }
});

test('обмен, стартовавший во время network-фазы входа, не перезаписывает владельческую сессию', async () => {
  // Второй подслучай: signInWithPassword задержан, обмен анонимного refresh
  // СТАРТУЕТ во время network-фазы входа (когда первый инкремент уже прошёл),
  // а запись ответа обмена случается ПОСЛЕ записи владельческих токенов.
  // Ответ securetoken держим до завершения входа — иначе обмен успел бы
  // записаться ДО входа, и вход бы его перезаписал (гонка не проявилась бы).
  let resolveRefresh = null;
  const fetchImpl = (url, opts = {}) => {
    const u = String(url);
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      return new Promise((resolve) => {
        resolveRefresh = () => resolve(anonRefreshResponse());
      });
    }
    if (u.indexOf('signInWithPassword') !== -1) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(ownerResponse()), 40);
      });
    }
    return Promise.resolve(okJson({}));
  };

  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, ANON_R);

  const login = context.ownerSignIn('owner@example.com', 'pw');
  // Дать входу дойти до сети: signInWithPassword висит, первый инкремент уже сделан
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Обмен стартует ВО ВРЕМЯ network-фазы входа
  const refresh = context.getAuthToken();
  assert.ok(resolveRefresh, 'обмен не дошёл до сети во время входа');

  await login;
  // Ответ обмена приезжает ПОСЛЕ записи владельческих токенов
  resolveRefresh();
  await refresh;

  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'owner-r',
    'обмен, стартовавший во время входа, перезаписал владельческий refresh');
  assert.equal(await context.getAuthToken(), 'owner-tok',
    'обмен, стартовавший во время входа, перезаписал кэш id-токена');
  const stored = JSON.parse(sandbox.localStorage.getItem(AUTH_OWNER_KEY) || 'null');
  assert.ok(stored && stored.uid === OWNER_UID, 'запись владельца потерялась');
});

test('выход во время входа: ownerSignIn отвергает, сессии нет', async () => {
  // Семантика ownerSignOut не меняется: инкремент поверх наших инкрементов
  // по-прежнему отменяет вход. Проверка должна работать и до, и после фикса.
  let resolveLogin = null;
  const fetchImpl = (url) => {
    if (String(url).indexOf('signInWithPassword') !== -1) {
      return new Promise((resolve) => {
        resolveLogin = () => resolve(ownerResponse());
      });
    }
    return Promise.resolve(okJson({}));
  };

  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);

  const login = context.ownerSignIn('owner@example.com', 'pw');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(resolveLogin, 'вход не дошёл до сети до выхода');

  context.ownerSignOut();
  resolveLogin();

  await assert.rejects(login, /отменён/,
    'вход после выхода должен отвергнуться, а не установить сессию');
  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), null,
    'опоздавший успешный вход вернул refresh-токен в разлогиненное устройство');
  assert.equal(sandbox.localStorage.getItem(AUTH_OWNER_KEY), null,
    'опоздавший успешный вход вернул запись владельца');
  assert.equal(context.getOwnerAccount(), null, 'состояние входа восстановилось');
});

test('опоздавший 400 от старого обмена не разлогинивает новую владельческую сессию', async () => {
  // Деструктивная ветка exchangeRefreshToken: 4xx → forcedSignOut. Без сверки
  // authSession она стирала бы сессию, которую уже успел открыть ownerSignIn.
  // Мотив из ТЗ: «Войти» жмут, пока старый refresh уже мёртв и висит в сети.
  const fetchImpl = (url) => {
    const u = String(url);
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: { message: 'INVALID_REFRESH_TOKEN' } }),
        }), 50);
      });
    }
    if (u.indexOf('signInWithPassword') !== -1) {
      return Promise.resolve(ownerResponse());
    }
    return Promise.resolve(okJson({}));
  };

  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, ANON_R);

  const stale = context.forceRefreshAuthToken();
  await context.ownerSignIn('owner@example.com', 'pw');
  await stale;

  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'owner-r',
    'опоздавший 400 старого обмена стёр владельческий refresh-токен');
  const stored = JSON.parse(sandbox.localStorage.getItem(AUTH_OWNER_KEY) || 'null');
  assert.ok(stored && stored.uid === OWNER_UID,
    'опоздавший 400 старого обмена разлогинил владельца');
  assert.equal(context.getOwnerAccount() && context.getOwnerAccount().uid, OWNER_UID,
    'ownerAccount в памяти модуля потерян после опоздавшего 400');
  assert.equal(await context.getAuthToken(), 'owner-tok',
    'кэш id-токена владельца затёрт опоздавшим 400');
});

test('опоздавший 400 requestFreshToken не стирает владельческий refresh и не заводит signUp', async () => {
  // Вторая дыра: requestFreshToken на 4xx снимал AUTH_REFRESH_KEY без сверки
  // поколения. После успешного входа это стирало бы owner-r (а при owner ещё
  // и бросало «Сессия владельца потеряна» на живую сессию). Плюс: неудача
  // старого обмена не должна ставить 5-минутную паузу новой сессии.
  const fetchImpl = (url) => {
    const u = String(url);
    if (u.indexOf('securetoken.googleapis.com') !== -1) {
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: { message: 'INVALID_REFRESH_TOKEN' } }),
        }), 50);
      });
    }
    if (u.indexOf('signInWithPassword') !== -1) {
      return Promise.resolve(ownerResponse());
    }
    // signUp не должен вызываться: Owner уже есть, анонимный аккаунт заводить нельзя
    if (u.indexOf('accounts:signUp') !== -1) {
      return Promise.resolve(okJson({ idToken: 'anon-new', refreshToken: 'anon-new-r', expiresIn: '3600' }));
    }
    return Promise.resolve(okJson({}));
  };

  const { context, sandbox } = loadApp({ fetchImpl });
  context.setFirebaseApiKey(KEY);
  sandbox.localStorage.setItem(AUTH_REFRESH_KEY, ANON_R);

  const pending = context.getAuthToken();
  await context.ownerSignIn('owner@example.com', 'pw');
  await pending;

  assert.equal(sandbox.localStorage.getItem(AUTH_REFRESH_KEY), 'owner-r',
    'опоздавший 400 requestFreshToken стёр владельческий refresh');
  const stored = JSON.parse(sandbox.localStorage.getItem(AUTH_OWNER_KEY) || 'null');
  assert.ok(stored && stored.uid === OWNER_UID, 'запись владельца потеряна');
  assert.equal(await context.getAuthToken(), 'owner-tok',
    'после опоздавшего 400 владельческий токен не выдаётся');
});
