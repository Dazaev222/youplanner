// F6.1 (Раздел 6 ТЗ): единый владелец геометрии Harness на iOS.
// Тесты пишутся ДО реализации (RED): js/harness/viewport.js ещё нет.
//
// Модуль принимает DOM-зависимости аргументами (app/root/deps) — тесты идут
// на заглушках, не на живом окне. Реальная iPhone-геометрия проверяется
// вручную (сценарии F6.5.1–F6.5.2), здесь — unit-контракт.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeTimers } from './helpers/fake-timers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT_PATH = join(ROOT, 'js', 'harness', 'viewport.js');
const INDEX_PATH = join(ROOT, 'js', 'harness', 'index.js');
const CSS_PATH = join(ROOT, 'styles', 'harness.css');

assert.ok(existsSync(VIEWPORT_PATH),
  'js/harness/viewport.js не существует — реализация не начата (ожидаются RED)');

const { mountHarnessViewport } = await import('file://' + VIEWPORT_PATH);

/* --- Мини-заглушки DOM -------------------------------------------------------- */

function makeStyle() {
  const vars = new Map();
  const calls = [];
  return {
    calls,
    setProperty(k, v) { calls.push(['set', k, String(v)]); vars.set(k, String(v)); },
    getPropertyValue(k) { return vars.has(k) ? vars.get(k) : ''; },
    removeProperty(k) { calls.push(['remove', k]); vars.delete(k); },
  };
}

function makeClassList() {
  const set = new Set();
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
  };
}

function makeElement(extra = {}) {
  const el = Object.assign({
    tagName: 'DIV',
    style: makeStyle(),
    classList: makeClassList(),
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = this.listeners[type];
      if (list) {
        const i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      }
    },
    dispatch(type, event = {}) {
      for (const fn of (this.listeners[type] || []).slice()) fn(event);
    },
    listenerCount(type) { return (this.listeners[type] || []).length; },
    getBoundingClientRect() {
      return { top: 0, bottom: 600, left: 0, right: 390, width: 390, height: 600 };
    },
    getAttribute() { return null; },
  }, extra);
  return el;
}

// Фейковая среда: window + document + visualViewport + rAF-очередь.
function makeEnv({ visualViewport, mobile = true, tabBarRect = null } = {}) {
  const rafQueue = [];
  const rafCalls = [];
  const winListeners = {};

  const vv = visualViewport === undefined
    ? makeElement({
      tagName: '#visual-viewport',
      height: 800,
      offsetTop: 0,
      scale: 1,
      width: 390,
    })
    : visualViewport;

  const body = makeElement({ tagName: 'BODY' });
  const documentElement = makeElement({ tagName: 'HTML', clientWidth: 390 });
  const doc = makeElement({
    tagName: '#document',
    body,
    documentElement,
    activeElement: null,
    getElementById(id) { return id === 'tab-bar' ? env.tabBar : null; },
  });

  const win = makeElement({
    tagName: '#window',
    innerWidth: 390,
    visualViewport: vv,
    matchMedia(query) {
      return {
        media: query,
        get matches() { return mobile; },
        addEventListener() {},
        removeEventListener() {},
      };
    },
    requestAnimationFrame(fn) {
      rafCalls.push(1);
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrame(id) {
      if (rafQueue[id - 1]) rafQueue[id - 1] = null;
    },
    setTimeout,
    clearTimeout,
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = winListeners[type];
      if (list) {
        const i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      }
    },
    dispatch(type, event = {}) {
      for (const fn of (winListeners[type] || []).slice()) fn(event);
    },
    listenerCount(type) { return (winListeners[type] || []).length; },
  });
  doc.defaultView = win;

  const tabBar = makeElement({
    tagName: 'NAV',
    getBoundingClientRect() {
      return tabBarRect || { top: 802, bottom: 846, left: 0, right: 390, width: 390, height: 44 };
    },
  });

  const root = makeElement({
    tagName: 'SECTION',
    querySelector(selector) {
      return selector === '.harness-dock' ? env.dock : null;
    },
  });
  const dock = makeElement({ tagName: 'FOOTER' });
  // #app в мобильном режиме fixed на высоту visual viewport: rect bottom 800.
  const app = makeElement({
    tagName: 'DIV',
    getBoundingClientRect() {
      return { top: 0, bottom: 800, left: 0, right: 390, width: 390, height: 800 };
    },
  });

  const env = {
    app, root, dock, tabBar, win, doc, body, vv,
    rafQueue,
    flushFrames() {
      const pending = rafQueue.splice(0);
      for (const fn of pending) if (fn) fn();
    },
    rafCount() { return rafCalls.length; },
  };
  return env;
}

