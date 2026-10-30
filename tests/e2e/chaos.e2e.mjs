/* ═══════════════════════════════════════════════════════════════════
   Chaos-E2E YouPlanner (playwright, постоянный набор).

   Запуск:  node tests/e2e/chaos.e2e.mjs
   Покрывает отказы, на которых приложение обязано выживать:

     1. Старт без сети: Firebase недоступен — таблица собирается
        на локальных данных, ни одной pageerror.
     2. Кнопка «Выполнено»: рамка видна на белом фоне (регресс-тест
        UI-фикса), клик работает, фокус с клавиатуры не теряется.
     3. 1000 кликов: штормовое переключение всех разделов — интерфейс
        отвечает после шторма, DOM не разрастается (утечка).
     4. Сеть: офлайн при отметке привычки (работает локально) и при
        вопросе ассистенту («Печатает…» разрешается ошибкой, не висит).
     5. Хранилище: QuotaExceededError при записи отметки — тост об
        ошибке, интерфейс жив, ни одного необработанного исключения.
     6. Данные: битый JSON и JSON чужой схемы с сервера — снимок
        отвергается, локальные данные целы, экран работает.

   Внешняя сеть блокируется целиком: тесты не зависят ни от Firebase,
   ни от нейросервиса. ═════════════════════════════════════════════ */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { habit } from '../helpers/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolveRoot(HERE);
const PORT = 8933;
const BASE = `http://127.0.0.1:${PORT}`;
const FIREBASE = /firebaseio\.com/;

function resolveRoot(from) {
  // tests/e2e/ → корень проекта
  return join(from, '..', '..');
}

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
    console.error(`  FAIL  ${name}\n        ${e.message.split('\n').slice(0, 4).join('\n        ')}`);
  }
}

