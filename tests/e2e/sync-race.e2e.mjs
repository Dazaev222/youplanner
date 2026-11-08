// sync-race e2e: гонка двух устройств на живом приложении (АДР 2026-11-08,
// гейт 4). Два контекста Playwright против ОДНОГО мока Firebase с честной
// условной записью: GET отдаёт ETag, PUT с чужим If-Match отвечает 412 —
// ровно как real-time database с правилами. Доказательство гонки — кольцо
// 412: правка устройства B при чужом свежем снимке → 412 → перечитать →
// applyMergedFromCloud слить → повторный PUT, и в теле успешного PUT едут
// ОБЕ привычки (своя и чужая). Плюс обратная доставка: A видит правку B
// после ручной сверки (applyCloudData по пути снимка).
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = 8936;
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

// Состояние мока: один «сервер» с ревизией и условной записью.
const fb = { snapshot: null, revision: 0, puts: [], conflicts: 0 };
const etag = () => '"' + fb.revision + '"';

function firebaseHandler(route, url) {
  const method = route.request().method();
  // Соседние узлы вне скоупа сценария: planner — пуст; backups — пуст (копия
  // троттлится сама, гонку корня закрывает 412-ветка условной записи).
  if (url.includes('-planner')) return { status: 200, body: 'null', headers: {} };
  if (url.includes('-backups')) return { status: 200, body: 'null', headers: {} };
  if (method === 'GET') {
    if (fb.snapshot === null) return { status: 200, body: 'null', headers: {} };
    // ETag — не CORS-safelisted заголовок: без Access-Control-Expose-Headers
    // кросс-доменный fetch его не видит, и клиент слепнет (реальный RTDB
    // отдаёт именно такой набор — на нём держится If-Match клиента)
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
    const body = route.request().postData() || '{}';
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
    // updatedAt двигает «сервер»: следующий GET строго новее предыдущего
    parsed.updatedAt = Date.now();
    fb.snapshot = parsed;
    fb.revision++;
    // ifMatch — доказательство условной записи: null = PUT был безусловным
    fb.puts.push({ at: Date.now(), body: parsed, ifMatch: ifMatch ?? null, node: url.includes('-planner') ? 'planner' : url.includes('-backups') ? 'backups' : 'root' });
    return { status: 200, body: 'null', headers: { ETag: etag(), 'Access-Control-Expose-Headers': 'ETag' } };
  }
  return { status: 200, body: 'null', headers: {} };
}

async function newPage(browser, label) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    locale: 'ru-RU',
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (FIREBASE.test(url) || AUTH_HOSTS.test(url)) {
      const out = firebaseHandler(route, url);
      return route.fulfill({ status: out.status, contentType: 'application/json', body: out.body, headers: out.headers });
    }
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.label = label;
  page.errorsCollected = errors;
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
  return { context, page };
}

// Реальный путь правки привычки: Настройки → Редактировать → «+ Добавить»
async function addHabit(page, name) {
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
  await page.click('#settings-edit-habits');
  await page.waitForSelector('#habits-edit-view:not([hidden])', { timeout: 5000 });
  await page.click('#habits-edit-add');
  await page.waitForSelector('#habit-modal:not([hidden])', { timeout: 5000 });
  await page.fill('#form-name', name);
  await page.click('#habit-form button[type=submit]');
  await page.click('#modal-close');
  await page.click('#habits-edit-back');
  await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
  await page.click('#settings-back');
  await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
}

// Ждёт, пока предикат станет истинным (поллинг состояния мока и страницы).
async function waitUntil(pred, timeout = 20000, step = 300) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

async function manualSync(page) {
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
  await page.click('#settings-sync-now');
  await page.waitForTimeout(1500);
  await page.click('#settings-back');
  await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
}