function mount(env, { onLayout, timers } = {}) {
  return mountHarnessViewport({
    app: env.app,
    root: env.root,
    onLayout,
    deps: {
      window: env.win,
      document: env.doc,
      visualViewport: env.vv === undefined ? null : env.vv,
      timers: timers || { setTimeout, clearTimeout },
    },
  });
}

// Вариант mount, где visualViewport берётся из window (обычный путь).
function mountNative(env, { onLayout, timers } = {}) {
  return mountHarnessViewport({
    app: env.app,
    root: env.root,
    onLayout,
    deps: {
      window: env.win,
      document: env.doc,
      timers: timers || { setTimeout, clearTimeout },
    },
  });
}

function harnessVarCalls(style) {
  return style.calls.filter(([op, key]) =>
    key === '--harness-vh' || key === '--harness-vtop' || key === '--harness-bottom-space');
}

/* --- Геометрия: переменные ------------------------------------------------------- */

test('F6.1: offsetTop=40, height=420 → переменные --harness-vh/--harness-vtop на #app', () => {
  const env = makeEnv();
  env.vv.height = 420;
  env.vv.offsetTop = 40;
  const vp = mountNative(env);
  env.flushFrames();
  assert.equal(env.app.style.getPropertyValue('--harness-vh'), '420px');
  assert.equal(env.app.style.getPropertyValue('--harness-vtop'), '40px');
  vp.destroy();
});

test('F6.1: значение пишется только при изменении — серия событий не спамит стили', () => {
  const env = makeEnv();
  env.vv.height = 420;
  const vp = mountNative(env);
  env.flushFrames();
  const writes = harnessVarCalls(env.app.style).filter(([op]) => op === 'set').length;
  // Серия событий без изменения геометрии
  env.vv.dispatch('resize');
  env.vv.dispatch('scroll');
  env.win.dispatch('resize');
  env.flushFrames();
  const after = harnessVarCalls(env.app.style).filter(([op]) => op === 'set').length;
  assert.equal(after, writes, 'без изменений геометрии новых записей нет');
  // Реальное изменение — ровно одна новая запись
  env.vv.height = 380;
  env.vv.dispatch('resize');
  env.flushFrames();
  assert.equal(harnessVarCalls(env.app.style).filter(([op]) => op === 'set').length, writes + 1);
  vp.destroy();
});

test('F6.1: один запланированный rAF на серию событий, без постоянного цикла', () => {
  const env = makeEnv();
  const vp = mountNative(env);
  env.vv.dispatch('resize');
  env.vv.dispatch('scroll');
  env.win.dispatch('resize');
  env.win.dispatch('orientationchange');
  env.win.dispatch('pageshow');
  env.doc.dispatch('visibilitychange');
  assert.equal(env.rafCount(), 1, 'серия событий даёт один rAF');
  env.flushFrames();
  assert.equal(env.rafCount(), 1, 'после обработки новых rAF само по себе не появляется');
  vp.destroy();
  env.flushFrames();
  assert.equal(env.rafCount(), 1, 'после destroy rAF не планируются');
});

test('F6.1: refresh() пересчитывает геометрию', () => {
  const env = makeEnv();
  env.vv.height = 500;
  const vp = mountNative(env);
  env.flushFrames();
  env.vv.height = 430;
  vp.refresh();
  env.flushFrames();
  assert.equal(env.app.style.getPropertyValue('--harness-vh'), '430px');
  vp.destroy();
});

