/* ═══════════════════════════════════════════════════════════════════
   Diary-Chat-E2E YouPlanner (playwright, постоянный набор).

   Запуск:  node tests/e2e/diary-chat.e2e.mjs
   Сервер и браузер — по образцу habits-archive.e2e.mjs; герметично:
   Firebase — заглушка с памятью, провайдер ИИ — заглушка-регистратор.
   Наружу никто не ходит, настоящий лимит ИИ не расходуется, реальные
   записи дневника не затрагиваются (мастер-ТЗ §5.2, §6.5).

   Сценарии:

     1. Сеть молчит до явного согласия: сводка согласия построена
        локально, POST провайдера нет.
     2. «Отмена» ничего не отправляет.
     3. Подтверждение: приложение переходит в чат ассистента, уходит
        один запрос с двумя сообщениями (системный + данные), ответ
        появляется в ленте; ключи uid/journalId в запрос не текут.
     4. Обычный вопрос после анализа: дневник в контекст не попадает
        (история с contextKind=diary отфильтрована). ═══════════════ */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = 8936;
const BASE = `http://127.0.0.1:${PORT}`;
const PROVIDER_RE = /api\.neuraldeep\.ru/;
// Узел проекта в RTDB: все пути дневника живут внутри него (js/sync/core.js)
const FB_PREFIX = '/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9';
const FIXED_REPLY = 'Сводка: два события, оба связаны с работой. Планируйте отдых заранее.';

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

// Серверный журнал дневника: валидные записи по схеме (js/harness/diary/schema.js).
// times относительные — fixture не привязан к дате запуска.
function journalFixture() {
  const now = Date.now();
  const start = now - 40 * 24 * 60 * 60 * 1000;
  const ev1 = now - 12 * 24 * 60 * 60 * 1000;
  const ev2 = now - 5 * 24 * 60 * 60 * 1000;
  return {
    initialization: {
      schemaVersion: 1,
      journalId: 'journal-test',
      startedAtMs: start,
      initialDurationMs: 1000,
      timeZone: 'Europe/Moscow',
      createdAtMs: start + 1000,
      deviceId: 'device-test',
    },
    events: {
      'event-1': {
        schemaVersion: 1, eventId: 'event-1', occurredAtMs: ev1,
        reason: 'Стресс на работе', deviceId: 'device-test', createdAtMs: ev1,
      },
      'event-2': {
        schemaVersion: 1, eventId: 'event-2', occurredAtMs: ev2,
        triggerId: 'trigger-1', reason: 'Срыв перед дедлайном',
        deviceId: 'device-test', createdAtMs: ev2,
      },
    },
    triggerCreations: {
      'trigger-1': {
        schemaVersion: 1, triggerId: 'trigger-1', name: 'Дедлайн',
        createdAtMs: start + 2000, deviceId: 'device-test',
      },
    },
  };
}

function seedData() {
  return {
    'youplanner.fb.owner': JSON.stringify({ email: 'owner@example.test', uid: 'uid-test' }),
    'youplanner.diary.journalId.uid-test': 'journal-test',
    'youplanner.api_key': 'test-key',
    'youplanner.migrations': JSON.stringify({ press: true }),
    'youplanner.habits': JSON.stringify([
      { id: 'h1', name: 'Чтение', type: 'boolean', unit: '', goal: null },
    ]),
    'youplanner.records': JSON.stringify({}),
  };
}

async function newPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
  });
  // Firebase-заглушка с памятью; узел журнала посеян заранее.
  const db = new Map();
  db.set(FB_PREFIX + '/diaryV1/uid-test/journals/journal-test', JSON.stringify(journalFixture()));
  const providerCalls = [];
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
    if (PROVIDER_RE.test(url)) {
      providerCalls.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: FIXED_REPLY } }] }),
      });
    }
    if (/securetoken\.googleapis\.com|identitytoolkit\.googleapis\.com/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    }
    return route.abort();
  });
  // Засев одноразовый: addInitScript срабатывает и на reload.
  await context.addInitScript((seed) => {
    if (localStorage.getItem('youplanner.e2e-seeded') === '1') return;
    for (const [key, value] of Object.entries(seed)) {
      localStorage.setItem(key, value);
    }
    localStorage.setItem('youplanner.e2e-seeded', '1');
  }, seedData());
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.errorsCollected = errors;
  page.providerCalls = providerCalls;
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-table:not([hidden])', { timeout: 15000 });
  return { context, page };
}

