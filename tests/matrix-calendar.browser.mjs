/* Матрица — ЛИСТ «ДАТА И ДЛИТЕЛЬНОСТЬ» В НАСТОЯЩЕМ БРАУЗЕРЕ (ТЗ Б4, Воркер 2).

   Файл НЕ входит в glob `tests/*.test.mjs` и запускается отдельно:

       node tests/matrix-calendar.browser.mjs

   Почему он есть: tests/matrix-calendar.test.mjs проверяет поведение листа в
   fake DOM, а fake DOM не знает геометрию, настоящий клик по подложке,
   ловушку Tab, инертность фона и порядок наложения дочерних слоёв. Здесь
   проверяется ровно это: что лист ПОДНИМАЕТСЯ над таб-баром, что тап мимо
   панели его закрывает, что фокус не убегает в список за спиной диалога и что
   выбор напоминания лежит ВЫШЕ самого календаря, а не под ним.

   Отдельно проверяется время: `input[type=time]` в fake DOM — поле с
   текстовым value, а здесь настоящий контрол, который принимает 09:30 и
   пересчитывает длительность.

   Внешняя сеть заблокирована: Firebase и шрифты отваливаются по своей воле, и
   это не дефект — в отчёт идут только pageerror. */

import { chromium } from 'playwright';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MATRIX_KEY = 'youplanner.matrix.tasks';
const SHOT_DIR = join(ROOT, '.test_tmp', 'matrix-calendar');

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

let BASE = '';
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
    console.error('  FAIL  ' + name + '\n        ' + String(e.message).split('\n').slice(0, 4).join('\n        '));
  }
}

function iso(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}

// Задача с назначенным timed-интервалом, повтором и напоминанием — чтобы
// метки на карточке были проверены на видимом тексте, а не в модели.
const SEED = [{
  id: 'seed-schedule',
  title: 'Приём у врача',
  notes: '',
  due: iso(1),
  doDate: null,
  priority: 2,
  done: false,
  doneAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  order: 1,
  archived: false,
  schedule: {
    version: 1,
    allDay: false,
    startDate: iso(1),
    endDate: iso(1),
    startTime: '09:30',
    endTime: '10:15',
    timeZoneMode: 'device',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 30, date: null, time: null }],
    repeat: {
      basis: 'scheduled', unit: 'week', interval: 1, weekdays: [2], monthMode: 'dayOfMonth',
      nth: null, weekday: null, dates: [], ends: { type: 'never', until: null, count: null },
    },
    series: null,
  },
}];

async function openMatrix(browser, viewport) {
  const context = await browser.newContext({ viewport, locale: 'ru-RU' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();
    return route.abort();
  });
  await context.addInitScript(([key, tasks]) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(tasks));
  }, [MATRIX_KEY, SEED]);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('.day-card, #habits-tbody tr'),
    null, { timeout: 20000 });
  await page.evaluate(() => {
    const item = document.querySelector('[data-matrix-view]');
    if (!item) throw new Error('входа в Матрицу нет в DOM');
    item.click();
  });
  await page.waitForSelector('.matrix-card', { timeout: 10000 });
  page.errorsCollected = errors;
  return { context, page };
}

async function shoot(page, name) {
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, name + '.png') });
}