/* --- Fallback и desktop --------------------------------------------------------- */

test('F6.1: без visualViewport переменные сняты — работает CSS fallback', () => {
  const env = makeEnv({ visualViewport: null });
  const vp = mount(env);
  env.flushFrames();
  assert.equal(env.app.style.getPropertyValue('--harness-vh'), '');
  assert.equal(env.app.style.getPropertyValue('--harness-vtop'), '');
  vp.destroy();
});

test('F6.1: desktop снимает мобильные inline-переменные и класс editing', () => {
  const env = makeEnv({ mobile: false });
  const vp = mountNative(env);
  env.flushFrames();
  assert.equal(env.app.style.getPropertyValue('--harness-vh'), '');
  assert.equal(env.app.style.getPropertyValue('--harness-vtop'), '');
  // Пришли на desktop из mobile-состояния с классом: класс снят
  env.body.classList.add('harness-editing');
  env.win.dispatch('resize');
  env.flushFrames();
  assert.equal(env.body.classList.contains('harness-editing'), false,
    'на desktop мобильный editing-класс снят');
  vp.destroy();
});

test('F6.1: смена mobile→desktop и обратно пересчитывает переменные', () => {
  // matchMedia-заглушка с переключаемым matches
  const rafQueue = [];
  let mobile = true;
  const win = makeElement({
    tagName: '#window',
    innerWidth: 390,
    visualViewport: makeElement({ tagName: '#vv', height: 800, offsetTop: 0, scale: 1 }),
    matchMedia(query) {
      return {
        media: query,
        get matches() { return mobile; },
        addEventListener() {},
        removeEventListener() {},
      };
    },
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame() {},
  });
  const doc = makeElement({ tagName: '#document', body: makeElement({ tagName: 'BODY' }),
    documentElement: makeElement({ tagName: 'HTML', clientWidth: 390 }) });
  doc.defaultView = win;
  const app = makeElement({ tagName: 'DIV' });
  const vp = mountHarnessViewport({
    app, root: makeElement({ tagName: 'SECTION' }),
    deps: { window: win, document: doc },
  });
  rafQueue.splice(0).forEach((fn) => fn());
  assert.equal(app.style.getPropertyValue('--harness-vh'), '800px');
  mobile = false;
  win.dispatch('resize');
  rafQueue.splice(0).forEach((fn) => fn());
  assert.equal(app.style.getPropertyValue('--harness-vh'), '',
    'на desktop мобильная переменная снята');
  mobile = true;
  win.dispatch('resize');
  rafQueue.splice(0).forEach((fn) => fn());
  assert.equal(app.style.getPropertyValue('--harness-vh'), '800px',
    'возврат на mobile пересчитал переменную');
  vp.destroy();
});

/* --- Редактирование и клавиатура --------------------------------------------------- */

test('F6.1: focusin на textarea/input/contenteditable ставит body.harness-editing', () => {
  const env = makeEnv();
  const vp = mountNative(env);
  env.flushFrames();
  const textarea = makeElement({ tagName: 'TEXTAREA' });
  env.root.dispatch('focusin', { target: textarea });
  assert.equal(env.body.classList.contains('harness-editing'), true);
  vp.destroy();
});

test('F6.1: range/checkbox/button не включают editing-класс', () => {
  const env = makeEnv();
  const vp = mountNative(env);
  env.flushFrames();
  for (const type of ['range', 'checkbox', 'button', 'submit']) {
    env.root.dispatch('focusin', { target: makeElement({ tagName: 'INPUT', type }) });
    assert.equal(env.body.classList.contains('harness-editing'), false, 'type=' + type);
  }
  vp.destroy();
});

