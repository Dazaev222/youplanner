/* Матрица — ГЕОМЕТРИЯ В НАСТОЯЩЕМ БРАУЗЕРЕ (ТЗ А2/А7, Воркер 1).

   Файл НЕ входит в glob `tests/*.test.mjs` и запускается отдельно:

       node tests/matrix-layout.browser.mjs

   Почему он вообще есть: fake DOM из tests/matrix-ui.test.mjs не умеет
   считать CSS. Высоту экрана, равность строк сетки, резерв под таб-бар,
   перенос «+» на вторую строку и настоящую всплываемость клика может
   проверить только layout. Здесь проверяется именно layout, а не «код
   загрузился».

   Порт берётся у самой ОС (listen(0)), а не вычитывается из головы: соседние
   e2e-наборы занимают 8933 и 8934, и жёсткий порт здесь означал бы «тест
   падает, потому что порт занят», а не «матрица сломана».

   RED на нынешнем состоянии (перед правкой А4/А7) падает на отсутствии
   `.matrix-card-add`, на FAB, на многоточиях и на резерве 168px под
   исчезнувшую кнопку. GREEN фиксирует геометрию из А7.

   Внешняя сеть заблокирована: Firebase и шрифты отваливаются по своей
   воле, и это НЕ считается дефектом локального UI — в отчёт идут только
   pageerror (необработанные JS-ошибки страницы). */

import { chromium } from 'playwright';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MATRIX_KEY = 'youplanner.matrix.tasks';
// Скриншоты — в gitignored .test_tmp/: это доказательство прогона, а не
// артефакт репозитория.
const SHOT_DIR = join(ROOT, '.test_tmp', 'matrix-layout');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
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

let passed = 0;
let failed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error('  FAIL  ' + name + '\n        ' + String(e.message).split('\n').slice(0, 5).join('\n        '));
  }
}

function iso(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}

function seedTask(id, over) {
  return Object.assign({
    id: 'seed-' + id,
    title: 'Задача ' + id,
    notes: '',
    due: null,
    doDate: null,
    priority: 0,
    done: false,
    doneAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    order: id,
    archived: false,
  }, over || {});
}

// Пустая матрица, одна задача, длинный список и сто задач — четыре снимка,
// на которых А7 требует одинаковую высоту карточек.
const SEEDS = {
  empty: [],
  one: [seedTask(1, { priority: 3, due: iso(0), title: 'Срочно и важно сегодня' })],
  many: Array.from({ length: 20 }, (_, i) => seedTask(i + 1, {
    priority: i % 2 ? 3 : 1,
    due: i % 3 ? iso(i % 4) : null,
    title: 'Длинная русская задача номер ' + (i + 1) + ' с нетривиальным заголовком, который не влезает в строку',
  })),
  hundred: Array.from({ length: 100 }, (_, i) => seedTask(i + 1, {
    priority: i % 4,
    due: iso(i % 5),
    title: 'Задача номер ' + (i + 1),
  })),
};

// Длины сторон из ТЗ А7. `kind` говорит, какой нижний край считать
// границей доступного контента: на телефоне это капсула таб-бара, выше 700px
// таб-бара нет и границей служит низ окна.
const VIEWPORTS = [
  { name: 'phone 390×844', width: 390, height: 844, tabbar: true },
  { name: 'phone 360×740', width: 360, height: 740, tabbar: true },
  { name: 'phone 320×653', width: 320, height: 653, tabbar: true },
  { name: 'tablet 768×1024', width: 768, height: 1024, tabbar: false },
  { name: 'desktop 1440×900', width: 1440, height: 900, tabbar: false },
];

const STRESSED = [
  { name: 'landscape 844×390', width: 844, height: 390 },
  // 200% зум на 1440×900: CSS-пикселей остаётся половина
  { name: 'desktop 200% zoom (720×450 css)', width: 720, height: 450 },
];

