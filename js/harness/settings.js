/* Настройки модели Harness — нормализация и локальное хранилище (ТЗ F6.2).
   МОДУЛЬ БЕЗ DOM: только данные и storage. DOM формы — settings-view.js,
   композиция — index.js, транспорт — firebase.js (не импортируется здесь).

   Формат записи (ТЗ F6.2.5, контракт _ci/contract/contract.json):
     { schemaVersion: 1, revision: <новый uuid на сохранение>,
       provider: 'opencode',          — транспорт адаптера (семейство
                                        восстанавливается по modelId)
       modelId, reasoning?,           — reasoning из тиров модели каталога
       contextTokens, maxOutputTokens — входят в снимок (fixture model_task),
                                        адаптер их не принимает и в запрос
                                        провайдера не передаёт
       persona: { preferredName, about, responseStyle } }

   Ключ: harness.modelSettings.v1.<ownerUid>.<deviceId> — отдельно от
   assistant_* и sync-снимка; настройки локальны на устройстве, API-ключи в
   персонализации не хранятся. Политика записи: одна setItem → read-back →
   обновление active; QuotaExceededError/SecurityError — прежние active и
   честная ошибка; конфликт другой вкладки — отказ без затирания. */

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_KEY_PREFIX = 'harness.modelSettings.v1';

// Каталог моделей — согласованный контракт координатора (contract.json),
// источник: модели/providers/opencode_provider.py _MODEL_TIERS. Числа
// generationParams адаптером не принимаются (UNSUPPORTED_SETTING_KEYS) —
// в UI отключаются с причиной, значения фиксированы контрактом.
export const MODEL_CATALOG = Object.freeze({
  families: Object.freeze([
    {
      provider: 'glm',
      label: 'GLM',
      status: 'available',
      transport: 'opencode',
      models: Object.freeze([
        { modelId: 'tooken/glm-5.3-flash', default: true,
          reasoning: Object.freeze(['low', 'medium', 'high']) },
        { modelId: 'opencode/glm-5.3-flash-free',
          reasoning: Object.freeze(['low', 'high']) },
      ]),
    },
    {
      provider: 'qwen',
      label: 'Qwen',
      status: 'available',
      transport: 'opencode',
      models: Object.freeze([
        { modelId: 'opencode/qwen3.8-flash',
          reasoning: Object.freeze(['low', 'medium', 'high']) },
      ]),
    },
    {
      provider: 'deepseek',
      label: 'DeepSeek',
      status: 'available',
      transport: 'opencode',
      models: Object.freeze([
        { modelId: 'opencode/deepseek-v4.1-flash-free',
          reasoning: Object.freeze(['low', 'high']) },
      ]),
    },
  ]),
  generationParams: Object.freeze({
    temperature: null,
    contextTokens: null,
    maxOutputTokens: null,
    unsupportedReason: 'адаптер не принимает параметр',
  }),
  // Значения снимка: fixture model_task контракта (contextTokens 32000,
  // maxOutputTokens 2048) — не угаданы, а взяты из согласованного формата.
  contextTokensDefault: 32000,
  maxOutputTokensDefault: 2048,
  persona: Object.freeze({
    preferredNameMax: 80,
    aboutMax: 2000,
    responseStyleMax: 2000,
  }),
});

export function settingsStorageKey(ownerUid, deviceId) {
  return SETTINGS_KEY_PREFIX + '.' + String(ownerUid) + '.' + String(deviceId);
}

export function familyForModel(catalog, modelId) {
  for (const family of catalog.families) {
    if (family.models.some((m) => m.modelId === modelId)) return family;
  }
  return null;
}

function modelById(catalog, modelId) {
  for (const family of catalog.families) {
    const model = family.models.find((m) => m.modelId === modelId);
    if (model) return { family, model };
  }
  return null;
}

