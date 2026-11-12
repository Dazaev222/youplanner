// qaza-new-device e2e: регресс владельца 2026-11-12.
//
// Сценарий с двумя устройствами и ОДНИМ моком Firebase (честная условная
// запись, ETag/If-Match — как в sync-race.e2e.mjs):
//   A (iPhone) с историей каза правит счётчики через настоящий экран
//   «Каза-намазы» и отправляет их наверх конвертом {v, ts};
//   B — новый браузер с ПУСТЫМ localStorage. Он открывается «до входа»
//   (сервер отвечает 403), успевает сделать локальную правку в другом
//   разделе (pending), затем «входит» и синхронизируется.
//
// Проверка: localStorage.qaza на B побайтно равен qaza на A, а серверный
// конверт qaza не затёрт голым дефолтом 305/306/306/305/305.
//
// Без фикса (js/sync/merge.js: pending пропускал все конвертные разделы)
// догоняющий PUT уносил наверх дефолт и стирал конверт A.

import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = 8937;
const BASE = `http://127.0.0.1:${PORT}`;
const FIREBASE = /firebaseio\.com/;
const AUTH_HOSTS = /securetoken\.googleapis\.com|identitytoolkit\.googleapis\.com/;
const TMP = join(ROOT, '.test_tmp');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const file = join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  readFile(file).then((data) => {
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  }, () => { res.writeHead(404); res.end('not found'); });
});

// Один «сервер». authorized=false — устройство ещё не вошло (правила Firebase
// отвечают 403), authorized=true — вход выполнен.
const fb = { snapshot: null, revision: 0, puts: [], conflicts: 0, authorized: true };
const etag = () => '"' + fb.revision + '"';

function firebaseHandler(route, url) {
  const method = route.request().method();
  if (url.includes('-planner')) return { status: 200, body: 'null', headers: {} };
  if (url.includes('-backups')) return { status: 200, body: 'null', headers: {} };
  if (!fb.authorized) {
    return { status: 403, body: '{"error":"Permission denied"}', headers: {} };
  }
  if (method === 'GET') {
    if (fb.snapshot === null) return { status: 200, body: 'null', headers: {} };
    return {
      status: 200,
      body: JSON.stringify(fb.snapshot),
      headers: { ETag: etag(), 'Access-Control-Expose-Headers': 'ETag' },
    };
  }
  if (method === 'PUT') {
    const ifMatch = route.request().headers()['if-match'];
    if (ifMatch !== undefined && ifMatch !== etag()) {
      fb.conflicts++;
      return { status: 412, body: '{"error":"precondition failed"}', headers: {} };
    }
    let parsed;
    try { parsed = JSON.parse(route.request().postData() || '{}'); } catch { parsed = {}; }
    parsed.updatedAt = Date.now();
    fb.snapshot = parsed;
    fb.revision++;
    fb.puts.push({ at: Date.now(), body: parsed, ifMatch: ifMatch ?? null });
    return {
      status: 200,
      body: 'null',
      headers: { ETag: etag(), 'Access-Control-Expose-Headers': 'ETag' },
    };
  }
  return { status: 200, body: 'null', headers: {} };
}

async function newPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    locale: 'ru-RU',
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (FIREBASE.test(url) || AUTH_HOSTS.test(url)) {
      const out = firebaseHandler(route, url);
      return route.fulfill({
        status: out.status,
        contentType: 'application/json',
        body: out.body,
        headers: out.headers,
      });
    }
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
  return { context, page, errors };
}

async function waitUntil(pred, timeout = 20000, step = 250) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

// Настоящая правка каза через экран: «Каза-намазы» → выбрать намаз → «Добавить».
async function addMissedQaza(page, namazIndex) {
  await page.click('#qaza-btn');
  await page.waitForSelector('#qaza-view:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('#qaza-add .qaza-add-radio', { timeout: 5000 });
  await page.locator('#qaza-add .qaza-add-option').nth(namazIndex).click();
  await page.click('#qaza-add-btn');
  await page.waitForTimeout(300);
  await page.click('#qaza-back');
  await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
}

function readQaza(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('youplanner.qaza');
    return raw ? JSON.parse(raw) : null;
  });
}