test('F6.1: focusout не снимает класс немедленно — ждёт восстановления высоты', async () => {
  const env = makeEnv();
  const timers = makeFakeTimers();
  const vp = mountNative(env, { timers: { setTimeout: timers.schedule, clearTimeout: timers.cancel } });
  env.flushFrames();
  const textarea = makeElement({ tagName: 'TEXTAREA' });
  env.root.dispatch('focusin', { target: textarea });
  // Клавиатура открылась
  env.vv.height = 620;
  env.vv.dispatch('resize');
  env.flushFrames();
  // Фокус ушёл в никуда
  env.root.dispatch('focusout', { target: textarea, relatedTarget: null });
  assert.equal(env.body.classList.contains('harness-editing'), true,
    'сразу после focusout класс ещё стоит');
  // Высота восстановилась → допуск 24px → стабильность 120ms → снятие
  env.vv.height = 800;
  env.vv.dispatch('resize');
  env.flushFrames();
  assert.equal(env.body.classList.contains('harness-editing'), true,
    'до стабильности 120ms класс ещё стоит');
  timers.advance(121);
  assert.equal(env.body.classList.contains('harness-editing'), false,
    'после восстановления и стабильности класс снят');
  vp.destroy();
});

test('F6.1: восстановление с допуском 24px снимает класс, уменьшение >80px держит резерв', async () => {
  const env = makeEnv();
  const timers = makeFakeTimers();
  const vp = mountNative(env, { timers: { setTimeout: timers.schedule, clearTimeout: timers.cancel } });
  env.flushFrames();
  const textarea = makeElement({ tagName: 'TEXTAREA' });
  env.root.dispatch('focusin', { target: textarea });
  env.vv.height = 700;  // клавиатура
  env.vv.dispatch('resize');
  env.flushFrames();
  env.root.dispatch('focusout', { target: textarea, relatedTarget: null });
  // Клавиатура закрывается в два шага: 780 (в допуске 24px от 800)
  env.vv.height = 780;
  env.vv.dispatch('resize');
  env.flushFrames();
  timers.advance(130);
  assert.equal(env.body.classList.contains('harness-editing'), false,
    'восстановление в допуске 24px снимает класс');
  vp.destroy();

  // Уменьшение >80px держится — резерв снят (класс остаётся)
  const env2 = makeEnv();
  const timers2 = makeFakeTimers();
  const vp2 = mountNative(env2, { timers: { setTimeout: timers2.schedule, clearTimeout: timers2.cancel } });
  env2.flushFrames();
  const ta2 = makeElement({ tagName: 'TEXTAREA' });
  env2.root.dispatch('focusin', { target: ta2 });
  env2.vv.height = 640;
  env2.vv.dispatch('resize');
  env2.flushFrames();
  env2.root.dispatch('focusout', { target: ta2, relatedTarget: null });
  env2.vv.height = 700;  // база 800 → уменьшение 100 > 80
  env2.vv.dispatch('resize');
  env2.flushFrames();
  timers2.advance(1000);
  assert.equal(env2.body.classList.contains('harness-editing'), true,
    'устойчивое уменьшение >80px держит резерв снятым');
  vp2.destroy();
});

test('F6.1: возврат из фона пересчитывает editing (пропущенный blur не ломает состояние)', async () => {
  const env = makeEnv();
  const timers = makeFakeTimers();
  const vp = mountNative(env, { timers: { setTimeout: timers.schedule, clearTimeout: timers.cancel } });
  env.flushFrames();
  const textarea = makeElement({ tagName: 'TEXTAREA' });
  env.root.dispatch('focusin', { target: textarea });
  env.vv.height = 620;
  env.vv.dispatch('resize');
  env.flushFrames();
  // Приложение ушло в фон и вернулось; фокус потерян без события blur
  env.doc.activeElement = env.body;
  env.doc.dispatch('visibilitychange');
  env.flushFrames();
  env.vv.height = 800;
  env.vv.dispatch('resize');
  env.flushFrames();
  timers.advance(200);
  assert.equal(env.body.classList.contains('harness-editing'), false,
    'после возврата из фона класс снят без пропущенного blur');
  vp.destroy();
});

