/* Гонка «войти во время refresh» — ЖИВОЙ БРАУЗЕР (Playwright, chromium).

   Файл НЕ входит в glob `tests/*.test.mjs` и запускается отдельно:

       node tests/firebase-auth-race.browser.mjs

   По образцу tests/mobile-tap.browser.mjs: локальный http-сервер статики
   из корня worktree, внешняя сеть закрыта. В отличие от юнит-теста
   tests/firebase-auth-race.test.mjs здесь работает настоящий fetch,
   настоящий ES-модуль js/data/firebase-auth.js и настоящий localStorage —
   песочница vm не проверяет.

   page.route перехватывает auth-домены (сеть наружу не ходит):
     - securetoken.googleapis.com — задержка 200 мс + анонимная пара
       {id_token:'anon-tok2', refresh_token:'anon-r2'};
     - identitytoolkit.googleapis.com signInWithPassword — сразу
       владельческий ответ {idToken:'owner-tok', refreshToken:'owner-r'}.

   Сценарий в page.evaluate: положить анонимный refresh, запустить
   getAuthToken() БЕЗ await, await ownerSignIn, дождаться refresh-промиса,
   вернуть {refresh, token}. Ассерты те же, что в юнит-тесте: после входа
   в localStorage лежит owner-r, getAuthToken() === 'owner-tok'.

   Порт у ОС (listen(0)): соседние e2e занимают 8933–8936. */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  // Минимальный харнесс без загрузки app.js: init() приложения сам дёргает
  // getAuthToken через syncFromCloud и мешал бы сценарию гонки. Модуль
  // firebase-auth.js импортируем из evaluate, как это делает человек
  // в консоли живой страницы.
  if (path === '/__auth_harness.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    return;
  }
  const file = path === '/' ? '/index.html' : decodeURIComponent(path);
  if (file.includes('..')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404).end('нет файла');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:' + server.address().port;

async function main() {
  const browser = await chromium.launch({ headless: true });
  let failed = false;
  try {
    const context = await browser.newContext({ locale: 'ru-RU' });

    // Внешняя сеть закрыта: всё, что не наш origin и не перехвачено ниже,
    // абортится. Конкретные auth-маршруты регистрируем ПОСЛЕ catch-all —
    // Playwright примеряет маршруты в обратном порядке регистрации.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE)) return route.continue();
      return route.abort();
    });
    await context.route('**/securetoken.googleapis.com/**', async (route) => {
      // Задержка 200 мс: обмен должен ещё висеть, когда ownerSignIn уже
      // запишет владельческие токены — иначе гонка не проявится.
      await new Promise((r) => setTimeout(r, 200));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id_token: 'anon-tok2', refresh_token: 'anon-r2', expires_in: '3600' }),
      });
    });
    await context.route('**/identitytoolkit.googleapis.com/**', async (route) => {
      const url = route.request().url();
      if (url.indexOf('signInWithPassword') !== -1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            idToken: 'owner-tok', refreshToken: 'owner-r', expiresIn: '3600',
            localId: 'OWNER-UID', email: 'owner@example.com',
          }),
        });
        return;
      }
      // signUp и прочие identitytoolkit в этом сценарии не участвуют
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'UNEXPECTED_IDENTITYTOOLKIT_CALL' } }),
      });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/__auth_harness.html', { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async () => {
      const auth = await import('/js/data/firebase-auth.js');
      localStorage.setItem('youplanner.fb.refresh', 'anon-r');
      // Запустить обмен анонимного refresh БЕЗ await — как юнит-тест
      const pending = auth.getAuthToken();
      await auth.ownerSignIn('owner@example.com', 'pw');
      await pending;
      return {
        refresh: localStorage.getItem('youplanner.fb.refresh'),
        token: await auth.getAuthToken(),
        owner: localStorage.getItem('youplanner.fb.owner'),
      };
    });

    assert.equal(result.refresh, 'owner-r',
      'опоздавший ответ securetoken затёр владельческий refresh: ' + result.refresh);
    assert.equal(result.token, 'owner-tok',
      'опоздавший ответ securetoken затёр кэш id-токена: ' + result.token);
    assert.ok(result.owner && JSON.parse(result.owner).uid === 'OWNER-UID',
      'запись владельца потерялась: ' + result.owner);
    assert.deepEqual(errors, [], 'pageerror: ' + errors.join(' | '));
    console.log('  PASS  вход во время обмена: owner-r и owner-tok выжили (живой браузер)');
    console.log('  результат evaluate:', JSON.stringify(result));
  } catch (e) {
    failed = true;
    console.error('  FAIL  ' + String(e.message).split('\n').slice(0, 8).join('\n        '));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
  if (!failed) console.log('\nИтог: 1 PASS, 0 FAIL');
}

main().catch((e) => {
  console.error('ПРОГОН НЕ ВЫПОЛНЕН: ' + e.message);
  server.close();
  process.exitCode = 1;
});