async function waitForQaza(page, expected, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const local = await readQaza(page);
    if (local && JSON.stringify(local) === JSON.stringify(expected)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Локальная правка ДРУГОГО раздела: pending взводится по-настоящему, а qaza
// при этом не трогается — ровно ситуация «человек что-то нажал до входа».
async function toggleHabitCell(page) {
  await page.evaluate(() => {
    const today = new Date();
    const iso = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');
    const cells = Array.from(document.querySelectorAll('#habits-tbody .cell-x'));
    const past = cells.filter((c) => c.getAttribute('data-date') <= iso);
    (past[0] || cells[0]).click();
  });
  await page.waitForTimeout(100);
}

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${String(e && e.stack || e).split('\n').slice(0, 12).join('\n        ')}`);
  }
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  await mkdir(TMP, { recursive: true });
  console.log('▶ YouPlanner qaza-new-device-e2e (:8937)');

  let qazaA = null;
  let qazaTsA = null;

  await step('1. A (iPhone): пустой сервер → дефолты, затем правка каза через экран уходит конвертом', async () => {
    const { context, page, errors } = await newPage(browser);
    const seeded = await waitUntil(() => fb.snapshot !== null &&
      Array.isArray(fb.snapshot.habits) && fb.snapshot.habits.length > 0);
    assert.ok(seeded, 'стартовый PUT дефолтов не доехал');

    await addMissedQaza(page, 0); // +1 к Фаджру

    qazaA = await readQaza(page);
    assert.ok(qazaA && qazaA.remaining, 'локальный qaza A не прочитался');

    const landed = await waitUntil(() => {
      const env = fb.snapshot && fb.snapshot.qaza;
      return env && env.v && JSON.stringify(env.v) === JSON.stringify(qazaA) &&
        typeof env.ts === 'number' && env.ts > 0;
    });
    assert.ok(landed, `сервер не принял конверт qaza-A: ${JSON.stringify(fb.snapshot && fb.snapshot.qaza)}`);
    qazaTsA = fb.snapshot.qaza.ts;
    assert.deepEqual(errors, [], `pageerror на A: ${errors.join(' | ')}`);
    await context.close();
  });

  await step('2. B: новый браузер, пустой localStorage, «до входа» (403) — стартуют дефолты', async () => {
    fb.authorized = false;
    const { context, page, errors } = await newPage(browser);
    const qazaB = await readQaza(page);
    assert.ok(qazaB && qazaB.remaining, 'B не засеял стартовый qaza');
    assert.equal(qazaB.remaining.fajr, 305, 'B должен стартовать с дефолта, а не с серверных чисел');
    assert.deepEqual(errors, [], `pageerror на B: ${errors.join(' | ')}`);

    // Правка другого раздела до первой успешной сверки: pending честный.
    await toggleHabitCell(page);
    const records = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.records') || '{}'));
    assert.ok(Object.keys(records).length > 0, 'локальная правка B не записалась');

    // «Вход выполнен»: правила с этого момента пускают.
    fb.authorized = true;
    // Сеть вернулась: приложение планирует отправку. Само по себе это не
    // правка и не должно запирать серверный снимок.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    const healed = await waitForQaza(page, qazaA, 25000);
    assert.ok(healed,
      `B не получил qaza-A: ${await page.evaluate(() => localStorage.getItem('youplanner.qaza'))}`);

    const localB = await readQaza(page);
    assert.deepEqual(localB, qazaA, 'localStorage.qaza на B не равен qaza на A');

    const env = fb.snapshot && fb.snapshot.qaza;
    assert.ok(env && env.v, 'серверный qaza не конверт — затёрт голым объектом');
    assert.deepEqual(env.v, qazaA, 'серверный qaza не совпал с правкой A');
    assert.equal(env.ts, qazaTsA, 'сервер потерял метку записи конверта A');

    assert.deepEqual(errors, [], `pageerror на B: ${errors.join(' | ')}`);
    await page.screenshot({ path: join(TMP, 'qaza-new-device-final.png') });
    await context.close();
  });

  await browser.close();
  server.close();
  console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
