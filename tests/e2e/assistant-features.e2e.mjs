/* ═══════════════════════════════════════════════════════════════════
   Assistant-E2E YouPlanner (playwright, постоянный набор).

   Запуск:  node tests/e2e/assistant-features.e2e.mjs
   Сервер и браузер поднимаются по образцу chaos.e2e.mjs (тот же
   статический сервер, тот же chromium, герметичная маршрутизация),
   порт другой — 8934, чтобы прогоны не спорили за сокет.

   Покрывает новые элементы чата ассистента:

     1. Модалка «Настройки ассистента»: ввод ключа на табе «API Ключ»,
        шестерёнка открывает ровно одну панель; переключение табов
        «API Ключ» ↔ «Персонализация» двигает hidden-панели и
        aria-selected сегмента (role=tablist).
     2. «Лимит длины ответа» доходит до API: слайдер #assistant-max-tokens
        на 2500 → «Сохранить» пишет maxTokens в
        youplanner.assistant_persona; перехват api.neuraldeep.ru
        показывает max_tokens: 2500 и числовую temperature в теле POST.
     3. Кнопка «Отправить» во время запроса: disabled + серый фон
        var(--surface-pressed); после ответа disabled снят, фон —
        var(--accent). Цвета сверяются с CSS-переменными токенов.
     4. Чип «Анализ привычек»: по засеянным youplanner.habits /
        youplanner.records строится реплика «Сделай анализ моих
        привычек…», появляется пузырь пользователя, и та же реплика
        уходит в messages[] запроса к API.
     5. Shift+Enter: включённый тумблер разрешает перенос строки в
        textarea, Enter отправляет реплику и чистит поле.
     6. Ключ с кириллицей («тест») больше не роняет fetch на заголовке
        Authorization (non ISO-8859-1): запрос уходит с вычищенным
        ключом, а пользователь получает честный отказ «Ключ повреждён…»
        вместо вводящего в заблуждение «Нет связи с сервисом». Баг
        найден этим набором, исправлен в postAssistantChat +
        onAssistantKeySave (аудит 2026-11-01).

   Внешняя сеть блокируется целиком (как в chaos): Firebase отвечает
   пустым узлом, api.neuraldeep.ru — перехват с валидным ответом. ═══ */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
// chaos.e2e.mjs занимает 8933 — здесь соседний порт
const PORT = 8934;
const BASE = `http://127.0.0.1:${PORT}`;
const FIREBASE = /firebaseio\.com/;
// Ход ассистента — единственный разрешённый внешний запрос
const NEURAL = /api\.neuraldeep\.ru/;

// Валидный ответ OpenAI-совместимого эндпоинта: js/ui/assistant-media.js
// (postAssistantChat) читает choices[0].message.content и требует
// непустую строку
const OK_REPLY = { choices: [{ message: { content: 'ОК' } }] };

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

// Захват тел POST к api.neuraldeep.ru. firstBody() — промис первого
// пойманного тела: тест ждёт его вместо гадания «ушёл ли запрос»
function makeApiCapture() {
  const api = { bodies: [], headers: [], _waiters: [] };
  api.firstBody = function (timeoutMs = 15000) {
    if (this.bodies.length) return Promise.resolve(this.bodies[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('запрос к api.neuraldeep.ru не ушёл за ' + timeoutMs + ' мс')),
        timeoutMs);
      this._waiters.push((body) => { clearTimeout(timer); resolve(body); });
    });
  };
  return api;
}

// Перехват нейросервиса: тело и заголовки — в захват, ответ — по
// настройке (задержка/текст). Валидный JSON — как парсит postAssistantChat.
async function handleNeural(route, api, neural) {
  let body;
  try { body = route.request().postDataJSON(); }
  catch (e) { body = route.request().postData(); }
  api.bodies.push(body);
  api.headers.push(route.request().headers());
  const waiters = api._waiters.splice(0);
  for (const w of waiters) w(body);
  if (neural && neural.delayMs) {
    await new Promise((r) => setTimeout(r, neural.delayMs));
  }
  const reply = (neural && neural.reply) || OK_REPLY;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(reply),
  });
}