test('F6.1: без visualViewport editing снимается отложенно (250ms), точность ограничена', async () => {
  const env = makeEnv({ visualViewport: null });
  const timers = makeFakeTimers();
  const vp = mount(env, { timers: { setTimeout: timers.schedule, clearTimeout: timers.cancel } });
  env.flushFrames();
  const textarea = makeElement({ tagName: 'TEXTAREA' });
  env.root.dispatch('focusin', { target: textarea });
  assert.equal(env.body.classList.contains('harness-editing'), true);
  env.root.dispatch('focusout', { target: textarea, relatedTarget: null });
  timers.advance(100);
  assert.equal(env.body.classList.contains('harness-editing'), true,
    'до 250ms класс ещё стоит');
  timers.advance(200);
  assert.equal(env.body.classList.contains('harness-editing'), false,
    'без visualViewport снятие отложенное (250ms)');
  vp.destroy();
});

/* --- Резерв под таб-бар ------------------------------------------------------------ */

test('F6.1: --harness-bottom-space — бар перекрывает app: max(8, app.bottom - bar.top + 8)', () => {
  const env = makeEnv({ tabBarRect: { top: 760, bottom: 804, left: 0, right: 390, width: 390, height: 44 } });
  const vp = mountNative(env);
  env.flushFrames();
  assert.equal(env.app.style.getPropertyValue('--harness-bottom-space'), '48px',
    'app.bottom 800 − bar.top 760 + 8 = 48');
  vp.destroy();
});

test('F6.1: бар не перекрывает app → переменная снята (CSS fallback 8px + safe-area)', () => {
  const env = makeEnv({ tabBarRect: { top: 802, bottom: 846, left: 0, right: 390, width: 390, height: 44 } });
  const vp = mountNative(env);
  env.flushFrames();
  assert.equal(env.app.style.getPropertyValue('--harness-bottom-space'), '');
  vp.destroy();
});

test('F6.1: скрытый бар не измеряется как нулевой — используется fallback', () => {
  const env = makeEnv({ tabBarRect: { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } });
  const vp = mountNative(env);
  env.flushFrames();
  assert.equal(env.app.style.getPropertyValue('--harness-bottom-space'), '',
    'нулевой rect скрытого бара не даёт резерва — CSS fallback');
  vp.destroy();
});

/* --- onLayout и destroy --------------------------------------------------------------- */

test('F6.1: onLayout вызывается после обновления геометрии', () => {
  const env = makeEnv();
  const layouts = [];
  const vp = mountNative(env, { onLayout: () => layouts.push(env.app.style.getPropertyValue('--harness-vh')) });
  env.flushFrames();
  assert.deepEqual(layouts, ['800px'], 'onLayout получил уже записанную геометрию');
  vp.destroy();
});

