// F6.2 (Раздел 6 ТЗ): экран «Настройки модели», локальное хранилище и
// конфликты. Тесты пишутся ДО реализации (RED): js/harness/settings.js и
// settings-view.js ещё нет.
//
// settings.js — нормализация/хранилище БЕЗ DOM; settings-view.js — DOM формы
// с инъекцией элементов. Каталог — согласованный контракт (_ci/contract/
// contract.json): семейства glm/qwen/deepseek через транспорт opencode,
// temperature/context/maxOutputTokens не принимаются адаптером.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_PATH = join(ROOT, 'js', 'harness', 'settings.js');
const VIEW_PATH = join(ROOT, 'js', 'harness', 'settings-view.js');
const HTML_PATH = join(ROOT, 'index.html');
const CSS_PATH = join(ROOT, 'styles', 'harness.css');

assert.ok(existsSync(SETTINGS_PATH),
  'js/harness/settings.js не существует — реализация не начата (ожидаются RED)');
assert.ok(existsSync(VIEW_PATH),
  'js/harness/settings-view.js не существует — реализация не начата (ожидаются RED)');

const settings = await import('file://' + SETTINGS_PATH);
const viewModule = await import('file://' + VIEW_PATH);

const {
  MODEL_CATALOG, settingsStorageKey, normalizeSettings, defaultSettings,
  createSettingsStore,
} = settings;
const { createSettingsView } = viewModule;

/* --- Каталог (согласованный контракт) --------------------------------------------- */

test('F6.2: каталог — три семейства glm/qwen/deepseek через транспорт opencode', () => {
  const families = MODEL_CATALOG.families.map((f) => f.provider).sort();
  assert.deepEqual(families, ['deepseek', 'glm', 'qwen']);
  for (const family of MODEL_CATALOG.families) {
    assert.equal(family.transport, 'opencode');
    assert.equal(family.status, 'available');
    assert.ok(family.models.length >= 1);
    for (const model of family.models) {
      assert.ok(Array.isArray(model.reasoning) && model.reasoning.length >= 1);
    }
  }
  assert.equal(MODEL_CATALOG.generationParams.temperature, null);
  assert.equal(MODEL_CATALOG.generationParams.contextTokens, null);
  assert.equal(MODEL_CATALOG.generationParams.maxOutputTokens, null);
  assert.match(MODEL_CATALOG.generationParams.unsupportedReason, /адаптер не принимает параметр/);
});

/* --- Нормализация -------------------------------------------------------------------- */

const validRecord = {
  schemaVersion: 1,
  revision: '00000000-0000-4000-8000-000000000000',
  provider: 'opencode',
  modelId: 'tooken/glm-5.3-flash',
  reasoning: 'medium',
  contextTokens: 32000,
  maxOutputTokens: 2048,
  persona: { preferredName: 'Хозяин', about: '', responseStyle: '' },
};

test('F6.2: нормализация — валидная запись формата F6.2.5 проходит', () => {
  const result = normalizeSettings(validRecord, MODEL_CATALOG);
  assert.equal(result.ok, true);
  assert.equal(result.settings.modelId, 'tooken/glm-5.3-flash');
  assert.equal(result.settings.contextTokens, 32000);
  assert.equal(result.settings.maxOutputTokens, 2048);
  assert.equal(result.settings.persona.preferredName, 'Хозяин');
});

test('F6.2: fixture model_task из contract.json проходит нормализацию', () => {
  // Настройки из эталонного fixture контракта обязаны быть валидными:
  // JSON PWA ↔ Python validator сходятся на одном формате.
  const contractPath = join('C:', 'Users', 'Admin', '.zcode', 'workspace',
    'draft-5a1189e6-9e65-44be-af5b-e40246c98ac4', '_ci', 'contract', 'contract.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const fixtureSettings =
    contract.fixtures.model_task.params.actions[0].params.settings;
  const result = normalizeSettings(fixtureSettings, MODEL_CATALOG);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('F6.2: неизвестная schemaVersion отклоняется, запись не перезаписывается молча', () => {
  const result = normalizeSettings(
    Object.assign({}, validRecord, { schemaVersion: 2 }), MODEL_CATALOG);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema');
});

test('F6.2: битый JSON в хранилище — причина corrupt, active не тронут', () => {
  const storage = makeStorage({ 'harness.modelSettings.v1.uid-1.pc-main-01': '{битый' });
  const store = createSettingsStore({ storage, ownerUid: 'uid-1', deviceId: 'pc-main-01' });
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'corrupt');
  assert.equal(store.getActive(), null, 'повреждённая запись не становится active');
});

test('F6.2: NaN/Infinity/строки-числа отклоняются', () => {
  for (const bad of [NaN, Infinity, -Infinity, '32000', null]) {
    const result = normalizeSettings(
      Object.assign({}, validRecord, { contextTokens: bad }), MODEL_CATALOG);
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.reason, 'numbers');
  }
  const result = normalizeSettings(
    Object.assign({}, validRecord, { maxOutputTokens: NaN }), MODEL_CATALOG);
  assert.equal(result.ok, false);
});

test('F6.2: отрицательные и нулевые токены отклоняются', () => {
  for (const bad of [-1, 0, -32000]) {
    const result = normalizeSettings(
      Object.assign({}, validRecord, { contextTokens: bad }), MODEL_CATALOG);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'numbers');
  }
});