async function newPage(browser, { initScript, initScriptArg, neural } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    locale: 'ru-RU',
  });
  const api = makeApiCapture();
  // Герметичность: наружу — только перехват нейросервиса; Firebase по
  // умолчанию отвечает пустым узлом («сервер пуст»), остальное абортится
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (NEURAL.test(url)) return handleNeural(route, api, neural);
    if (FIREBASE.test(url)) {
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
  return { context, page, api };
}

// Открыть чат ассистента: тот же вход, что использует chaos (клик по
// кнопке в шапке, ждём поле ввода)
async function openAssistant(page) {
  await page.click('#assistant-btn');
  await page.waitForSelector('#assistant-input', { timeout: 5000 });
}

// Ждать пузырь бота с точным текстом (typing-узел «Печатает…» не считается:
// ответ его перезаписывает и снимает is-typing)
async function waitForBotReply(page, text, timeout = 10000) {
  await page.waitForFunction((wanted) => {
    const msgs = document.querySelectorAll('#assistant-chat .assistant-msg-bot');
    for (const m of msgs) {
      if (m.textContent === wanted && !m.classList.contains('is-typing')) return true;
    }
    return false;
  }, text, { timeout });
}

// Разрешённое значение CSS-переменной в формате computed-цвета
// ('rgb(r, g, b)'): сырой токен из getPropertyValue — hex, с фоном
// элемента его напрямую не сравнить
async function cssVarColor(page, varName) {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, varName);
}

async function sendBgColor(page) {
  return page.evaluate(() =>
    getComputedStyle(document.getElementById('assistant-send')).backgroundColor);
}

// aria-selected таба сегмента настроек
async function tabSelected(page, tab) {
  return page.getAttribute(
    `#assistant-settings-switch [data-assistant-tab="${tab}"]`, 'aria-selected');
}

// Пара панелей модалки: hidden-атрибуты и фактическая видимость
async function panelsState(page) {
  return page.evaluate(() => {
    const persona = document.getElementById('assistant-persona-panel');
    const apiPanel = document.getElementById('assistant-api-panel');
    return {
      personaHidden: persona.hidden,
      apiHidden: apiPanel.hidden,
      personaDisplay: getComputedStyle(persona).display,
      apiDisplay: getComputedStyle(apiPanel).display,
    };
  });
}