test('F6.1: destroy снимает слушатели/observers, отменяет rAF/таймеры, чистит классы/переменные', async () => {
  const env = makeEnv({ tabBarRect: { top: 760, bottom: 804, left: 0, right: 390, width: 390, height: 44 } });
  const timers = makeFakeTimers();
  const vp = mountNative(env, { timers: { setTimeout: timers.schedule, clearTimeout: timers.cancel } });
  env.flushFrames();

  const winCounts = ['resize', 'orientationchange', 'pageshow']
    .map((t) => env.win.listenerCount(t));
  const vvCounts = ['resize', 'scroll'].map((t) => env.vv.listenerCount(t));
  const docCounts = ['visibilitychange'].map((t) => env.doc.listenerCount(t));
  const rootCounts = ['focusin', 'focusout'].map((t) => env.root.listenerCount(t));
  assert.ok(winCounts.every((n) => n > 0), 'слушатели window навешаны');
  assert.ok(vvCounts.every((n) => n > 0), 'слушатели visualViewport навешаны');

  const textarea = makeElement({ tagName: 'TEXTAREA' });
  env.root.dispatch('focusin', { target: textarea });
  assert.equal(env.body.classList.contains('harness-editing'), true);

  vp.destroy();
  env.flushFrames();
  timers.advance(1000);

  assert.deepEqual(['resize', 'orientationchange', 'pageshow']
    .map((t) => env.win.listenerCount(t)), winCounts.map(() => 0),
    'слушатели window сняты');
  assert.deepEqual(['resize', 'scroll'].map((t) => env.vv.listenerCount(t)),
    vvCounts.map(() => 0), 'слушатели visualViewport сняты');
  assert.deepEqual(['visibilitychange'].map((t) => env.doc.listenerCount(t)),
    docCounts.map(() => 0), 'слушатели document сняты');
  assert.deepEqual(['focusin', 'focusout'].map((t) => env.root.listenerCount(t)),
    rootCounts.map(() => 0), 'слушатели root сняты');
  assert.equal(env.body.classList.contains('harness-editing'), false,
    'editing-класс снят при destroy');
  assert.equal(env.app.style.getPropertyValue('--harness-vh'), '', 'переменные vh сняты');
  assert.equal(env.app.style.getPropertyValue('--harness-vtop'), '', 'переменные vtop сняты');
  assert.equal(env.app.style.getPropertyValue('--harness-bottom-space'), '',
    'переменная bottom-space снята');
  assert.equal(timers.pendingCount(), 0, 'таймеры отменены');
});

test('F6.1: двадцать mount/unmount не увеличивают число обработчиков', () => {
  const env = makeEnv();
  const totalListeners = () => {
    let n = 0;
    for (const target of [env.win, env.vv, env.doc, env.root]) {
      for (const list of Object.values(target.listeners)) n += list.length;
    }
    return n;
  };
  const empty = totalListeners();
  const first = mountNative(env);
  const mounted = totalListeners();
  assert.ok(mounted > empty, 'mount навешивает обработчики');
  first.destroy();
  assert.equal(totalListeners(), empty);
  for (let i = 0; i < 20; i++) {
    const vp = mountNative(env);
    assert.equal(totalListeners(), mounted,
      'после ' + (i + 1) + ' циклов обработчиков столько же, сколько после первого mount');
    vp.destroy();
    assert.equal(totalListeners(), empty, 'после destroy — исходное число');
  }
});

/* --- Статические проверки проводки ------------------------------------------------ */

test('F6.1: index.js подключает viewport.js, без syncSheetToKeyboard в маршруте Harness', () => {
  const source = readFileSync(INDEX_PATH, 'utf8');
  assert.match(source, /mountHarnessViewport/,
    'index.js обязан монтировать единый владелец геометрии');
  assert.doesNotMatch(source, /syncSheetToKeyboard/,
    'дублирующее управление клавиатурой в Harness-маршруте удалено');
  assert.doesNotMatch(source, /Math\.max\(120/,
    'layoutDialog без константного минимума Math.max(120, …)');
});

test('F6.1: обязательный CSS-блок из ТЗ в harness.css, старые 84px убраны', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  assert.match(css, /body\.view-harness\s*\{\s*color-scheme:\s*light;/);
  assert.match(css, /#harness-settings-view\[hidden\],\s*#harness-chat-panel\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(css, /\.harness-chat-panel,\s*\.harness-settings-view\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*\}/);
  assert.match(css, /\.harness-messages\s*\{[^}]*overscroll-behavior:\s*contain[^}]*\}/);
  assert.match(css, /@media \(max-width:\s*700px\)\s*\{[^{]*\{[\s\S]*?var\(--harness-vtop, 0px\)/);
  assert.match(css, /height:\s*var\(--harness-vh, 100dvh\)/);
  assert.match(css, /body\.view-harness\.harness-editing #tab-bar\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(css, /padding:\s*12px 16px var\(--harness-bottom-space, calc\(8px \+ env\(safe-area-inset-bottom, 0px\)\)\)/);
  assert.doesNotMatch(css, /84px/, 'старый резерв 84px заменён механизмом F6.1');
});
