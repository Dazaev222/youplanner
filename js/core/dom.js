// Экранирование текста перед вставкой в innerHTML
export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Двузначное число: 7 -> '07'
export function pad2(value) {
  return String(value).padStart(2, '0');
}
// Безопасное значение habitId для CSS-селектора
export function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(String(value));
  }
  return String(value).replace(/["\\]/g, '\\$&');
}
// Плашка-подсказка поверх шторок. 3,5 с для подсказок; ошибки держатся 6 с.
// Повторный вызов перезапускает отсчёт, а не копит таймеры: последнее слово
// важнее прежнего. Тост закрывается тапом и свайпом вверх (баг 2 из
// теста Vision на iPhone): pointer-events включён в toast.css.
export let toastTimer = null;

function hideToast() {
  const toast = document.getElementById('toast');
  if (toast) toast.hidden = true;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function armToast(ms) {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    const toast = document.getElementById('toast');
    if (toast) toast.hidden = true;
    toastTimer = null;
  }, ms);
}

// Слушатели жестов ставятся один раз на живой элемент #toast.
let toastGesturesBound = false;
function bindToastGestures() {
  if (toastGesturesBound) return;
  const toast = document.getElementById('toast');
  if (!toast || typeof toast.addEventListener !== 'function') return;
  toastGesturesBound = true;
  toast.addEventListener('click', hideToast);
  let touchStartY = null;
  toast.addEventListener('touchstart', function (e) {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  toast.addEventListener('touchmove', function (e) {
    if (touchStartY !== null && e.touches[0].clientY < touchStartY - 30) {
      touchStartY = null;
      hideToast();
    }
  }, { passive: true });
}

export function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  bindToastGestures();
  toast.textContent = message;
  toast.hidden = false;
  armToast(3500);
}

// Тост об ошибке: тот же единственный элемент #toast, но одинаковый текст
// не перезаписывается заново — только продлевается отсчёт скрытия. Иначе
// цепочка одинаковых сбоев (три Enter во время чтения PDF) каждый раз
// «зажигает» плашку заново, и она кажется мигающей. Ошибке 6 с: длинные
// формулировки причин не успевают прочитать за 3,5 с (баг 2, iPhone).
export function showErrorToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  bindToastGestures();
  if (!toast.hidden && toast.textContent === message) {
    armToast(6000);
    return;
  }
  toast.textContent = message;
  toast.hidden = false;
  armToast(6000);
}

// Единый текст сетевого сбоя и единая точка его показа. display(message) —
// куда вывести (по умолчанию error-тост); silent — только вернуть текст,
// показать его вызывающий решит сам (например, в ленте ассистента).
export const NETWORK_ERROR_TEXT =
  'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';

export function handleNetworkError(error, options) {
  const opts = options || {};
  if (error) console.error((opts.context || '[сеть]') + ':', error);
  const message = opts.message || NETWORK_ERROR_TEXT;
  if (!opts.silent) (opts.display || showErrorToast)(message);
  return message;
}

// Показ и скрытие элемента по id
export function setHidden(id, hidden) {
  const element = document.getElementById(id);
  if (element) element.hidden = hidden;
}

// Высота, на которую клавиатура перекрывает окно. В медиа-запросе телефона
// шторки стоят по bottom и поднимаются на эту величину: без неё клавиатура
// накрывает панель формы вместе с полем ввода.
export function syncSheetToKeyboard() {
  if (!window.visualViewport) return;
  const offset = Math.max(0,
    window.innerHeight - window.visualViewport.height
    - window.visualViewport.offsetTop);
  document.documentElement.style.setProperty('--keyboard-offset', offset + 'px');
}

// Отложенный вызов: серия быстрых событий даёт один вызов функции — после
// паузы wait мс от последнего события. Мгновенную часть отклика (пересчёт
// итога на экране) вызывающий делает сам, сюда попадает только дорогая
// запись: хранилище, сеть. Жило отдельным файлом (js/core/debounce.js),
// потребителем был только js/ui/sleep-view.js — слито сюда (этап Y4).
//
// flush() — выполнить отложенный вызов прямо сейчас (уход со вкладки,
// закрытие экрана: страница может исчезнуть раньше таймера). cancel() —
// снять отложенный вызов без выполнения. Когда отложенного вызова нет,
// обе операции — тихий no-op.
export function debounce(fn, wait) {
  let timer = null;
  let lastArgs = null;

  function invoke() {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    fn.apply(null, args);
  }

  function debounced() {
    lastArgs = arguments;
    if (timer) clearTimeout(timer);
    timer = setTimeout(invoke, wait);
  }

  debounced.flush = function () {
    if (!timer) return;
    clearTimeout(timer);
    invoke();
  };

  debounced.cancel = function () {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  return debounced;
}

// Таймаут-гард сетевого запроса: пара «сигнал + cancel», ms — предел
// ожидания, свой у каждого слоя (синхронизация 20 с, auth 30 с, ассистент
// 60 с). Жило тремя копиями (syncGuard, authTimeoutGuard, timeoutGuard
// в assistant-media) с одним правилом — сведено сюда; модуль ничего
// не импортирует, поэтому циклов с data/ и sync/ не возникает.
// AbortSignal.timeout появился в Safari только в 15.4, и вызов на старых
// iPhone кидал TypeError — каждый запрос мгновенно падал; ручной контроллер
// работает везде, поэтому сигналом служит он. Таймер возвращается вместе
// с сигналом: без cancel() короткий успешный запрос оставлял бы за собой
// живой таймер до истечения таймаута. Песочницы без Abort API (юнит-тесты,
// старые движки) ходят без сигнала: отсутствие таймаута лучше падения
// каждого запроса. timedOut() различает истёкший таймаут: в ручной ветке
// fetch отвергается AbortError (не TimeoutError), и без этого флага таймаут
// на старых Safari выдавался за «нет связи».
export function timeoutGuard(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return {
      signal: AbortSignal.timeout(ms),
      cancel: function () {},
      timedOut: function () { return false; },
    };
  }
  if (typeof AbortController === 'undefined') {
    return {
      signal: undefined,
      cancel: function () {},
      timedOut: function () { return false; },
    };
  }
  let fired = false;
  const controller = new AbortController();
  const timer = setTimeout(function () {
    fired = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    cancel: function () { clearTimeout(timer); },
    timedOut: function () { return fired; },
  };
}
