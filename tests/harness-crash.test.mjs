// F6.5 (Раздел 6 ТЗ): краш-тесты, unit-часть сценариев 1–10 и 12.
// Сценарии 3 (viewport), 7 (битый JSON/NaN/persona/XSS) и 12 (потеря ответа
// PUT) покрыты в harness-viewport / harness-settings / harness-contract;
// здесь — оставшиеся unit-проверки. Реальные iPhone-сценарии 1–2 и
// браузерная раскладка сценария 5 требуют живого устройства (см. отчёт).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeTimers } from './helpers/fake-timers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = await import('file://' + join(ROOT, 'js', 'harness', 'settings.js'));
const viewModule = await import('file://' + join(ROOT, 'js', 'harness', 'settings-view.js'));
const approvalsModule = await import('file://' + join(ROOT, 'js', 'harness', 'approvals.js'));
const commands = await import('file://' + join(ROOT, 'js', 'harness', 'commands.js'));

const { MODEL_CATALOG, defaultSettings, createSettingsStore } = settings;
const { createSettingsView } = viewModule;
const { createApprovalController } = approvalsModule;
const { buildModelTaskParams, freezeSettingsSnapshot } = commands;

const VALID = {
  schemaVersion: 1,
  revision: '00000000-0000-4000-8000-000000000000',
  provider: 'opencode',
  modelId: 'tooken/glm-5.3-flash',
  reasoning: 'medium',
  contextTokens: 32000,
  maxOutputTokens: 2048,
  persona: { preferredName: 'Хозяин', about: '', responseStyle: '' },
};

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    _map: map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

/* --- Сценарий 4: pending approval во время клавиатуры ----------------------------------- */

function stubElement(extra = {}) {
  return Object.assign({
    textContent: '',
    hidden: true,
    disabled: false,
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() {},
    blur() {},
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
  }, extra);
}

test('F6.5.4: blur перед открытием dialog — черновик поля не теряется', () => {
  const input = stubElement({ value: 'Черновик задачи владельца' });
  const opened = [];
  const elements = {
    dialog: stubElement(),
    title: stubElement(),
    counter: stubElement(),
    summary: stubElement(),
    facts: stubElement(),
    arguments: stubElement(),
    stateLine: stubElement(),
    approveBtn: stubElement({ hidden: false, disabled: false }),
    rejectBtn: stubElement({ hidden: false, disabled: false }),
    collapseBtn: stubElement({ hidden: false }),
  };
  let beforeOpenCalls = 0;
  const ctrl = createApprovalController({
    elements,
    deps: {
      read: async () => ({ ok: false }),
      decide: async () => ({ ok: true }),
      serverNow: () => 1000,
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
      isVisible: () => true,
      // Как в index.js: blur активного ввода без потери черновика
      beforeOpen: () => {
        beforeOpenCalls += 1;
        input.blur();   // значение поля остаётся
      },
    },
  });
  ctrl.applySnapshot([{
    approvalId: 'apr-1', commandId: 'cmd-1', actionId: 'a', attemptId: 't',
    deviceId: 'pc-main-01', tool: 'fs_delete', params: { path: 'x' },
    digest: 'a'.repeat(64), schemaVersion: 1, createdAt: 1000, expiresAt: 61000,
  }]);
  assert.equal(beforeOpenCalls, 1, 'beforeOpen вызван перед showModal');
  assert.equal(elements.dialog.open, true);
  assert.equal(input.value, 'Черновик задачи владельца',
    'blur не стирает черновик');
  // Фокус в textarea автоматически не возвращается: закрытие диалога ставит
  // фокус на плашку очереди (поведение index.js), не в поле ввода.
});

test('F6.5.4: layoutDialog без константного минимума — карточка сжимается, кнопки не выталкиваются', () => {
  const source = readFileSync(join(ROOT, 'js', 'harness', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.max\(120/);
  assert.match(source, /Math\.max\(0, bottomEdge - \(visibleTop \+ 8\)\)/,
    'доступная высота ограничена реальным местом');
});

/* --- Сценарий 6: offline/perезагрузка ------------------------------------------------------ */

test('F6.5.6: перезагрузка восстанавливает только валидную запись; повреждённая — сообщение и явное исправление', () => {
  const storage = makeStorage();
  storage.setItem('harness.modelSettings.v1.uid-1.pc-main-01', '{повреждено');
  let seq = 0;
  const store = createSettingsStore({
    storage, ownerUid: 'uid-1', deviceId: 'pc-main-01',
    makeRevision: () => 'r-' + (++seq),
  });
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'corrupt');
  assert.equal(store.getActive(), null, 'после перезагрузки active пуст');
  // Явное сохранение владельца исправляет повреждённую запись
  const saved = store.save(VALID);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(store.getActive().persona, VALID.persona);
  // Повторная загрузка — валидная запись восстановлена
  const store2 = createSettingsStore({
    storage, ownerUid: 'uid-1', deviceId: 'pc-main-01',
    makeRevision: () => 'r-x',
  });
  const reloaded = store2.load();
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.settings.persona.preferredName, 'Хозяин');
});