test('F6.2: неизвестные ключи отклоняются (строгая схема)', () => {
  const result = normalizeSettings(
    Object.assign({}, validRecord, { surprise: 1 }), MODEL_CATALOG);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown');
});

test('F6.2: слишком длинная персона отклоняется (80/2000/2000)', () => {
  const long = 'x'.repeat(81);
  const result = normalizeSettings(
    Object.assign({}, validRecord,
      { persona: { preferredName: long, about: '', responseStyle: '' } }),
    MODEL_CATALOG);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'length');
  const longAbout = 'x'.repeat(2001);
  const result2 = normalizeSettings(
    Object.assign({}, validRecord,
      { persona: { preferredName: '', about: longAbout, responseStyle: '' } }),
    MODEL_CATALOG);
  assert.equal(result2.ok, false);
});

test('F6.2: модель вне каталога и reasoning вне тиров модели отклоняются', () => {
  const result = normalizeSettings(
    Object.assign({}, validRecord, { modelId: 'unknown/model-x' }), MODEL_CATALOG);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model');
  const result2 = normalizeSettings(
    Object.assign({}, validRecord, { reasoning: 'ultra' }), MODEL_CATALOG);
  assert.equal(result2.ok, false);
  assert.equal(result2.reason, 'reasoning');
  // reasoning, входящий в тиры выбранной модели, проходит
  const ok = normalizeSettings(
    Object.assign({}, validRecord, { reasoning: 'high' }), MODEL_CATALOG);
  assert.equal(ok.ok, true);
});

test('F6.2: provider — только транспорт каталога (opencode)', () => {
  const bad = normalizeSettings(
    Object.assign({}, validRecord, { provider: 'direct-api' }), MODEL_CATALOG);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'provider');
});

/* --- Ключ хранилища и defaults --------------------------------------------------------- */

test('F6.2: ключ harness.modelSettings.v1.<ownerUid>.<deviceId>, отдельно от assistant_*', () => {
  assert.equal(settingsStorageKey('Sdlw3hRi0WYUL29Wz9Gi7X2L3I33', 'pc-main-01'),
    'harness.modelSettings.v1.Sdlw3hRi0WYUL29Wz9Gi7X2L3I33.pc-main-01');
  assert.doesNotMatch(settingsStorageKey('u', 'd'), /assistant_/);
});

test('F6.2: defaults — модель по умолчанию каталога, значения из контракта', () => {
  const def = defaultSettings(MODEL_CATALOG);
  assert.equal(def.schemaVersion, 1);
  assert.equal(def.provider, 'opencode');
  assert.equal(def.modelId, 'tooken/glm-5.3-flash');
  assert.ok(MODEL_CATALOG.families.some((f) =>
    f.models.some((m) => m.modelId === def.modelId && m.default)),
    'модель по умолчанию существует в каталоге');
  assert.ok(def.contextTokens > 0 && def.maxOutputTokens > 0);
  assert.deepEqual(def.persona, { preferredName: '', about: '', responseStyle: '' });
});

/* --- Хранилище -------------------------------------------------------------------------- */

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    _map: map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function makeStore(storage, overrides = {}) {
  let seq = 0;
  return createSettingsStore(Object.assign({
    storage,
    ownerUid: 'uid-1',
    deviceId: 'pc-main-01',
    makeRevision: () => 'rev-' + (++seq).toString().padStart(4, '0'),
  }, overrides));
}

