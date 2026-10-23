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

// Показ и скрытие элемента по id
export function setHidden(id, hidden) {
  const element = document.getElementById(id);
  if (element) element.hidden = hidden;
}
