import { debounce } from '../core/debounce.js';
import { escapeHtml } from '../core/dom.js';
import { actualWakeTime, loadSleep, saveSleep, sleepAnchors, sleepCycleLabel, sleepCycleTimes, sleepDurationMinutes, sleepFallMinutes, sleepFormatDuration, sleepTimeMinutes } from '../data/sleep.js';
// Значение поля экрана. Поля читаются как есть: набор, который видит человек
export function sleepFieldValue(id) {
  const field = document.getElementById(id);
  return field ? field.value : '';
}
// Состояние галочки «встану по рекомендации». Снятая галочка и отсутствие
// элемента — одно и то же: без экрана решения нет, и по умолчанию идёт цель
export function sleepFollowRec() {
  const box = document.getElementById('sleep-follow-rec');
  return !!box && box.checked === true;
}
// Синхронизация поля фактического подъёма: видимость и подсказка. Вызывается
// из renderSleepView и onSleepFieldChange. Галочка «встал по плану» отмечена —
// поле скрыто, подсказка очищена. Галочка снята, поле пустое — подсказка
// «Введите время, во сколько встали». Галочка снята, поле заполнено, но
// время не разбирается — подсказка «Введите время в формате ЧЧ:ММ».
// Иначе — подсказка очищена
export function syncRealWakeField() {
  const onPlanBox = document.getElementById('sleep-on-plan');
  const field = document.getElementById('sleep-real-wake-field');
  const note = document.getElementById('sleep-real-wake-note');
  const input = document.getElementById('sleep-real-wake');
  if (!onPlanBox || !field || !note || !input) return;

  if (onPlanBox.checked) {
    field.hidden = true;
    note.textContent = '';
    return;
  }

  field.hidden = false;
  if (!input.value) {
    note.textContent = 'Введите время, во сколько встали';
  } else if (sleepTimeMinutes(input.value) === null) {
    note.textContent = 'Введите время в формате ЧЧ:ММ';
  } else {
    note.textContent = '';
  }
}
// Решение по текущим полям: что уйдёт в историю и сколько это минут. Одно
// место, где из трёх полей и галочки собирается ответ; им пользуются и
// отрисовка, и запись, поэтому разойтись они не могут. Пустое или неверное
// любое из полей — null
export function sleepDecision() {
  const bed = sleepFieldValue('sleep-bed');
  const wake = sleepFieldValue('sleep-wake');
  const fall = sleepFallMinutes(sleepFieldValue('sleep-fall'));
  if (fall === null) return null;

  const followRec = sleepFollowRec();
  const actualWake = actualWakeTime(bed, fall, wake, followRec);
  if (actualWake === null) return null;

  const sleepMin = sleepDurationMinutes(bed, fall, actualWake);
  if (sleepMin === null) return null;

  // Фактический подъём: галочка «встал по плану» снята — поле времени
  // обязательно, иначе запись в хранилище не идёт
  const onPlanBox = document.getElementById('sleep-on-plan');
  const realWakeField = document.getElementById('sleep-real-wake');
  const onPlan = !!onPlanBox && onPlanBox.checked;
  let realWake = null;
  let ready = true;
  if (!onPlan) {
    const realWakeValue = realWakeField ? realWakeField.value : '';
    if (realWakeValue) {
      const parsed = sleepTimeMinutes(realWakeValue);
      if (parsed !== null) {
        realWake = realWakeValue;
      } else {
        ready = false;
      }
    } else {
      ready = false;
    }
  }

  const realSleepMin = realWake !== null
    ? sleepDurationMinutes(bed, fall, realWake)
    : null;

  const excludedBox = document.getElementById('sleep-excluded');
  const excluded = !!excludedBox && excludedBox.checked === true;

  return {
    bed: bed,
    fall: fall,
    wake: wake,
    followRec: followRec,
    actualWake: actualWake,
    sleepMin: sleepMin,
    realWake: realWake,
    realSleepMin: realSleepMin,
    excluded: excluded,
    ready: ready,
  };
}
// Вход на экран: три поля и галочка заполняются сохранённым, затем считается
// итог. Записи нет — поля остаются пустыми, галочка снята, и итог тоже пуст.
// Галочка ставится сравнением actualWake с wake: отдельного поля у неё нет,
// а «встаю по рекомендации» — это ровно случай, когда времена разошлись.
// Совпадение (будильник ровно на конце цикла) галочку не вернёт, но разницы
// там нет: оба режима дают одно и то же время
export function renderSleepView() {
  const sleep = loadSleep();
  const follow = document.getElementById('sleep-follow-rec');
  if (follow) follow.checked = !!sleep && sleep.actualWake !== sleep.wake;
  if (sleep) {
    const bed = document.getElementById('sleep-bed');
    const fall = document.getElementById('sleep-fall');
    const wake = document.getElementById('sleep-wake');
    if (bed) bed.value = sleep.bed;
    if (fall) fall.value = String(sleep.fall);
    if (wake) wake.value = sleep.wake;
  } else {
    const onPlan = document.getElementById('sleep-on-plan');
    if (onPlan) onPlan.checked = true;
    const realWake = document.getElementById('sleep-real-wake');
    if (realWake) realWake.value = '';
    const excluded = document.getElementById('sleep-excluded');
    if (excluded) excluded.checked = false;
  }
  if (sleep) {
    const onPlan = document.getElementById('sleep-on-plan');
    if (onPlan) onPlan.checked = sleep.realWake === null;
    const realWake = document.getElementById('sleep-real-wake');
    if (realWake) realWake.value = sleep.realWake || '';
    const excluded = document.getElementById('sleep-excluded');
    if (excluded) excluded.checked = sleep.excluded === true;
  }
  syncRealWakeField();
  renderSleepResult();
}
// Итог по трём полям и галочке. Пустое или неверное любое из полей —
// результата нет вовсе: половина расчёта хуже, чем его отсутствие
export function renderSleepResult() {
  const box = document.getElementById('sleep-result');
  if (!box) return;

  const decision = sleepDecision();
  const result = decision === null
    ? null
    : sleepCycleTimes(decision.bed, decision.fall, decision.wake);

  if (!decision || !result) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = sleepResultMarkup(decision, result);
}
// Разметка итога: крупный будильник, время для истории, длительность сна,
// пояснение, список циклов и полоска. Крупным у пары вариантов идёт первый —
// тот, что раньше: подсвечены в списке оба, а решает человек. Время для
// истории считается от галочки и с крупным может не совпасть: там ближайший
// конец цикла, здесь — то, что человек выбрал
export function sleepResultMarkup(decision, result) {
  const pick = result.recommended[0];
  const parts = [];

  parts.push('<p class="sleep-alarm">Будильник: ' + escapeHtml(pick.time) + '</p>');
  let actualText;
  if (decision.realWake) {
    actualText = 'В историю: ' + decision.realWake + ' (по факту)';
  } else if (decision.followRec) {
    actualText = 'В историю: ' + decision.actualWake + ' (по рекомендации)';
  } else if (decision.ready === true) {
    actualText = 'В историю: ' + decision.actualWake + ' (по цели)';
  } else {
    actualText = 'В историю: —';
  }
  parts.push('<p class="sleep-actual">' + escapeHtml(actualText) + '</p>');
  parts.push('<p class="sleep-duration">Сон: ' +
    escapeHtml(sleepFormatDuration(decision.realSleepMin ?? decision.sleepMin)) + '</p>');

  let detail = sleepCycleLabel(pick.cycles) + ', ' + sleepFormatDuration(pick.sleepMinutes);
  if (result.recommended.length === 2) {
    detail += ' · встать раньше — ' + result.recommended[0].time +
      ', встать позже — ' + result.recommended[1].time;
  }
  parts.push('<p class="sleep-detail">' + escapeHtml(detail) + '</p>');

  parts.push('<div class="sleep-cycles">');
  for (let i = 0; i < result.cycles.length; i++) {
    const cycle = result.cycles[i];
    const recommended = result.recommended.indexOf(cycle) !== -1;
    parts.push('<p' + (recommended ? ' class="is-recommended"' : '') + '>' +
      escapeHtml(sleepCycleLabel(cycle.cycles) + ' — ' + cycle.time) + '</p>');
  }
  parts.push('</div>');

  parts.push(sleepBarMarkup(decision.bed, decision.fall, decision.wake, result.cycles));
  return parts.join('');
}
// Полоска: по горизонтали — от отхода до конца последнего цикла. Засечки
// нарисованы узкими прямоугольниками, а не линиями: viewBox растягивается
// по ширине карточки неравномерно (preserveAspectRatio="none"), и толщина
// штриха у линии поехала бы вместе с растяжением. Метка подъёма — акцентная
// и заметно шире засечки; за последним циклом она прижимается к краю
export function sleepBarMarkup(bed, fall, wake, cycles) {
  const anchors = sleepAnchors(bed, fall, wake);
  if (!anchors || !cycles.length) return '';

  const span = anchors.asleepMinutes + cycles[cycles.length - 1].sleepMinutes -
    anchors.bedMinutes;
  if (span <= 0) return '';

  function at(minutes) {
    const percent = ((minutes - anchors.bedMinutes) / span) * 100;
    return Math.max(0, Math.min(100, percent));
  }

  const parts = [];
  parts.push('<div class="sleep-bar">');
  parts.push('<svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">');
  parts.push('<rect class="sleep-bar-track" x="0" y="17" width="100" height="6"></rect>');
  for (let i = 0; i < cycles.length; i++) {
    const tick = (at(anchors.asleepMinutes + cycles[i].sleepMinutes) - 0.3).toFixed(2);
    parts.push('<rect class="sleep-bar-tick" x="' + tick +
      '" y="11" width="0.6" height="18"></rect>');
  }
  const mark = (at(anchors.wakeMinutes) - 0.5).toFixed(2);
  parts.push('<rect class="sleep-bar-wake" x="' + mark +
    '" y="5" width="1" height="30"></rect>');
  parts.push('</svg>');
  parts.push('</div>');
  return parts.join('');
}
// Правка любого поля или галочки: пересчёт и итог — сразу, запись — с
// задержкой. Аудит 2026-10-31: раньше каждый тик ввода (input на каждое
// движение колеса времени) перечитывал и перезаписывал весь ключ сна с
// дневником. Теперь серия правок даёт одну запись — через 500 мс от
// последнего события, последним решением. Галочка идёт сюда же — она меняет
// то же решение, а формы на экране нет, отправлять нечего. Слушаются оба
// события полей: колесо времени на телефоне присылает только change
const SLEEP_SAVE_DEBOUNCE_MS = 500;
// Запись решения в хранилище. Неудача saveSleep (хранилище отказало) —
// полный рендер экрана: поля перечитываются из данных, как раньше.
function commitSleepDecision(decision) {
  if (!saveSleep({
    bed: decision.bed,
    fall: decision.fall,
    wake: decision.wake,
    actualWake: decision.actualWake,
    sleepMin: decision.sleepMin,
    realWake: decision.realWake,
    realSleepMin: decision.realSleepMin,
    excluded: decision.excluded,
  })) {
    renderSleepView();
    syncRealWakeField();
  }
}
const debouncedSleepSave = debounce(commitSleepDecision, SLEEP_SAVE_DEBOUNCE_MS);

export function onSleepFieldChange() {
  syncRealWakeField();
  const decision = sleepDecision();
  if (!decision || !decision.ready) return;

  // Итог на экране — мгновенно: он считается из полей, запись не ждёт
  renderSleepResult();
  debouncedSleepSave(decision);
}
// Уход со вкладки или с экрана сна: отложенная запись выполняется сразу,
// чтобы последний ввод не потерялся вместе с закрытой страницей.
export function flushPendingSleepSave() {
  debouncedSleepSave.flush();
}