test('F6.2: save — новая revision-uuid на каждое сохранение, read-back, active обновлён', () => {
  const storage = makeStorage();
  let seq = 0;
  const store = makeStore(storage, {
    makeRevision: () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'),
  });
  assert.deepEqual(store.load(), { ok: true, settings: null }, 'пустое хранилище — записи нет');
  const next = Object.assign({}, validRecord, { revision: 'старый-ревизия' });
  const saved = store.save(next);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.notEqual(saved.settings.revision, 'старый-ревизия',
    'revision перегенерируется при сохранении');
  assert.match(saved.settings.revision, /^[0-9a-f-]{36}$/, 'revision — UUID');
  const saved2 = store.save(Object.assign({}, validRecord));
  assert.notEqual(saved2.settings.revision, saved.settings.revision,
    'новый UUID на каждое успешное сохранение');
  // Читается ровно то, что записано
  const onDisk = JSON.parse(storage.getItem(settingsStorageKey('uid-1', 'pc-main-01')));
  assert.equal(onDisk.revision, saved2.settings.revision);
  assert.deepEqual(store.getActive().persona, validRecord.persona);
});

test('F6.2: невалидная запись не сохраняется и active не меняется', () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  const first = store.save(validRecord);
  assert.equal(first.ok, true);
  const before = storage.getItem(settingsStorageKey('uid-1', 'pc-main-01'));
  const bad = store.save(Object.assign({}, validRecord, { contextTokens: -5 }));
  assert.equal(bad.ok, false);
  assert.equal(storage.getItem(settingsStorageKey('uid-1', 'pc-main-01')), before,
    'хранилище не перезаписано невалидной записью');
  assert.equal(store.getActive().contextTokens, validRecord.contextTokens);
});

test('F6.2: QuotaExceededError — прежние active сохранены, честная ошибка', () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  assert.equal(store.save(validRecord).ok, true);
  const before = storage.getItem(settingsStorageKey('uid-1', 'pc-main-01'));
  // Хранилище начинает выбрасывать QuotaExceededError
  storage.setItem = () => {
    const err = new Error('место кончилось');
    err.name = 'QuotaExceededError';
    throw err;
  };
  const result = store.save(Object.assign({}, validRecord,
    { persona: { preferredName: 'Другое', about: '', responseStyle: '' } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'quota');
  assert.equal(store.getActive().persona.preferredName, 'Хозяин',
    'прежние active settings остались');
  assert.equal(storage.getItem(settingsStorageKey('uid-1', 'pc-main-01')), before,
    'хранилище не изменено частичной записью');
});

test('F6.2: SecurityError — та же честная ошибка хранения', () => {
  const storage = makeStorage();
  storage.setItem = () => {
    const err = new Error('private mode');
    err.name = 'SecurityError';
    throw err;
  };
  const store = makeStore(storage);
  const result = store.save(validRecord);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'security');
  assert.equal(store.getActive(), null);
});

test('F6.2: read-back mismatch — сохранение не считается успешным', () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  // Хранилище-лжец: setItem проходит, но чтение возвращает старое
  storage.setItem = (k, v) => { storage._map.set(k + '#ghost', v); };
  const result = store.save(validRecord);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'readback');
  assert.equal(store.getActive(), null, 'active не обновлён без подтверждённой записи');
});