// Значения по умолчанию: модель catalog default, reasoning — 'medium' из
// тиров модели (fixture), иначе первый тир. Числа — константы контракта.
export function defaultSettings(catalog = MODEL_CATALOG) {
  const found = catalog.families
    .map((f) => ({ family: f, model: f.models.find((m) => m.default) || f.models[0] }))
    .find((x) => x.model) || null;
  const model = found ? found.model : null;
  const tiers = model ? model.reasoning : [];
  const reasoning = tiers.includes('medium') ? 'medium'
    : (tiers.length ? tiers[0] : undefined);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    revision: '',
    provider: found ? found.family.transport : 'opencode',
    modelId: model ? model.modelId : '',
    reasoning,
    contextTokens: catalog.contextTokensDefault,
    maxOutputTokens: catalog.maxOutputTokensDefault,
    persona: { preferredName: '', about: '', responseStyle: '' },
  };
}

const ALLOWED_KEYS = ['schemaVersion', 'revision', 'provider', 'modelId',
  'reasoning', 'temperature', 'contextTokens', 'maxOutputTokens', 'persona'];
const PERSONA_LIMITS = {
  preferredName: MODEL_CATALOG.persona.preferredNameMax,
  about: MODEL_CATALOG.persona.aboutMax,
  responseStyle: MODEL_CATALOG.persona.responseStyleMax,
};

// Строгая нормализация: неизвестные ключи, NaN/Infinity, отрицательные и
// нулевые токены, переполненная персона — отказ с причиной. Молчаливой
// потери данных нет: unsupported-temperature в записи — отказ (владелец
// сохраняет исправленные значения явно).
// opts.requireRevision: false — запись ЕЩЁ БЕЗ revision (вход store.save,
// revision генерируется там); true (по умолчанию) — запись из хранилища.
export function normalizeSettings(raw, catalog = MODEL_CATALOG,
  { requireRevision = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'format' };
  }
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (!ALLOWED_KEYS.includes(key)) return { ok: false, reason: 'unknown' };
  }
  if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema' };
  }
  if (requireRevision) {
    if (typeof raw.revision !== 'string' || !raw.revision) {
      return { ok: false, reason: 'revision' };
    }
  } else if (raw.revision !== undefined && typeof raw.revision !== 'string') {
    return { ok: false, reason: 'revision' };
  }
  if (typeof raw.provider !== 'string' || !raw.provider) {
    return { ok: false, reason: 'provider' };
  }
  const transports = new Set(
    catalog.families.map((family) => String(family.transport)));
  if (!transports.has(raw.provider)) {
    return { ok: false, reason: 'provider' };
  }
  if (typeof raw.modelId !== 'string' || !raw.modelId ||
      !modelById(catalog, raw.modelId)) {
    return { ok: false, reason: 'model' };
  }
  const found = modelById(catalog, raw.modelId);
  let reasoning;
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== 'string' ||
        !found.model.reasoning.includes(raw.reasoning)) {
      return { ok: false, reason: 'reasoning' };
    }
    reasoning = raw.reasoning;
  }
  if (raw.temperature !== undefined) {
    // Адаптер параметр не принимает: запись с ним чужая — не нормализуем
    // молча, владелец сохраняет исправленные значения явно.
    return { ok: false, reason: 'unsupported' };
  }
  const numbers = {};
  for (const field of ['contextTokens', 'maxOutputTokens']) {
    const value = raw[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return { ok: false, reason: 'numbers' };
    }
    numbers[field] = value;
  }
  if (!raw.persona || typeof raw.persona !== 'object' || Array.isArray(raw.persona)) {
    return { ok: false, reason: 'persona' };
  }
  const personaKeys = Object.keys(raw.persona);
  if (personaKeys.length !== Object.keys(PERSONA_LIMITS).length ||
      personaKeys.some((key) => !(key in PERSONA_LIMITS))) {
    return { ok: false, reason: 'persona' };
  }
  const persona = {};
  for (const [key, max] of Object.entries(PERSONA_LIMITS)) {
    const value = raw.persona[key];
    if (typeof value !== 'string') return { ok: false, reason: 'persona' };
    if (value.length > max) return { ok: false, reason: 'length' };
    persona[key] = value;
  }
  const settings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    revision: raw.revision,
    provider: raw.provider,
    modelId: raw.modelId,
    contextTokens: numbers.contextTokens,
    maxOutputTokens: numbers.maxOutputTokens,
    persona,
  };
  if (reasoning !== undefined) settings.reasoning = reasoning;
  return { ok: true, settings };
}

