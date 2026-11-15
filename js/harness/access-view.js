/* DOM модуля «Доступ к ПК» (ТЗ Раздел 7, A7.3). Компаньон access.js
   (валидация/контроллер) и firebase.js (транспорт): здесь только
   представление и поведение. Все записи в DOM — через value/textContent
   (innerHTML запрещён, см. тесты). Index.js в модули не импортируется.

   Особенность монтажа: index.html вне владения YP-воркера access-v1, поэтому
   fieldset#harness-access-group и кнопка шапки создаются ПАМЯТИ DOM при
   mount (A7.3.1 разрешает расширение формы; группа встаёт ПЕРЕД группой
   «Модель», кнопка — в существующую .harness-head). Второго экрана не
   создаётся: кнопка шапки открывает существующие настройки с фокусом на
   legend (tabindex=-1).

   Контракт (A7.3.2–A7.3.8):
   * Доступ — отдельное сетевое сохранение, НЕ settingsStore и НЕ кнопка
     «Сохранить настройки»: радио/чекбокс останавливают всплытие change/
     input, чтобы dirty-трекинг формы настроек не срабатывал.
   * Radio меняет ТОЛЬКО черновик; Apply safe/medium — один CAS PUT;
     Apply unrestricted открывает предупреждение и НИЧЕГО не пишет;
     отдельный confirm-submit с checkbox формирует confirmation + новый
     requestId + CAS от заново сверенной версии.
   * Синхронный submitting-флаг до первого await; кнопки изменения disabled
     до сверки ответа; offline/auth-expired запрещают применение; timeout →
     «Исход изменения неизвестен».
   * Статусы по A7.3.6/A7.3.7 из describeAccessStatus (access.js): «активен»
     только по свежему совпавшему ack; mount — только чтение, никогда не
     записывать safe поверх существующего unrestricted. */

import { describeAccessStatus, ACCESS_MODES, ACCESS_MODE_LABELS } from './access.js';

// Подписи radio — точно из A7.3.1.
const ACCESS_MODE_OPTIONS = [
  { mode: 'safe', id: 'harness-access-safe',
    label: 'Safe — спрашивать о каждом действии' },
  { mode: 'medium', id: 'harness-access-medium',
    label: 'Medium — читать самостоятельно' },
  { mode: 'unrestricted', id: 'harness-access-unrestricted',
    label: 'Unrestricted — полный доступ без запросов' },
];

const ACCESS_CONFIRM_WARNING =
  'Код сможет работать напрямую в Windows с правами пользователя. ' +
  'Запросов разрешения на действия не будет. ' +
  'Уже выполненные действия нельзя отменить сменой режима';
const ACCESS_CONFIRM_CHECK_LABEL = 'Понимаю риск прямого доступа к Windows';

// Текущий «показанный» режим для diff с черновиком: свежий ack →
// effectiveMode; иначе — режим последней политики; иначе null.
function accessDisplayedMode(state) {
  if (state.policy) return state.policy.mode;
  return null;
}