// Все слои списками вниз: клики по карточкам блокирует любой открытый
// backdrop, а проверять «экран под листом» нужно именно с чистого экрана.
// Escape тут не самодеятельность, но и не палочка: непустой черновик на него
// показывает вопрос, а вопрос своим Escape возвращает в черновик. Поэтому
// на открытый вопрос отвечаем «Отбросить» прямо.
async function closeLayers(page) {
  for (let i = 0; i < 8; i++) {
    if (!(await page.locator('.matrix-sheet').count())) return;
    const discard = page.locator('.matrix-confirm-discard');
    if (await discard.count()) { await discard.click(); continue; }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
  throw new Error('слои матрицы не закрылись за 8 шагов');
}

// Открыть лист создания и из него — лист даты.
async function openDateSheet(page) {
  await page.locator('.matrix-card-add').first().click();
  await page.waitForSelector('.matrix-sheet.is-composer', { timeout: 5000 });
  await page.locator('.matrix-attr[aria-label="Срок исполнения"]').click();
  await page.waitForSelector('.matrix-sheet.is-date', { timeout: 5000 });
}

const VIEWPORTS = [
  { name: 'phone 390×844', width: 390, height: 844, tabbar: true },
  { name: 'phone 320×653', width: 320, height: 653, tabbar: true },
  { name: 'desktop 1440×900', width: 1440, height: 900, tabbar: false },
];

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
BASE = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch();
console.log('Матрица, лист даты — браузер: ' + BASE);

try {
  for (const viewport of VIEWPORTS) {
    const { context, page } = await openMatrix(browser, viewport);
    const tag = viewport.name;
    try {
      await step(tag + ': лист прижат к низу, целиком в окне и достижим', async () => {
        await openDateSheet(page);
        const box = await page.locator('.matrix-sheet.is-date').boundingBox();
        const probe = await page.evaluate(() => {
          const sheet = document.querySelector('.matrix-sheet.is-date');
          const r = sheet.getBoundingClientRect();
          const hitInSheet = (sel) => {
            const node = sheet.querySelector(sel);
            if (!node) return 'нет узла ' + sel;
            // «Достижим» здесь = «до узла можно доехать прокруткой листа»:
            // нижние строки на коротком экране изначально за краем окна, и
            // считать это дефектом было бы неверно.
            node.scrollIntoView({ block: 'center' });
            const b = node.getBoundingClientRect();
            const hit = document.elementFromPoint(Math.round(b.left + b.width / 2),
              Math.round(b.top + b.height / 2));
            return hit && sheet.contains(hit) ? 'ok'
              : 'перекрыт: ' + (hit ? String(hit.className) : 'ничто');
          };
          return {
            w: window.innerWidth, h: window.innerHeight,
            top: r.top, bottom: r.bottom, left: r.left, right: r.right,
            ready: hitInSheet('.matrix-date-ready'),
            clear: hitInSheet('.matrix-clear'),
            day: hitInSheet('.matrix-cal-day.is-today'),
          };
        });
        if (!box) throw new Error('листа нет на экране');
        if (probe.left < -1 || probe.right > probe.w + 1) throw new Error('лист шире окна');
        if (probe.top < -1) throw new Error('шапка листа ушла за верх окна');
        // Модальный лист закрывает таб-бар — это его право (z-index 1050),
        // но убежать за нижний край он не имеет права: «Очистить» и последняя
        // строка месяца остались бы недоступными.
        if (Math.abs(probe.bottom - probe.h) > 2) {
          throw new Error('лист не прижат к низу окна: ' + Math.round(probe.bottom)
            + ' вместо ' + probe.h);
        }
        if (probe.ready !== 'ok') throw new Error('«Готово» ' + probe.ready);
        if (probe.clear !== 'ok') throw new Error('«Очистить» ' + probe.clear);
        if (probe.day !== 'ok') throw new Error('день сетки ' + probe.day);
        await shoot(page, 'sheet-' + tag.replace(/[^a-z0-9]+/gi, '-'));
      });

      await step(tag + ': fields не создают горизонтального скролла', async () => {
        const wide = await page.evaluate(() => document.documentElement.scrollWidth
          - document.documentElement.clientWidth);
        if (wide > 1) throw new Error('горизонтальный скролл ' + wide + ' px');
      });

      await step(tag + ': «Готово» и заголовок достижимы при прокрутке листа', async () => {
        const state = await page.evaluate(() => {
          const sheet = document.querySelector('.matrix-sheet.is-date');
          const head = sheet.querySelector('.matrix-date-ready');
          sheet.scrollTop = sheet.scrollHeight;
          const r = head.getBoundingClientRect();
          const s = sheet.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, sheetTop: s.top, scrollable: sheet.scrollHeight > sheet.clientHeight };
        });
        if (state.bottom < state.sheetTop || state.top > state.sheetTop + 80) {
          throw new Error('«Готово» не у у края прокручиваемого листа');
        }
      });

      await step(tag + ': тап по подложке закрывает лист, черновик жив', async () => {
        await page.mouse.click(Math.round(viewport.width / 2), 12);
        await page.waitForSelector('.matrix-sheet.is-date', { state: 'detached', timeout: 5000 });
        const composer = await page.locator('.matrix-sheet.is-composer').count();
        if (composer !== 1) throw new Error('лист создания исчез вместе с календарём');
      });
    } finally {
      await context.close();
    }
  }

  // Дальше — поведение на одном телефонном снимке: фокус, контролы, слои.
  const { context, page } = await openMatrix(browser, VIEWPORTS[0]);
  try {
    await step('фон под листом инертен, Tab остаётся внутри диалога', async () => {
      await openDateSheet(page);
      const inert = await page.evaluate(() => {
        const screen = document.getElementById('matrix-screen');
        return { inert: screen.inert === true, hidden: screen.getAttribute('aria-hidden') };
      });
      if (!inert.inert || inert.hidden !== 'true') throw new Error('экран под листом доступен');

      await page.evaluate(() => {
        const nodes = document.querySelectorAll('.matrix-sheet.is-date button, .matrix-sheet.is-date input, .matrix-sheet.is-date [tabindex]');
        nodes[nodes.length - 1].focus();
      });
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        return !!(active && active.closest('.matrix-sheet.is-date'));
      });
      if (!inside) throw new Error('Tab увёл фокус из диалога');
      await page.keyboard.press('Shift+Tab');
      const back = await page.evaluate(() => !!(document.activeElement
        && document.activeElement.closest('.matrix-sheet.is-date')));
      if (!back) throw new Error('Shift+Tab увёл фокус из диалога');
    });

    await step('настоящее поле времени: 09:30 → 10:15 = 45 мин', async () => {
      await page.locator('.matrix-cal-day').first().click();
      await page.locator('.matrix-mode-btn[data-mode="timed"]').click();
      await page.locator('input[type="time"][data-endpoint="start"]').fill('09:30');
      await page.locator('input[type="time"][data-endpoint="end"]').fill('10:15');
      const duration = await page.locator('.matrix-duration').innerText();
      if (!/45 мин/.test(duration)) throw new Error('длительность: ' + duration);
    });

    await step('«Весь день» снимает поля часов с экрана, даты остаются доступны', async () => {
      await page.locator('.matrix-all-day-input').check();
      const times = await page.locator('.matrix-sheet.is-date input[type="time"]').count();
      if (times !== 0) throw new Error('полей часов стало ' + times);
      const days = await page.locator('.matrix-cal-day').count();
      if (days < 28) throw new Error('сетка дней пропала: ' + days);
      const visible = await page.locator('.matrix-schedule-endpoint[data-endpoint="end"]').isVisible();
      if (!visible) throw new Error('пилюля «Закончить» исчезла вместе с часами');
      await page.locator('.matrix-all-day-input').uncheck();
      const back = await page.locator('.matrix-sheet.is-date input[type="time"]').count();
      if (back !== 2) throw new Error('часы не вернулись: ' + back);
    });

    await step('невалидный порядок границ: «Готово» не закрывает лист, причина в живом регионе', async () => {
      // Обе границы намеренно ставятся в ОДИН день: «+» в q1 приносит сегодня,
      // и без этого интервал оказался бы четырёхдневным, а 23:30 → 00:15 в нём
      // было бы абсолютно верным
      await page.locator('.matrix-schedule-endpoint[data-endpoint="start"]').click();
      await page.locator('.matrix-cal-day.is-today').click();
      await page.locator('.matrix-schedule-endpoint[data-endpoint="end"]').click();
      await page.locator('.matrix-cal-day.is-today').click();
      await page.locator('input[type="time"][data-endpoint="start"]').fill('23:30');
      await page.locator('input[type="time"][data-endpoint="end"]').fill('00:15');
      await page.locator('.matrix-date-ready').click();
      const open = await page.locator('.matrix-sheet.is-date').count();
      if (open !== 1) throw new Error('лист закрылся на невалидной форме');
      const text = await page.locator('.matrix-schedule-error').innerText();
      if (!text.trim()) throw new Error('причина не названа');
      const live = await page.evaluate(() => {
        const box = document.querySelector('.matrix-schedule-error');
        return { role: box.getAttribute('role'), live: box.getAttribute('aria-live') };
      });
      if (live.role !== 'alert' || live.live !== 'assertive') throw new Error('регион ошибок не объявляется');
      const invalid = await page.evaluate(() => {
        const field = document.querySelector('input[type="time"][data-endpoint="end"]');
        return { invalid: field.getAttribute('aria-invalid'), described: field.getAttribute('aria-describedby') };
      });
      if (invalid.invalid !== 'true' || !invalid.described) {
        throw new Error('неверное поле не связано с ошибкой');
      }
      await page.locator('input[type="time"][data-endpoint="end"]').fill('23:45');
      await page.locator('.matrix-date-ready').click();
      await page.waitForSelector('.matrix-sheet.is-date', { state: 'detached', timeout: 5000 });
    });

    await step('дочерний выбор напоминания лежит ВЫШЕ календаря', async () => {
      await page.locator('.matrix-attr[aria-label="Срок исполнения"]').click();
      await page.waitForSelector('.matrix-sheet.is-date', { timeout: 5000 });
      await page.locator('.matrix-reminder-row').click();
      await page.waitForSelector('.matrix-sheet.is-reminder', { timeout: 5000 });
      const onTop = await page.evaluate(() => {
        const sheet = document.querySelector('.matrix-sheet.is-date');
        const box = sheet.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(box.left + box.width / 2),
          Math.round(box.top + Math.min(30, box.height / 2)));
        return !!(hit && hit.closest('.matrix-sheet.is-reminder, .matrix-sheet-backdrop.is-reminder'));
      });
      if (!onTop) throw new Error('подложка календаря осталась кликабельной под выбором');
      const options = await page.locator('.matrix-reminder-option').count();
      if (options < 7) throw new Error('вариантов напоминания ' + options);
      await shoot(page, 'reminder-layer');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.matrix-sheet.is-reminder', { state: 'detached', timeout: 5000 });
      const stillDate = await page.locator('.matrix-sheet.is-date').count();
      if (stillDate !== 1) throw new Error('Escape снял вместе с выбором и календарь');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.matrix-sheet.is-date', { state: 'detached', timeout: 5000 });
    });

    await step('карточка называет время, повтор и напоминание', async () => {
      await closeLayers(page);
      const row = await page.evaluate(() => {
        const card = document.querySelector('.matrix-card');
        const due = card.querySelector('.matrix-due');
        return {
          due: due ? due.textContent : '',
          repeat: card.querySelectorAll('.matrix-repeat-mark').length,
          reminder: card.querySelectorAll('.matrix-reminder-mark').length,
          edit: card.querySelectorAll('.matrix-task-schedule').length,
        };
      });
      if (!/9:30|09:30/.test(row.due)) throw new Error('время начала не подписано: ' + row.due);
      if (row.repeat !== 1 || row.reminder !== 1) throw new Error('меток: ' + row.repeat + '/' + row.reminder);
      if (row.edit !== 1) throw new Error('действия «Изменить дату и время» нет');
      await shoot(page, 'card-marks');
    });

    await step('режим существующей задачи: отмена Escape не трогает хранилище', async () => {
      const before = await page.evaluate((key) => localStorage.getItem(key), MATRIX_KEY);
      await closeLayers(page);
      await page.locator('.matrix-task-schedule').first().click();
      await page.waitForSelector('.matrix-sheet.is-date', { timeout: 5000 });
      await page.locator('.matrix-cal-day').nth(2).click();
      await page.keyboard.press('Escape');
      await page.waitForSelector('.matrix-sheet.is-date', { state: 'detached', timeout: 5000 });
      const after = await page.evaluate((key) => localStorage.getItem(key), MATRIX_KEY);
      if (after !== before) throw new Error('отмена записала расписание в хранилище');
    });

    await step('перенос назначенного интервала спрашивает подтверждение', async () => {
      await closeLayers(page);
      await page.locator('.matrix-task-move').first().click();
      await page.waitForSelector('.matrix-sheet.is-move', { timeout: 5000 });
            // Seed-задача уже в q1 (срок завтра + важность), поэтому предлагаются
      // остальные квадранты: перенос в q3 тоже двигает окончание и обязан
      // спросить разрешение.
      await page.locator('.matrix-sheet-item[data-quadrant="q3"]').click();
      await page.waitForSelector('.matrix-move-preview', { timeout: 5000 });
      const before = await page.evaluate((key) => localStorage.getItem(key), MATRIX_KEY);
      await page.locator('.matrix-move-cancel').click();
      await page.waitForSelector('.matrix-move-preview', { state: 'detached', timeout: 5000 });
      const after = await page.evaluate((key) => localStorage.getItem(key), MATRIX_KEY);
      if (after !== before) throw new Error('отказ от переноса всё-таки записался');
    });

    await step('напоминание из листа доходит до хранилища и обратно', async () => {
      await closeLayers(page);
      await page.locator('.matrix-card-add').first().click();
      await page.waitForSelector('.matrix-sheet.is-composer', { timeout: 5000 });
      await page.locator('.matrix-attr[aria-label="Срок исполнения"]').click();
      await page.waitForSelector('.matrix-sheet.is-date', { timeout: 5000 });
      await page.locator('.matrix-cal-day').nth(3).click();
      await page.locator('.matrix-mode-btn[data-mode="timed"]').click();
      await page.locator('.matrix-reminder-row').click();
      await page.waitForSelector('.matrix-sheet.is-reminder', { timeout: 5000 });
      await page.locator('.matrix-reminder-option[data-offset="15"]').click();
      await page.locator('.matrix-date-ready').click();
      await page.waitForSelector('.matrix-sheet.is-date', { state: 'detached', timeout: 5000 });
      await page.locator('.matrix-composer-title').fill('Полоскать');
      await page.locator('.matrix-composer').evaluate((form) => form.requestSubmit());
      await page.waitForSelector('.matrix-sheet.is-composer', { state: 'detached', timeout: 5000 });
      const stored = await page.evaluate((key) => {
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const task = list.filter(t => t.title === 'Полоскать')[0];
        return task && task.schedule ? task.schedule.reminders.length : -1;
      }, MATRIX_KEY);
      if (stored !== 1) throw new Error('напоминание не дожило до хранилища: ' + stored);
    });

    // Живая доставка: единственный способ проверить весь путь — настоящий
    // час, настоящий тик и настоящий стек уведомлений. Правило ставится на
    // ~+70 секунд вперёд, контроллер тикает каждые 30, и «додумывать» это
    // моками в fake DOM было бы проверкой собственной заглушки.
    await step('напоминание доходит до экрана само (тикер + стек уведомлений)', async () => {
      await closeLayers(page);
      const soon = await page.evaluate(() => {
        const at = new Date(Date.now() + 70000);
        const pad = (n) => String(n).padStart(2, '0');
        return {
          date: at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()),
          time: pad(at.getHours()) + ':' + pad(at.getMinutes()),
        };
      });
      await page.evaluate(([key, date, time]) => {
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const task = list.filter(t => t.id === 'seed-schedule')[0];
        task.schedule.startDate = date;
        task.schedule.endDate = date;
        task.schedule.startTime = time;
        task.schedule.endTime = time;
        task.schedule.reminders = [{ id: 'live', anchor: 'start', offsetMinutes: 0, date: null, time: null }];
        task.due = date;
        localStorage.setItem(key, JSON.stringify(list));
      }, [MATRIX_KEY, soon.date, soon.time]);
      // правка прямо в localStorage — экран её не знает, поэтому перерисовка
      // и refresh контроллера идут через само приложение
      await page.evaluate(() => {
        document.querySelector('.matrix-card-add').click();
        document.querySelector('.matrix-sheet-x.matrix-composer-close').click();
      });

      await page.waitForSelector('.matrix-reminder-stack .matrix-reminder-notice',
        { timeout: 150000 });
      const notice = await page.evaluate(() => {
        const box = document.querySelector('.matrix-reminder-stack');
        const node = box.querySelector('.matrix-reminder-notice');
        return {
          live: box.getAttribute('aria-live'),
          title: node.querySelector('.matrix-reminder-notice-title').textContent,
          time: node.querySelector('.matrix-reminder-notice-time').textContent,
          actions: node.querySelectorAll('button').length,
        };
      });
      if (notice.live !== 'polite') throw new Error('стек не является живым регионом');
      if (!/Приём у врача/.test(notice.title)) throw new Error('заголовок: ' + notice.title);
      if (!notice.time.trim()) throw new Error('время не названо');
      if (notice.actions !== 2) throw new Error('кнопок ' + notice.actions);
      await shoot(page, 'notice-live');
      await page.locator('.matrix-reminder-notice-close').first().click();
      const left = await page.locator('.matrix-reminder-notice').count();
      if (left !== 0) throw new Error('«Закрыть» не снял уведомление');
    });

    await step('«Настроить» в настоящем браузере: режим месяца и набор дат', async () => {
      await closeLayers(page);
      await page.locator('.matrix-card-add').first().click();
      await page.locator('.matrix-attr[aria-label="Срок исполнения"]').click();
      await page.waitForSelector('.matrix-sheet.is-date');
      await page.locator('.matrix-cal-day.is-today').click();
      // Один и тот же черновик проходит два режима подряд: так проверка не
      // зависит от того, какая из накопленных тестом задач первой легла в
      // сетку, и не трогает чужие правила.
      await page.locator('.matrix-repeat-row').click();
      await page.waitForSelector('.matrix-sheet.is-repeat');
      await page.selectOption('.matrix-repeat-unit', 'month');
      await page.selectOption('.matrix-repeat-month-mode', 'nthWeekday');
      await page.selectOption('.matrix-repeat-nth', '-1');
      await page.selectOption('.matrix-repeat-weekday-pick', '1');
      // «От выполнения» для такого правила не имеет смысла — контрол обязан
      // быть выключен, а не молча переписывать правило (ТЗ Б7)
      if (!(await page.locator('.matrix-repeat-basis').isDisabled())) {
        throw new Error('completion-based не отключён для сложного правила');
      }
      await page.locator('.matrix-repeat-apply').click();
      const monthlySummary = await page.locator('.matrix-repeat-row').innerText();
      if (!/месяц/.test(monthlySummary)) throw new Error('строка повтора: ' + monthlySummary);

      await page.locator('.matrix-repeat-row').click();
      await page.waitForSelector('.matrix-sheet.is-repeat');
      await page.selectOption('.matrix-repeat-unit', 'dates');
      // Список дат пуст по-настоящему: правило собирается только из того, что
      // человек добавил сам, и подсказка об этом обязана быть видна.
      const emptyHint = await page.locator('.matrix-repeat-hint').first().innerText();
      if (!/пуст/i.test(emptyHint)) throw new Error('подсказки о пустом списке нет: ' + emptyHint);
      const picked = iso(12);
      await page.locator('.matrix-repeat-date-input').fill(picked);
      await page.locator('.matrix-repeat-date-add').click();
      if (await page.locator('.matrix-repeat-date').count() !== 1) {
        throw new Error('дата не добавилась');
      }
      await page.locator('.matrix-repeat-date-add').click();
      if (await page.locator('.matrix-repeat-date').count() !== 1) {
        throw new Error('та же дата добавилась дважды');
      }
      await shoot(page, 'repeat-dates');
      await page.locator('.matrix-repeat-apply').click();
      await page.locator('.matrix-date-ready').click();
      await page.waitForSelector('.matrix-sheet.is-date', { state: 'detached', timeout: 5000 });

      await page.locator('.matrix-composer-title').fill('По выбранным датам');
      await page.locator('.matrix-composer').evaluate((form) => form.requestSubmit());
      await page.waitForSelector('.matrix-sheet.is-composer', { state: 'detached', timeout: 5000 });
      const stored = await page.evaluate(([key, date]) => {
        const task = JSON.parse(localStorage.getItem(key) || '[]')
          .filter(t => t.title === 'По выбранным датам')[0];
        if (!task) return null;
        return { repeat: task.schedule.repeat, start: task.schedule.startDate, due: task.due };
      }, [MATRIX_KEY, picked]);
      if (!stored) throw new Error('задача не создана');
      if (stored.repeat.unit !== 'dates') throw new Error('единица не сменилась');
      if (Array.from(stored.repeat.dates).join() !== picked) {
        throw new Error('даты в правиле: ' + stored.repeat.dates.join());
      }
      // Первая дата списка становится сроком: правило «по датам» иначе
      // невалидно, и лист обязан это сделать, а не отказывать вслепую.
      if (stored.start !== picked || stored.due !== picked) {
        throw new Error('срок не поехал за списком дат: ' + stored.start + '/' + stored.due);
      }
      await closeLayers(page);
    });

    await step('за весь прогон — ни одной pageerror', async () => {
      if (page.errorsCollected.length) throw new Error(page.errorsCollected.join('\n'));
    });
  } finally {
    await context.close();
  }

  console.log('\nИтог: ' + passed + ' PASS, ' + failed + ' FAIL');
  if (failed) {
    console.log('Упавшие проверки:');
    for (const name of failures) console.log('  — ' + name);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
