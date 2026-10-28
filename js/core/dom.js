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
// Плашка-подсказка поверх шторок. 3,5 с: два коротких предложения прочитать
// можно, а заслонить следующий шаг она не успевает. Повторный вызов перезапускает
// отсчёт, а не копит таймеры: последнее слово важнее прежнего.
export let toastTimer = null;
export function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toast.hidden = true;
    toastTimer = null;
  }, 3500);
}

// Тост об ошибке: тот же единственный элемент #toast, но одинаковый текст
// не перезаписывается заново — только продлевается отсчёт скрытия. Иначе
// цепочка одинаковых сбоев (три Enter во время чтения PDF) каждый раз
// «зажигает» плашку заново, и она кажется мигающей.
export function showErrorToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (!toast.hidden && toast.textContent === message) {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.hidden = true;
      toastTimer = null;
    }, 3500);
    return;
  }
  showToast(message);
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
