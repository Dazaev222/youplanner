/* Единый владелец геометрии Harness (ТЗ F6.1, Раздел 6).

   Один модуль измеряет visualViewport и пишет на #app ровно три переменные:
   --harness-vh (видимая высота), --harness-vtop (видимый верх) и
   --harness-bottom-space (резерв под плавающий таб-бар при закрытой
   клавиатуре). Остальную геометрию делает CSS (styles/harness.css, блок
   F6.1): #app fixed на мобильном пороге 700px, dock/settings берут резерв
   из переменной с CSS fallback.

   Правила (F6.1.3–F6.1.8):
   * без screen.height, констант высоты клавиатуры, UA-sniffing и запрета
     zoom; при scale != 1 уменьшение высоты не трактуется как клавиатура;
   * серия событий (vv resize/scroll, window resize/orientationchange/
     pageshow, visibilitychange, focusin/focusout, ResizeObserver таб-бара
     и dock) даёт ОДИН запланированный requestAnimationFrame; постоянного
     цикла нет, стили пишутся только при изменении;
   * body.harness-editing — при фокусе в поле (input/textarea/contenteditable,
     кроме range/checkbox/button); после focusout класс снимается не сразу,
     а после восстановления высоты (допуск 24px, стабильность 120ms);
     устойчивое уменьшение >80px держит резерв снятым;
   * без visualViewport — ограниченная точность: состояние по фокусу и
     отложенное снятие 250ms (CSS fallback 100dvh);
   * destroy снимает все слушатели/observers/кадры/таймеры и только свои
     классы/переменные: 20 mount/unmount не накапливают обработчики.

   Модуль не импортирует index.js/firebase.js и не трогает другие маршруты:
   DOM-зависимости (app/root/окно) приходят аргументами, tests подставляют
   заглушки. */

const MOBILE_QUERY = '(max-width: 700px)';
// Типы input, которые не поднимают программную клавиатуру и не включают
// editing-класс (F6.1.7: не range/checkbox/button).
const NON_EDITABLE_INPUT_TYPES = [
  'range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden',
];
const VAR_VH = '--harness-vh';
const VAR_VTOP = '--harness-vtop';
const VAR_BOTTOM = '--harness-bottom-space';
const OWNED_VARS = [VAR_VH, VAR_VTOP, VAR_BOTTOM];
// Допуск восстановления высоты после закрытия клавиатуры (F6.1.7).
const RESTORE_TOLERANCE_PX = 24;
// Стабильность высоты перед снятием editing-класса (F6.1.7).
const STABILITY_MS = 120;
// Отложенное снятие без visualViewport (F6.1.7, ограниченная точность).
const FALLBACK_REMOVE_MS = 250;
// Минимальный резерв под плавающий таб-бар (F6.1.6).
const BOTTOM_RESERVE_MIN_PX = 8;

function isEditable(el) {
  if (!el || (typeof el !== 'object' && typeof el !== 'function')) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    return !NON_EDITABLE_INPUT_TYPES.includes(type);
  }
  if (el.isContentEditable === true) return true;
  const attr = el.getAttribute ? el.getAttribute('contenteditable') : null;
  return Boolean(attr) && String(attr).toLowerCase() !== 'false';
}