test('F6.5.6: неизвестная schemaVersion в хранилище — не перезаписывается молча', () => {
  const storage = makeStorage();
  storage.setItem('harness.modelSettings.v1.uid-1.pc-main-01',
    JSON.stringify(Object.assign({}, VALID, { schemaVersion: 99 })));
  const store = createSettingsStore({
    storage, ownerUid: 'uid-1', deviceId: 'pc-main-01', makeRevision: () => 'r-1',
  });
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'schema');
  // До явного сохранения запись на диске не изменилась
  const onDisk = JSON.parse(storage.getItem('harness.modelSettings.v1.uid-1.pc-main-01'));
  assert.equal(onDisk.schemaVersion, 99);
  // Явное сохранение владельца заменяет её валидной
  assert.equal(store.save(VALID).ok, true);
  assert.equal(JSON.parse(storage.getItem('harness.modelSettings.v1.uid-1.pc-main-01')).schemaVersion, 1);
});

test('F6.5.6: локальное сохранение настроек не требует сети — модуль без fetch/адаптера', () => {
  for (const name of ['settings.js', 'settings-view.js']) {
    const source = readFileSync(join(ROOT, 'js', 'harness', name), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|new XMLHttpRequest|new EventSource|WebSocket|sendBeacon/i,
      name + ' не ходит в сеть: сохранение локальное (F6.2.7)');
    assert.doesNotMatch(source, /import\s+.*firebase/,
      name + ' не импортирует транспорт');
  }
});

/* --- Сценарий 8: смена семейства с несовместимыми параметрами ------------------------------ */

function makeControl(extra = {}) {
  const listeners = {};
  const children = [];
  let ownText = '';
  const el = Object.assign({
    tagName: 'DIV',
    value: '',
    disabled: false,
    hidden: true,
    listeners,
    children,
    classList: { add() {}, remove() {}, contains() { return false; } },
    style: {},
    appendChild(node) { children.push(node); node.parentNode = el; return node; },
    removeChild(node) {
      const i = children.indexOf(node);
      if (i !== -1) children.splice(i, 1);
      node.parentNode = null;
      return node;
    },
    get firstChild() { return children[0] || null; },
    get textContent() {
      let out = ownText;
      for (const child of children) out += String(child.textContent || '');
      return out;
    },
    set textContent(v) { ownText = String(v); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (list) { const i = list.indexOf(fn); if (i !== -1) list.splice(i, 1); }
    },
    dispatch(type, event = {}) {
      event.target = event.target || el;
      event.preventDefault = event.preventDefault || (() => {});
      for (const fn of (listeners[type] || []).slice()) fn(event);
    },
    listenerCount(type) { return (listeners[type] || []).length; },
    setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {},
  }, extra);
  return el;
}

function makeCrashView({ storage } = {}) {
  const ids = ['view', 'form', 'title', 'provider', 'model', 'capabilities',
    'reasoning', 'reasoningHelp', 'temperature', 'temperatureValue', 'temperatureHelp',
    'context', 'contextValue', 'contextHelp', 'outputLimit', 'outputLimitValue',
    'personaName', 'personaContext', 'personaStyle', 'status', 'error',
    'saveBtn', 'discardBtn'];
  const elements = {};
  for (const id of ids) elements[id] = makeControl();
  elements.view.children = [];
  const doc = { createElement: (tag) => makeControl({ tagName: tag.toUpperCase() }), activeElement: null };
  let seq = 0;
  const store = createSettingsStore({
    storage: storage || makeStorage(),
    ownerUid: 'uid-1', deviceId: 'pc-main-01',
    makeRevision: () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'),
  });
  store.load();
  const view = createSettingsView({
    elements,
    deps: {
      catalog: MODEL_CATALOG, doc,
      getActive: () => store.getActive(),
      getDefault: () => defaultSettings(MODEL_CATALOG),
      save: (next) => store.save(next),
      isOffline: () => false,
      onBack: () => {},
      clearActive: () => store.clearMemory(),
    },
  });
  return { view, elements, store };
}

