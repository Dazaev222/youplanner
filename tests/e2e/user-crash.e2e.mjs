/* ═══════════════════════════════════════════════════════════════════
   User-Crash-E2E YouPlanner (playwright, постоянный набор).

   Запуск:  node tests/e2e/user-crash.e2e.mjs        (порт 8934: 8933
   занят chaos.e2e.mjs — наборы живут параллельно)

   Реальные пользовательские сценарии, на каждом — сбор pageerror
   и сравнение с пустым массивом (как в chaos.e2e.mjs):

     1. Создание привычки: Настройки → «Редактировать привычки» →
        «+ Добавить привычку» → «Вода» — в списке, в таблице и в
        localStorage youplanner.habits.
     2. Переключение ВСЕХ вкладок подряд (реестр SCREENS из
        js/ui/router.js — единственный источник правды о разделах):
        каждая отрисовывается, ровно один контейнер виден, подсветка
        вкладки и класс тела — по реестру, ни одного pageerror.
     3. Long Press на привычке (~700 мс) — что реально происходит,
        и реальный путь удаления («Удалить» + confirm) — привычка
        исчезла из списка, таблицы и localStorage.
     4. Настройки: поменять затемнение фона, уйти, вернуться —
        значение живо (localStorage youplanner.app_bg).
     5. Стресс-офлайн: setOffline(true) → создать привычку и
        отметить существующую → приложение живо и кликабельно,
        данные в localStorage; setOffline(false) → PUT доезжает.
     6. Firebase route.abort() на PUT при онлайне: отметка → никаких
        необработанных исключений, UI жив, повторная правка снова
        пытается уйти в сеть.
     7. Битый JSON '{{{' на GET корня: приложение не падает,
        локальные данные целы.
     8. 401 на GET и PUT (включая securetoken/identitytoolkit):
        никаких бесконечных петель refresh-запросов (гард
        authPausedUntil в firebase-auth.js), UI жив.

   Внешняя сеть блокируется целиком: тесты не зависят ни от Firebase,
   ни от нейросервиса. Скриншоты ключевых моментов — .test_tmp/ ═══ */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = 8934;
const BASE = `http://127.0.0.1:${PORT}`;
const FIREBASE = /firebaseio\.com/;
const AUTH_HOSTS = /securetoken\.googleapis\.com|identitytoolkit\.googleapis\.com/;
const TMP = join(ROOT, '.test_tmp');

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
    console.error(`  FAIL  ${name}\n        ${e.message.split('\n').slice(0, 6).join('\n        ')}`);
  }
}