export function mountHarnessViewport({ app, root, onLayout, deps = {} }) {
  if (!app || typeof app.style !== 'object') {
    throw new Error('mountHarnessViewport: нужен корневой #app с style');
  }
  const doc = deps.document ||
    (root && root.ownerDocument) || (app && app.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);
  const win = deps.window || (doc && doc.defaultView) ||
    (typeof window !== 'undefined' ? window : null);
  // Явный deps.visualViewport (включая null для теста fallback) старше window.
  const vv = deps.visualViewport !== undefined
    ? deps.visualViewport
    : (win && win.visualViewport) || null;
  const timers = deps.timers || {
    setTimeout: (typeof setTimeout === 'function') ? setTimeout : null,
    clearTimeout: (typeof clearTimeout === 'function') ? clearTimeout : null,
  };
  const raf = deps.requestAnimationFrame ||
    (win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : null) ||
    ((fn) => timers.setTimeout(fn, 0));
  const cancelRaf = deps.cancelAnimationFrame ||
    (win && win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : null) ||
    ((id) => timers.clearTimeout(id));

  const state = {
    destroyed: false,
    frame: 0,
    editing: false,
    focusEditable: false,
    baseHeight: 0,          // высота без клавиатуры (измеряется при scale=1)
    stabilityTimer: 0,
    fallbackTimer: 0,
    written: new Map(),     // переменная → последнее записанное значение
  };
  const listeners = [];
  let ro = null;

  function bind(target, type, handler) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }

  /* --- Стили: только на #app, только при изменении ------------------------- */

  function writeVar(name, value) {
    if (state.written.get(name) === value) return;
    state.written.set(name, value);
    if (value === '') app.style.removeProperty(name);
    else app.style.setProperty(name, value);
  }

  // Снятие класса выполняется всегда (даже если внутренний флаг уже false):
  // desktop-переход и destroy обязаны убрать остаточный editing-класс.
  function setEditing(on) {
    const changed = state.editing !== on;
    state.editing = on;
    const body = doc && doc.body;
    if (body && body.classList) {
      if (on) {
        if (changed) body.classList.add('harness-editing');
      } else {
        body.classList.remove('harness-editing');
      }
    }
  }

  function isMobile() {
    const mm = deps.matchMedia || (win && win.matchMedia);
    if (typeof mm === 'function') {
      try {
        return Boolean(mm.call(win, MOBILE_QUERY).matches);
      } catch (e) { /* ниже fallback по ширине */ }
    }
    const width = (doc && doc.documentElement &&
      Number(doc.documentElement.clientWidth)) ||
      (win && Number(win.innerWidth)) || NaN;
    return Number.isFinite(width) ? width <= 700 : false;
  }

  function tabBar() {
    if (deps.tabBar !== undefined) return deps.tabBar;
    return (doc && typeof doc.getElementById === 'function')
      ? doc.getElementById('tab-bar') : null;
  }

  /* --- Резерв под плавающий таб-бар (F6.1.6) --------------------------------- */

  function updateBottomSpace() {
    const bar = tabBar();
    let barRect = null;
    let appRect = null;
    try { barRect = bar ? bar.getBoundingClientRect() : null; } catch (e) { barRect = null; }
    try { appRect = app.getBoundingClientRect(); } catch (e) { appRect = null; }
    // Скрытый бар (нулевой rect) не считается перекрытием: измерять его как
    // нулевой запрещено — уходит в CSS fallback (8px + safe-area).
    const barVisible = barRect && barRect.height > 0 && barRect.width > 0;
    if (!barVisible || !appRect || !(appRect.bottom > 0)) {
      writeVar(VAR_BOTTOM, '');
      return;
    }
    if (barRect.top < appRect.bottom) {
      const reserve = Math.max(BOTTOM_RESERVE_MIN_PX,
        Math.round(appRect.bottom - barRect.top + BOTTOM_RESERVE_MIN_PX));
      writeVar(VAR_BOTTOM, reserve + 'px');
    } else {
      writeVar(VAR_BOTTOM, '');
    }
  }

  /* --- Снятие editing-класса по геометрии (F6.1.7) ----------------------------- */

  function clearStability() {
    if (state.stabilityTimer) {
      timers.clearTimeout(state.stabilityTimer);
      state.stabilityTimer = 0;
    }
  }

  function updateEditingByGeometry(height, scale) {
    if (!state.editing || state.focusEditable) return;
    if (scale !== null && scale !== 1) {
      // Уменьшение высоты при масштабировании — не клавиатура: сравнение с
      // базой недостоверно. Фокус ушёл, а класс допустим только пока есть
      // фокус — снимаем (застрявший класс недопустим).
      setEditing(false);
      return;
    }
    if (state.baseHeight > 0 && height >= state.baseHeight - RESTORE_TOLERANCE_PX) {
      // Высота восстановилась: снять класс после стабильности 120ms.
      if (!state.stabilityTimer) {
        state.stabilityTimer = timers.setTimeout(function () {
          state.stabilityTimer = 0;
          if (state.destroyed || state.focusEditable) return;
          const current = vv && Number.isFinite(Number(vv.height)) ? Number(vv.height) : 0;
          if (state.baseHeight > 0 &&
              current >= state.baseHeight - RESTORE_TOLERANCE_PX) {
            setEditing(false);
          }
        }, STABILITY_MS);
      }
      return;
    }
    if (state.baseHeight > 0 && state.baseHeight - height > 80) {
      // Устойчивое уменьшение >80px: резерв держится снятым.
      clearStability();
    }
  }

  /* --- Измерение ------------------------------------------------------------------ */

  function measure() {
    state.frame = 0;
    if (state.destroyed) return;
    if (!isMobile()) {
      // Desktop: снять мобильные inline-переменные и классы (F6.1.4).
      writeVar(VAR_VH, '');
      writeVar(VAR_VTOP, '');
      writeVar(VAR_BOTTOM, '');
      setEditing(false);
      state.focusEditable = false;
      state.baseHeight = 0;
      if (onLayout) onLayout();
      return;
    }
    const rawHeight = vv ? Number(vv.height) : NaN;
    if (vv && Number.isFinite(rawHeight) && rawHeight > 0) {
      const height = Math.round(rawHeight);
      const rawTop = Number(vv.offsetTop);
      const top = Math.round(Number.isFinite(rawTop) ? rawTop : 0);
      writeVar(VAR_VH, height + 'px');
      writeVar(VAR_VTOP, top + 'px');
      const rawScale = Number(vv.scale);
      const scale = Number.isFinite(rawScale) ? rawScale : null;
      if (!state.editing && (scale === null || scale === 1)) {
        // База без клавиатуры обновляется без редактирования при scale=1
        // (поворот перекалибровывает тем же путём).
        state.baseHeight = height;
      }
      updateEditingByGeometry(height, scale);
    } else {
      // API нет: переменные сняты — CSS fallback (100dvh/100vh).
      writeVar(VAR_VH, '');
      writeVar(VAR_VTOP, '');
      state.baseHeight = 0;
    }
    updateBottomSpace();
    if (onLayout) onLayout();
  }

  function schedule() {
    if (state.destroyed || state.frame) return;
    state.frame = raf(measure);
  }

  /* --- Фокус и редактирование (F6.1.7) ------------------------------------------- */

  function onFocusIn(event) {
    if (state.destroyed) return;
    const target = event && event.target;
    if (!isEditable(target)) return;
    state.focusEditable = true;
    clearStability();
    if (state.fallbackTimer) {
      timers.clearTimeout(state.fallbackTimer);
      state.fallbackTimer = 0;
    }
    setEditing(true);
    schedule();
  }

  function onFocusOut(event) {
    if (state.destroyed) return;
    if (isEditable(event && event.relatedTarget)) return;   // переход в другое поле
    state.focusEditable = false;
    if (!vv) {
      // Ограниченная точность без visualViewport: состояние по фокусу и
      // отложенное снятие 250ms.
      if (state.fallbackTimer) timers.clearTimeout(state.fallbackTimer);
      state.fallbackTimer = timers.setTimeout(function () {
        state.fallbackTimer = 0;
        if (!state.destroyed && !state.focusEditable) setEditing(false);
      }, FALLBACK_REMOVE_MS);
      return;
    }
    // С visualViewport снятие решается в measure по восстановлению высоты;
    // немедленного возврата бара нет.
    schedule();
  }

  function onVisibility() {
    if (state.destroyed) return;
    if (doc && doc.visibilityState === 'hidden') return;
    // Фон/возврат: пересчитать, не полагаясь на пропущенный blur.
    if (state.editing && !isEditable(doc && doc.activeElement)) {
      state.focusEditable = false;
    }
    schedule();
  }

  /* --- Проводка ------------------------------------------------------------------------ */

  bind(vv, 'resize', schedule);
  bind(vv, 'scroll', schedule);
  bind(win, 'resize', schedule);
  bind(win, 'orientationchange', schedule);
  bind(win, 'pageshow', schedule);
  bind(doc, 'visibilitychange', onVisibility);
  if (root) {
    bind(root, 'focusin', onFocusIn);
    bind(root, 'focusout', onFocusOut);
  }

  const RO = deps.ResizeObserver || (win && win.ResizeObserver) || null;
  if (RO && typeof RO === 'function') {
    try {
      ro = new RO(function () { schedule(); });
      const bar = tabBar();
      if (bar && typeof ro.observe === 'function') ro.observe(bar);
      const dock = (root && typeof root.querySelector === 'function')
        ? root.querySelector('.harness-dock') : null;
      if (dock && typeof ro.observe === 'function') ro.observe(dock);
    } catch (e) {
      ro = null;
    }
  }

  schedule();   // первичное измерение

  return {
    refresh: schedule,
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      for (const [target, type, handler] of listeners) {
        try {
          target.removeEventListener(type, handler);
        } catch (e) { /* снятие не должно ронять выход */ }
      }
      listeners.length = 0;
      if (state.frame) {
        cancelRaf(state.frame);
        state.frame = 0;
      }
      clearStability();
      if (state.fallbackTimer) {
        timers.clearTimeout(state.fallbackTimer);
        state.fallbackTimer = 0;
      }
      if (ro) {
        try { ro.disconnect(); } catch (e) { /* ignore */ }
        ro = null;
      }
      setEditing(false);
      for (const name of OWNED_VARS) {
        state.written.delete(name);
        try { app.style.removeProperty(name); } catch (e) { /* ignore */ }
      }
      onLayout = null;
    },
  };
}
