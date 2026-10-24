import { toISODate } from '../core/dates.js';
import { escapeHtml, setHidden, showToast } from '../core/dom.js';
import { getRecord } from '../data/records.js';
import { bus } from '../core/bus.js';
import { NAMAZ_LABELS, NAMAZ_ORDER, QAZA_DAILY_GOAL, QAZA_HABIT_ID, addMissedQaza, getQazaPlan, kazaDayFor, loadQaza, markQazaDone, normalizeQazaCursor, qazaTotalRemaining, saveQaza, undoQazaDone } from '../data/qaza.js';
// Состояние очереди каза. Заполняется в init(), дальше меняется только вкладкой.
export let qazaState = null;
// Намаз, выбранный в блоке ручного добавления. Живёт только в интерфейсе
// и не сохраняется: это ещё не решение, а подготовка к нажатию «Добавить».
export let qazaAddPick = null;
export function renderQazaView() {
  if (!qazaState) return;

  const total = qazaTotalRemaining(qazaState);

  const summary = document.getElementById('qaza-summary');
  if (summary) {
    summary.textContent = 'Осталось всего: ' + total +
      ' · Цель: ' + QAZA_DAILY_GOAL + ' намаза в день';
  }

  // Когда очередь исчерпана, выбирать стартовый намаз не из чего
  setHidden('qaza-start-block', total === 0);

  renderQazaRemaining();
  renderQazaStart();
  renderQazaPlan();
  renderQazaAdd();
}
// Выбор намаза для ручного добавления: пять радио в виде пилюль, как в блоке
// «Откуда продолжаем?». По умолчанию не выбрано ничего — программа не берётся
// угадывать, какой именно намаз человек забыл.
export function renderQazaAdd() {
  const box = document.getElementById('qaza-add');
  const button = document.getElementById('qaza-add-btn');

  // Подтверждать нечего, пока намаз не выбран
  if (button) button.disabled = qazaAddPick === null;
  if (!box) return;

  let html = '';
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const isPicked = i === qazaAddPick;

    html += '<label class="qaza-add-option' + (isPicked ? ' is-picked' : '') + '">' +
      '<input type="radio" class="qaza-add-radio" name="qaza-add" value="' + i + '"' +
      (isPicked ? ' checked' : '') + '>' +
      '<span class="qaza-add-name">' + escapeHtml(NAMAZ_LABELS[NAMAZ_ORDER[i]]) + '</span>' +
      (isPicked ? '<span class="qaza-add-mark">выбран</span>' : '') +
      '</label>';
  }

  box.innerHTML = html;
}
// Выбор намаза в блоке добавления: только подсветка, состояние очереди не трогается.
// Обработчик делегирован на #qaza-add, потому что список перерисовывается.
export function onQazaAddPick(event) {
  const target = event && event.target;
  if (!target || !target.classList || !target.classList.contains('qaza-add-radio')) return;

  const index = parseInt(target.value, 10);
  if (!Number.isInteger(index) || index < 0 || index >= NAMAZ_ORDER.length) return;

  qazaAddPick = index;
  renderQazaAdd();
  restoreQazaRadioFocus('qaza-add', 'qaza-add-radio');
}
// Подтверждение добавления: остаток выбранного намаза растёт на единицу,
// счётчик дня и курсор очереди остаются на месте.
export function onQazaAddSubmit() {
  if (qazaAddPick === null) return;

  // Ручное добавление тоже идёт в день каза: ночью до Фаджра это вчера (§5)
  if (!addMissedQaza(qazaState, NAMAZ_ORDER[qazaAddPick], kazaDayFor(new Date()))) return;

  // После добавления выбор сбрасывается: повторное нажатие не должно
  // записать тот же намаз второй раз
  qazaAddPick = null;
  renderQazaView();
  bus.emit('qaza:changed');
}
// Выбор стартового намаза: пять радио. Текущий помечен рамкой и словом «сейчас»,
// чтобы выбор не передавался только цветом.
export function renderQazaStart() {
  const box = document.getElementById('qaza-start');
  if (!box) return;

  let html = '';
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const isCursor = i === qazaState.cursor;

    html += '<label class="qaza-start-option' + (isCursor ? ' is-cursor' : '') + '">' +
      '<input type="radio" class="qaza-start-radio" name="qaza-start" value="' + i + '"' +
      (isCursor ? ' checked' : '') + '>' +
      '<span class="qaza-start-name">' + escapeHtml(NAMAZ_LABELS[NAMAZ_ORDER[i]]) + '</span>' +
      (isCursor ? '<span class="qaza-start-mark">сейчас</span>' : '') +
      '</label>';
  }

  box.innerHTML = html;
}
// Смена стартового намаза: курсор переставляется и план пересчитывается.
// Обработчик делегирован на #qaza-start, потому что список перерисовывается.
export function onQazaStartChange(event) {
  const target = event && event.target;
  if (!target || !target.classList || !target.classList.contains('qaza-start-radio')) return;

  const index = parseInt(target.value, 10);
  if (!Number.isInteger(index) || index < 0 || index >= NAMAZ_ORDER.length) return;

  qazaState.cursor = index;

  // Курсор обязан указывать на намаз с остатком > 0
  normalizeQazaCursor(qazaState);

  if (!saveQaza(qazaState)) return;
  renderQazaView();
  restoreQazaRadioFocus('qaza-start', 'qaza-start-radio');
}
// Перерисовка списка радио уносит фокус вместе со старыми узлами, и обход
// стрелками обрывается. Возвращаем фокус на выбранный вариант.
// На мышиный клик это не влияет: :focus-visible тогда не срабатывает.
export function restoreQazaRadioFocus(boxId, radioClass) {
  const box = document.getElementById(boxId);
  if (!box) return;

  const checked = box.querySelector('.' + radioClass + ':checked');
  if (checked) checked.focus({ preventScroll: true });
}
// Список пяти намазов с остатками. Текущий помечен рамкой и словом «сейчас»,
// чтобы информация не передавалась только цветом.
export function renderQazaRemaining() {
  const box = document.getElementById('qaza-remaining');
  if (!box) return;

  let html = '';
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const key = NAMAZ_ORDER[i];
    const isCursor = i === qazaState.cursor;
    const isEmpty = qazaState.remaining[key] === 0;

    html += '<div class="qaza-row' + (isCursor ? ' is-cursor' : '') +
      (isEmpty ? ' is-empty' : '') + '">' +
      '<span class="qaza-row-name">' + escapeHtml(NAMAZ_LABELS[key]) + '</span>' +
      (isCursor ? '<span class="qaza-row-mark">сейчас</span>' : '') +
      '<span class="qaza-count">' + escapeHtml(qazaState.remaining[key]) + '</span>' +
      '</div>';
  }

  box.innerHTML = html;
}
// План на сегодня. Кнопка «Выполнено» есть только у первого пункта:
// очередь строго последовательная, перепрыгнуть её нельзя.
export function renderQazaPlan() {
  const box = document.getElementById('qaza-plan');
  const note = document.getElementById('qaza-note');
  const undo = document.getElementById('qaza-undo');
  const startLabel = document.getElementById('qaza-plan-start');
  if (!box) return;

  // День каза, а не календарный: запись, зачтённая ночью во вчера, отменяется
  // оттуда же, куда легла (§7)
  const today = kazaDayFor(new Date());
  const plan = getQazaPlan(qazaState);

  if (undo) {
    const last = qazaState.history[qazaState.history.length - 1];
    undo.disabled = !last || last.date !== today;
  }

  if (plan.length === 0) {
    box.innerHTML = '';
    if (startLabel) {
      startLabel.hidden = true;
      startLabel.textContent = '';
    }
    if (note) {
      note.hidden = false;
      note.textContent = 'Все каза выполнены. Остатков не осталось.';
    }
    return;
  }

  if (note) {
    note.hidden = true;
    note.textContent = '';
  }

  // Всегда видно, откуда программа отсчитывает план
  if (startLabel) {
    startLabel.hidden = false;
    startLabel.textContent = 'Начать с: ' + NAMAZ_LABELS[NAMAZ_ORDER[qazaState.cursor]];
  }

  let html = '';
  for (let i = 0; i < plan.length; i++) {
    const key = NAMAZ_ORDER[plan[i]];
    const isCurrent = i === 0;

    html += '<div class="qaza-plan-item' + (isCurrent ? ' is-current' : '') + '">' +
      '<span class="qaza-plan-name">' + escapeHtml(NAMAZ_LABELS[key]) + '</span>' +
      (isCurrent
        ? '<button type="button" id="qaza-done" class="btn btn-primary">Выполнено</button>'
        : '<span class="qaza-plan-next">дальше</span>') +
      '</div>';
  }

  box.innerHTML = html;
}
// Нажатие «Выполнено». Обработчик делегирован на #qaza-plan, потому что
// содержимое плана перерисовывается целиком.
// День берётся не календарный, а день каза (§5): ночью до Фаджра выполнение
// уходит во вчерашний день, и об этом говорит тост — иначе отметка в таблице
// встала бы не туда, где её ищут (§6).
export function onQazaDone(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== 'function') return;
  if (!target.closest('#qaza-done')) return;

  const day = kazaDayFor(new Date());
  if (!markQazaDone(qazaState, day)) return;
  renderQazaView();
  bus.emit('qaza:changed');

  if (day !== toISODate(new Date())) showToast('Каза зачтена во вчерашний день');
}
// Отмена работает с тем днём, к которому отнесена верхняя запись (§7):
// запись, зачтённая вчера, снимается там же, где и легла.
export function onQazaUndo() {
  if (!undoQazaDone(qazaState, kazaDayFor(new Date()))) return;
  renderQazaView();
  bus.emit('qaza:changed');
}
// Разметка ячейки каза: число выполненных за день либо прочерк
export function qazaCellMarkup(date) {
  const value = getRecord(date, QAZA_HABIT_ID);
  const isEmpty = typeof value !== 'number';
  return '<span class="cell-qaza' + (isEmpty ? ' is-empty' : '') + '">' +
    escapeHtml(isEmpty ? '—' : String(value)) + '</span>';
}

// Состояние очереди принадлежит этому модулю; остальным — доступ.
// Переприсваивать импортированный let нельзя, поэтому три функции.
export function getQazaState() {
  return qazaState;
}

export function setQazaState(value) {
  qazaState = value;
}

// Ленивая инициализация при входе на экран: init и статистика зовут её
export function ensureQazaState() {
  if (!qazaState) qazaState = loadQaza();
}