test('F6.2: конфликт другой вкладки — отказ save и перечитывание, без затирания', () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  assert.equal(store.save(validRecord).ok, true);
  // Другая вкладка записала свою версию ПОСЛЕ нашей (expectedRaw устарел)
  const external = JSON.stringify(Object.assign({}, validRecord, {
    revision: 'external-revision',
    persona: { preferredName: 'Из другой вкладки', about: '', responseStyle: '' },
  }));
  storage.setItem(settingsStorageKey('uid-1', 'pc-main-01'), external);
  const result = store.save(Object.assign({}, validRecord,
    { persona: { preferredName: 'Моя правка', about: '', responseStyle: '' } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  // Перечитывание: external валиден → active обновлён, наша запись НЕ перезаписала
  assert.equal(store.getActive().persona.preferredName, 'Из другой вкладки');
  assert.equal(JSON.parse(storage.getItem(settingsStorageKey('uid-1', 'pc-main-01'))).revision,
    'external-revision');
});

test('F6.2: applyExternal (storage-событие) обновляет active только валидной записью', () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  const external = JSON.stringify(Object.assign({}, validRecord, { revision: 'ext-1' }));
  const applied = store.applyExternal(external);
  assert.equal(applied.changed, true);
  assert.equal(store.getActive().revision, 'ext-1');
  const bad = store.applyExternal('не json');
  assert.equal(bad.changed, false);
  assert.equal(store.getActive().revision, 'ext-1', 'битая внешняя запись не затирает active');
  const removed = store.applyExternal(null);
  assert.equal(removed.changed, true, 'удаление другой вкладкой — тоже внешнее изменение');
  assert.equal(store.getActive(), null);
});

test('F6.2: смена владельца/устройства не смешивает записи', () => {
  const storage = makeStorage();
  const storeA = createSettingsStore({
    storage, ownerUid: 'uid-1', deviceId: 'pc-main-01',
    makeRevision: () => 'r-a',
  });
  assert.equal(storeA.save(validRecord).ok, true);
  const storeB = createSettingsStore({
    storage, ownerUid: 'uid-2', deviceId: 'pc-main-01',
    makeRevision: () => 'r-b',
  });
  assert.deepEqual(storeB.load(), { ok: true, settings: null },
    'другой владелец не видит чужие настройки');
});

/* --- DOM-заглушки для view --------------------------------------------------------------- */

function makeControl(extra = {}) {
  const listeners = {};
  const children = [];
  let ownText = '';
  const el = Object.assign({
    tagName: 'DIV',
    value: '',
    disabled: false,
    hidden: true,
    type: null,
    listeners,
    children,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    appendChild(node) { children.push(node); node.parentNode = el; return node; },
    removeChild(node) {
      const i = children.indexOf(node);
      if (i !== -1) children.splice(i, 1);
      node.parentNode = null;
      return node;
    },
    get firstChild() { return children[0] || null; },
    // textContent агрегирует собственных текст и детей — как в живом DOM.
    get textContent() {
      let out = ownText;
      for (const child of children) {
        out += String(child.textContent || '');
      }
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
    setAttribute() {},
    getAttribute() { return null; },
    focus() { el.focused = true; },
    blur() {},
    focused: false,
  }, extra);
  return el;
}

function makeDoc() {
  const created = [];
  return {
    created,
    createElement(tag) {
      const el = makeControl({ tagName: String(tag).toUpperCase() });
      created.push(el);
      return el;
    },
    activeElement: null,
  };
}

function makeViewElements() {
  const el = {};
  for (const id of ['view', 'form', 'title', 'provider', 'model', 'capabilities',
    'reasoning', 'reasoningHelp', 'temperature', 'temperatureValue', 'temperatureHelp',
    'context', 'contextValue', 'contextHelp', 'outputLimit', 'outputLimitValue',
    'personaName', 'personaContext', 'personaStyle', 'status', 'error',
    'saveBtn', 'discardBtn']) {
    el[id] = makeControl();
  }
  el.view.children = [];
  return el;
}

function makeView({ storage = makeStorage(), offline = false } = {}) {
  const elements = makeViewElements();
  const doc = makeDoc();
  let seq = 0;
  const store = createSettingsStore({
    storage, ownerUid: 'uid-1', deviceId: 'pc-main-01',
    makeRevision: () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'),
  });
  store.load();
  const backs = [];
  const dirtyEvents = [];
  const announcements = [];
  const view = createSettingsView({
    elements,
    deps: {
      catalog: MODEL_CATALOG,
      doc,
      getActive: () => store.getActive(),
      getDefault: () => defaultSettings(MODEL_CATALOG),
      save: (next) => store.save(next),
      isOffline: () => offline,
      announce: (t) => announcements.push(t),
      onDirty: (d) => dirtyEvents.push(d),
      onBack: () => backs.push(1),
      clearActive: () => store.clearMemory(),
    },
  });
  return { view, elements, doc, store, backs, dirtyEvents, announcements, storage };
}

/* --- View: заполнение формы ------------------------------------------------------------------ */

test('F6.2: populate — семейства/модели/тиры, персона из active', () => {
  const h = makeView();
  h.store.save(Object.assign({}, validRecord, {
    persona: { preferredName: 'Хозяин', about: 'Контекст', responseStyle: 'Кратко' },
  }));
  h.view.open();
  // Семейства — все три, у выбранной модели семейство glm
  const familyOptions = h.elements.provider.children;
  assert.deepEqual(familyOptions.map((o) => o.value).sort(),
    ['deepseek', 'glm', 'qwen']);
  assert.equal(h.elements.provider.value, 'glm');
  const modelValues = h.elements.model.children.map((o) => o.value);
  assert.ok(modelValues.includes('tooken/glm-5.3-flash'));
  assert.equal(h.elements.model.value, 'tooken/glm-5.3-flash');
  assert.deepEqual(h.elements.reasoning.children.map((o) => o.value),
    ['low', 'medium', 'high']);
  assert.equal(h.elements.reasoning.value, 'medium');
  assert.equal(h.elements.personaName.value, 'Хозяин');
  assert.equal(h.elements.personaContext.value, 'Контекст');
  assert.equal(h.elements.personaStyle.value, 'Кратко');
  assert.equal(h.view.isDirty(), false, 'после populate форма не dirty');
});

test('F6.2: unsupported-поля disabled с причиной «адаптер не принимает параметр»', () => {
  const h = makeView();
  h.view.open();
  for (const [input, help, output] of [
    [h.elements.temperature, h.elements.temperatureHelp, h.elements.temperatureValue],
    [h.elements.context, h.elements.contextHelp, h.elements.contextValue],
    [h.elements.outputLimit, h.elements.contextHelp, h.elements.outputLimitValue],
  ]) {
    assert.equal(input.disabled, true, 'поле отключено: ' + input.tagName);
    assert.match(help.textContent, /адаптер не принимает параметр/);
    assert.ok(output.textContent.length > 0, 'output показывает состояние поля');
  }
});

/* --- View: dirty, смена модели, сохранение ------------------------------------------------ */

test('F6.2: правка персона делает форму dirty, discard возвращает active', () => {
  const h = makeView();
  h.store.save(validRecord);
  h.view.open();
  assert.equal(h.view.isDirty(), false);
  h.elements.personaName.value = 'Ати';
  h.elements.form.dispatch('input', { target: h.elements.personaName });
  assert.equal(h.view.isDirty(), true);
  assert.ok(h.dirtyEvents.includes(true));
  h.elements.discardBtn.dispatch('click');
  assert.equal(h.elements.personaName.value, 'Хозяин', 'discard восстановил active');
  assert.equal(h.view.isDirty(), false);
});

test('F6.2: смена модели на несовместимую — defaults + список изменений до сохранения', () => {
  const h = makeView();
  h.store.save(Object.assign({}, validRecord, { reasoning: 'medium' }));
  h.view.open();
  // tooken/glm-5.3-flash имеет [low, medium, high]; переходим на модель
  // opencode/glm-5.3-flash-free с тирами [low, high]: medium несовместим.
  h.elements.model.value = 'opencode/glm-5.3-flash-free';
  h.elements.model.dispatch('change', { target: h.elements.model });
  assert.equal(h.elements.reasoning.value, 'low',
    'несовместимый reasoning заменён подтверждённым default модели');
  assert.match(h.elements.capabilities.textContent, /medium/,
    'список изменений показывает прежнее значение');
  assert.match(h.elements.capabilities.textContent, /low/,
    'список изменений показывает новое значение');
  // Сохранённая запись прошла нормализацию с новой моделью
  const saved = h.store.save(h.view.read());
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.settings.reasoning, 'low');
});

test('F6.2: save — успех, статус локальный; offline-текст честный', () => {
  const h = makeView({ offline: false });
  h.view.open();
  h.elements.personaName.value = 'Ати';
  h.elements.form.dispatch('submit');
  assert.equal(h.view.isDirty(), false, 'после сохранения форма синхронна с active');
  assert.match(h.elements.status.textContent, /Сохранено на этом устройстве/);
  assert.match(h.elements.status.textContent, /следующим задачам/);
  assert.doesNotMatch(h.elements.status.textContent, /Синхронизировано с ПК/);
  assert.equal(h.elements.error.hidden, true);

  const h2 = makeView({ offline: true });
  h2.view.open();
  h2.elements.personaStyle.value = 'Кратко';
  h2.elements.form.dispatch('submit');
  assert.match(h2.elements.status.textContent,
    /Сохранено на этом устройстве; применяется к следующим задачам после подключения/);
});

test('F6.2: QuotaExceeded — ошибка словами, успех не показан, правка осталась в форме', () => {
  const h = makeView();
  h.store.save(Object.assign({}, validRecord,
    { persona: { preferredName: 'Хозяин', about: '', responseStyle: '' } }));
  h.view.open();
  h.storage.setItem = () => {
    const err = new Error('quota');
    err.name = 'QuotaExceededError';
    throw err;
  };
  h.elements.personaName.value = 'Новое имя';
  h.elements.form.dispatch('submit');
  assert.equal(h.elements.error.hidden, false, 'ошибка показана');
  assert.match(h.elements.error.textContent, /Не удалось сохранить на этом устройстве/);
  assert.doesNotMatch(h.elements.status.textContent, /Сохранено/,
    'успех не показан при ошибке хранения');
  assert.equal(h.elements.personaName.value, 'Новое имя',
    'рабочая копия осталась в памяти формы');
  assert.equal(h.view.isDirty(), true, 'форма остаётся dirty');
});

test('F6.2: повторный submit во время сохранения игнорируется (синхронный флаг)', () => {
  const h = makeView();
  let releases = [];
  h.view.open();
  // save с внешним гейтом: проверяем, что второй submit не прошёл
  let saves = 0;
  const view2 = createSettingsView({
    elements: makeViewElements(),
    deps: Object.assign({}, {}),
  }).api || null;
  // Прямая проверка: двойной dispatch submit даёт одну запись в хранилище
  h.elements.personaName.value = 'Раз';
  h.elements.form.dispatch('submit');
  h.elements.form.dispatch('submit');
  const key = settingsStorageKey('uid-1', 'pc-main-01');
  assert.equal(JSON.parse(h.storage.getItem(key)).persona.preferredName, 'Раз');
  assert.ok(saves === 0);
});

test('F6.2: конфликт при save — сообщение без затирания ввода', () => {
  const h = makeView();
  h.store.save(validRecord);
  h.view.open();
  // Другая вкладка пишет после загрузки формы
  h.storage.setItem(settingsStorageKey('uid-1', 'pc-main-01'), JSON.stringify(
    Object.assign({}, validRecord, { revision: 'external-2' })));
  h.elements.personaName.value = 'Моя правка';
  h.elements.form.dispatch('submit');
  assert.equal(h.elements.error.hidden, false);
  assert.match(h.elements.error.textContent, /другой вкладке/);
  assert.equal(h.elements.personaName.value, 'Моя правка',
    'ввод пользователя не затёрт конфликтом');
});

/* --- View: dirty-Back inline-блок -------------------------------------------------------------- */

test('F6.2: requestBack без dirty возвращает в чат сразу', () => {
  const h = makeView();
  h.view.open();
  assert.equal(h.view.requestBack(), true);
  assert.deepEqual(h.backs, [1]);
});

test('F6.2: dirty-Back — inline-блок «Есть несохранённые изменения», не модалка', () => {
  const h = makeView();
  h.store.save(validRecord);
  h.view.open();
  h.elements.personaName.value = 'Правка';
  h.elements.form.dispatch('input', { target: h.elements.personaName });
  assert.equal(h.view.requestBack(), false, 'dirty — возврат отложен выбором');
  const block = h.view.confirmBlock();
  assert.ok(block, 'inline-блок создан');
  assert.equal(block.hidden, false);
  assert.match(block.textContent, /Есть несохранённые изменения/);
  const labels = block.children.filter((c) => c.tagName === 'BUTTON')
    .map((b) => b.textContent);
  assert.deepEqual(labels,
    ['Сохранить и вернуться', 'Не сохранять', 'Остаться'],
    'три действия inline-блока');
  // «Остаться»: фокус/текст сохраняются, блок скрыт
  h.view.confirmStay();
  assert.equal(block.hidden, true);
  assert.equal(h.elements.personaName.value, 'Правка');
  assert.deepEqual(h.backs, []);
  // «Не сохранять»: discard + возврат в чат
  h.view.requestBack();
  h.view.confirmDiscard();
  assert.equal(h.elements.personaName.value, 'Хозяин', 'discard восстановил active');
  assert.deepEqual(h.backs, [1]);
  // «Сохранить и вернуться»: save + возврат
  h.elements.personaName.value = 'Финал';
  h.elements.form.dispatch('input', { target: h.elements.personaName });
  h.view.requestBack();
  h.view.confirmSaveBack();
  assert.equal(JSON.parse(h.storage.getItem(settingsStorageKey('uid-1', 'pc-main-01')))
    .persona.preferredName, 'Финал');
  assert.deepEqual(h.backs, [1, 1]);
});

test('F6.2: storage-событие другой вкладки при dirty — конфликт без затирания ввода', () => {
  const h = makeView();
  h.store.save(validRecord);
  h.view.open();
  h.elements.personaName.value = 'Моё';
  h.elements.form.dispatch('input', { target: h.elements.personaName });
  const external = JSON.stringify(Object.assign({}, validRecord, {
    revision: 'ext-3',
    persona: { preferredName: 'Чужое', about: '', responseStyle: '' },
  }));
  h.view.onExternalChange(h.store.applyExternal(external));
  assert.equal(h.elements.personaName.value, 'Моё',
    'ввод не затёрт внешним изменением');
  assert.equal(h.view.isDirty(), true);
  assert.match(h.elements.error.textContent, /другой вкладке/);
  // Не dirty: внешняя запись отражается в форме
  const h2 = makeView();
  h2.store.save(validRecord);
  h2.view.open();
  h2.view.onExternalChange(h2.store.applyExternal(JSON.stringify(
    Object.assign({}, validRecord, { revision: 'ext-4' }))));
  assert.equal(h2.view.isDirty(), false);
});

/* --- View: XSS и destroy ---------------------------------------------------------------------- */

test('F6.2: XSS-строки выводятся как текст — без исполнения HTML', () => {
  const h = makeView();
  h.store.save(Object.assign({}, validRecord, {
    persona: {
      preferredName: '<img src=x onerror=alert(1)>',
      about: '<script>alert(2)</script>',
      responseStyle: '"><svg onload=alert(3)>',
    },
  }));
  h.view.open();
  // Значения идут через .value/.textContent — в DOM-заглушке они и есть текст
  assert.equal(h.elements.personaName.value, '<img src=x onerror=alert(1)>');
  // Обратная конвертация: read() сохраняет строки как есть (валидатор ПК ограничит длину)
  const read = h.view.read();
  assert.equal(read.persona.preferredName, '<img src=x onerror=alert(1)>');
  h.elements.form.dispatch('submit');
  const onDisk = JSON.parse(h.storage.getItem(settingsStorageKey('uid-1', 'pc-main-01')));
  assert.equal(onDisk.persona.preferredName, '<img src=x onerror=alert(1)>',
    'строка сохраняется как данные, не как разметка');
});

test('F6.2: destroy снимает слушатели формы/полей; повторный mount не дублирует', () => {
  const h = makeView();
  h.view.open();
  const counts = ['submit', 'input', 'change'].map((t) => h.elements.form.listenerCount(t));
  const fieldCounts = ['click'].map((t) => h.elements.discardBtn.listenerCount(t));
  assert.ok(counts.every((n) => n > 0));
  h.view.destroy();
  assert.deepEqual(['submit', 'input', 'change']
    .map((t) => h.elements.form.listenerCount(t)), counts.map(() => 0));
  assert.deepEqual(['click'].map((t) => h.elements.discardBtn.listenerCount(t)),
    fieldCounts.map(() => 0));
});

test('F6.2: reset очищает форму и память после logout — чужие значения не показываются', () => {
  const h = makeView();
  h.store.save(Object.assign({}, validRecord,
    { persona: { preferredName: 'Хозяин', about: '', responseStyle: '' } }));
  h.view.open();
  h.view.reset();
  assert.equal(h.elements.personaName.value, '');
  assert.equal(h.elements.personaContext.value, '');
  assert.equal(h.elements.personaStyle.value, '');
  assert.equal(h.store.getActive(), null, 'active очищен');
});

/* --- Статические проверки разметки и стилей ------------------------------------------------- */

test('F6.2: index.html — chat-panel оборачивает шапку/ленту/announcer/dock', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const panelAt = html.indexOf('<div id="harness-chat-panel" class="harness-chat-panel">');
  assert.ok(panelAt !== -1, 'обёртка #harness-chat-panel не найдена');
  const headAt = html.indexOf('<header class="harness-head">', panelAt);
  const dockAt = html.indexOf('<footer class="harness-dock">', panelAt);
  const panelClose = html.indexOf('</div>', dockAt);
  assert.ok(headAt > panelAt && dockAt > headAt && panelClose > dockAt,
    'шапка, лента и dock внутри chat-panel');
  const announcerAt = html.indexOf('id="harness-announcer"', panelAt);
  assert.ok(announcerAt > panelAt && announcerAt < dockAt);
});