async function openMatrix(browser, viewport, seedName) {
  const context = await browser.newContext({ viewport, locale: 'ru-RU' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();
    return route.abort();
  });
  await context.addInitScript(([key, tasks]) => {
    // Пишем только когда ключа нет: reload обязан показать сохранённую задачу,
    // а не перезаписать её снимком теста.
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify(tasks));
    }
  }, [MATRIX_KEY, SEEDS[seedName || 'empty']]);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  // Готовность приложения: первый отрисованный JS-раздел. Отдельно для
  // телефона (карточки дня) и для широкого экрана (таблица недели) — на
  // 390 px таблицы в DOM нет, и ждать её было бы вечным таймаутом.
  await page.waitForFunction(() => !!document.querySelector('.day-card, #habits-tbody tr'),
    null, { timeout: 20000 });
  // Вход в Матрицу — тот же обработчик, что и в приложении (пункт меню
  // статистики). .click() в evaluate обходит скрытость панели и не требует
  // разворачивать меню ради каждого снимка.
  await page.evaluate(() => {
    const item = document.querySelector('[data-matrix-view]');
    if (!item) throw new Error('входа в Матрицу нет в DOM');
    item.click();
  });
  await page.waitForSelector('.matrix-card', { timeout: 10000 });
  page.errorsCollected = errors;
  return { context, page };
}

// Снимок экрана в .test_tmp/. Нужен для А7: assert подтверждает числа, а
// скриншот подтверждает, что эти числа — то, что человек реально видит.
async function shoot(page, name) {
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, name + '.png') });
}

// Один обмер сетки: карточки, их ряды, низ грида и граница доступного контента.
// Считается в браузере, потому что fake DOM этого не знает.
async function measure(page) {
  return page.evaluate(() => {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const cards = Array.from(document.querySelectorAll('.matrix-card'));
    const grid = document.querySelector('.matrix-grid');
    const bar = document.querySelector('#tab-bar');
    const barVisible = bar && !bar.hidden && getComputedStyle(bar).display !== 'none';
    const adds = cards.map(c => c.querySelector('.matrix-card-add'));
    return {
      cardCount: cards.length,
      quadrants: cards.map(c => c.dataset.quadrant),
      cardRects: cards.map(rectOf),
      gridRect: rectOf(grid),
      addRects: adds.map(a => a ? rectOf(a) : null),
      fabCount: document.querySelectorAll('.matrix-fab').length,
      moreCount: document.querySelectorAll('.matrix-more, .matrix-head-menu, .matrix-detail-menu').length,
      dottedButtons: Array.from(document.querySelectorAll('button'))
        .filter(b => /[⋯…]/.test(b.textContent || '')).length,
      reserveBottom: barVisible ? rectOf(bar).top : window.innerHeight,
      scroll: {
        docWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        docHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      },
      cardOverflowX: cards.map(c => c.scrollWidth - c.clientWidth),
    };
  });
}