async function newPage(browser, { initScript, initScriptArg, firebaseHandler } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    locale: 'ru-RU',
  });
  // Герметичность: наружу из тестового браузера не пускаем никого.
  // Firebase по умолчанию отвечает пустым узлом — «сервер пуст».
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (FIREBASE.test(url)) {
      if (firebaseHandler) return firebaseHandler(route, url);
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    }
    return route.abort();
  });
  if (initScript) {
    if (initScriptArg === undefined) await context.addInitScript(initScript);
    else await context.addInitScript(initScript, initScriptArg);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.errorsCollected = errors;
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-table', { timeout: 15000 });
  return { context, page };
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  console.log('▶ YouPlanner chaos-e2e');

  // ── 1. Старт без сети ────────────────────────────────────────────────
  await step('1. Firebase недоступен: приложение стартует на локальных данных', async () => {
    const { context, page } = await newPage(browser, {
      firebaseHandler: (route) => route.abort(),
    });
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
    const rows = await page.locator('#habits-tbody tr').count();
    assert.ok(rows >= 5, `ожидались дефолтные привычки, строк: ${rows}`);
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 2. Кнопка «Выполнено» ────────────────────────────────────────────
  await step('2. «Выполнено»: рамка видна, клик работает, фокус держится', async () => {
    const { context, page } = await newPage(browser);
    await page.click('#qaza-btn');
    await page.waitForSelector('#qaza-done', { timeout: 5000 });

    // Регресс UI-фикса: рамка не прозрачная и читается на белом
    const border = await page.evaluate(() => {
      const el = document.getElementById('qaza-done');
      const cs = getComputedStyle(el);
      return { color: cs.borderTopColor, width: cs.borderTopWidth, bg: cs.backgroundColor };
    });
    assert.equal(border.width, '1px', `ширина рамки: ${border.width}`);
    assert.notEqual(border.color, 'rgba(0, 0, 0, 0)', 'рамка прозрачна — кнопка слита с фоном');

    // Клик: план перерисовывается, «Выполнено» переезжает к следующему
    // пункту (очередь последовательна), курсор сдвинулся Магриб → Иша
    const wasCurrent = await page.textContent('.qaza-plan-item.is-current .qaza-plan-name');
    await page.click('#qaza-done');
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('.qaza-plan-item.is-current .qaza-plan-name');
        return el && el.textContent !== prev;
      }, wasCurrent, { timeout: 5000 })
      .catch(() => {
        throw new Error('после клика план не перерисовался: курсор не сдвинулся');
      });

    // Фокус с клавиатуры: Tab до кнопки даёт видимый outline (buttons.css)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#qaza-btn');
    await page.waitForSelector('#qaza-done');
    await page.focus('#qaza-done');
    await page.keyboard.press('Shift');   // нейтральная клавиша: сбросить :focus-visible нельзя, но состояние читаем
    const outline = await page.evaluate(() => {
      const el = document.getElementById('qaza-done');
      return el.matches(':focus') ? getComputedStyle(el).outlineStyle : 'not-focused';
    });
    assert.notEqual(outline, 'not-focused', 'кнопка потеряла фокус');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 3. 1000 кликов ───────────────────────────────────────────────────
  await step('3. 1000 кликов по разделам: отвечает после шторма, DOM не течёт', async () => {
    // Ключ ассистента сеём заранее: без него каждый вход на вкладку
    // открывает модалку ключа, и её подложка перехватывает клики
    const { context, page } = await newPage(browser, {
      initScript: () => {
        localStorage.setItem('youplanner.api_key', 'test-key-for-e2e');
      },
    });
    const domBefore = await page.evaluate(
      () => document.getElementsByTagName('*').length);

    const route = [
      ['#qaza-btn', '#qaza-back'],
      ['#schedule-btn', '#schedule-back'],
      ['#assistant-btn', '#assistant-back'],
      // Молитвы открываются из шапки каза; назад — сначала в каза (#prayer-back),
      // затем из каза на главную (#qaza-back)
      ['#qaza-btn', null],
      ['#prayer-btn', '#prayer-back'],
      ['#qaza-back', null],
    ];
    let clicks = 0;
    for (let i = 0; i < 100 && clicks < 1000; i++) {
      for (const [open, close] of route) {
        await page.click(open);
        clicks++;
        if (close) { await page.click(close); clicks++; }
        if (clicks >= 1000) break;
      }
    }
    assert.ok(clicks >= 1000, `набрано кликов: ${clicks}`);

    // После шторма интерфейс обязан отвечать: переход и рендер настроек
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-version', { timeout: 5000 });
    const version = await page.textContent('#settings-version');
    assert.match(version, /Версия:/, 'настройки не отрисовались после шторма');

    const domAfter = await page.evaluate(
      () => document.getElementsByTagName('*').length);
    assert.ok(domAfter < domBefore * 3 + 200,
      `DOM разросся: было ${domBefore}, стало ${domAfter}`);
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 4. Сеть: офлайн ──────────────────────────────────────────────────
  await step('4. Офлайн: отметка привычки работает, ассистент не зависает', async () => {
    const { context, page } = await newPage(browser, {
      initScript: () => {
        localStorage.setItem('youplanner.api_key', 'test-key-for-e2e');
      },
    });
    await context.setOffline(true);

    // Отметка привычки при отрезанной сети: локальная запись, таблица живая
    const firstCheck = page.locator('#habits-tbody input.cell-check').first();
    await firstCheck.click();
    await page.waitForTimeout(300);
    const checked = await firstCheck.isChecked();
    assert.equal(checked, true, 'отметка не встала при офлайне');

    // Ассистент офлайн: «Печатает…» обязан разрешиться ошибкой, не висеть
    await page.click('#assistant-btn');
    await page.waitForSelector('#assistant-input');
    await page.fill('#assistant-input', 'Проверка офлайна');
    await page.click('#assistant-send');
    await page.waitForSelector('.assistant-msg-bot.is-error', { timeout: 10000 });
    const errText = await page.textContent('.assistant-msg-bot.is-error');
    assert.match(errText, /Нет связи/, `неожиданный текст ошибки: ${errText.slice(0, 80)}`);
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 5. Хранилище: квота ──────────────────────────────────────────────
  await step('5. QuotaExceeded: тост об ошибке, интерфейс жив', async () => {
    const { context, page } = await newPage(browser, {
      initScript: () => {
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'youplanner.records') {
            throw new DOMException('quota exceeded (chaos-test)', 'QuotaExceededError');
          }
          return orig.call(this, key, value);
        };
      },
    });
    await page.locator('#habits-tbody input.cell-check').first().click();
    await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
    const toast = await page.textContent('#toast');
    assert.match(toast, /Не удалось сохранить/,
      `неожиданный тост: ${toast.slice(0, 80)}`);

    // Интерфейс жив: квота сломана насовсем, поэтому каждая отметка снова
    // показывает тост (правильное поведение — не молчать), и переходы работают
    await page.click('#qaza-btn');
    await page.waitForSelector('#qaza-done', { timeout: 5000 });
    await page.click('#qaza-back');
    await page.locator('#habits-tbody input.cell-check').nth(1).click();
    await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
    assert.match(await page.textContent('#toast'), /Не удалось сохранить/,
      'повторный отказ хранилища не показан');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 6. Данные: битый и чужой JSON с сервера ──────────────────────────
  await step('6. Битый JSON с Firebase: приложение работает на локальных данных', async () => {
    const { context, page } = await newPage(browser, {
      firebaseHandler: (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: 'не-json{{{' }),
    });
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
    const rows = await page.locator('#habits-tbody tr').count();
    assert.ok(rows >= 5, 'таблица пуста после битого ответа');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  await step('7. JSON чужой схемы: снимок отвергнут, локальные данные целы', async () => {
    const seededHabits = [
      habit(),
      habit({ id: 'h2', name: 'Зухр' }),
      habit({ id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 }),
    ];
    const { context, page } = await newPage(browser, {
      // Локальные данные сеем до старта: на первом запуске с пустым локалом
      // и битым, но «победившим» по времени снимком приложение честно
      // показывает пустую таблицу — применять мусор нельзя, дефолты писать
      // тоже (сервер-то не пуст). Здесь проверяем главное: данные, которые
      // УЖЕ есть локально, мусорный снимок не вытесняет.
      initScript: ({ habits }) => {
        localStorage.setItem('youplanner.habits', JSON.stringify(habits));
      },
      initScriptArg: { habits: seededHabits },
      // Таймстамп из будущего: снимок «новее» любого локального — проверяем
      // именно защиту валидаторами, а не сравнение времени
      firebaseHandler: (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          updatedAt: 99999999999999,
          habits: 'строка вместо массива',
          records: 42,
          qaza: { remaining: 'мусор' },
          prayer: null,
          fast: { remaining: '15' },
          sleep: { bed: 7 },
          schedule: [],
        }),
      }),
    });
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#habits-tbody .habit-name'))
        .map((el) => el.textContent));
    assert.ok(names.includes('Фаджр') && names.includes('Каза'),
      `локальные привычки вытеснены чужим снимком: ${names.join(', ')}`);

    // Отметка после «применения» мусора обязана работать: данные целы
    const firstCheck = page.locator('#habits-tbody input.cell-check').first();
    await firstCheck.click();
    await page.waitForTimeout(200);
    assert.equal(await firstCheck.isChecked(), true, 'отметка не работает после мусорного снимка');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  await browser.close();
  server.close();

  console.log(`\nИтог: ${passed} PASS, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