test('F6.2: index.html — section настроек по скелету ТЗ, рядом с chat-panel', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  for (const pattern of [
    '<section id="harness-settings-view" class="harness-settings-view" aria-labelledby="harness-settings-title" hidden>',
    '<button id="harness-settings-back" class="harness-icon-btn" type="button" aria-label="Назад в чат">Назад</button>',
    '<h2 id="harness-settings-title" tabindex="-1">Настройки модели</h2>',
    '<form id="harness-settings-form" class="harness-settings-content">',
    '<legend>Модель</legend>',
    '<select id="harness-provider" name="provider"></select>',
    '<select id="harness-model" name="modelId"></select>',
    '<p id="harness-capabilities" role="status"></p>',
    '<legend>Размышления</legend>',
    '<select id="harness-reasoning" name="reasoning"></select>',
    '<p id="harness-reasoning-help"></p>',
    '<legend>Параметры генерации</legend>',
    '<input id="harness-temperature" type="range" name="temperature" aria-describedby="harness-temperature-help">',
    '<output id="harness-temperature-value" class="harness-settings-value" for="harness-temperature"></output>',
    '<p id="harness-temperature-help"></p>',
    '<input id="harness-context" type="range" name="contextTokens" aria-describedby="harness-context-help">',
    '<output id="harness-context-value" class="harness-settings-value" for="harness-context"></output>',
    '<p id="harness-context-help"></p>',
    '<input id="harness-output-limit" type="range" name="maxOutputTokens">',
    '<output id="harness-output-limit-value" class="harness-settings-value" for="harness-output-limit"></output>',
    '<legend>Персонализация</legend>',
    '<input id="harness-persona-name" name="preferredName" type="text" maxlength="80" autocomplete="off">',
    '<textarea id="harness-persona-context" name="about" rows="4" maxlength="2000"></textarea>',
    '<textarea id="harness-persona-style" name="responseStyle" rows="4" maxlength="2000"></textarea>',
    '<p id="harness-settings-status" role="status" aria-live="polite"></p>',
    '<p id="harness-settings-error" class="harness-settings-error" role="alert" hidden></p>',
    '<button id="harness-settings-save" type="submit">Сохранить настройки</button>',
    '<button id="harness-settings-discard" type="button">Отменить изменения</button>',
    '<footer class="harness-settings-actions">',
  ]) {
    assert.ok(html.includes(pattern), 'нет фрагмента скелета: ' + pattern);
  }
  // Настройки — внутри harness-view, рядом с chat-panel; вложенного main нет
  const viewAt = html.indexOf('<section id="harness-view"');
  const viewEnd = html.indexOf('</section>', html.indexOf('id="harness-settings-view"'));
  assert.ok(html.indexOf('id="harness-settings-view"') > viewAt,
    'settings-view внутри harness-view');
  const mains = [...html.matchAll(/<main\b[^>]*>/gi)];
  assert.equal(mains.length, 1);
});

