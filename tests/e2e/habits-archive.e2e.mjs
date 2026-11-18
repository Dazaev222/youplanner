/* ═══════════════════════════════════════════════════════════════════
   Habits-Archive-E2E YouPlanner (playwright, постоянный набор).

   Запуск:  node tests/e2e/habits-archive.e2e.mjs
   Сервер и браузер — по образцу chaos.e2e.mjs; герметично: Firebase
   отвечает пустым узлом, наружу никто не ходит. Данные — тестовые,
   сеются в localStorage до загрузки приложения.

   Сценарии (мастер-ТЗ §6.3–6.4):

     1. 1440 px: архивация из редактора — привычка исчезает из таблицы
        недели, знаменатель прогресса уменьшается, отметка сохраняется.
     2. Экран «Архив привычек»: строка с кнопкой «Вернуть»; возврат
        возвращает привычку с прежним id и прежними отметками; после
        перезагрузки страницы отметки на месте.
     3. Пустой архив: «В архиве пока нет привычек».
     4. 390 px: главный экран, экран архива — без горизонтального
        переполнения; сценарий архивация → возврат повторяется.
     5. Все привычки в архиве: честное пустое состояние на главном,
        без NaN/ошибок. ═════════════════════════════════════════════════ */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = 8935;
const BASE = `http://127.0.0.1:${PORT}`;

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
  let file = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  readFile(file).then((data) => {
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  }, () => { res.writeHead(404); res.end('not found'); });
});

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message.split('\n').slice(0, 5).join('\n        ')}`);
  }
}

const TODAY = new Date().toISOString().slice(0, 10);

function seedData() {
  return {
    'youplanner.habits': JSON.stringify([
      { id: 'h1', name: 'Чтение', type: 'boolean', unit: '', goal: null },
      { id: 'h2', name: 'Зарядка', type: 'boolean', unit: '', goal: null },
    ]),
    'youplanner.records': JSON.stringify({ [TODAY]: { h1: true } }),
    // Миграция «Пресс» дополняет список при первом старте и ломала бы
    // сценарий «все в архиве» — для набора она не нужна
    'youplanner.migrations': JSON.stringify({ press: true }),
  };
}

async function newPage(browser, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'ru-RU',
  });
  // Firebase-заглушка с памятью: PUT сохраняется и отдаётся следующим GET.
  // Наивный «всегда null» ломает цикл подтверждения сверки после
  // перезагрузки страницы — приложение стирало архивные флаги.
  const db = new Map();
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (/firebaseio\.com/.test(url)) {
      const path = new URL(url).pathname.replace(/\.json$/, '');
      const method = route.request().method();
      if (method === 'PUT' || method === 'POST') {
        const body = route.request().postData() ?? 'null';
        db.set(path, body);
        return route.fulfill({ status: 200, contentType: 'application/json', body });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: db.get(path) ?? 'null' });
    }
    if (/securetoken\.googleapis\.com|identitytoolkit\.googleapis\.com/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    }
    return route.abort();
  });
  // Засев одноразовый: addInitScript срабатывает и на reload, и без флага
  // перезагрузка стирала бы результаты сценария (архивные флаги, отметки)
  await context.addInitScript((seed) => {
    if (localStorage.getItem('youplanner.e2e-seeded') === '1') return;
    for (const [key, value] of Object.entries(seed)) {
      localStorage.setItem(key, value);
    }
    localStorage.setItem('youplanner.e2e-seeded', '1');
  }, seedData());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.errorsCollected = errors;
  page.dialogText = null;
  page.on('dialog', async (dialog) => {
    page.dialogText = dialog.message();
    await dialog.accept();
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#day-cards:not([hidden]), #habits-table:not([hidden])', { timeout: 15000 });
  return { context, page };
}

async function gotoSettings(page) {
  if (await page.locator('#settings-view:not([hidden])').count()) return;
  // На ПК настройки открывает кнопка шапки, на телефоне — таб-бар
  const headerBtn = page.locator('#settings-btn:visible');
  if (await headerBtn.count()) {
    await headerBtn.click();
  } else {
    await page.click('#tab-bar .tab-item[data-view="settings"]');
  }
  await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
}

async function openEditor(page) {
  await gotoSettings(page);
  await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
  await page.click('#settings-edit-habits');
  await page.waitForSelector('#habits-edit-view:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('#habits-edit-list li[data-habit-id]', { timeout: 5000 });
}

// Аккордеон: поля и кнопки строки раскрываются тапом по заголовку
async function expandRow(page, habitId) {
  await page.click(`li[data-habit-id="${habitId}"] .habit-row-head`);
  await page.waitForSelector(`li[data-habit-id="${habitId}"] .edit-archive`, { timeout: 5000 });
}

async function closeEditor(page) {
  await page.click('#habits-edit-back');
  await page.waitForSelector('#habits-edit-view', { state: 'hidden', timeout: 5000 }).catch(() => {});
}

async function openArchiveScreen(page) {
  await gotoSettings(page);
  await page.click('#settings-habits-archive');
  await page.waitForSelector('#habits-archive-view:not([hidden])', { timeout: 5000 });
}

async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  console.log('▶ YouPlanner habits-archive-e2e');

  // ── 1. Архивация на 1440 px ──────────────────────────────────────────
  await step('1. 1440: архивация убирает привычку из таблицы недели', async () => {
    const { context, page } = await newPage(browser);
    await page.waitForSelector('tr[data-habit-id="h2"]', { timeout: 15000 });
    await openEditor(page);
    await expandRow(page, 'h2');
    await page.click('li[data-habit-id="h2"] .edit-archive');
    assert.match(page.dialogText, /Зарядка/, 'подтверждение называет привычку и историю');
    await page.waitForSelector('#habits-edit-list li[data-habit-id="h2"]', { state: 'detached', timeout: 5000 });
    await closeEditor(page);
    await page.waitForSelector('tr[data-habit-id="h2"]', { state: 'detached', timeout: 5000 });
    const body = await page.textContent('body');
    assert.ok(!body.includes('NaN'), 'NaN в интерфейсе после архивации');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 2. Экран архива: возврат с сохранением отметок ───────────────────
  await step('2. 1440: экран архива показывает строку, возврат возвращает отметки после перезагрузки', async () => {
    const { context, page } = await newPage(browser);
    await openEditor(page);
    await expandRow(page, 'h2');
    await page.click('li[data-habit-id="h2"] .edit-archive');
    await page.waitForSelector('#habits-edit-list li[data-habit-id="h2"]', { state: 'detached', timeout: 5000 });
    await closeEditor(page);
    await openArchiveScreen(page);
    await page.waitForSelector('#habits-archive-list li[data-habit-id="h2"]', { timeout: 5000 });
    const name = await page.textContent('#habits-archive-list li[data-habit-id="h2"]');
    assert.ok(name.includes('Зарядка'), 'имя и тип показаны');
    await page.click('#habits-archive-list li[data-habit-id="h2"] .archive-restore');
    await page.waitForSelector('#habits-archive-list li[data-habit-id="h2"]', { state: 'detached', timeout: 5000 });
    assert.ok(await page.textContent('#habits-archive-empty') !== null, 'экран жив');
    // Перезагрузка: отметки прежние
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('tr[data-habit-id="h2"]', { timeout: 15000 });
    const body = await page.textContent('body');
    assert.ok(body.includes('Зарядка'), 'привычка видна после перезагрузки');
    const marked = await page.locator('input.cell-check[data-habit-id="h1"]:checked').count();
    assert.ok(marked >= 1, 'отметка h1 за сегодня сохранилась');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 3. Пустой архив ──────────────────────────────────────────────────
  await step('3. 1440: пустой архив — честное пустое состояние', async () => {
    const { context, page } = await newPage(browser);
    await openArchiveScreen(page);
    await page.waitForSelector('#habits-archive-empty:not([hidden])', { timeout: 5000 });
    const text = await page.textContent('#habits-archive-empty');
    assert.match(text, /пока нет привычек/);
    await context.close();
  });

  // ── 4. 390 px: архивация → возврат, без горизонтального переполнения ─
  await step('4. 390: сценарий архивация→архив→возврат, без горизонтального скролла', async () => {
    const { context, page } = await newPage(browser, { width: 390, height: 844 });
    await page.waitForSelector('#day-cards:not([hidden]), #habits-table:not([hidden])', { timeout: 15000 });
    await openEditor(page);
    await expandRow(page, 'h1');
    await page.click('li[data-habit-id="h1"] .edit-archive');
    await page.waitForSelector('#habits-edit-list li[data-habit-id="h1"]', { state: 'detached', timeout: 5000 });
    await closeEditor(page);
    await openArchiveScreen(page);
    await page.waitForSelector('#habits-archive-list li[data-habit-id="h1"]', { timeout: 5000 });
    assert.equal(await horizontalOverflow(page), false, 'горизонтальное переполнение на экране архива');
    await page.click('#habits-archive-list li[data-habit-id="h1"] .archive-restore');
    await page.waitForSelector('#habits-archive-list li[data-habit-id="h1"]', { state: 'detached', timeout: 5000 });
    await page.click('#habits-archive-back');
    await page.waitForSelector('#habits-archive-view', { state: 'hidden', timeout: 5000 });
    assert.equal(await horizontalOverflow(page), false, 'горизонтальное переполнение на главном');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 5. Все привычки в архиве ─────────────────────────────────────────
  await step('5. 1440: все в архиве — пустое состояние, без ошибок', async () => {
    const { context, page } = await newPage(browser);
    await openEditor(page);
    await expandRow(page, 'h1');
    await page.click('li[data-habit-id="h1"] .edit-archive');
    await page.waitForSelector('#habits-edit-list li[data-habit-id="h1"]', { state: 'detached', timeout: 5000 });
    await expandRow(page, 'h2');
    await page.click('li[data-habit-id="h2"] .edit-archive');
    await page.waitForSelector('#habits-edit-list li[data-habit-id="h2"]', { state: 'detached', timeout: 5000 });
    await closeEditor(page);
    // Пустое состояние живёт на главном: перезагрузка возвращает на главный экран
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#habits-empty-note:not([hidden])', { timeout: 15000 });
    const note = await page.textContent('#habits-empty-note');
    assert.match(note, /Архив привычек/, 'пустое состояние предлагает архив');
    assert.ok(!(await page.textContent('body')).includes('NaN'));
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  await browser.close();
  server.close();
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