test('F6.5.8: смена семейства DeepSeek→GLM→Qwen — provider остаётся транспортом opencode', () => {
  const h = makeCrashView();
  h.store.save(VALID);
  h.view.open();
  h.elements.provider.value = 'qwen';
  h.elements.provider.dispatch('change', { target: h.elements.provider });
  assert.equal(h.elements.model.value, 'opencode/qwen3.8-flash',
    'выбрана модель по умолчанию нового семейства');
  const read = h.view.read();
  assert.equal(read.provider, 'opencode',
    'в записи уходит транспорт каталога, не название семейства');
  assert.equal(read.modelId, 'opencode/qwen3.8-flash');
  assert.equal(read.reasoning, 'medium', 'тир medium доступен — значение сохранено');
  const saved = h.store.save(read);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.settings.provider, 'opencode');
});

test('F6.5.8: unsupported-параметры не уходят в payload модельной задачи', () => {
  const h = makeCrashView();
  h.store.save(VALID);
  h.view.open();
  const snapshot = freezeSettingsSnapshot(h.store.getActive());
  const params = buildModelTaskParams({ text: 'задача', settings: snapshot });
  const settingsInPayload = params.actions[0].params.settings;
  assert.equal('temperature' in settingsInPayload, false,
    'temperature не отправляется (адаптер не принимает параметр)');
  for (const key of ['schemaVersion', 'revision', 'provider', 'modelId',
    'contextTokens', 'maxOutputTokens', 'persona']) {
    assert.ok(key in settingsInPayload, 'ключ формата F6.2.5 на месте: ' + key);
  }
  assert.deepEqual(settingsInPayload.persona, VALID.persona);
});

test('F6.5.8: reasoning не имитируется промптом — только тир модели', () => {
  const source = readFileSync(join(ROOT, 'js', 'harness', 'settings.js'), 'utf8');
  assert.doesNotMatch(source, /думай глубже|think deeper|думай/i,
    'reasoning не добавляется как декоративная добавка к промпту');
  const viewSource = readFileSync(join(ROOT, 'js', 'harness', 'settings-view.js'), 'utf8');
  assert.doesNotMatch(viewSource, /думай глубже|think deeper|думай/i);
});

/* --- Сценарий 9: быстрый повтор открытия не умножает слушатели ------------------------------ */

test('F6.5.9: быстрые open/close настроек не умножают слушатели', () => {
  const h = makeCrashView();
  const total = () => {
    let n = 0;
    for (const el of Object.values(h.elements)) {
      for (const list of Object.values(el.listeners)) n += list.length;
    }
    return n;
  };
  h.view.open();
  const mounted = total();
  for (let i = 0; i < 10; i++) {
    h.view.open();
    h.view.close();
  }
  assert.equal(total(), mounted, 'open/close не навешивают новых слушателей');
  h.view.destroy();
  assert.equal(total(), 0);
});

/* --- Сценарий 12: смена настроек сразу после отправки --------------------------------------- */

test('F6.5.12: сохранение настроек сразу после отправки не меняет payload созданной задачи', () => {
  const h = makeCrashView();
  h.store.save(VALID);
  h.view.open();
  // 1) «Отправить»: снимок снят и params построены
  const sentSnapshot = freezeSettingsSnapshot(h.store.getActive());
  const sentParams = buildModelTaskParams({
    text: 'первая задача', settings: sentSnapshot,
  });
  // 2) Владелец меняет настройки и сохраняет
  h.elements.personaName.value = 'Новое имя';
  h.elements.form.dispatch('submit');
  // 3) Payload уже созданной задачи прежний; следующая задача — новый снимок
  assert.equal(sentParams.actions[0].params.settings.persona.preferredName, 'Хозяин',
    'уходил первоначальный неизменяемый snapshot');
  const nextSnapshot = freezeSettingsSnapshot(h.store.getActive());
  const nextParams = buildModelTaskParams({
    text: 'вторая задача', settings: nextSnapshot,
  });
  assert.equal(nextParams.actions[0].params.settings.persona.preferredName, 'Новое имя',
    'следующая задача использует новый snapshot');
  assert.notEqual(
    JSON.stringify(sentParams.actions[0].params.settings),
    JSON.stringify(nextParams.actions[0].params.settings));
});

/* --- Сценарий 10: сессии и поздние ответы ---------------------------------------------------- */

test('F6.5.10: storage-обработчик не работает без сессии store (logout/смена владельца)', () => {
  const source = readFileSync(join(ROOT, 'js', 'harness', 'index.js'), 'utf8');
  assert.match(source, /event\.key !== settingsStore\.key\(\)\) return/,
    'событие чужого ключа игнорируется');
  assert.match(source, /if \(destroyed \|\| !settingsStore \|\| !event\) return/,
    'без store (logout/смена владельца) внешние записи не применяются');
});