function tableNames(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#habits-tbody .habit-name'))
      .map((el) => el.textContent));
}

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 6).join('\n        ')}`);
  }
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  await mkdir(TMP, { recursive: true });
  console.log('▶ YouPlanner sync-race-e2e (:8936)');

  await step('1. Устройство A: пустой сервер → дефолты засеяны, PUT принят', async () => {
    const { context, page } = await newPage(browser, 'A');
    const seeded = await waitUntil(() => fb.snapshot !== null &&
      Array.isArray(fb.snapshot.habits) && fb.snapshot.habits.length > 0);
    assert.ok(seeded, 'стартовый PUT дефолтов не доехал');
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.habits') || '[]'));
    assert.ok(Array.isArray(stored) && stored.length > 0, 'дефолтные привычки не засеялись локально');
    await context.close();
  });

  let pageB, contextB;
  let pageA, contextA;
  await step('2. Устройство B: снимок с сервера применяется (applyCloudData, метка встаёт)', async () => {
    const opened = await newPage(browser, 'B');
    contextB = opened.context; pageB = opened.page;
    const stored = await pageB.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.habits') || '[]'));
    const names = await tableNames(pageB);
    assert.equal(names.length, stored.length, 'таблица не совпала с применённым снимком');
    const ts = await pageB.evaluate(() => localStorage.getItem('youplanner.sync.ts'));
    assert.ok(Number(ts) > 0, 'метка снимка не встала — applyCloudData не сработал');
  });

  await step('3. A добавляет «Гонка-А»; B добавляет «Гонку-B» → 412 → слияние → PUT несёт ОБЕ (гонка доказана)', async () => {
    const { context: contextA, page: pageA } = await newPage(browser, 'A');
    await addHabit(pageA, 'Гонка-А');
    const aLanded = await waitUntil(() => fb.snapshot !== null &&
      JSON.stringify(fb.snapshot.habits).includes('Гонка-А'));
    assert.ok(aLanded, 'PUT устройства A с «Гонкой-А» не доехал до сервера');

    const putsBefore = fb.puts.length;
    const conflictsBefore = fb.conflicts;
    await addHabit(pageB, 'Гонка-B');
    const merged = await waitUntil(() => fb.puts.length > putsBefore &&
      JSON.stringify(fb.puts[fb.puts.length - 1].body.habits).includes('Гонка-B') &&
      JSON.stringify(fb.puts[fb.puts.length - 1].body.habits).includes('Гонка-А'));
    const putsSummary = fb.puts.map((p) =>
      `[${p.node}] If-Match=${p.ifMatch} (${(p.body.habits || []).map((h) => h.name).join('+')})`).join(' | ');
    assert.ok(merged,
      `успешный PUT B не содержит обе привычки; 412 за сценарий: ${fb.conflicts - conflictsBefore}; ` +
      `успешные PUT: ${putsSummary}`);
    assert.ok(fb.conflicts > conflictsBefore,
      `условная запись не сработала: конфликтов 412 = ${fb.conflicts - conflictsBefore}`);
    await contextA.close();
  });

  await step('4. A вручную сверяется: видит «Гонку-B», своя правка не потерялась', async () => {
    const { context: contextA, page: pageA } = await newPage(browser, 'A');
    await manualSync(pageA);
    const names = await tableNames(pageA);
    assert.ok(names.includes('Гонка-А'), `своя правка A пропала: ${names.join(', ')}`);
    assert.ok(names.includes('Гонка-B'), `чужая правка B не доехала до A: ${names.join(', ')}`);
    const stored = await pageA.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.habits') || '[]'));
    assert.ok(stored.some((h) => h.name === 'Гонка-А') && stored.some((h) => h.name === 'Гонка-B'),
      'localStorage A не содержит обе привычки');
    assert.deepEqual(pageA.errorsCollected, [], `pageerror на A: ${pageA.errorsCollected.join(' | ')}`);
    await contextA.close();
  });

  await step('5. B вручную сверяется: обе привычки на месте, без потерь', async () => {
    await manualSync(pageB);
    const names = await tableNames(pageB);
    assert.ok(names.includes('Гонка-А') && names.includes('Гонка-B'),
      `на B нет обеих привычек: ${names.join(', ')}`);
    assert.deepEqual(pageB.errorsCollected, [], `pageerror на B: ${pageB.errorsCollected.join(' | ')}`);
    await pageB.screenshot({ path: join(TMP, 'sync-race-final.png') });
    await contextB.close();
  });

  // ─── Qaza-секция: конверты цельных разделов {v, ts} (аудит P1-3) ───
  // Конфликт целых разделов разрешается не слиянием, а правилом конверта:
  // побеждает раздел с более новой меткой записи раздела (section-writes).
  // Метки задаём явно (T1 < T2 < T3), а не часами приложения — иначе
  // loadQaza() при загрузке страницы сдвинул бы метку на время загрузки.
  const qazaBase = Date.now();
  const T1 = qazaBase;
  const T2 = qazaBase + 1000;
  const T3 = qazaBase + 2000;
  const qazaA = {
    version: 3, cursor: 0,
    remaining: { fajr: 10, zuhr: 20, asr: 30, maghrib: 40, isha: 50 },
    history: [],
  };
  const qazaB = {
    version: 3, cursor: 1,
    remaining: { fajr: 11, zuhr: 21, asr: 31, maghrib: 41, isha: 51 },
    history: [],
  };
  const qazaA2 = {
    version: 3, cursor: 2,
    remaining: { fajr: 99, zuhr: 88, asr: 77, maghrib: 66, isha: 55 },
    history: [],
  };

  // Прямая запись локального состояния раздела и его метки записи
  // (минуем saveQaza — она пометила бы раздел текущим временем).
  async function setQazaLocal(page, qaza, writes) {
    await page.evaluate(({ qazaJson, writesJson }) => {
      localStorage.setItem('youplanner.qaza', qazaJson);
      localStorage.setItem('youplanner.sync.section-writes', writesJson);
    }, { qazaJson: JSON.stringify(qaza), writesJson: JSON.stringify(writes) });
  }

  async function readQazaLocal(page) {
    return page.evaluate(() => {
      const raw = localStorage.getItem('youplanner.qaza');
      const qaza = raw && raw !== 'undefined' ? JSON.parse(raw) : null;
      const writesRaw = localStorage.getItem('youplanner.sync.section-writes');
      const writes = writesRaw && writesRaw !== 'undefined' ? JSON.parse(writesRaw) : {};
      return { qaza, writes };
    });
  }

  // Ручная отправка (push) из настроек. Фактическую доставку PUT сверяем с
  // разделяемым состоянием мока, а не фиксированным таймаутом.
  // Ждёт доставки PUT с ожидаемым конвертом в разделяемом состоянии мока.
  // Возвращает true/false — падать сам не бросает (диагностика остаётся в шаге).
  async function syncPush(page, expectEnvelope) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    await page.click('#settings-sync-push');
    await page.waitForTimeout(300);
    await page.click('#settings-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
    if (!expectEnvelope) return;
    return waitUntil(() =>
      fb.snapshot && fb.snapshot.qaza &&
      JSON.stringify(fb.snapshot.qaza.v) === JSON.stringify(expectEnvelope.v) &&
      fb.snapshot.qaza.ts === expectEnvelope.ts,
      20000);
  }

  await step('6. Qaza: A пишет локальную qaza-A (section-writes qaza = T1) и отправляет — на сервере конверт {v: qaza-A, ts: T1}', async () => {
    const opened = await newPage(browser, 'A-qaza');
    contextA = opened.context; pageA = opened.page;
    await setQazaLocal(pageA, qazaA, { qaza: T1 });
    const pushedA = await syncPush(pageA, { v: qazaA, ts: T1 });
    assert.ok(pushedA, 'сервер не принял конверт qaza {v: qaza-A, ts: T1}');
    const state = await readQazaLocal(pageA);
    assert.deepEqual(state.qaza, qazaA, 'localStorage A не содержит qaza-A');
    assert.equal(state.writes.qaza, T1, 'section-writes A не содержат T1 для qaza');
    assert.deepEqual(pageA.errorsCollected, [], `pageerror на A: ${pageA.errorsCollected.join(' | ')}`);
  });

  await step('7. Qaza: B пишет qaza-B (section-writes qaza = T2, T2 > T1) и отправляет — сервер берёт конверт {v: qaza-B, ts: T2}', async () => {
    const opened = await newPage(browser, 'B-qaza');
    contextB = opened.context; pageB = opened.page;
    await setQazaLocal(pageB, qazaB, { qaza: T2 });
    const pushedB = await syncPush(pageB, { v: qazaB, ts: T2 });
    assert.ok(pushedB, 'сервер не принял конверт qaza {v: qaza-B, ts: T2}');
    const state = await readQazaLocal(pageB);
    assert.deepEqual(state.qaza, qazaB, 'localStorage B не содержит qaza-B');
    assert.equal(state.writes.qaza, T2, 'section-writes B не содержат T2 для qaza');
    assert.deepEqual(pageB.errorsCollected, [], `pageerror на B: ${pageB.errorsCollected.join(' | ')}`);
  });

  await step('8. Qaza: A ручная сверка — при T2 > T1 серверный конверт побеждает, A принимает qaza-B', async () => {
    await manualSync(pageA);
    const state = await readQazaLocal(pageA);
    assert.deepEqual(state.qaza, qazaB, `A не принял qaza-B: ${JSON.stringify(state.qaza)}`);
    assert.equal(state.writes.qaza, T2, `section-writes A не переняли серверный T2`);
    assert.deepEqual(fb.snapshot.qaza, { v: qazaB, ts: T2 },
      `серверный конверт qaza не {v: qaza-B, ts: T2}`);
    assert.deepEqual(pageA.errorsCollected, [], `pageerror на A: ${pageA.errorsCollected.join(' | ')}`);
  });

  await step('9. Qaza: A пишет qaza-A2 (section-writes qaza = T3, T3 > T2) и отправляет — серверный T2 стареет, PUT уходит с qaza-A2', async () => {
    await setQazaLocal(pageA, qazaA2, { qaza: T3 });
    const pushedA2 = await syncPush(pageA, { v: qazaA2, ts: T3 });
    assert.ok(pushedA2, 'PUT A не ушёл с qaza-A2 (серверный T2 не перекрыл локальную правку T3)');
    const state = await readQazaLocal(pageA);
    assert.deepEqual(state.qaza, qazaA2, 'localStorage A не содержит qaza-A2 после PUT');
    assert.equal(state.writes.qaza, T3, 'section-writes A не содержат T3 для qaza');
    assert.deepEqual(pageA.errorsCollected, [], `pageerror на A: ${pageA.errorsCollected.join(' | ')}`);
  });

  if (contextA) await contextA.close();
  if (contextB) await contextB.close();
  await browser.close();
  server.close();
  console.log(`\nИтог: ${passed} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