// Обёртка сетевого мока: каждый fulfill/abort попадает в журнал запросов —
// по нему проверяются «PUT доехал», «повторная правка снова ушла в сеть»
// и «нет бесконечной петли refresh-запросов».
function netLog() {
  const requests = [];
  return {
    requests,
    fulfill(route, status, body, headers) {
      requests.push({
        method: route.request().method(),
        url: route.request().url(),
        status,
        at: Date.now(),
      });
      return route.fulfill({ status, contentType: 'application/json', body, headers });
    },
    abort(route) {
      requests.push({
        method: route.request().method(),
        url: route.request().url(),
        status: 'abort',
        at: Date.now(),
      });
      return route.abort();
    },
    count(pred) { return requests.filter(pred).length; },
    async waitFor(pred, timeout = 10000, since = 0) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = requests.find((r) => r.at >= since && pred(r));
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error('запрос не пришёл за ' + timeout + ' мс: ' +
            JSON.stringify(requests.slice(-8).map((r) => r.method + ' ' + r.status)));
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

async function newPage(browser, { initScript, initScriptArg, firebaseHandler } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    locale: 'ru-RU',
  });
  const net = netLog();
  // Герметичность: наружу из тестового браузера не пускаем никого.
  // Firebase по умолчанию отвечает пустым узлом — «сервер пуст».
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (FIREBASE.test(url) || AUTH_HOSTS.test(url)) {
      if (firebaseHandler) return firebaseHandler(route, url, net);
      return net.fulfill(route, 200, 'null');
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
  page.net = net;
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-table', { timeout: 15000 });
  return { context, page };
}

// Реестр экранов читается из живого модуля приложения: тот же инстанс,
// что обслуживает переключение (ES-модули кэшируются по URL).
async function loadScreens(page) {
  return page.evaluate(async () => {
    const mod = await import('/js/ui/router.js');
    const out = {};
    for (const key of Object.keys(mod.SCREENS)) {
      out[key] = { el: mod.SCREENS[key].el, tab: mod.SCREENS[key].tab, bodyClass: mod.SCREENS[key].bodyClass || null };
    }
    return out;
  });
}

// Атрибуты видимости/aria раздела: ровно один контейнер SCREENS виден,
// класс тела совпадает с реестром, подсветка вкладки — по tabFor.
async function assertScreen(page, screens, name) {
  return page.evaluate(({ screens, name }) => {
    const visible = Object.keys(screens)
      .filter((key) => { const el = document.getElementById(screens[key].el); return el && !el.hidden; })
      .sort();
    const current = document.getElementById(screens[name].el);
    const tabItem = document.querySelector('#tab-bar .tab-item.is-active');
    const bodyClasses = Array.from(document.body.classList).sort();
    return {
      visible,
      currentExists: !!current,
      bodyClasses,
      activeTab: tabItem ? tabItem.getAttribute('data-view') : null,
    };
  }, { screens, name });
}

function expectScreen(result, screens, name, expectedTab) {
  const expectedVisible = [name].sort();
  assert.deepEqual(result.visible, expectedVisible,
    `видимые контейнеры: ${result.visible.join(', ')}, ожидался ${name}`);
  assert.equal(result.currentExists, true, `контейнер ${screens[name].el} не найден`);
  if (screens[name].bodyClass) {
    assert.ok(result.bodyClasses.includes(screens[name].bodyClass),
      `класс тела ${screens[name].bodyClass} не выставлен (${result.bodyClasses.join(', ')})`);
  }
  assert.equal(result.activeTab, expectedTab,
    `подсветка вкладки: ${result.activeTab}, ожидалась ${expectedTab}`);
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  await mkdir(TMP, { recursive: true });
  console.log('▶ YouPlanner user-crash-e2e (:8934)');

  // ── 1. Создание привычки ─────────────────────────────────────────────
  await step('1. Создание привычки «Вода»: в списке, в таблице, в localStorage', async () => {
    const { context, page } = await newPage(browser);
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });

    // Реальный путь: Настройки → «Редактировать привычки» → «+ Добавить привычку»
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    await page.click('#settings-edit-habits');
    await page.waitForSelector('#habits-edit-view:not([hidden])', { timeout: 5000 });
    await page.click('#habits-edit-add');
    await page.waitForSelector('#habit-modal:not([hidden])', { timeout: 5000 });
    await page.screenshot({ path: join(TMP, 'user-crash-1-modal.png') });

    await page.fill('#form-name', 'Вода');
    await page.click('#habit-form button[type=submit]');

    // Появилась в списке модалки
    const modalNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#habit-list .habit-edit-name'))
        .map((el) => el.value));
    assert.ok(modalNames.includes('Вода'), `«Вода» нет в списке модалки: ${modalNames.join(', ')}`);

    // Модалка жива, привычка легла в localStorage
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.habits') || '[]'));
    const inStorage = stored.find((h) => h.name === 'Вода');
    assert.ok(inStorage, 'в localStorage youplanner.habits «Вода» не записана');
    assert.equal(inStorage.type, 'boolean', 'тип созданной привычки не boolean');

    // Закрыть модалку → назад (экран «Привычки» ведёт в Настройки) → на главную
    await page.click('#modal-close');
    await page.click('#habits-edit-back');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    await page.click('#settings-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
    const tableNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#habits-tbody .habit-name'))
        .map((el) => el.textContent));
    assert.ok(tableNames.includes('Вода'), `«Вода» нет в таблице: ${tableNames.join(', ')}`);
    await page.screenshot({ path: join(TMP, 'user-crash-1-table.png') });

    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 2. Переключение всех вкладок подряд ──────────────────────────────
  // Реальные пути ПК: кнопки шапки, строки настроек, строки хаба статистики,
  // кнопки «Назад». Панель меню статистики — только мобильная
  // (styles/stats.css: #stats-menu display:none вне max-width:700px): она и
  // Матрица через неё обходятся отдельным мобильным контекстом в 2б. Вход в
  // Матрицу на ПК (строка в хабе статистики) проверяется жёстко ниже и в
  // walk-обходе.
  await step('2а. Все вкладки ПК подряд: каждая отрисовывается, видимость/aria по реестру', async () => {
    const { context, page } = await newPage(browser, {
      // Ключ ассистента сеём заранее (как chaos): без него модалка ключа
      // перехватывает клики на разделе ассистента
      initScript: () => {
        localStorage.setItem('youplanner.api_key', 'test-key-for-e2e');
      },
    });
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
    const screens = await loadScreens(page);
    // Реестр обязан покрывать все контейнеры-секции index.html
    assert.ok(screens.main && screens.settings && screens.qaza && screens.schedule &&
      screens.assistant && screens.stats && screens.matrix && screens.sleep,
      `реестр SCREENS неожиданно мал: ${Object.keys(screens).join(', ')}`);

    // Линейный маршрут: каждый вход открыт из предыдущего экрана.
    // [экран, вход, выход, ожидаемая вкладка после входа]
    const walk = [
      ['qaza', () => page.click('#qaza-btn'), () => page.click('#qaza-back'), 'qaza'],
      ['schedule', () => page.click('#schedule-btn'), () => page.click('#schedule-back'), 'schedule'],
      ['assistant', () => page.click('#assistant-btn'), () => page.click('#assistant-back'), 'assistant'],
      ['settings', () => page.click('#settings-btn'), null, 'settings'],
      ['edit-habits', () => page.click('#settings-edit-habits'),
        () => page.click('#habits-edit-back'), 'settings'],
      ['prayer-settings', () => page.click('#settings-prayer'),
        () => page.click('#prayer-settings-back'), 'settings'],
      ['sleep', () => page.click('#settings-sleep'), () => page.click('#sleep-back'), 'settings'],
      ['schedule-edit', () => page.click('#settings-edit-schedule'),
        () => page.click('#schedule-edit-back'), 'schedule'],
      [null, () => page.click('#settings-back'), null, null], // Настройки → главная
      ['prayer', async () => {
        await page.click('#qaza-btn');
        await page.click('#prayer-btn');
      }, () => page.click('#prayer-back'), 'qaza'],
      ['fast', () => page.click('#fast-btn'), () => page.click('#fast-back'), 'qaza'],
      [null, () => page.click('#qaza-back'), null, null], // каза → главная
      // Хаб статистики на ПК: Настройки → «Статистика». Строки категорий
      // живут в самом хабе, «Назад» из категории возвращает в хаб
      ['stats', async () => {
        await page.click('#settings-btn');
        await page.click('#settings-stats');
      }, null, 'main'],
      ['stats-qaza', () => page.click('#stats-row-qaza'),
        () => page.click('#stats-qaza-back'), 'main'],
      ['stats-fast', () => page.click('#stats-row-fast'),
        () => page.click('#stats-fast-back'), 'main'],
      ['stats-sleep', () => page.click('#stats-row-sleep'),
        () => page.click('#stats-sleep-back'), 'main'],
      ['stats-habits', () => page.click('#stats-row-habits'), null, 'main'],
      // Карточка привычки открывается тапом по строке списка
      ['stats-habit', () => page.click('#stats-habits-list > *'),
        () => page.click('#stats-habit-back'), 'main'],
      [null, () => page.click('#stats-habits-back'), null, null], // → хаб
      // Матрица на ПК: строка в хабе статистики (краш-тест 3), выход —
      // «Назад» на главную, таб-бара на десктопе нет
      ['matrix', () => page.click('#stats-row-matrix'),
        () => page.click('#matrix-back'), 'main'],
    ];

    const problems = [];
    for (const [name, open, close, expectedTab] of walk) {
      await open();
      await page.waitForTimeout(120); // рендерам и подсветке вкладки
      if (!name) continue; // служебный переход без проверки
      try {
        const state = await assertScreen(page, screens, name);
        expectScreen(state, screens, name, expectedTab);
      } catch (e) {
        problems.push(`${name}: ${e.message.split('\n')[0]}`);
      }
      if (close) { await close(); await page.waitForTimeout(80); }
    }

    // Жёсткий вход в Матрицу на ПК (краш-тест 3, не обход): Настройки →
    // «Статистика» → #stats-row-matrix. Walk выше гоняет экран по реестру,
    // но ничего не знал о кнопке возврата: здесь контракт целиком — экран
    // виден, «← Назад» реально видима (на телефоне её гасит mobile.css),
    // клик по ней возвращает на главную
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    await page.click('#settings-stats');
    await page.waitForSelector('#stats-view:not([hidden])', { timeout: 5000 });
    await page.click('#stats-row-matrix');
    await page.waitForSelector('#matrix-view:not([hidden])', { timeout: 5000 });
    const matrixBack = await page.evaluate(() => {
      const back = document.getElementById('matrix-back');
      return {
        present: !!back,
        visible: !!back && back.offsetWidth > 0 && back.offsetHeight > 0,
        text: back ? back.textContent.trim() : '',
      };
    });
    assert.ok(matrixBack.present && matrixBack.visible,
      `«← Назад» Матрицы не видима на ПК: ${JSON.stringify(matrixBack)}`);
    assert.equal(matrixBack.text, '← Назад',
      `неожиданный текст кнопки возврата: "${matrixBack.text}"`);
    expectScreen(await assertScreen(page, screens, 'matrix'), screens, 'matrix', 'main');
    await page.screenshot({ path: join(TMP, 'user-crash-2a-matrix.png') });
    await page.click('#matrix-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
    expectScreen(await assertScreen(page, screens, 'main'), screens, 'main', 'main');

    await page.screenshot({ path: join(TMP, 'user-crash-2a-desktop.png') });
    assert.deepEqual(problems, [], `проблемы обхода вкладок ПК:\n  ${problems.join('\n  ')}`);
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  await step('2б. Мобильные вкладки: таб-бар, меню статистики, Матрица', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, // ≤700px — мобильный режим
      locale: 'ru-RU',
    });
    const net = netLog();
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE)) return route.continue();
      if (FIREBASE.test(url) || AUTH_HOSTS.test(url)) return net.fulfill(route, 200, 'null');
      return route.abort();
    });
    await context.addInitScript(() => {
      localStorage.setItem('youplanner.api_key', 'test-key-for-e2e');
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#day-cards .day-card', { timeout: 15000 });
    const screens = await loadScreens(page);

    const problems = [];
    // Таб-бар: Главное / Каза / Расписание / Ассистент / Настройки
    for (const [name, view] of [
      ['qaza', 'qaza'], ['schedule', 'schedule'], ['assistant', 'assistant'],
      ['settings', 'settings'], ['main', 'main'],
    ]) {
      await page.click(`#tab-bar .tab-item[data-view="${view}"]`);
      await page.waitForTimeout(120);
      try {
        const state = await assertScreen(page, screens, name);
        expectScreen(state, screens, name, view);
      } catch (e) {
        problems.push(`таб-бар ${view}: ${e.message.split('\n')[0]}`);
      }
    }

    // Гамбургер: хаб статистики и Матрица (только мобильный вход)
    await page.click('#stats-menu-btn');
    await page.waitForTimeout(150);
    await page.click('.stats-menu-item[data-stats-view="stats"]');
    await page.waitForTimeout(120);
    try {
      const state = await assertScreen(page, screens, 'stats');
      expectScreen(state, screens, 'stats', 'main');
    } catch (e) {
      problems.push(`stats (меню): ${e.message.split('\n')[0]}`);
    }

    await page.click('#tab-bar .tab-item[data-view="main"]');
    await page.waitForTimeout(120);
    await page.click('#stats-menu-btn');
    await page.waitForTimeout(150);
    await page.click('.stats-menu-item[data-matrix-view]');
    await page.waitForTimeout(200);
    try {
      const state = await assertScreen(page, screens, 'matrix');
      expectScreen(state, screens, 'matrix', 'main');
    } catch (e) {
      problems.push(`matrix (меню): ${e.message.split('\n')[0]}`);
    }
    await page.screenshot({ path: join(TMP, 'user-crash-2b-matrix.png') });

    // Выход из Матрицы — таб-баром, как на телефоне выходит человек
    await page.click('#tab-bar .tab-item[data-view="main"]');
    await page.waitForTimeout(150);
    const after = await assertScreen(page, screens, 'main');
    try {
      expectScreen(after, screens, 'main', 'main');
    } catch (e) {
      problems.push(`выход из matrix таб-баром: ${e.message.split('\n')[0]} (видимо: ${after.visible.join(', ')})`);
    }

    assert.deepEqual(problems, [], `проблемы мобильного обхода:\n  ${problems.join('\n  ')}`);
    assert.deepEqual(errors, [], `pageerror: ${errors.join(' | ')}`);
    await context.close();
  });

  // ── 3. Long Press и удаление привычки ────────────────────────────────
  await step('3. Удаление привычки: long press 700 мс и реальный путь «Удалить»', async () => {
    const { context, page } = await newPage(browser);
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });

    // Один обработчик window.confirm на сценарий: до удаления все диалоги
    // гасятся, при удалении — принимаются. Тексты копятся в журнал.
    const dialogs = [];
    let dialogMode = 'dismiss';
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      if (dialogMode === 'accept') return d.accept();
      return d.dismiss();
    });

    // Часть А — сценарий из ТЗ: удержание на строке привычки 700 мс.
    // Ничего открывать не должно ни за что: чиним фактическое поведение.
    const row = page.locator('#habits-tbody tr.habit-row').nth(1); // «Зухр»
    const box = await row.locator('.habit-name').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();

    // Что открылось за удержание? Никакого попапа удаления быть не должно:
    // ни confirm, ни новой видимой модалки/шторки поверх таблицы
    await page.waitForTimeout(200);
    const openedPopups = await page.evaluate(() => {
      const modal = document.getElementById('habit-modal');
      const sheet = document.getElementById('level-sheet');
      const keyModal = document.getElementById('assistant-key-modal');
      return {
        habitModal: modal && !modal.hidden,
        levelSheet: sheet && !sheet.hidden,
        keyModal: keyModal && !keyModal.hidden,
      };
    });
    assert.equal(dialogs.length, 0,
      `long press на привычке открыл диалог: ${dialogs.join(' | ')}`);
    assert.deepEqual(openedPopups,
      { habitModal: false, levelSheet: false, keyModal: false },
      `long press на привычке открыл попап: ${JSON.stringify(openedPopups)}`);
    await page.screenshot({ path: join(TMP, 'user-crash-3-longpress.png') });

    // Часть Б — реальный путь удаления на ПК: Настройки → «Редактировать
    // привычки» → «+ Добавить привычку» открывает модалку со списком, у
    // строки — своя кнопка «Удалить». Попутно — жёсткий PASS аккордеона
    // на ПК (краш-тест 3): раньше правило раскрытия жило только в mobile.css
    dialogMode = 'accept';
    await page.click('#settings-btn');
    await page.click('#settings-edit-habits');
    await page.waitForSelector('#habits-edit-view:not([hidden])', { timeout: 5000 });

    // Регрессия краш-теста 3 — жёстко: строка аккордеона на ПК обязана
    // раскрываться целиком: .is-open, .habit-row-body display:block
    // (styles/habits-edit.css:77-79), кнопка .edit-delete реально видима
    await page.locator('#habits-edit-list li.habit-row-edit')
      .filter({ hasText: 'Зухр' }).locator('.habit-row-head').click();
    await page.waitForTimeout(150);
    const accordionState = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#habits-edit-list li.habit-row-edit'))
        .find((r) => (r.querySelector('.habit-row-name') || {}).textContent === 'Зухр');
      if (!row) return { found: false };
      const body = row.querySelector('.habit-row-body');
      const del = row.querySelector('.edit-delete');
      return {
        found: true,
        isOpen: row.classList.contains('is-open'),
        bodyDisplay: body ? getComputedStyle(body).display : null,
        deleteVisible: !!del && del.offsetWidth > 0 && del.offsetHeight > 0,
      };
    });
    assert.ok(accordionState.found, 'строка «Зухр» не нашлась в #habits-edit-list');
    assert.equal(accordionState.isOpen, true,
      'на ПК аккордеон не раскрылся: у строки нет .is-open');
    assert.equal(accordionState.bodyDisplay, 'block',
      `на ПК .habit-row-body = ${accordionState.bodyDisplay}, ждали block — ` +
      'правило styles/habits-edit.css .habit-row-edit.is-open .habit-row-body не работает');
    assert.ok(accordionState.deleteVisible,
      'кнопка .edit-delete в раскрытой строке не видима на ПК (offsetWidth/offsetHeight = 0)');

    // Регрессия на мобильном (390x844): базовое правило раскрытия не имело
    // права сломать мобильное поведение — аккордеон открывается как раньше
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, // ≤700px — мобильный режим
      locale: 'ru-RU',
    });
    const mnet = netLog();
    await mctx.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE)) return route.continue();
      if (FIREBASE.test(url) || AUTH_HOSTS.test(url)) return mnet.fulfill(route, 200, 'null');
      return route.abort();
    });
    await mctx.addInitScript(() => {
      localStorage.setItem('youplanner.api_key', 'test-key-for-e2e');
    });
    const mpage = await mctx.newPage();
    const merrors = [];
    mpage.on('pageerror', (e) => merrors.push(String(e)));
    await mpage.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await mpage.waitForSelector('#day-cards .day-card', { timeout: 15000 });
    await mpage.click('#tab-bar .tab-item[data-view="settings"]');
    await mpage.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    await mpage.click('#settings-edit-habits');
    await mpage.waitForSelector('#habits-edit-view:not([hidden])', { timeout: 5000 });
    await mpage.locator('#habits-edit-list li.habit-row-edit')
      .filter({ hasText: 'Зухр' }).locator('.habit-row-head').click();
    await mpage.waitForTimeout(150);
    const mobileAccordion = await mpage.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#habits-edit-list li.habit-row-edit'))
        .find((r) => (r.querySelector('.habit-row-name') || {}).textContent === 'Зухр');
      if (!row) return { found: false };
      const body = row.querySelector('.habit-row-body');
      const del = row.querySelector('.edit-delete');
      return {
        found: true,
        isOpen: row.classList.contains('is-open'),
        bodyDisplay: body ? getComputedStyle(body).display : null,
        deleteVisible: !!del && del.offsetWidth > 0 && del.offsetHeight > 0,
      };
    });
    assert.ok(mobileAccordion.found, 'мобильный: строка «Зухр» не нашлась в #habits-edit-list');
    assert.equal(mobileAccordion.isOpen, true, 'мобильный: аккордеон не раскрылся');
    assert.equal(mobileAccordion.bodyDisplay, 'block',
      `мобильный: .habit-row-body = ${mobileAccordion.bodyDisplay}, ждали block`);
    assert.ok(mobileAccordion.deleteVisible,
      'мобильный: кнопка .edit-delete в раскрытой строке не видима');
    assert.deepEqual(merrors, [], `pageerror (мобильный аккордеон): ${merrors.join(' | ')}`);
    await mctx.close();

    await page.click('#habits-edit-add');
    await page.waitForSelector('#habit-modal:not([hidden])', { timeout: 5000 });
    // Имя в модалке живёт в value инпута (не в textContent): ищем строку
    // по значению поля, затем жмём её «Удалить»
    const zuhrId = await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll('#habit-list li[data-habit-id]'))
        .find((n) => (n.querySelector('.habit-edit-name') || {}).value === 'Зухр');
      return li ? li.getAttribute('data-habit-id') : null;
    });
    assert.ok(zuhrId, '«Зухр» не нашлась в списке модалки');
    await page.locator(`#habit-list li[data-habit-id="${zuhrId}"] .habit-delete`).click();
    await page.waitForTimeout(400);
    const confirmDialogs = dialogs.slice(); // до этого момента диалогов не было
    assert.ok(confirmDialogs.length >= 1,
      'подтверждение удаления не спросили');
    assert.match(confirmDialogs[0], /Зухр/,
      `неожиданный текст подтверждения: ${confirmDialogs[0]}`);

    // Строка исчезла из списка модалки
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#habit-list .habit-edit-name'))
        .map((el) => el.value));
    assert.ok(!names.includes('Зухр'), `«Зухр» осталась в списке после удаления: ${names.join(', ')}`);

    // И из localStorage (без надгробия-воскрешения: привычка удалена)
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.habits') || '[]'));
    assert.ok(!stored.find((h) => h.name === 'Зухр'),
      '«Зухр» осталась в localStorage после удаления');

    // И из таблицы на главной: модалку закрываем, из экрана «Привычки» —
    // в Настройки, оттуда на главную
    await page.click('#modal-close');
    await page.click('#habits-edit-back');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    await page.click('#settings-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
    const tableNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#habits-tbody .habit-name'))
        .map((el) => el.textContent));
    assert.ok(!tableNames.includes('Зухр'),
      `«Зухр» осталась в таблице после удаления: ${tableNames.join(', ')}`);
    await page.screenshot({ path: join(TMP, 'user-crash-3-deleted.png') });

    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 4. Настройки: поле живо после закрытия ───────────────────────────
  await step('4. Настройки: затемнение фона меняется и переживает закрытие', async () => {
    const { context, page } = await newPage(browser);
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });

    await page.click('#settings-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });

    // Ползунок затемнения: значение по умолчанию 80, ставим 35
    const before = await page.inputValue('#settings-bg-dim');
    assert.equal(before, '80', `стартовое затемнение: ${before}, ожидалось 80`);
    await page.locator('#settings-bg-dim').fill('35');
    await page.locator('#settings-bg-dim').dispatchEvent('change');
    await page.waitForTimeout(100);

    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.app_bg') || 'null'));
    assert.ok(saved && saved.dim === 35,
      `в localStorage youplanner.app_bg не 35: ${JSON.stringify(saved)}`);

    // Уйти с настроек и вернуться: значение живо
    await page.click('#settings-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    const after = await page.inputValue('#settings-bg-dim');
    assert.equal(after, '35', `после возвращения затемнение: ${after}, ожидалось 35`);
    const label = await page.textContent('#settings-bg-dim-value');
    assert.equal(label.trim(), '35%', `подпись значения: ${label}`);
    await page.screenshot({ path: join(TMP, 'user-crash-4-settings.png') });

    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 5. Стресс-офлайн ─────────────────────────────────────────────────
  await step('5. Офлайн: создание и отметка живут, после возврата сети PUT доезжает', async () => {
    const { context, page } = await newPage(browser);
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
    // Ждём стартовый обмен (GET + PUT дефолтов), чтобы офлайн-фаза была чистой
    await page.net.waitFor((r) => r.method === 'PUT' && r.status === 200, 8000);
    const putBefore = page.net.count((r) => r.method === 'PUT');

    await context.setOffline(true);

    // Создаём привычку офлайн
    await page.click('#settings-btn');
    await page.click('#settings-edit-habits');
    await page.waitForSelector('#habits-edit-view:not([hidden])', { timeout: 5000 });
    await page.click('#habits-edit-add');
    await page.waitForSelector('#habit-modal:not([hidden])', { timeout: 5000 });
    await page.fill('#form-name', 'Офлайн-привычка');
    await page.click('#habit-form button[type=submit]');
    await page.click('#modal-close');
    await page.click('#habits-edit-back');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    await page.click('#settings-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });

    // Отмечаем существующую «выполнено» (первая строка — «Фаджр»)
    const firstCheck = page.locator('#habits-tbody input.cell-check').first();
    await firstCheck.click();
    await page.waitForTimeout(300);
    assert.equal(await firstCheck.isChecked(), true, 'отметка не встала офлайн');

    // Данные в localStorage
    const local = await page.evaluate(() => ({
      habits: JSON.parse(localStorage.getItem('youplanner.habits') || '[]')
        .map((h) => h.name),
      records: JSON.parse(localStorage.getItem('youplanner.records') || '{}'),
    }));
    assert.ok(local.habits.includes('Офлайн-привычка'),
      `офлайн-привычка не в localStorage: ${local.habits.join(', ')}`);
    // Дата отметки — та, что стоит в data-date самого чекбокса (первый
    // столбец таблицы — понедельник текущей недели, не обязательно сегодня)
    const markDate = await firstCheck.getAttribute('data-date');
    assert.ok(Object.keys(local.records).includes(markDate),
      `запись отметки не в localStorage за ${markDate}: ${JSON.stringify(local.records).slice(0, 200)}`);
    assert.equal(local.records[markDate] && local.records[markDate].h1, true,
      `отметка не записана как true: ${JSON.stringify(local.records[markDate])}`);
    await page.screenshot({ path: join(TMP, 'user-crash-5-offline.png') });

    // UI не завис: кликабелен — переход в каза и назад отвечает
    const t0 = Date.now();
    await page.click('#qaza-btn');
    await page.waitForSelector('#qaza-view:not([hidden])', { timeout: 3000 });
    await page.click('#qaza-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 3000 });
    const clickLatency = Date.now() - t0;
    assert.ok(clickLatency < 3000, `интерфейс отвечает ${clickLatency} мс — завис?`);
    assert.deepEqual(page.errorsCollected, [], `pageerror офлайна: ${page.errorsCollected.join(' | ')}`);

    // Сеть вернулась: 'online' → scheduleSync → PUT доезжает и принят моком
    await context.setOffline(false);
    const seenAt = Date.now();
    const put = await page.net.waitFor(
      (r) => r.method === 'PUT' && r.url.includes('.json') && r.at >= seenAt, 12000);
    assert.equal(put.status, 200, `PUT после возврата сети: ${put.status}`);
    const putAfter = page.net.count((r) => r.method === 'PUT');
    assert.ok(putAfter > putBefore, `новых PUT нет (${putBefore} → ${putAfter})`);
    assert.deepEqual(page.errorsCollected, [], `pageerror после офлайна: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 6. Firebase abort на PUT при онлайне ─────────────────────────────
  await step('6. PUT обрывается (abort): без исключений, UI жив, повтор уходит в сеть', async () => {
    const { context, page } = await newPage(browser, {
      // GET корня — пустой сервер (дефолты засеются), PUT — обрыв сети
      firebaseHandler: (route, url, net) => {
        if (route.request().method() === 'PUT') return net.abort(route);
        return net.fulfill(route, 200, 'null');
      },
    });
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
    // Стартовый PUT тоже оборван — ждём, пока он произойдёт, и фиксируем счёт
    await page.net.waitFor((r) => r.method === 'PUT' && r.status === 'abort', 8000);
    const putBefore = page.net.count((r) => r.method === 'PUT');

    // Отметка привычки: правка → debounce 1.5 с → PUT → обрыв
    const firstCheck = page.locator('#habits-tbody input.cell-check').first();
    await firstCheck.click();
    await page.waitForTimeout(300);
    assert.equal(await firstCheck.isChecked(), true, 'отметка не встала при обрыве PUT');

    // Обрыв обязан завершиться тихо: следующая попытка PUT уходит за 12 с
    await page.net.waitFor((r) => r.method === 'PUT' && r.status === 'abort' &&
      r.at > 0, 12000, Date.now() - 0);
    const putMid = page.net.count((r) => r.method === 'PUT');
    assert.ok(putMid > putBefore, `после правки PUT не ушёл (${putBefore} → ${putMid})`);
    assert.deepEqual(page.errorsCollected, [], `pageerror при обрыве PUT: ${page.errorsCollected.join(' | ')}`);

    // UI жив: переход в настройки и обратно работает
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    const version = await page.textContent('#settings-version');
    assert.match(version, /Версия:/, 'настройки не отрисовались после обрыва PUT');
    await page.click('#settings-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });

    // Повторная правка снова пытается уйти в сеть
    const secondCheck = page.locator('#habits-tbody input.cell-check').nth(1);
    await secondCheck.click();
    await page.waitForTimeout(300);
    await page.net.waitFor((r) => r.method === 'PUT', 12000,
      page.net.requests[page.net.requests.length - 1].at + 1);
    const putAfter = page.net.count((r) => r.method === 'PUT');
    assert.ok(putAfter > putMid, `повторная правка не ушла в сеть (${putMid} → ${putAfter})`);
    console.log(`        (PUT-попыток: старт ${putBefore}, после 1-й правки ${putMid}, после 2-й ${putAfter} — все abort, pageerror нет)`);
    assert.deepEqual(page.errorsCollected, [], `pageerror после повтора: ${page.errorsCollected.join(' | ')}`);
    await page.screenshot({ path: join(TMP, 'user-crash-6-put-abort.png') });
    await context.close();
  });

  // ── 7. Битый JSON с сервера ──────────────────────────────────────────
  await step('7. Битый JSON («{{{») на GET корня: приложение живо, локальные данные целы', async () => {
    const seededHabits = [
      { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
      { id: 'h2', name: 'Зухр', type: 'boolean', unit: '', goal: null },
      { id: 'h-x', name: 'Моя привычка', type: 'boolean', unit: '', goal: null },
    ];
    const { context, page } = await newPage(browser, {
      initScript: ({ habits }) => {
        localStorage.setItem('youplanner.habits', JSON.stringify(habits));
      },
      initScriptArg: { habits: seededHabits },
      firebaseHandler: (route, url, net) => {
        if (route.request().method() === 'GET') return net.fulfill(route, 200, '{{{');
        return net.fulfill(route, 200, 'null');
      },
    });
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });

    // Таблица собрана на локальных данных
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#habits-tbody .habit-name'))
        .map((el) => el.textContent));
    assert.ok(names.includes('Моя привычка') && names.includes('Фаджр'),
      `локальные данные вытеснены битым ответом: ${names.join(', ')}`);

    // localStorage не переписан мусором
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('youplanner.habits') || '[]'));
    assert.ok(Array.isArray(stored) && stored.find((h) => h.name === 'Моя привычка'),
      'localStorage переписан битым снимком');

    // Отметка работает — данные целы
    const firstCheck = page.locator('#habits-tbody input.cell-check').first();
    await firstCheck.click();
    await page.waitForTimeout(300);
    assert.equal(await firstCheck.isChecked(), true, 'отметка не работает после битого JSON');
    await page.screenshot({ path: join(TMP, 'user-crash-7-broken-json.png') });
    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  // ── 8. 401 на GET и PUT: нет петли refresh-запросов ──────────────────
  await step('8. 401 всюду: refresh-петли нет (гард authPausedUntil), UI жив', async () => {
    const { context, page } = await newPage(browser, {
      firebaseHandler: (route, url, net) => net.fulfill(route, 401, '{"error":"Unauthorized request."}'),
    });
    await page.waitForSelector('#habits-tbody tr', { timeout: 15000 });
    await page.waitForTimeout(2500); // стартовая сверка + стартовый PUT

    // Пользовательская правка при полном 401
    const firstCheck = page.locator('#habits-tbody input.cell-check').first();
    await firstCheck.click();
    await page.waitForTimeout(2500); // debounce 1.5 с + PUT

    // Петля refresh-запросов: сумма auth-запросов за всю сессию мала
    // (гард authPausedUntil: одна неудача добычи токена глушит сеть на 5 мин)
    const authReq = page.net.requests.filter((r) => AUTH_HOSTS.test(r.url));
    const dataReq = page.net.requests.filter((r) => FIREBASE.test(r.url));
    assert.ok(authReq.length <= 3,
      `петля refresh-запросов: ${authReq.length} auth-запросов (${authReq.map((r) => r.url.slice(8, 60)).join(' | ')})`);
    assert.ok(dataReq.length <= 10,
      `петля data-запросов: ${dataReq.length} (${dataReq.map((r) => r.method + ':' + r.status).join(' | ')})`);
    // И всего запросов наружу мало — никакого шторма
    assert.ok(page.net.requests.length <= 15,
      `шторм запросов: ${page.net.requests.length} всего`);
    console.log(`        (факт: auth-запросов ${authReq.length}, data-запросов ${dataReq.length} ` +
      `[${dataReq.map((r) => r.method + ':' + r.status).join(', ')}], всего ${page.net.requests.length})`);

    // UI жив: переход в настройки отрисовал раздел и статус отказа
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });
    const ownerStatus = await page.textContent('#settings-owner-status');
    assert.ok(ownerStatus.trim().length > 0, 'статус аккаунта пуст при 401');
    await page.click('#settings-back');
    await page.waitForSelector('#main:not([hidden])', { timeout: 5000 });
    await page.screenshot({ path: join(TMP, 'user-crash-8-401.png') });

    assert.deepEqual(page.errorsCollected, [], `pageerror: ${page.errorsCollected.join(' | ')}`);
    await context.close();
  });

  await browser.close();
  server.close();

  console.log(`\nИтог: ${passed} PASS, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