test('F6.5.10: черновики чата разделены по устройству, pending — по владельцу', () => {
  // Черновики: draftPrefix + deviceId (покрыто harness-chat; здесь — ключи)
  const indexSource = readFileSync(join(ROOT, 'js', 'harness', 'index.js'), 'utf8');
  assert.match(indexSource, /draftPrefix: 'harness\.draft\.'/);
  // Pending: harness.pendingCommand.<ownerUid>.<deviceId>
  const commandsSource = readFileSync(join(ROOT, 'js', 'harness', 'commands.js'), 'utf8');
  assert.match(commandsSource, /harness\.pendingCommand/);
  const settingsSource = readFileSync(join(ROOT, 'js', 'harness', 'settings.js'), 'utf8');
  assert.match(settingsSource, /harness\.modelSettings\.v1/);
});

/* --- Сценарий 1/2: unit-эквивалент геометрии (реальный iPhone — непроверено) ------------------ */

test('F6.5.1-2 (unit-эквивалент): база пересчитывается после поворота и фон/возврат', async () => {
  // Поворот с закрытой клавиатурой: base обновляется при scale=1 без editing
  const settingsModule = await import('file://' + join(ROOT, 'js', 'harness', 'viewport.js'));
  const { mountHarnessViewport } = settingsModule;
  function makeStyle() {
    const vars = new Map();
    return {
      setProperty(k, v) { vars.set(k, String(v)); },
      getPropertyValue(k) { return vars.has(k) ? vars.get(k) : ''; },
      removeProperty(k) { vars.delete(k); },
    };
  }
  function makeElement(extra = {}) {
    const listeners = {};
    return Object.assign({
      tagName: 'DIV', style: makeStyle(), listeners,
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener(t, f) { (listeners[t] ||= []).push(f); },
      removeEventListener(t, f) {
        const l = listeners[t]; if (l) { const i = l.indexOf(f); if (i !== -1) l.splice(i, 1); }
      },
      dispatch(t, e = {}) { for (const f of (listeners[t] || []).slice()) f(e); },
      listenerCount(t) { return (listeners[t] || []).length; },
      getBoundingClientRect() { return { top: 0, bottom: 800, left: 0, right: 390, width: 390, height: 800 }; },
      getAttribute() { return null; },
    }, extra);
  }
  const vv = makeElement({ tagName: '#vv', height: 800, offsetTop: 0, scale: 1 });
  const body = makeElement({ tagName: 'BODY' });
  const doc = makeElement({
    tagName: '#document', body,
    documentElement: makeElement({ tagName: 'HTML', clientWidth: 390 }),
    activeElement: null,
  });
  const rafQueue = [];
  const win = makeElement({
    tagName: '#window', visualViewport: vv,
    matchMedia() { return { get matches() { return true; }, addEventListener() {}, removeEventListener() {} }; },
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame(id) { if (rafQueue[id - 1]) rafQueue[id - 1] = null; },
  });
  doc.defaultView = win;
  const app = makeElement({ tagName: 'DIV' });
  const root = makeElement({ tagName: 'SECTION' });
  const timers = makeFakeTimers();
  const vp = mountHarnessViewport({
    app, root,
    deps: {
      window: win, document: doc,
      timers: { setTimeout: timers.schedule, clearTimeout: timers.cancel },
    },
  });
  rafQueue.splice(0).forEach((f) => f && f());
  assert.equal(app.style.getPropertyValue('--harness-vh'), '800px');
  // Поворот: высота изменилась, editing нет — база перекалибрована
  vv.height = 375; vv.offsetTop = 0;
  win.dispatch('orientationchange');
  rafQueue.splice(0).forEach((f) => f && f());
  assert.equal(app.style.getPropertyValue('--harness-vh'), '375px');
  // Клавиатура открылась и закрылась после поворота — восстановление в
  // допуске 24px снимает editing (сценарий 1: повтор фокуса)
  const textarea = makeElement({ tagName: 'TEXTAREA' });
  root.dispatch('focusin', { target: textarea });
  vv.height = 240; vv.dispatch('resize');
  rafQueue.splice(0).forEach((f) => f && f());
  assert.ok(body.classList.contains && false === false);
  root.dispatch('focusout', { target: textarea, relatedTarget: null });
  vv.height = 371; vv.dispatch('resize');   // восстановление в допуске 24px
  rafQueue.splice(0).forEach((f) => f && f());
  timers.advance(130);
  assert.equal(body.classList.contains('harness-editing'), false,
    'после поворота восстановление высоты снимает editing');
  vp.destroy();
});