// Сеянные привычки — формат записей js/data/habits.js (DEFAULT_HABITS):
// id/имя/тип/единица/цель
const SEEDED_HABITS = [
  { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
  { id: 'h2', name: 'Зухр', type: 'boolean', unit: '', goal: null },
  { id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 },
];

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  console.log('▶ YouPlanner assistant-features-e2e');

  // ── 1. Вкладки настроек ──────────────────────────────────────────────
  await step('1. Настройки: ключ вводится, шестерёнка открывает одну панель, табы переключаются с aria', async () => {
    const { context, page } = await newPage(browser);

    // Первый вход без ключа: модалка открывается сама, на табе «API Ключ»
    await openAssistant(page);
    await page.waitForSelector('#assistant-key-modal:not([hidden])', { timeout: 5000 });
    assert.equal(await tabSelected(page, 'api'), 'true',
      'без ключа модалка должна открыться на табе «API Ключ»');
    assert.equal(await tabSelected(page, 'persona'), 'false');

    // Вводим ключ и сохраняем — модалка закрывается
    await page.fill('#assistant-key-input', 'e2e-key-tabs');
    await page.click('#assistant-key-save');
    await page.waitForFunction(
      () => document.getElementById('assistant-key-modal').hidden === true,
      null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('youplanner.api_key')),
      'e2e-key-tabs', 'ключ не осел в localStorage');

    // Шестерёнка: модалка с ключом открывается на «Персонализации»,
    // видима ровно одна панель
    await page.click('#assistant-settings');
    await page.waitForSelector('#assistant-key-modal:not([hidden])', { timeout: 5000 });
    assert.equal(await tabSelected(page, 'persona'), 'true',
      'с ключом по умолчанию активен таб «Персонализация»');
    let panels = await panelsState(page);
    assert.equal(panels.personaHidden, false, 'панель «Персонализация» скрыта при открытии');
    assert.equal(panels.apiHidden, true, 'панель «API Ключ» видна при открытии — панелей стало две');
    assert.equal(panels.apiDisplay, 'none', 'скрытая панель «API Ключ» не должна занимать место');
    assert.notEqual(panels.personaDisplay, 'none');

    // Сегмент — tablist, кнопки — табы
    assert.equal(await page.getAttribute('#assistant-settings-switch', 'role'), 'tablist');
    assert.equal(await page.getAttribute(
      '#assistant-settings-switch [data-assistant-tab="persona"]', 'role'), 'tab');

    // Клик «API Ключ»: панели переехали, aria-selected перевернулся
    await page.click('#assistant-settings-switch [data-assistant-tab="api"]');
    panels = await panelsState(page);
    assert.equal(panels.apiHidden, false, 'панель «API Ключ» не показалась по клику');
    assert.equal(panels.personaHidden, true, 'панель «Персонализация» не скрылась по клику');
    assert.equal(await tabSelected(page, 'api'), 'true');
    assert.equal(await tabSelected(page, 'persona'), 'false');

    // Обратно на «Персонализацию»
    await page.click('#assistant-settings-switch [data-assistant-tab="persona"]');
    panels = await panelsState(page);
    assert.equal(panels.personaHidden, false);
    assert.equal(panels.apiHidden, true);
    assert.equal(await tabSelected(page, 'persona'), 'true');
    assert.equal(await tabSelected(page, 'api'), 'false');

    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 2. Лимит длины ответа доходит до API ─────────────────────────────
  await step('2. Слайдер «Лимит длины ответа» 2500: в persona-хранилище и в max_tokens запроса', async () => {
    const { context, page, api } = await newPage(browser, {
      initScript: () => {
        localStorage.setItem('youplanner.api_key', 'e2e-key-tokens');
      },
    });
    await openAssistant(page);
    await page.click('#assistant-settings');
    await page.waitForSelector('#assistant-key-modal:not([hidden])', { timeout: 5000 });

    // Слайдер с подписью «Лимит длины ответа» — #assistant-max-tokens
    // (range 100..4000, шаг 100). fill выставляет значение и стреляет
    // input — та же реакция, что на перетаскивание
    await page.fill('#assistant-max-tokens', '2500');
    assert.equal(await page.textContent('#assistant-max-tokens-value'), '2500 симв.',
      'живая подпись слайдера не обновилась');

    await page.click('#assistant-key-save');
    const persona = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.assistant_persona')));
    assert.equal(persona.maxTokens, 2500,
      `в youplanner.assistant_persona maxTokens=${JSON.stringify(persona.maxTokens)}`);

    // Отправка реплики: перехват ловит тело POST к нейросервису
    await page.fill('#assistant-input', 'Скажи ОК');
    await page.click('#assistant-send');
    const body = await api.firstBody();
    assert.equal(body.max_tokens, 2500,
      `в payload ушло max_tokens=${JSON.stringify(body.max_tokens)}`);
    assert.equal(typeof body.temperature, 'number',
      `temperature не число: ${JSON.stringify(body.temperature)}`);
    assert.ok(Array.isArray(body.messages) && body.messages.length >= 2,
      'в payload нет массива messages (system + реплика)');
    const lastUser = body.messages.filter((m) => m.role === 'user').pop();
    assert.ok(lastUser && lastUser.content === 'Скажи ОК',
      'реплика не долетела до messages[]');
    // Ключ сохранённый уходит в Authorization, а не только в localStorage
    await waitForBotReply(page, 'ОК');
    assert.equal(api.headers[0] && api.headers[0].authorization,
      'Bearer e2e-key-tokens', 'ключ не ушёл в Authorization запроса');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 3. Состояние кнопки «Отправить» во время запроса ─────────────────
  await step('3. «Отправить»: во время ожидания disabled и серый фон, после ответа — акцент', async () => {
    const { context, page } = await newPage(browser, {
      neural: { delayMs: 800 },
      initScript: () => {
        localStorage.setItem('youplanner.api_key', 'e2e-key-busy');
      },
    });
    await openAssistant(page);
    await page.fill('#assistant-input', 'Долгий вопрос');
    await page.click('#assistant-send');

    // Во время полёта запроса кнопка обязана погаснуть
    await page.waitForFunction(
      () => document.getElementById('assistant-send').disabled === true,
      null, { timeout: 3000 });
    assert.ok(await page.locator('#assistant-send').isDisabled(),
      'кнопка не задизейблилась во время запроса');
    assert.equal(await page.evaluate(() =>
      document.getElementById('assistant-send').hasAttribute('disabled')), true,
      'у кнопки нет disabled-атрибута во время запроса');

    // Серый фон: computed background равен --surface-pressed
    const pressedColor = await cssVarColor(page, '--surface-pressed');
    const busyBg = await sendBgColor(page);
    assert.equal(busyBg, pressedColor,
      `фон при disabled=${busyBg}, ожидался --surface-pressed (${pressedColor})`);

    // Ответ пришёл: disabled снят, фон вернулся к --accent
    await waitForBotReply(page, 'ОК');
    await page.waitForFunction(
      () => document.getElementById('assistant-send').disabled === false,
      null, { timeout: 3000 });
    const accentColor = await cssVarColor(page, '--accent');
    const idleBg = await sendBgColor(page);
    assert.equal(idleBg, accentColor,
      `фон после ответа=${idleBg}, ожидался --accent (${accentColor})`);

    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 4. Анализ привычек ───────────────────────────────────────────────
  await step('4. Чип «Анализ привычек»: пузырь со снимком и та же реплика в messages[]', async () => {
    const { context, page, api } = await newPage(browser, {
      // Данные сеем до старта приложения: 3 привычки из формата
      // js/data/habits.js и записи десяти дней с h1:true, h6:2
      initScript: ({ habits }) => {
        const iso = (d) => d.getFullYear() + '-'
          + String(d.getMonth() + 1).padStart(2, '0') + '-'
          + String(d.getDate()).padStart(2, '0');
        const records = {};
        const now = new Date();
        for (let i = 0; i < 10; i++) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          records[iso(d)] = { h1: true, h6: 2 };
        }
        localStorage.setItem('youplanner.habits', JSON.stringify(habits));
        localStorage.setItem('youplanner.records', JSON.stringify(records));
        // ASCII-ключ: сценарий про чип анализа, а не про секреты заголовков.
        // Ключ с кириллицей роняет fetch до сети — см. сценарий 6 (баг).
        localStorage.setItem('youplanner.api_key', 'e2e-key-analysis');
      },
      initScriptArg: { habits: SEEDED_HABITS },
    });

    // Ключ сеян — модалка не открывается сама, чат готов к приёму
    await openAssistant(page);
    await page.click('.assistant-chip[data-action="analysis"]');

    // Пузырь пользователя со снимком: текст начинается с команды анализа
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll('#assistant-chat .assistant-msg-user');
      for (const m of msgs) {
        if (m.textContent.startsWith('Сделай анализ моих привычек')) return true;
      }
      return false;
    }, null, { timeout: 5000 });
    const bubbleText = await page.evaluate(() => {
      const msgs = document.querySelectorAll('#assistant-chat .assistant-msg-user');
      return msgs[msgs.length - 1].textContent;
    });

    // Та же реплика ушла в messages[] запроса к нейросервису
    const body = await api.firstBody();
    const lastUser = body.messages.filter((m) => m.role === 'user').pop();
    assert.ok(lastUser && lastUser.content === bubbleText,
      `в messages[] ушла не та реплика: ${JSON.stringify(lastUser && lastUser.content).slice(0, 120)}`);
    assert.ok(bubbleText.includes('Фаджр'),
      'в снимке анализа нет сеянной привычки «Фаджр»');

    await waitForBotReply(page, 'ОК');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 5. Shift+Enter ───────────────────────────────────────────────────
  await step('5. Shift+Enter: тумблер даёт перенос строки, Enter отправляет и чистит поле', async () => {
    const { context, page, api } = await newPage(browser, {
      initScript: () => {
        localStorage.setItem('youplanner.api_key', 'e2e-key-shift');
      },
    });
    await openAssistant(page);

    // Включаем тумблер «Shift+Enter — новая строка» и сохраняем
    await page.click('#assistant-settings');
    await page.waitForSelector('#assistant-key-modal:not([hidden])', { timeout: 5000 });
    await page.check('#assistant-shift-enter');
    await page.click('#assistant-key-save');
    const persona = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.assistant_persona')));
    assert.equal(persona.shiftEnter, true, 'тумблер Shift+Enter не сохранился');

    // Focus в поле: Shift+Enter — нативный перенос, значение содержит \n
    await page.click('#assistant-input');
    await page.keyboard.type('Многострочный');
    await page.keyboard.press('Shift+Enter');
    let value = await page.inputValue('#assistant-input');
    assert.ok(value.includes('\n'),
      `Shift+Enter не вставил перенос строки: ${JSON.stringify(value)}`);

    // Допечатываем и отправляем Enter: пузырь появился, поле очищено
    await page.keyboard.type('вопрос');
    await page.keyboard.press('Enter');
    const bubbleText = await page.evaluate(() => {
      const msgs = document.querySelectorAll('#assistant-chat .assistant-msg-user');
      return msgs.length ? msgs[msgs.length - 1].textContent : null;
    });
    assert.equal(bubbleText, 'Многострочный\nвопрос',
      `пузырь пользователя не совпал: ${JSON.stringify(bubbleText)}`);
    value = await page.inputValue('#assistant-input');
    assert.equal(value, '', `textarea не очистилась: ${JSON.stringify(value)}`);

    // Реплика дошла до API, ответ дорисовался — чат вернулся в покой
    const body = await api.firstBody();
    const lastUser = body.messages.filter((m) => m.role === 'user').pop();
    assert.ok(lastUser && lastUser.content === 'Многострочный\nвопрос',
      'многострочная реплика не долетела до messages[]');
    await waitForBotReply(page, 'ОК');
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 6. БАГ ПРОДУКТА: ключ с кириллицей — «Нет связи» при исправной сети ─
  // Тест ПАДАЕТ намеренно, пока не исправлен postAssistantChat
  // (js/ui/assistant-media.js): 'Bearer ' + apiKey кладёт кириллицу в
  // заголовок, fetch бросает TypeError ещё до запроса, catch трактует его
  // как сетевой сбой — пользователь видит «Нет связи…», хотя сеть в порядке.
  await step('6. Ключ с кириллицей (аудит): запрос уходит в API, а не «Нет связи»', async () => {
    const { context, page, api } = await newPage(browser, {
      initScript: () => {
        // Ключ с не-ISO-8859-1 символами — как в баг-репорте: «тест»
        localStorage.setItem('youplanner.api_key', 'тест');
      },
    });
    await openAssistant(page);
    await page.fill('#assistant-input', 'Привет');
    await page.click('#assistant-send');

    // Ждём, чем разрешится запрос: либо ответ перехвата, либо ошибка
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll('#assistant-chat .assistant-msg-bot');
      const last = msgs[msgs.length - 1];
      return last && !last.classList.contains('is-typing')
        && (last.classList.contains('is-error') || last.textContent === 'ОК');
    }, null, { timeout: 10000 });

    // Правильное поведение: при исправной сети реплика доходит до API
    // (или пользователь получает понятный отказ ключа, но не «Нет связи»)
    const errorText = await page.evaluate(() => {
      const err = document.querySelector('#assistant-chat .assistant-msg-bot.is-error');
      return err ? err.textContent : null;
    });
    assert.equal(errorText, null,
      'баг продукта: fetch падает на кириллице в Authorization ещё до сети, '
      + `пользователю показано «${errorText}» вместо похода в API`);
    assert.ok(api.bodies.length >= 1,
      'баг продукта: запрос к api.neuraldeep.ru не отправлен при исправной сети');

    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  await browser.close();
  server.close();

  console.log(`\nИтог: ${passed} PASS, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
