import { setHidden } from '../core/dom.js';
import { FAST_MAX_INPUT, FAST_VERSION, addFast, fastRemainingLabel, loadFast, markFastDone, parseFastInput, setFast } from '../data/fast.js';
// Форма открыта кнопкой обычного экрана: 'add' или 'edit'. Первый запуск
// сюда не пишется — он выводится из отсутствия ключа. Иначе «ключ стёрли»
// и «форму ещё не закрыли» стали бы одним состоянием.
export let fastInitMode = null;
// Экран раздела: форма ввода или обычный экран. Признак первого запуска —
// только loadFast() === null. Остаток 0 — существующий счётчик, и экран
// у него обычный: возмещать нечего, но добавлять и править есть что.
export function renderFastView() {
  const fast = loadFast();
  const mode = fastInitMode || (fast === null ? 'start' : null);

  setHidden('fast-init', mode === null);
  setHidden('fast-main', mode !== null || fast === null);

  if (mode !== null) {
    // Заголовок и «Отмена» зависят от случая: на первом запуске обычного
    // экрана ещё нет, и отменять нечего
    const title = document.querySelector('#fast-init .qaza-subtitle');
    if (title) {
      title.textContent = mode === 'add' ? 'Сколько дней добавить?'
        : mode === 'edit' ? 'Сколько дней осталось?'
          : 'Сколько дней нужно возместить?';
    }
    setHidden('fast-init-cancel', mode === 'start');

    // Сообщение об ошибке снимается при каждом открытии формы заново
    const note = document.getElementById('fast-init-note');
    if (note) note.textContent = '';
    return;
  }

  const label = document.getElementById('fast-remaining');
  if (label) label.textContent = fastRemainingLabel(fast.remaining);

  // При нулевом остатке «Возместить» гаснет: возмещённых постов не бывает
  // больше, чем дней к возмещению
  const done = document.getElementById('fast-done');
  if (done) done.disabled = fast.remaining <= 0;
}
// Открыть форму кнопкой обычного экрана
export function openFastForm(mode) {
  fastInitMode = mode;

  const field = document.getElementById('fast-init-value');
  if (field) field.value = '';
  renderFastView();
  if (field) field.focus();
}
export function onFastAdd() {
  openFastForm('add');
}
export function onFastEdit() {
  openFastForm('edit');
}
export function onFastInitCancel() {
  fastInitMode = null;
  renderFastView();
}
// «Возместить 1 день». Кнопка при нулевом остатке погашена, но обработчик
// проверяет остаток сам: погашенная кнопка — подсказка, а не защита,
// и остаток не должен уйти в минус нажатием из консоли или скрипта.
export function onFastDone() {
  const fast = loadFast();
  if (!fast || fast.remaining <= 0) return;

  if (!markFastDone(fast)) return;
  renderFastView();
}
// «Сохранить» формы. Один обработчик на три случая: режим решает, что делать
// с введённым числом. Неверный ввод оставляет форму открытой — исправлять
// его здесь же, а не в обычном экране.
export function onFastInitSave() {
  const field = document.getElementById('fast-init-value');
  const note = document.getElementById('fast-init-note');
  const fast = loadFast();

  const mode = fastInitMode || (fast === null ? 'start' : null);
  if (mode === null) return;

  // Первый запуск и «Изменить счётчик» задают остаток целиком (≥ 0),
  // «Добавить уразу» — только прибавку (> 0, ноль не принимается)
  const value = parseFastInput(field ? field.value : '', mode === 'add' ? 'add' : 'counter');
  if (value === null) {
    if (note) {
      note.textContent = mode === 'add'
        ? 'Введите целое число больше нуля, не больше ' + FAST_MAX_INPUT + '.'
        : 'Введите целое число от 0 до ' + FAST_MAX_INPUT + '.';
    }
    return;
  }

  if (mode === 'add') {
    if (!addFast(fast, value)) return;
  } else {
    // Первого ключа ещё нет — заводим его здесь же
    if (!setFast(fast || { version: FAST_VERSION, remaining: 0, history: [] }, value)) return;
  }

  if (note) note.textContent = '';
  if (field) field.value = '';

  fastInitMode = null;
  renderFastView();
}

// Уход с экрана из switchAppView: незакрытая форма не переживает переход,
// возвращаться к наполовину заполненному полю незачем
export function resetFastForm() {
  fastInitMode = null;
}
