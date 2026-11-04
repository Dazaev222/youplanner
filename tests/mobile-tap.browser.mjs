/* Мобильные тап-цели — ГЕОМЕТРИЯ В НАСТОЯЩЕМ БРАУЗЕРЕ (находка 1 аудита).

   Файл НЕ входит в glob `tests/*.test.mjs` и запускается отдельно, как
   tests/matrix-layout.browser.mjs:

       node tests/mobile-tap.browser.mjs

   Почему он вообще есть: fake DOM из helpers/load-app.mjs не умеет считать
   CSS, а размер зоны нажатия — свойство раскладки, а не разметки. Глазком по
   CSS тоже не проверить: `.btn` в мобильном блоке даёт 44 px, но то же самое
   правило в styles/mobile.css перебивает размеры контролов карточки, и итог
   знает только layout. Здесь меряются реальные getBoundingClientRect на трёх
   телефонах.

   Порог 44 px — гайдлайн Apple и то же число, которое сам mobile.css
   закрепил для кнопок и пунктов панели статистики. Проверяются только
   контролы, которые и есть основная цель нажатия на своём экране: отметка
   привычки в карточке дня, листание недель, переходы раздела каза, отправка
   сообщения. Микроскопические контролы таблицы недели и поля форм — не они:
   см. отчёт смены.

   Порт берётся у самой ОС (listen(0)): соседние e2e-наборы занимают 8933 и
   8934, жёсткий порт означал бы «тест падает, потому что порт занят».

   Внешняя сеть заблокирована: Firebase и шрифты отваливаются по своей воле,
   и это НЕ дефект локального UI — в отчёт идут только pageerror. */

import { chromium } from 'playwright';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOT_DIR = join(ROOT, '.test_tmp', 'mobile-tap');
const MIN_TARGET = 44;

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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:' + server.address().port;

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
    console.error('  FAIL  ' + name + '\n        ' +
      String(e.message).split('\n').slice(0, 6).join('\n        '));
  }
}

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '360x740', width: 360, height: 740 },
  { name: '320x653', width: 320, height: 653 },
];

// Экран задаётся переключателем режима или таб-баром — теми же обработчиками,
// что и в приложении: клик внутри evaluate обходит скрытость панелей.
const SCREENS = {
  'main-day': function () {
    document.querySelector('#tab-bar [data-view="main"]').click();
    document.querySelector('#main-view-switch [data-view="day"]').click();
  },
  'main-week': function () {
    document.querySelector('#tab-bar [data-view="main"]').click();
    document.querySelector('#main-view-switch [data-view="week"]').click();
  },
  qaza: function () {
    document.querySelector('#tab-bar [data-view="qaza"]').click();
  },
  assistant: function () {
    document.querySelector('#tab-bar [data-view="assistant"]').click();
  },
};

// only цель нажатия: что человек задевает пальцем на этом экране в первую
// очередь. Селекторы — из разметки js/ui/main-table.js и index.html.
const TARGETS = [
  { screen: 'main-day', sel: '.day-card .cell-check', what: 'галочка «выполнено» в карточке дня' },
  { screen: 'main-day', sel: '.day-card .cell-x', what: 'кнопка «не выполнено» в карточке дня' },
  { screen: 'main-day', sel: '.day-card .cell-number', what: 'числовое поле в карточке дня' },
  { screen: 'main-day', sel: '.day-card .cell-select', what: 'список значений в карточке дня' },
  { screen: 'main-day', sel: '.day-card .cell-level-btn', what: 'кнопка уровня в карточке дня' },
  { screen: 'main-week', sel: '#week-prev', what: 'стрелка «предыдущая неделя»' },
  { screen: 'main-week', sel: '#week-next', what: 'стрелка «следующая неделя»' },
  { screen: 'qaza', sel: '#prayer-btn', what: 'переход «Молитвы» из каза' },
  { screen: 'qaza', sel: '#fast-btn', what: 'переход «Ураза» из каза' },
  { screen: 'assistant', sel: '#assistant-send', what: 'отправка сообщения' },
];

async function open(browser, viewport, screen) {
  const context = await browser.newContext({ viewport, locale: 'ru-RU', hasTouch: true });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('.day-card, #habits-tbody tr'),
    null, { timeout: 20000 });
  await page.evaluate(SCREENS[screen]);
  await page.waitForTimeout(300);
  page.errorsCollected = errors;
  return { context, page };
}

async function shoot(page, name) {
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, name + '.png') });
}

// Один замер: габарит цели + не появился ли горизонтальный перелив.
async function measureTarget(page, sel) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const de = document.documentElement;
    return {
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
    };
  }, sel);
}

async function main() {
  const browser = await chromium.launch();
  try {
    // Снимок карточки дня: доказательство, что контролы остались в один ряд
    // и строка не разъехалась (числа из assert подтверждают размеры, картинка
    // — что эти числа видит человек).
    for (const viewport of VIEWPORTS) {
      const { context, page } = await open(browser, viewport, 'main-day');
      await shoot(page, 'main-day-' + viewport.name);
      await step('карточка дня: контролы в один ряд и без перелива @ ' + viewport.name, async () => {
        const res = await page.evaluate(() => {
          const card = document.querySelector('.day-card');
          if (!card) return null;
          const controls = card.querySelector('.day-card-controls');
          if (!controls) return null;
          const cr = card.getBoundingClientRect();
          const rr = controls.getBoundingClientRect();
          const de = document.documentElement;
          return {
            over: rr.right > cr.right + 0.5,
            scrollWidth: de.scrollWidth,
            clientWidth: de.clientWidth,
            cardHeight: Math.round(cr.height),
            children: Array.from(controls.children).map((child) => {
              const b = child.getBoundingClientRect();
              return Math.round(b.height);
            }),
          };
        });
        assert.ok(res, 'на телефоне обязана быть карточка дня с контролами');
        assert.equal(res.over, false, 'блок контролов не вылез за правый край карточки');
        assert.equal(res.scrollWidth, res.clientWidth,
          'страница не ушла в горизонтальный скролл: ' + res.scrollWidth + ' > ' + res.clientWidth);
        assert.ok(res.cardHeight >= 44, 'карточка дня не сжалась ниже своей высоты: ' + res.cardHeight);
        assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
      });
      await context.close();
    }

    for (const viewport of VIEWPORTS) {
      for (const target of TARGETS) {
        const { context, page } = await open(browser, viewport, target.screen);
        await step(target.what + ' >= 44px @ ' + viewport.name, async () => {
          const m = await measureTarget(page, target.sel);
          assert.ok(m, target.sel + ' не найден на экране ' + target.screen);
          assert.ok(m.width >= MIN_TARGET && m.height >= MIN_TARGET,
            target.sel + ' = ' + m.width + '×' + m.height +
            ' px, нужно не меньше ' + MIN_TARGET + ' px по каждой оси');
          assert.equal(m.scrollWidth, m.clientWidth,
            'после правки появился горизонтальный перелив: ' + m.scrollWidth + ' > ' + m.clientWidth);
          assert.deepEqual(page.errorsCollected, [], 'pageerror: ' + page.errorsCollected.join(' | '));
        });
        await context.close();
      }
    }
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
