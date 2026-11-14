/* DOM-форма экрана «Настройки модели» (ТЗ F6.2). Компаньон settings.js:
   здесь только представление и поведение формы — нормализация/хранилище
   живут в settings.js, композиция в index.js. Все записи в DOM — через
   value/textContent (innerHTML запрещён, см. тесты).

   Контракт:
   * populate(active|defaults) — форма правок НЕ хранит: правка меняет
     working copy, active обновляется только после успешного save;
   * unsupported-параметры (temperature/context/maxOutputTokens) — disabled
     с причиной «адаптер не принимает параметр», значения не редактируются;
   * смена модели: несовместимые значения заменяются подтверждёнными
     defaults модели, список замен показывается до сохранения;
   * Save: синхронный флаг повторного submit → validate → store.save →
     статус/ошибка словами; QuotaExceeded — правка остаётся в форме;
   * dirty-Back — inline-блок с тремя действиями (не модалка);
   * storage-событие другой вкладки при dirty — конфликт без затирания ввода;
   * destroy снимает все слушатели, включая динамический inline-блок. */

import { familyForModel } from './settings.js';

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function createSettingsView({ elements, deps }) {
  const el = elements;
  const io = deps || {};
  const catalog = io.catalog;
  const doc = io.doc;

  const state = {
    base: null,          // снимок, которому соответствует форма (working copy)
    saving: false,       // синхронный флаг повторного submit
    confirm: null,       // динамический inline-блок dirty-Back
    confirmHandlers: [],
    destroyed: false,
  };
  const listeners = [];

  function bind(target, type, handler) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }

  function hideError() {
    el.error.hidden = true;
    el.error.textContent = '';
  }

  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = false;
    if (io.announce) io.announce(text);
  }

  function setStatus(text) {
    el.status.textContent = text;
    el.status.hidden = !text;
  }

  /* --- Selects ------------------------------------------------------------------ */

  function fillSelect(select, items, selectedValue) {
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const item of items) {
      const option = doc.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      if (item.disabled) option.disabled = true;
      select.appendChild(option);
    }
    select.value = selectedValue;
  }

  function familyByKey(key) {
    return catalog.families.find((family) => family.provider === key) || null;
  }

  function currentFamily() {
    return familyByKey(el.provider.value) ||
      familyForModel(el.model.value) || catalog.families[0];
  }

  function defaultModelOf(family) {
    return family.models.find((m) => m.default) || family.models[0];
  }

  function familyForModel(modelId) {
    for (const family of catalog.families) {
      if (family.models.some((m) => m.modelId === modelId)) return family;
    }
    return null;
  }

  function defaultReasoningOf(model, preferred) {
    const tiers = model.reasoning;
    if (tiers.includes(preferred)) return preferred;
    if (tiers.includes('medium')) return 'medium';
    return tiers[0];
  }

  // Смена модели: rebuild тиров; несовместимые значения → подтверждённые
  // defaults + список замен до сохранения (ТЗ F6.2.4).
  function syncModelDependent({ previousReasoning, previousModelId } = {}) {
    const family = currentFamily();
    const model = family.models.find((m) => m.modelId === el.model.value) ||
      defaultModelOf(family);
    fillSelect(el.reasoning, model.reasoning.map((tier) => ({
      value: tier, label: tier,
    })), defaultReasoningOf(model, el.reasoning.value || ''));
    const changes = [];
    if (previousModelId && previousModelId !== model.modelId) {
      changes.push('модель "' + previousModelId + '" → "' + model.modelId + '"');
    }
    if (previousReasoning !== undefined &&
        previousReasoning !== el.reasoning.value) {
      changes.push('размышления "' + previousReasoning + '" → "' +
        el.reasoning.value + '"');
    }
    el.capabilities.textContent = 'Модель: ' + model.modelId +
      ' · Размышления: ' + model.reasoning.join(', ') +
      ' · Температура/контекст/лимит ответа: ' +
      catalog.generationParams.unsupportedReason +
      (changes.length ? ' · Заменено: ' + changes.join('; ') : '');
  }

  function onProviderChange() {
    const family = currentFamily();
    const previousModelId = el.model.value;
    const model = defaultModelOf(family);
    fillSelect(el.model, family.models.map((m) => ({
      value: m.modelId,
      label: m.modelId + (m.default ? ' — по умолчанию' : ''),
    })), model.modelId);
    syncModelDependent({ previousReasoning: el.reasoning.value, previousModelId });
    markDirty();
  }

  function onModelChange() {
    syncModelDependent({ previousReasoning: el.reasoning.value });
    markDirty();
  }

  /* --- Unsupported поля (F6.2.4) ---------------------------------------------------- */

  function setupUnsupportedFields() {
    const reason = catalog.generationParams.unsupportedReason;
    for (const [input, help, output, valueText] of [
      [el.temperature, el.temperatureHelp, el.temperatureValue, '—'],
      [el.context, el.contextHelp, el.contextValue,
        catalog.contextTokensDefault + ' (по умолчанию)'],
      [el.outputLimit, el.contextHelp, el.outputLimitValue,
        catalog.maxOutputTokensDefault + ' (по умолчанию)'],
    ]) {
      input.disabled = true;
      input.value = '';
      help.textContent = reason + ' — значение не редактируется и не уходит в задачу';
      output.textContent = valueText;
    }
  }

  /* --- Working copy ------------------------------------------------------------------ */

  function copySettings(settings) {
    return JSON.parse(JSON.stringify(settings));
  }

  function read() {
    const family = currentFamily();
    const transport = (familyForModel(el.model.value) || family).transport;
    return {
      schemaVersion: 1,
      revision: state.base ? String(state.base.revision || '') : '',
      provider: transport,
      modelId: el.model.value,
      reasoning: el.reasoning.value || undefined,
      contextTokens: catalog.contextTokensDefault,
      maxOutputTokens: catalog.maxOutputTokensDefault,
      persona: {
        preferredName: String(el.personaName.value || '').trim().slice(0,
          catalog.persona.preferredNameMax),
        about: String(el.personaContext.value || '').trim().slice(0,
          catalog.persona.aboutMax),
        responseStyle: String(el.personaStyle.value || '').trim().slice(0,
          catalog.persona.responseStyleMax),
      },
    };
  }

  function isDirty() {
    if (!state.base) return false;
    return stableStringify(read()) !== stableStringify(state.base);
  }

  function markDirty() {
    if (io.onDirty) io.onDirty(isDirty());
  }

  function populate(settings) {
    const source = settings || io.getDefault();
    state.base = copySettings(source);
    const family = familyForModel(source.modelId) || catalog.families[0];
    fillSelect(el.provider, catalog.families.map((f) => ({
      value: f.provider,
      label: f.label + (f.status !== 'available' ? ' (недоступно)' : ''),
      disabled: f.status !== 'available',
    })), family.provider);
    fillSelect(el.model, family.models.map((m) => ({
      value: m.modelId,
      label: m.modelId + (m.default ? ' — по умолчанию' : ''),
    })), source.modelId);
    const model = family.models.find((m) => m.modelId === source.modelId) ||
      defaultModelOf(family);
    fillSelect(el.reasoning, model.reasoning.map((tier) => ({
      value: tier, label: tier,
    })), source.reasoning || defaultReasoningOf(model, ''));
    setupUnsupportedFields();
    el.personaName.value = source.persona.preferredName;
    el.personaContext.value = source.persona.about;
    el.personaStyle.value = source.persona.responseStyle;
    el.capabilities.textContent = 'Модель: ' + model.modelId +
      ' · Размышления: ' + model.reasoning.join(', ') +
      ' · Температура/контекст/лимит ответа: ' +
      catalog.generationParams.unsupportedReason;
    markDirty();
  }

  /* --- Сохранение ------------------------------------------------------------------ */

  function submit() {
    if (state.saving || state.destroyed) return false;
    state.saving = true;
    let result = null;
    try {
      result = io.save ? io.save(read()) : { ok: false, reason: 'storage' };
    } catch (e) {
      result = { ok: false, reason: 'storage' };
    }
    state.saving = false;
    if (result && result.ok) {
      populate(result.settings);
      setStatus(io.isOffline && io.isOffline()
        ? 'Сохранено на этом устройстве; применяется к следующим задачам после подключения'
        : 'Сохранено на этом устройстве; применяется к следующим задачам');
      hideError();
      if (state.confirm) hideConfirm();
      if (io.announce) io.announce('Настройки сохранены на этом устройстве');
      return true;
    }
    const reason = result ? result.reason : 'storage';
    if (reason === 'quota' || reason === 'security' || reason === 'storage') {
      showError('Не удалось сохранить на этом устройстве. Изменения остались в форме.');
    } else if (reason === 'conflict') {
      showError('Настройки изменены в другой вкладке. Проверьте значения и сохраните снова.');
    } else if (reason === 'length') {
      showError('Слишком длинный текст персонализации: имя до 80 символов, описания до 2000.');
    } else if (reason === 'numbers') {
      showError('Проверьте числа: лимиты контекста и ответа — конечные положительные значения.');
    } else if (reason === 'corrupt' || reason === 'schema') {
      showError('В хранилище повреждённая запись. Исправьте значения и сохраните явно.');
    } else {
      showError('Не удалось сохранить настройки: проверьте значения формы.');
    }
    return false;
  }

  /* --- Dirty-Back: inline-блок (не модалка, F6.2.8) -------------------------------- */

  function hideConfirm() {
    if (state.confirm) state.confirm.hidden = true;
  }

  function showConfirm() {
    if (!state.confirm) {
      const block = doc.createElement('div');
      block.className = 'harness-settings-confirm';
      const label = doc.createElement('p');
      label.textContent = 'Есть несохранённые изменения';
      block.appendChild(label);
      const actions = [
        ['Сохранить и вернуться', () => confirmSaveBack()],
        ['Не сохранять', () => confirmDiscard()],
        ['Остаться', () => confirmStay()],
      ];
      for (const [text, handler] of actions) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.addEventListener('click', handler);
        state.confirmHandlers.push([button, 'click', handler]);
        block.appendChild(button);
      }
      // Inline-блок в начале формы: перед полями, не поверх них.
      if (typeof el.view.insertBefore === 'function' && el.form) {
        el.view.insertBefore(block, el.form);
      } else {
        el.view.appendChild(block);
      }
      state.confirm = block;
    }
    state.confirm.hidden = false;
  }

  function confirmSaveBack() {
    if (submit()) {
      hideConfirm();
      if (io.onBack) io.onBack();
    }
  }

  function confirmDiscard() {
    populate(io.getActive() || io.getDefault());
    hideConfirm();
    if (io.onBack) io.onBack();
  }

  function confirmStay() {
    hideConfirm();   // «Остаться»: фокус и текст не трогаем
  }

  /* --- Внешние изменения (storage другой вкладки) -------------------------------------- */

  function onExternalChange(result) {
    if (!result || !result.changed) return;
    if (isDirty()) {
      // Конфликт: ввод пользователя не затирается (ТЗ F6.2.7).
      showError('Настройки изменены в другой вкладке. Ваши правки не затёрты — ' +
        'проверьте значения и сохраните снова.');
      return;
    }
    populate(result.settings || io.getDefault());
  }

  /* --- Публичный контракт ------------------------------------------------------------------ */

  bind(el.form, 'submit', function (event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    submit();
  });
  bind(el.form, 'input', function () { markDirty(); });
  // Смена семейства/модели — на самих select (плюс form-level 'change' для
  // остальных полей; provider/model исключены, чтобы обработчик не сработал
  // дважды из-за всплытия в реальном DOM).
  bind(el.provider, 'change', onProviderChange);
  bind(el.model, 'change', onModelChange);
  bind(el.form, 'change', function (event) {
    if (event && (event.target === el.provider || event.target === el.model)) return;
    markDirty();
  });
  bind(el.discardBtn, 'click', function () {
    populate(io.getActive() || io.getDefault());
    setStatus('');
    hideError();
  });

  return {
    open() {
      if (state.destroyed) return;
      populate(io.getActive() || io.getDefault());
      setStatus('');
      hideError();
      hideConfirm();
      // Повреждённая запись хранилища не перезаписывается молча: сообщение
      // при открытии, исправление — явным сохранением владельца (F6.2.6).
      const notice = typeof io.getLoadNotice === 'function'
        ? io.getLoadNotice() : null;
      if (notice) showError(notice);
      if (el.title && typeof el.title.focus === 'function') el.title.focus();
    },
    close() {
      hideConfirm();
    },
    read,
    isDirty,
    reset() {
      state.base = null;
      for (const input of [el.personaName, el.personaContext, el.personaStyle]) {
        input.value = '';
        input.disabled = false;
      }
      for (const select of [el.provider, el.model, el.reasoning]) {
        while (select.firstChild) select.removeChild(select.firstChild);
        select.value = '';
      }
      el.capabilities.textContent = '';
      setStatus('');
      hideError();
      hideConfirm();
      // Logout/смена владельца: активная память хранилища очищается вместе
      // с формой — до нового входа чужие значения не показываются.
      if (typeof io.clearActive === 'function') io.clearActive();
    },
    requestBack() {
      if (state.destroyed) return false;
      if (isDirty()) {
        showConfirm();
        return false;
      }
      // Чистая форма: возврат в чат выполняется здесь (index получает
      // onBack и закрывает подэкран).
      if (io.onBack) io.onBack();
      return true;
    },
    confirmSaveBack,
    confirmDiscard,
    confirmStay,
    confirmBlock: () => state.confirm,
    onExternalChange,
    destroy() {
      state.destroyed = true;
      for (const [target, type, handler] of listeners) {
        try {
          target.removeEventListener(type, handler);
        } catch (e) { /* снятие не должно ронять выход */ }
      }
      listeners.length = 0;
      for (const [target, type, handler] of state.confirmHandlers) {
        try {
          target.removeEventListener(type, handler);
        } catch (e) { /* ignore */ }
      }
      state.confirmHandlers.length = 0;
      if (state.confirm && state.confirm.parentNode) {
        try {
          state.confirm.parentNode.removeChild(state.confirm);
        } catch (e) { /* ignore */ }
      }
      state.confirm = null;
      state.base = null;
    },
  };
}