let BASE = '';

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('▶ Матрица: геометрия в браузере — ' + BASE + ' (порт выдала ОС)');

  const browser = await chromium.launch({ headless: true });
  let context;
  let page;

  try {
    /* --- Снимок каркаса на обычном портрете ------------------------------ */
    for (const vp of VIEWPORTS) {
      await step('каркас на ' + vp.name + ': четыре карточки, четыре «+», без FAB и многоточий', async () => {
        ({ context, page } = await openMatrix(browser, vp));
        const m = await measure(page);
        assert.equal(m.cardCount, 4, 'карточек сетки: ' + m.cardCount);
        assert.deepEqual(m.quadrants, ['q1', 'q2', 'q3', 'q4'], 'порядок обхода по часовой от q1');
        assert.equal(m.addRects.filter(Boolean).length, 4, 'у каждой карточки своя «+»');
        for (const r of m.addRects) {
          assert.ok(r.width >= 44 && r.height >= 44, 'зона нажатия «+» ' + r.width + '×' + r.height + ' < 44×44');
        }
        assert.equal(m.fabCount, 0, 'служебный FAB под «+» больше не резервирует место');
        assert.equal(m.moreCount, 0, 'многоточий шапки/карточек в DOM быть не должно');
        assert.equal(m.dottedButtons, 0, 'кнопок с символом «⋯» остаться не могло');
        assert.equal(m.cardOverflowX.filter(d => d > 1).length, 0, 'горизонтального переполнения карточек нет');
        assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
        await context.close();
      });

      await step('сетка на ' + vp.name + ': строки равны, резерв снизу один и в пределах 8–12 px', async () => {
        ({ context, page } = await openMatrix(browser, vp, 'one'));
        const m = await measure(page);
        await shoot(page, vp.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
        const rows = [
          (m.cardRects[0].height + m.cardRects[1].height) / 2,
          (m.cardRects[2].height + m.cardRects[3].height) / 2,
        ];
        assert.ok(Math.abs(rows[0] - rows[1]) <= 2, 'верхний и нижний ряды различаются на '
          + (rows[1] - rows[0]).toFixed(2) + ' px (допуск 2 px)');
        const gap = m.reserveBottom - m.gridRect.bottom;
        assert.ok(gap >= 8 && gap <= 12, 'от grid до таб-бара/низа контента ' + gap.toFixed(2)
          + ' px, а надо 8–12 (резерв 84/168 px под исчезнувший FAB — это удвоение)');
        const slack = m.gridRect.top;
        assert.ok(slack < vp.height, 'сетка обязана занимать пространство между шапкой и навигацией');
        assert.ok(m.scroll.docWidth <= m.scroll.clientWidth + 1,
          'горизонтальная прокрутка недопустима: ' + m.scroll.docWidth + ' > ' + m.scroll.clientWidth);
        assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
        await context.close();
      });

      await step('высота карточек на ' + vp.name + ' не зависит от числа задач', async () => {
        const shots = [];
        for (const seed of ['empty', 'one', 'many', 'hundred']) {
          ({ context, page } = await openMatrix(browser, vp, seed));
          const m = await measure(page);
          shots.push(m.cardRects.map(r => Math.round(r.height)));
          await context.close();
        }
        const first = shots[0];
        for (let i = 1; i < shots.length; i++) {
          for (let c = 0; c < 4; c++) {
            assert.ok(Math.abs(shots[i][c] - first[c]) <= 2,
              'seed ' + ['empty', 'one', 'many', 'hundred'][i] + ', карточка ' + c + ': высота '
              + shots[i][c] + ' против ' + first[c] + ' на пустой сетке — список раздвигает ряд');
          }
        }
      });
    }

    /* --- Клик по «+»: настоящий, со всплытием ---------------------------- */
    await step('тап по «+» не всплывает в обработчик заголовка и открывает один лист', async () => {
      ({ context, page } = await openMatrix(browser, VIEWPORTS[0], 'one'));
      const before = await page.evaluate(() => ({
        detail: document.querySelectorAll('.matrix-detail').length,
      }));
      await page.click('.matrix-card[data-quadrant="q3"] .matrix-card-add');
      const after = await page.evaluate(() => ({
        detail: document.querySelectorAll('.matrix-detail').length,
        dialogs: document.querySelectorAll('.matrix-sheet.is-composer').length,
        role: (document.querySelector('.matrix-sheet.is-composer') || {}).getAttribute
          ? document.querySelector('.matrix-sheet.is-composer').getAttribute('role') : null,
        pill: (document.querySelector('.matrix-quad-pill') || {}).className,
        title: document.activeElement && document.activeElement.className,
      }));
      assert.equal(after.detail, before.detail, 'открытие листа не должно перекладывать экран в квадрант');
      assert.equal(after.dialogs, 1, 'dialog создания обязан быть ровно один');
      assert.equal(after.role, 'dialog', 'роль dialog на листе');
      assert.match(after.pill || '', /q-q3/, 'плашка листа показывает нажатый квадрант');
      assert.match(after.title || '', /matrix-composer-title/, 'фокус становится в поле заголовка');
      await shoot(page, 'composer-390x844-q3');

      // Фон под листом недоступен (inert + подложка), поэтому второй «+»
      // человек может нажать только ПОСЛЕ закрытия первого листа. Тап по
      // подложке — штатный способ закрыть пустой черновик.
      await page.mouse.click(12, 40);
      await page.waitForSelector('.matrix-sheet.is-composer', { state: 'detached', timeout: 5000 });
      assert.equal(await page.evaluate(() => document.querySelectorAll('.matrix-sheet-backdrop').length), 0,
        'закрытый лист убирается из DOM целиком, вместе с подложкой');
      assert.equal(await page.evaluate(() => document.querySelector('#matrix-screen').hasAttribute('inert')), false,
        'после закрытия фон снова доступен');

      await page.click('.matrix-card[data-quadrant="q1"] .matrix-card-add');
      const second = await page.evaluate(() => ({
        dialogs: document.querySelectorAll('.matrix-sheet.is-composer').length,
        backdrops: document.querySelectorAll('.matrix-sheet-backdrop').length,
        detail: document.querySelectorAll('.matrix-detail').length,
      }));
      assert.equal(second.dialogs, 1, 'повторное открытие не плодит второй лист');
      assert.equal(second.backdrops, 1, 'и вторую подложку тоже');
      assert.equal(second.detail, 0, 'и не открывает полноэкранный вид');

      // отправка
      await page.fill('.matrix-composer-title', 'Проверка геометрии');
      await page.keyboard.press('Enter');
      const saved = await page.evaluate((key) => {
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        return { count: list.length, first: list[0] && list[0].title, dialogs: document.querySelectorAll('.matrix-sheet.is-composer').length };
      }, MATRIX_KEY);
      assert.equal(saved.count, 2, 'после submit в хранилище вторая задача');
      assert.equal(saved.dialogs, 0, 'успешная запись закрывает лист');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!document.querySelector('.day-card, #habits-tbody tr'),
        null, { timeout: 20000 });
      await page.evaluate(() => document.querySelector('[data-matrix-view]').click());
      await page.waitForSelector('.matrix-card', { timeout: 10000 });
      const reloaded = await page.evaluate((key) => {
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const titles = Array.from(document.querySelectorAll('.matrix-task-title'))
          .map(n => n.textContent);
        return { count: list.length, drawn: titles.indexOf('Проверка геометрии') >= 0 };
      }, MATRIX_KEY);
      assert.equal(reloaded.count, 2, 'перезагрузка сохраняет добавленную задачу');
      assert.equal(reloaded.drawn, true, 'и перечитанная задача видна в сетке');
      assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
      await context.close();
    });

    /* --- Меню квадранта и приоритета: нижний лист ------------------------ */
    await step('квадрант и приоритет выбираются нижним листом, а не плавающим меню', async () => {
      ({ context, page } = await openMatrix(browser, VIEWPORTS[0], 'one'));
      await page.click('.matrix-card[data-quadrant="q3"] .matrix-card-add');
      await page.waitForSelector('.matrix-sheet.is-composer', { timeout: 10000 });

      await page.click('.matrix-quad-pill');
      const quad = await page.evaluate(() => {
        const sheet = document.querySelector('.matrix-sheet.is-quadpick');
        const scrim = document.querySelector('.matrix-sheet-backdrop.is-quadpick');
        const r = sheet && sheet.getBoundingClientRect();
        return {
          sheets: document.querySelectorAll('.matrix-sheet.is-quadpick').length,
          composer: document.querySelectorAll('.matrix-sheet.is-composer').length,
          floating: document.querySelectorAll('.matrix-pop').length,
          items: sheet ? sheet.querySelectorAll('.matrix-sheet-item').length : 0,
          bottomGap: r ? Math.round(window.innerHeight - r.bottom) : null,
          width: r ? Math.round(r.width) : 0,
          // Фокус обязан уехать внутрь листа, а не остаться на чипе, который
          // стал недоступным, и цель — текущий выбор, а не первая сверху.
          focusInside: !!(sheet && sheet.contains(document.activeElement)),
          focusOnCurrent: !!(document.activeElement
            && document.activeElement.getAttribute('aria-current') === 'true'),
          optionRoles: sheet
            ? Array.from(sheet.querySelectorAll('[role="option"]')).length : 0,
          scrimAlpha: scrim
            ? Number((getComputedStyle(scrim).backgroundColor.match(/[\d.]+\)$/) || ['0)'])[0].slice(0, -1))
            : null,
        };
      });
      assert.equal(quad.sheets, 1, 'квадрант открывается нижним листом');
      assert.equal(quad.composer, 1, 'лист создания остаётся под ним, а не закрывается');
      assert.equal(quad.floating, 0, 'плавающего меню по координатам якоря в разделе больше нет');
      assert.equal(quad.items, 4, 'в листе все четыре квадранта');
      assert.equal(quad.optionRoles, 0,
        'в dialog с кнопкой «Отмена» ролей option быть не должно — это ломает ARIA');
      assert.equal(quad.focusInside, true, 'фокус переехал внутрь листа');
      assert.equal(quad.focusOnCurrent, true, 'фокус встал на текущий квадрант');
      assert.ok(quad.bottomGap <= 1, 'лист лежит на нижней кромке, зазор ' + quad.bottomGap + ' px');
      assert.ok(quad.width >= 320, 'лист на всю ширину окна, ширина ' + quad.width);
      // Два scrim-а подряд (32% + 32%) превращают экран в серую кашу: вложенный
      // лист обязан брать светлый слой, как подтверждение.
      assert.ok(quad.scrimAlpha !== null && quad.scrimAlpha <= 0.2,
        'подложка вложенного листа светлее основной, alpha=' + quad.scrimAlpha);
      await shoot(page, 'quadpick-390x844');

      await page.locator('.matrix-sheet.is-quadpick .matrix-sheet-item').first().click();
      const picked = await page.evaluate(() => ({
        pill: (document.querySelector('.matrix-quad-pill') || {}).className,
        sheets: document.querySelectorAll('.matrix-sheet.is-quadpick').length,
        composer: document.querySelectorAll('.matrix-sheet.is-composer').length,
        focus: document.activeElement && document.activeElement.className,
      }));
      assert.match(picked.pill || '', /q-q1/, 'выбор квадранта перекладывает чип листа');
      assert.equal(picked.sheets, 0, 'лист выбора закрывается после выбора');
      assert.equal(picked.composer, 1, 'и возвращает в незакрытый лист создания');
      assert.match(picked.focus || '', /matrix-composer-title/, 'фокус возвращается в поле заголовка');

      await page.click('.matrix-attr[aria-label="Приоритет"]');
      const pr = await page.evaluate(() => {
        const sheet = document.querySelector('.matrix-sheet.is-pickpriority');
        return {
          sheets: document.querySelectorAll('.matrix-sheet.is-pickpriority').length,
          items: sheet ? sheet.querySelectorAll('.matrix-sheet-item').length : 0,
          dots: sheet ? sheet.querySelectorAll('.matrix-sheet-item .matrix-dot').length : 0,
          bottom: sheet ? Math.round(window.innerHeight - sheet.getBoundingClientRect().bottom) : null,
        };
      });
      assert.equal(pr.sheets, 1, 'приоритет открывается нижним листом');
      assert.equal(pr.items, 4, 'три приоритета и «без приоритета»');
      assert.equal(pr.dots, 4, 'у каждой строки есть цветная метка');
      assert.ok(pr.bottom <= 1, 'и он тоже лежит на нижней кромке');
      await shoot(page, 'priority-390x844');

      await page.locator('.matrix-sheet.is-pickpriority .matrix-sheet-item').first().click();
      const flag = await page.evaluate(() => ({
        attr: (document.querySelector('.matrix-attr[aria-label="Приоритет"]') || {}).className,
        sheets: document.querySelectorAll('.matrix-sheet').length,
      }));
      assert.match(flag.attr || '', /is-set/, 'выбранный приоритет виден на чипе');
      assert.equal(flag.sheets, 1, 'вложенный лист снят, остался только лист создания');

      // Отмена по Escape не имеет права уносить человека из листа создания.
      await page.click('.matrix-quad-pill');
      await page.keyboard.press('Escape');
      const escaped = await page.evaluate(() => ({
        sheets: document.querySelectorAll('.matrix-sheet').length,
        composer: document.querySelectorAll('.matrix-sheet.is-composer').length,
      }));
      assert.equal(escaped.sheets, 1, 'Escape снимает только вложенный лист');
      assert.equal(escaped.composer, 1, 'лист создания жив');
      assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
      await context.close();
    });

    /* --- Список внутри карточки: последний элемент достижим --------------- */
    await step('длинный список: последний элемент достижим прокруткой внутри карточки', async () => {
      ({ context, page } = await openMatrix(browser, VIEWPORTS[0], 'hundred'));
      const res = await page.evaluate(() => {
        const card = document.querySelector('.matrix-card[data-quadrant="q1"]');
        const list = card.querySelector('.matrix-list');
        if (!list) return { scrolled: false };
        const before = list.scrollTop;
        list.scrollTop = list.scrollHeight;
        const rows = list.querySelectorAll('.matrix-task');
        const last = rows[rows.length - 1];
        const lr = last.getBoundingClientRect();
        const cr = list.getBoundingClientRect();
        return {
          scrolled: list.scrollHeight > list.clientHeight,
          moved: list.scrollTop > before,
          inside: lr.bottom <= cr.bottom + 1 && lr.top >= cr.top - 1,
          cardScrollsItself: card.scrollHeight > card.clientHeight + 1,
        };
      });
      assert.equal(res.scrolled, true, 'в карточке на 100 задачах обязана появиться внутренняя прокрутка');
      assert.equal(res.moved, true, 'прокрутка внутри .matrix-list работает');
      assert.equal(res.inside, true, 'последняя строка списка достижима внутри карточки');
      assert.equal(res.cardScrollsItself, false, 'прокручивается список, а не карточка');
      await context.close();
    });

    /* --- Узкий экран: перенос «+» и читаемые заголовки ------------------- */
    await step('320 px: заголовки не обрезаются до одной буквы, «+» остаётся доступным', async () => {
      ({ context, page } = await openMatrix(browser, { width: 320, height: 653 }, 'one'));
      const res = await page.evaluate(() => {
        const titles = Array.from(document.querySelectorAll('.matrix-card-title'));
        return {
          widths: titles.map(t => Math.round(t.getBoundingClientRect().width)),
          heights: titles.map(t => Math.round(t.getBoundingClientRect().height)),
          lines: titles.map(t => Math.round(parseFloat(getComputedStyle(t).lineHeight) || 18)),
          scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.equal(res.scrollX <= 0, true, 'на 320 px горизонтальной прокрутки быть не должно');
      for (let i = 0; i < 4; i++) {
        const minReadable = res.lines[i] || 18;
        assert.ok(res.widths[i] >= 40, 'заголовок ' + i + ' сжался до ' + res.widths[i] + ' px');
        assert.ok(res.heights[i] >= minReadable, 'заголовок ' + i + ' обрезан по высоте');
      }
      await context.close();
    });

    /* --- Короткие экраны: вертикальная прокрутка допустима --------------- */
    for (const vp of STRESSED) {
      await step('«' + vp.name + '»: вертикальная прокрутка разрешена, карточки >= 160 px, горизонтали нет', async () => {
        ({ context, page } = await openMatrix(browser, vp, 'one'));
        const m = await measure(page);
        assert.ok(m.scroll.docWidth <= m.scroll.clientWidth + 1,
          'горизонтальная прокрутка недопустима даже в landscape');
        assert.ok(m.scroll.docHeight >= m.scroll.clientHeight - 1, 'экран измерим');
        const shortest = Math.min(...m.cardRects.map(r => r.height));
        await shoot(page, vp.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
        assert.ok(shortest >= 160 - 2, 'самая низкая карточка ' + shortest.toFixed(1)
          + ' px — ориентир А4.6 требует не меньше ~160 px читаемой высоты');
        assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
        await context.close();
      });
    }

    /* --- Лист над таб-баром и под клавиатурой ---------------------------- */
    await step('лист создания на телефоне лежит ВЫШЕ таб-бара и не прячет submit', async () => {
      ({ context, page } = await openMatrix(browser, VIEWPORTS[0], 'empty'));
      await page.click('.matrix-card[data-quadrant="q2"] .matrix-card-add');
      const geo = await page.evaluate(() => {
        const panel = document.querySelector('.matrix-sheet.is-composer');
        const backdrop = panel.closest('.matrix-sheet-backdrop');
        const bar = document.querySelector('#tab-bar');
        const pr = panel.getBoundingClientRect();
        const br = bar.getBoundingClientRect();
        const dr = backdrop.getBoundingClientRect();
        const send = panel.querySelector('.matrix-send');
        const sr = send.getBoundingClientRect();
        // Что реально под курсором в центре таб-бара: если это панель или
        // подложка, капсула накрыта листом и нажать её нельзя.
        const overBar = document.elementFromPoint(
          br.left + br.width / 2, br.top + br.height / 2);
        const coveredBySheet = !!overBar
          && (panel === overBar || panel.contains(overBar) || backdrop === overBar || backdrop.contains(overBar));
        return {
          zPanel: getComputedStyle(backdrop).zIndex,
          zBar: getComputedStyle(bar).zIndex,
          sendInsideViewport: sr.bottom <= window.innerHeight + 1 && sr.top >= 0,
          sendInsidePanel: sr.bottom <= pr.bottom + 1 && sr.top >= pr.top - 1,
          coveredBySheet,
          panelWidth: Math.round(pr.width),
          viewport: window.innerWidth,
          topOnScreen: pr.top >= 0,
        };
      });
      assert.ok(Number(geo.zPanel) > Number(geo.zBar),
        'лист обязан быть выше таб-бара: ' + geo.zPanel + ' против ' + geo.zBar);
      assert.equal(geo.coveredBySheet, true,
        'точка над таб-баром занята листом или подложкой: капсула не должна остаться кликабельной');
      assert.equal(geo.sendInsideViewport, true, 'кнопка отправки не обрезана экраном');
      assert.equal(geo.sendInsidePanel, true, 'и не залезает за границы панели');
      assert.equal(geo.topOnScreen, true, 'верх панели не уехал за экран');
      assert.equal(geo.panelWidth <= geo.viewport, true, 'на телефоне лист — на всю ширину экрана');
      assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
      await context.close();
    });

    /* --- Пустое состояние и плашка про локальность ----------------------- */
    await step('пустая матрица: воронка центрирована в свободном теле и не раздувает карточку', async () => {
      ({ context, page } = await openMatrix(browser, VIEWPORTS[0], 'empty'));
      const res = await page.evaluate(() => {
        const card = document.querySelector('.matrix-card[data-quadrant="q4"]');
        const empty = card.querySelector('.matrix-empty');
        const cr = card.getBoundingClientRect();
        const er = empty.getBoundingClientRect();
        return {
          minHeight: parseFloat(getComputedStyle(empty).minHeight) || 0,
          fits: er.bottom <= cr.bottom + 1,
          centered: Math.abs((er.top - cr.top) - (cr.bottom - er.bottom)) <= cr.height * 0.5,
        };
      });
      assert.equal(res.fits, true, 'пустое состояние не вылезает за карточку');
      assert.ok(res.minHeight < 200, 'пустое состояние не задаёт огромную минимальную высоту: ' + res.minHeight);
      await context.close();
    });

    await step('плашка «хранится только на этом устройстве» осталась и не съедает сетку', async () => {
      ({ context, page } = await openMatrix(browser, VIEWPORTS[0], 'empty'));
      const res = await page.evaluate(() => {
        const note = document.querySelector('.matrix-sync-note');
        return { count: document.querySelectorAll('.matrix-sync-note').length, text: note && note.textContent };
      });
      assert.equal(res.count, 1, 'предупреждение о локальном хранении обязано остаться одним');
      assert.match(res.text || '', /только на этом устройстве/);
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\nИтог: ' + passed + ' PASS, ' + failed + ' FAIL');
  if (failed) {
    console.log('Упавшие проверки:');
    for (const name of failures) console.log('  — ' + name);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('ПРОГОН НЕ ВЫПОЛНЕН: ' + e.message);
  server.close();
  process.exitCode = 1;
});