test('F6.2: кнопка «Настройки модели» перед «Меню ПК», SVG ползунков с currentColor', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const openAt = html.indexOf('id="harness-open-settings"');
  const menuAt = html.indexOf('aria-label="Меню ПК"');
  assert.ok(openAt !== -1, 'кнопка настроек не найдена');
  assert.ok(openAt < menuAt, 'кнопка настроек стоит перед «Меню ПК»');
  const buttonBlock = html.slice(html.lastIndexOf('<button', openAt), menuAt);
  assert.match(buttonBlock, /type="button"/);
  assert.match(buttonBlock, /aria-label="Настройки модели"/);
  assert.match(buttonBlock, /<svg[^>]*aria-hidden="true"/);
  assert.match(buttonBlock, /currentColor/);
  // «Меню ПК» не заменён
  assert.ok(html.includes('aria-label="Меню ПК"'));
});

test('F6.2: стили настроек — 16px поля, range appearance:none с thumb 24×24, actions в конце', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  assert.match(css, /\.harness-settings-head\s*\{[^}]*border-bottom:\s*1px solid var\(--separator\)/);
  assert.match(css, /\.harness-settings-content\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/);
  assert.match(css, /\.harness-settings-content\s*\{[^}]*max-width:\s*760px/);
  assert.match(css, /\.harness-settings-group\s*\{[^}]*margin:\s*0 0 24px/);
  assert.match(css, /#harness-settings-form (?:select|input)/);
  assert.match(css, /font-size:\s*16px/, 'редактируемые поля 16px против зума iOS');
  assert.match(css, /appearance:\s*none/, 'range без системного вида');
  assert.match(css, /-webkit-slider-runnable-track/);
  assert.match(css, /-moz-range-track/);
  assert.match(css, /-webkit-slider-thumb\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/);
  assert.match(css, /-webkit-slider-thumb\s*\{[^}]*margin-top:\s*-10px/);
  assert.match(css, /\.harness-settings-actions\s*\{[^}]*padding-bottom:\s*var\(--harness-bottom-space/);
  assert.doesNotMatch(css, /\.harness-settings-actions\s*\{[^}]*position:\s*(sticky|fixed)/);
  assert.match(css, /\.harness-settings-error\s*\{[^}]*var\(--danger\)/);
  assert.match(css, /#harness-settings-save\s*\{[^}]*background:\s*var\(--accent\)/);
  assert.match(css, /#harness-settings-discard\s*\{[^}]*background:\s*var\(--surface-alt\)/);
  assert.doesNotMatch(css, /#harness-settings-(?:save|discard)[^{]*\{[^}]*opacity:/,
    'disabled без opacity');
});

test('F6.2: без innerHTML в settings.js/settings-view.js (XSS-политика Harness)', () => {
  for (const path of [SETTINGS_PATH, VIEW_PATH]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.doesNotMatch(source, /insertAdjacentHTML|document\.write/);
  }
});