// Причина отказа хранилища: quota / security / прочее.
function storageErrorReason(err) {
  const name = String((err && err.name) || '');
  const code = err && err.code;
  if (/quota/i.test(name) || code === 22 || code === 1014) return 'quota';
  if (/security/i.test(name) || code === 18) return 'security';
  return 'storage';
}

function defaultRevision() {
  const c = (typeof crypto !== 'undefined') ? crypto : null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = (c && c.getRandomValues)
    ? c.getRandomValues(new Uint8Array(16))
    : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('');
}

export function createSettingsStore({
  storage, ownerUid, deviceId, catalog = MODEL_CATALOG, makeRevision,
}) {
  const key = settingsStorageKey(ownerUid, deviceId);
  const nextRevision = makeRevision || defaultRevision;
  let active = null;      // последняя валидно сохранённая/загруженная запись
  let activeRaw = null;   // исходный raw записи active (для сравнения вкладок)

  function parseAndNormalize(raw) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: 'corrupt' };
    }
    return normalizeSettings(parsed, catalog);
  }

  function load() {
    active = null;
    activeRaw = null;
    if (!storage) return { ok: true, settings: null };
    let raw = null;
    try {
      raw = storage.getItem(key);
    } catch (e) {
      return { ok: false, reason: 'storage' };
    }
    if (raw === null || raw === undefined || raw === '') {
      return { ok: true, settings: null };
    }
    const checked = parseAndNormalize(raw);
    if (!checked.ok) {
      // Повреждённая/чужая версия не становится active, но остаётся базой
      // сравнения: явное сохранение исправленных значений владельцем
      // перезапишет её (ТЗ F6.2.6), молчаливой потери данных нет.
      active = null;
      activeRaw = raw;
      return { ok: false, reason: checked.reason, raw };
    }
    active = checked.settings;
    activeRaw = raw;
    return { ok: true, settings: active };
  }

  function adoptExternal(raw) {
    if (raw === null || raw === undefined || raw === '') {
      active = null;
      activeRaw = null;
      return { ok: true, settings: null };
    }
    const checked = parseAndNormalize(raw);
    if (!checked.ok) return checked;
    active = checked.settings;
    activeRaw = raw;
    return checked;
  }

  function save(next) {
    // Запись может приходить без revision (форма): revision создаётся здесь.
    const checked = normalizeSettings(next, catalog, { requireRevision: false });
    if (!checked.ok) return { ok: false, reason: checked.reason };
    if (!storage) return { ok: false, reason: 'storage' };
    let currentRaw = null;
    try {
      currentRaw = storage.getItem(key);
    } catch (e) {
      return { ok: false, reason: 'storage' };
    }
    // Сравнение исходной revision с текущей (CAS-lite между вкладками):
    // строгой транзакционности localStorage не даёт — обнаруженный конфликт
    // честно отклоняется, запись другой вкладки не затирается.
    if ((currentRaw || null) !== (activeRaw || null)) {
      if (currentRaw) adoptExternal(currentRaw);
      return { ok: false, reason: 'conflict', settings: active };
    }
    const record = Object.assign({}, checked.settings, {
      revision: nextRevision(),
    });
    let written = null;
    try {
      written = JSON.stringify(record);
      storage.setItem(key, written);
    } catch (e) {
      return { ok: false, reason: storageErrorReason(e) };
    }
    // Read-back: успехом считается только подтверждённая запись.
    let back = null;
    try {
      back = storage.getItem(key);
    } catch (e) {
      back = null;
    }
    if (back !== written) return { ok: false, reason: 'readback' };
    let reparsed = null;
    try {
      reparsed = JSON.parse(back);
    } catch (e) {
      reparsed = null;
    }
    if (!reparsed || reparsed.revision !== record.revision) {
      return { ok: false, reason: 'readback' };
    }
    active = record;
    activeRaw = written;
    return { ok: true, settings: record };
  }

  return {
    key: () => key,
    load,
    save,
    // storage-событие другой вкладки/удаление записи.
    applyExternal(raw) {
      const result = adoptExternal(raw);
      return { changed: Boolean(result.ok), settings: active, reason: result.reason };
    },
    getActive: () => active,
    clearMemory() {
      active = null;
      activeRaw = null;
    },
  };
}