async function openDiaryAnalysis(page) {
  await page.click('#diary-btn');
  await page.waitForSelector('#diary-view button:has-text("Настройки")', { timeout: 15000 });
  await page.click('#diary-view button:has-text("Настройки")');
  await page.waitForSelector('#diary-view button:has-text("Анализ ИИ")', { timeout: 5000 });
  await page.click('#diary-view button:has-text("Анализ ИИ")');
  await page.waitForSelector('#diary-view button:has-text("Общий анализ в чате")', { timeout: 5000 });
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  console.log('▶ YouPlanner diary-chat-e2e');

  // ── 1. Сеть молчит до согласия ───────────────────────────────────────
  await step('1. 1440: сводка согласия локальна — POST провайдера нет', async () => {
    const { context, page } = await newPage(browser);
    await openDiaryAnalysis(page);
    await page.click('#diary-view button:has-text("Общий анализ в чате")');
    const summary = await page.textContent('#diary-view .diary-content');
    assert.match(summary, /Событий: 2/, 'в сводке число событий');
    assert.match(summary, /Я согласен отправить историю дневника/, 'есть чекбокс согласия');
    assert.equal(page.providerCalls.length, 0, 'до согласия запросов нет');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 2. Отмена ничего не отправляет ───────────────────────────────────
  await step('2. 1440: «Отмена» сбрасывает согласие без запроса', async () => {
    const { context, page } = await newPage(browser);
    await openDiaryAnalysis(page);
    await page.click('#diary-view button:has-text("Общий анализ в чате")');
    await page.check('#diary-view input[type="checkbox"]');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    const output = await page.textContent('#diary-view .diary-content');
    assert.doesNotMatch(output, /Событий: 2/, 'сводка убрана');
    assert.equal(page.providerCalls.length, 0, 'после отмены запросов нет');
    await context.close();
  });

  // ── 3. Подтверждение: запрос уходит в чат ассистента ─────────────────
  await step('3. 1440: согласие → один запрос (2 сообщения) → ответ в ленте чата', async () => {
    const { context, page } = await newPage(browser);
    await openDiaryAnalysis(page);
    await page.click('#diary-view button:has-text("Общий анализ в чате")');
    await page.check('#diary-view input[type="checkbox"]');
    await page.click('#diary-view button:has-text("Передать и проанализировать")');
    // Приложение переключается на чат ассистента
    await page.waitForSelector('#assistant-view:not([hidden])', { timeout: 15000 });
    await page.waitForSelector(`#assistant-chat .assistant-msg-bot:has-text("${FIXED_REPLY}")`, { timeout: 30000 });
    assert.equal(page.providerCalls.length, 1, 'ровно один запрос к провайдеру');
    const payload = page.providerCalls[0];
    assert.equal(payload.messages.length, 2, 'системный промпт + данные дневника');
    const flat = JSON.stringify(payload.messages);
    assert.match(flat, /Стресс на работе/, 'события дневника в запросе');
    assert.doesNotMatch(flat, /uid-test|journal-test|diaryV1/, 'служебные идентификаторы не текут');
    const feed = await page.textContent('#assistant-chat');
    assert.match(feed, /Прошу общий анализ Дневника привычек/, 'подпись-сводка в ленте');
    assert.doesNotMatch(feed, /uid-test|journal-test/, 'идентификаторы не в ленте');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 4. Обычный вопрос после анализа: дневник отфильтрован ────────────
  await step('4. 1440: обычный вопрос после анализа — дневника в контексте нет', async () => {
    const { context, page } = await newPage(browser);
    await openDiaryAnalysis(page);
    await page.click('#diary-view button:has-text("Общий анализ в чате")');
    await page.check('#diary-view input[type="checkbox"]');
    await page.click('#diary-view button:has-text("Передать и проанализировать")');
    await page.waitForSelector(`#assistant-chat .assistant-msg-bot:has-text("${FIXED_REPLY}")`, { timeout: 30000 });
    await page.fill('#assistant-input', 'Как дела с привычками?');
    await page.click('#assistant-send');
    await page.waitForFunction(
      () => document.querySelectorAll('#assistant-chat .assistant-msg-bot').length >= 2,
      null, { timeout: 30000 },
    );
    assert.equal(page.providerCalls.length, 2, 'второй запрос ушёл');
    const flat = JSON.stringify(page.providerCalls[1].messages);
    assert.doesNotMatch(flat, /Стресс на работе|Дедлайн/, 'чувствительные данные дневника отфильтрованы');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  await browser.close();
  server.close();
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