export function createAccessView({ elements, deps }) {
  const el = elements;
  const io = deps || {};
  const doc = io.doc;
  const controller = io.controller;
  if (!doc || !controller || !el.form) {
    throw new Error('createAccessView: нужны doc, controller, form');
  }

  const state = {
    mounted: false,
    submitting: false,     // синхронный флаг до первого await (A7.3.5)
    draftTouched: false,   // radio менял владелец после последнего mount/ack
    busy: Promise.resolve(),
    listeners: [],
    created: [],
  };

  const accessUi = { group: null, legend: null, radios: {}, status: null, error: null,
    confirm: null, check: null, confirmSubmit: null, confirmCancel: null,
    apply: null, open: null };

  function bind(target, type, handler) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler);
    state.listeners.push([target, type, handler]);
  }

  function unbindAll() {
    for (const [target, type, handler] of state.listeners) {
      try {
        target.removeEventListener(type, handler);
      } catch (e) { /* снятие не должно ронять выход */ }
    }
    state.listeners.length = 0;
  }

  /* --- DOM-постройка ------------------------------------------------------------------ */

  function make(tag) {
    const node = doc.createElement(tag);
    state.created.push(node);
    return node;
  }

  function buildGroup() {
    const group = make('fieldset');
    group.id = 'harness-access-group';
    group.classList.add('harness-settings-group');

    const legend = make('legend');
    legend.textContent = 'Доступ к ПК';
    legend.tabIndex = -1;   // цель фокуса кнопки шапки (A7.3.2)
    group.appendChild(legend);
    accessUi.legend = legend;

    for (const option of ACCESS_MODE_OPTIONS) {
      const label = make('label');
      label.className = 'harness-access-option';
      const radio = make('input');
      radio.type = 'radio';
      radio.name = 'harness-access-mode';
      radio.id = option.id;
      radio.value = option.mode;
      const text = make('span');
      text.textContent = option.label;
      label.appendChild(radio);
      label.appendChild(text);
      group.appendChild(label);
      accessUi.radios[option.mode] = radio;
      bind(radio, 'change', function (event) {
        // Доступ — НЕ settingsStore: всплытие в форму настроек остановлено,
        // dirty-трекинг модели не срабатывает (A7.3.1).
        if (event && typeof event.stopPropagation === 'function') {
          event.stopPropagation();
        }
        if (event && event.target && event.target !== radio) return;
        if (!radio.checked) return;
        state.draftTouched = true;
        controller.setDraft(option.mode);
      });
      bind(radio, 'input', function (event) {
        if (event && typeof event.stopPropagation === 'function') {
          event.stopPropagation();
        }
      });
    }

    const status = make('p');
    status.id = 'harness-access-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    group.appendChild(status);
    accessUi.status = status;

    const error = make('p');
    error.id = 'harness-access-error';
    error.className = 'harness-settings-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    group.appendChild(error);
    accessUi.error = error;

    buildConfirmBlock(group);

    const apply = make('button');
    apply.type = 'button';
    apply.id = 'harness-access-apply';
    apply.textContent = 'Применить режим';
    group.appendChild(apply);
    accessUi.apply = apply;
    bind(apply, 'click', function () {
      const flight = handleApply();
      state.busy = state.busy.then(() => flight).catch(() => {});
    });

    return group;
  }

  function buildConfirmBlock(group) {
    const block = make('div');
    block.id = 'harness-access-confirm';
    block.hidden = true;

    const warning = make('p');
    warning.textContent = ACCESS_CONFIRM_WARNING;
    block.appendChild(warning);

    const checkLabel = make('label');
    checkLabel.className = 'harness-access-check';
    const check = make('input');
    check.type = 'checkbox';
    check.id = 'harness-access-confirm-check';
    const checkText = make('span');
    checkText.textContent = ACCESS_CONFIRM_CHECK_LABEL;
    checkLabel.appendChild(check);
    checkLabel.appendChild(checkText);
    block.appendChild(checkLabel);
    accessUi.check = check;
    bind(check, 'change', function (event) {
      if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      if (event && event.target && event.target !== check) return;
      controller.setConfirmationChecked(check.checked);
    });
    bind(check, 'input', function (event) {
      if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
    });

    const submit = make('button');
    submit.type = 'button';
    submit.id = 'harness-access-confirm-submit';
    submit.textContent = 'Включить полный доступ';
    block.appendChild(submit);
    accessUi.confirmSubmit = submit;
    bind(submit, 'click', function () {
      const flight = handleConfirm();
      state.busy = state.busy.then(() => flight).catch(() => {});
    });

    const cancel = make('button');
    cancel.type = 'button';
    cancel.id = 'harness-access-confirm-cancel';
    cancel.textContent = 'Отмена';
    block.appendChild(cancel);
    accessUi.confirmCancel = cancel;
    bind(cancel, 'click', function () {
      controller.resetConfirmation();
      hideError();
    });

    group.appendChild(block);
    accessUi.confirm = block;
  }

  function buildOpenButton() {
    const button = make('button');
    button.type = 'button';
    button.id = 'harness-access-open';
    button.classList.add('harness-secondary');
    button.textContent = 'Доступ';
    bind(button, 'click', function () {
      if (typeof io.openSettings === 'function') io.openSettings();
      // Фокус на legend группы (tabindex=-1), не на весь экран (A7.3.2).
      if (accessUi.legend && typeof accessUi.legend.focus === 'function') {
        accessUi.legend.focus();
      }
    });
    return button;
  }

  /* --- Ошибки и кнопки ------------------------------------------------------------------ */

  function hideError() {
    accessUi.error.hidden = true;
    accessUi.error.textContent = '';
  }

  function showError(text) {
    accessUi.error.textContent = text;
    accessUi.error.hidden = false;
    if (typeof io.announce === 'function') io.announce(text);
  }

  function setChangeButtonsDisabled(disabled) {
    accessUi.apply.disabled = disabled;
    accessUi.confirmSubmit.disabled = disabled;
    accessUi.confirmCancel.disabled = disabled;
    for (const mode of ACCESS_MODES) {
      if (accessUi.radios[mode]) accessUi.radios[mode].disabled = disabled;
    }
  }

  /* --- Действия ---------------------------------------------------------------------------- */

  // A7.3.5: submitting-флаг синхронно до первого await; offline/auth-expired
  // запрещают применение; временная ошибка НЕ запускает авторетраи.
  async function handleApply() {
    if (state.submitting) return;
    if (typeof io.isOffline === 'function' && io.isOffline()) {
      showError('Нет сети: применить режим сейчас нельзя. Без фонового повтора.');
      return;
    }
    if (typeof io.isAuthOk === 'function' && !io.isAuthOk()) {
      showError('Нужен вход владельца — режим не применяется.');
      return;
    }
    state.submitting = true;           // синхронно, ДО первого await
    controller.beginSubmit();
    setChangeButtonsDisabled(true);
    hideError();
    let result;
    try {
      result = await controller.applyDraft();
    } catch (err) {
      result = { ok: false, reason: 'error', error: err };
    }
    state.submitting = false;
    setChangeButtonsDisabled(false);
    afterApply(result);
    render();
  }

  function afterApply(result) {
    if (result && result.ok) {
      hideError();
      if (typeof io.announce === 'function') io.announce('Режим записан — ожидаем ПК');
      return;
    }
    const reason = result ? result.reason : 'error';
    if (reason === 'confirm-required') {
      // Apply unrestricted открыл предупреждение: НИЧЕГО не записано.
      hideError();
      return;
    }
    if (reason === 'conflict') {
      showError('Версия изменилась параллельно. Проверьте текущий режим и примените снова.');
      return;
    }
    if (reason === 'unknown-outcome') {
      // Временная ошибка без автоматического повторного повышения (A7.3.5).
      showError('Исход изменения неизвестен. Проверьте связь и сверите режим.');
      return;
    }
    if (reason === 'read-failed' || reason === 'error') {
      const detail = result && result.error && result.error.message
        ? ' ' + result.error.message : '';
      showError('Не удалось записать режим.' + detail);
      return;
    }
    // busy/no-draft: тихо — состояние показано статусом.
  }

  async function handleConfirm() {
    if (state.submitting) return;
    if (typeof io.isOffline === 'function' && io.isOffline()) {
      showError('Нет сети: включить полный доступ сейчас нельзя.');
      return;
    }
    if (typeof io.isAuthOk === 'function' && !io.isAuthOk()) {
      showError('Нужен вход владельца — режим не применяется.');
      return;
    }
    if (!accessUi.check.checked) {
      // Checkbox без второго нажатия ничего не включает (A7.3.4).
      showError('Подтвердите риск: установите флажок, затем нажмите «Включить полный доступ».');
      return;
    }
    state.submitting = true;
    controller.beginSubmit();
    setChangeButtonsDisabled(true);
    hideError();
    let result;
    try {
      result = await controller.confirmUnrestricted();
    } catch (err) {
      result = { ok: false, reason: 'error', error: err };
    }
    state.submitting = false;
    setChangeButtonsDisabled(false);
    if (result.ok) {
      hideError();
      if (typeof io.announce === 'function') io.announce('Полный доступ записан — ожидаем ПК');
    } else if (result.reason === 'conflict') {
      showError('Версия изменилась параллельно. Подтвердите риск заново.');
    } else if (result.reason === 'version-changed') {
      showError('Версия политики изменилась. Подтверждение сброшено — выберите режим и подтвердите заново.');
    } else if (result.reason === 'unknown-outcome') {
      showError('Исход изменения неизвестен. Проверьте связь и сверите режим.');
    } else if (result.reason === 'read-failed' || result.reason === 'error') {
      const detail = result && result.error && result.error.message
        ? ' ' + result.error.message : '';
      showError('Не удалось записать режим.' + detail);
    } else if (result.reason === 'no-confirm') {
      showError('Шаг подтверждения закрыт — выберите режим и примените снова.');
    }
    render();
  }

  /* --- Отрисовка --------------------------------------------------------------------------- */

  function render() {
    if (!state.mounted) return;
    const snapshot = controller.state();
    const info = describeAccessStatus(snapshot.describeInput(), {
      serverNow: typeof io.serverNow === 'function' ? io.serverNow : (() => Date.now()),
      freshMs: io.freshMs,
    });

    // Radio отражают черновик; до первого ручного выбора — показанный режим.
    const shownMode = state.draftTouched ? snapshot.draftMode : accessDisplayedMode(snapshot);
    for (const mode of ACCESS_MODES) {
      if (accessUi.radios[mode]) accessUi.radios[mode].checked = shownMode === mode;
    }

    // Подтверждение открыто ровно тогда, когда контроллер его держит.
    accessUi.confirm.hidden = !snapshot.confirmationOpen;
    accessUi.check.checked = snapshot.confirmationChecked;

    // Статус: в спокойных состояниях черновик владельца показывает следующий
    // шаг; честные статусы (ожидание записи/неизвестный исход/офлайн/ошибки)
    // всегда побеждают черновик — «активен» не заявляется без свежего ack.
    const draftNote = state.draftTouched && snapshot.draftMode && (
      info.kind === 'not-configured' ||
      info.kind === 'waiting-unknown' ||
      (info.kind === 'active' && snapshot.draftMode !== info.mode));
    accessUi.status.textContent = draftNote
      ? 'Выбрано «' + ACCESS_MODE_LABELS[snapshot.draftMode] + '» — нажмите «Применить режим»'
      : info.text;
    accessUi.status.hidden = false;

    // Кнопка шапки: активный режим/ожидание (A7.3.2).
    if (accessUi.open) {
      if (info.kind === 'not-configured') accessUi.open.textContent = 'Доступ: не настроен';
      else if (info.kind === 'submitting' || info.kind === 'applying') {
        accessUi.open.textContent = 'Доступ: применяется';
      } else if (info.kind === 'waiting' || info.kind === 'waiting-unknown') {
        accessUi.open.textContent = 'Доступ: ожидаем ПК';
      } else if (info.kind === 'offline') {
        accessUi.open.textContent = 'Доступ: ПК не на связи';
      } else if (info.kind === 'unknown-outcome') {
        accessUi.open.textContent = 'Доступ: исход неизвестен';
      } else if (info.mode) {
        accessUi.open.textContent = 'Доступ: ' + ACCESS_MODE_LABELS[info.mode];
      } else {
        accessUi.open.textContent = 'Доступ';
      }
    }
  }

  /* --- Публичный контракт ------------------------------------------------------------------ */

  return {
    // mount — ТОЛЬКО чтение (A7.3.7): refresh читает policy/status, никогда
    // не записывает safe поверх существующего unrestricted. До завершения
    // первого чтения кнопки изменения заблокированы: Apply требует сверки
    // актуальной версии (например, для подтверждения unrestricted).
    mount() {
      if (state.mounted) return;
      state.mounted = true;
      accessUi.group = buildGroup();
      const formChildren = Array.from(el.form.children || []);
      const firstFieldset = formChildren.find((child) => child &&
        child.tagName === 'FIELDSET') || null;
      // Вставка ПЕРЕД группой моделей (первый fieldset формы).
      el.form.insertBefore(accessUi.group, firstFieldset);
      if (el.chatHead) {
        accessUi.open = buildOpenButton();
        if (typeof el.chatHead.insertBefore === 'function') {
          el.chatHead.insertBefore(accessUi.open, el.chatHead.firstChild);
        } else {
          el.chatHead.appendChild(accessUi.open);
        }
      }
      controller.onUpdate(render);
      setChangeButtonsDisabled(true);
      render();
      const flight = controller.refresh().catch(() => {}).then(() => {
        if (!state.submitting) setChangeButtonsDisabled(false);
        render();
      });
      state.busy = state.busy.then(() => flight).catch(() => {});
    },
    render,
    // Ожидание завершения запущенных async-действий (для тестов).
    waitForIdle() {
      return state.busy;
    },
    isSubmitting() {
      return state.submitting;
    },
    destroy() {
      state.mounted = false;
      unbindAll();
      if (controller && typeof controller.destroy !== 'function') {
        // контроллер живёт дольше view — его не гасим
      }
      for (const node of state.created) {
        try {
          if (node && node.parentNode) node.parentNode.removeChild(node);
        } catch (e) { /* снятие узла не роняет выход */ }
      }
      state.created.length = 0;
      accessUi.group = null;
      accessUi.open = null;
    },
  };
}
