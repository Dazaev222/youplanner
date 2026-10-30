import { bus } from '../core/bus.js';
import { toISODate } from '../core/dates.js';
import { safeSetItem } from '../core/storage.js';
// Ключ свой, отдельный от каза-намазов: счётчики независимы (§5).
// Отсутствие ключа — это и есть первый запуск; дефолта у уразы нет,
// начальное число задаёт человек.
export const FAST_KEY = 'youplanner.qaza.fast';
// Версия схемы. 1 — растущая история событий с полем source.
export const FAST_VERSION = 1;
// Источник записи истории: 'set' — первый запуск и «Изменить счётчик»,
// 'done' — «Возместить 1 день», 'add' — «Добавить уразу».
export const FAST_SOURCE_SET = 'set';
export const FAST_SOURCE_DONE = 'done';
export const FAST_SOURCE_ADD = 'add';
// Больше этого числа за раз не принимается: случайное нажатие не должно
// раздувать счётчик, а опечатка — историю
export const FAST_MAX_INPUT = 100000;
// Меньше этого числа событий за всё время — графика нет: три столбика на всю
// ширину карточки читались бы как «истории достаточно», хотя её почти нет
export const FAST_HISTORY_MIN = 5;

// Чистка истории. Пришла из хранилища, с сервера или из файла копии — правило
// одно: элемент годится, если это объект с датой 'YYYY-MM-DD', неотрицательным
// конечным числом и известным источником. Битые записи отбрасываются молча:
// история растёт годами, и одна испорченная строка не должна ронять счётчик
// или подменять цифры статистики (§5)
export function validFastHistory(history) {
  if (!Array.isArray(history)) return [];

  return history.filter(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return false;
    if (!Number.isFinite(item.count) || item.count < 0) return false;
    return item.source === FAST_SOURCE_SET || item.source === FAST_SOURCE_DONE ||
      item.source === FAST_SOURCE_ADD;
  });
}
// Чтение с проверкой. null — единственный признак первого запуска: нет ключа,
// битый JSON, не объект, остаток не число или отрицательный, история не массив.
// История при чтении чистится, а не отклоняется: счётчик из-за одной битой
// записи не теряется — он важнее истории (§5). В отличие от loadQaza() ничего
// не пишет: пустое хранилище здесь значит «число ещё не задано», а не «пора
// поставить дефолт».
export function loadFast() {
  try {
    const raw = localStorage.getItem(FAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Number.isFinite(parsed.remaining) || parsed.remaining < 0) return null;
    if (!Array.isArray(parsed.history)) return null;

    return {
      version: FAST_VERSION,
      remaining: Math.floor(parsed.remaining),
      history: validFastHistory(parsed.history),
    };
  } catch (e) {
    return null;
  }
}
// Запись ключа. Остаток приводится к целому и неотрицательному ещё раз:
// счётчик не может уйти в минус, откуда бы значение ни пришло.
export function saveFast(fast) {
  if (!fast || !Number.isFinite(fast.remaining)) return;

  if (!safeSetItem(FAST_KEY, JSON.stringify({
    version: FAST_VERSION,
    remaining: Math.max(0, Math.floor(fast.remaining)),
    history: Array.isArray(fast.history) ? fast.history : [],
  }))) return false;
  bus.emit('data:changed');
  return true;
}
// Общий помощник: одно событие в историю. Это растущий массив, а не стек:
// он не чистится по датам и нужен целиком разделу «Статистика» (§5).
// Интерфейс историю не читает — только пишет.
export function appendFastHistory(fast, count, source) {
  if (!fast || !Array.isArray(fast.history)) return;
  fast.history.push({ date: toISODate(new Date()), count: count, source: source });
}
// «Возместить 1 день». Возмещённый пост — факт, отмены у него нет.
// Проверка на остаток обязательна и здесь: погашенная кнопка — подсказка,
// а не защита, и обработчик не должен полагаться только на неё.
export function markFastDone(fast) {
  if (!fast || !Number.isFinite(fast.remaining) || fast.remaining <= 0) return false;

  const snapshot = JSON.parse(JSON.stringify(fast));
  fast.remaining -= 1;
  appendFastHistory(fast, 1, FAST_SOURCE_DONE);
  if (!saveFast(fast)) {
    Object.keys(fast).forEach(function (key) { delete fast[key]; });
    Object.assign(fast, snapshot);
    return false;
  }
  return true;
}
// «Добавить уразу»: остаток растёт на введённое число
export function addFast(fast, count) {
  if (!fast || !Number.isFinite(count) || count <= 0) return false;

  const snapshot = JSON.parse(JSON.stringify(fast));
  fast.remaining += count;
  appendFastHistory(fast, count, FAST_SOURCE_ADD);
  if (!saveFast(fast)) {
    Object.keys(fast).forEach(function (key) { delete fast[key]; });
    Object.assign(fast, snapshot);
    return false;
  }
  return true;
}
// «Изменить счётчик»: перезапись остатка, а не прибавка. Ошибки ввода
// исправляются только здесь — отдельной отмены у раздела нет.
export function setFast(fast, count) {
  if (!fast || !Number.isFinite(count) || count < 0) return false;

  const snapshot = JSON.parse(JSON.stringify(fast));
  fast.remaining = count;
  appendFastHistory(fast, count, FAST_SOURCE_SET);
  if (!saveFast(fast)) {
    Object.keys(fast).forEach(function (key) { delete fast[key]; });
    Object.assign(fast, snapshot);
    return false;
  }
  return true;
}
// Разбор введённого числа. Принимается только целое: пустое, дробное,
// отрицательное, нечисловое и больше FAST_MAX_INPUT отклоняются — null.
// mode 'counter' — первый запуск и «Изменить счётчик» (≥ 0),
// mode 'add' — «Добавить уразу» (> 0, ноль не принимается: прибавлять нечего).
export function parseFastInput(text, mode) {
  const raw = text === null || text === undefined ? '' : String(text).trim();
  if (!/^\d+$/.test(raw)) return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value > FAST_MAX_INPUT) return null;
  if (mode === 'add' && value === 0) return null;

  return value;
}
// Склонение «день / дня / дней»: 1 и 21 — день, 2–4 и 22–24 — дня,
// 0, 5–20 и 11–14 — дней
export function fastRemainingLabel(n) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;

  let word;
  if (mod100 >= 11 && mod100 <= 14) word = 'дней';
  else if (mod10 === 1) word = 'день';
  else if (mod10 >= 2 && mod10 <= 4) word = 'дня';
  else word = 'дней';

  return 'Ураза: осталось ' + n + ' ' + word;
}
// Сводка уразы за период одним проходом по истории (§5): значения по дням,
// суммы «Возмещено» и «Добавлено» и начало истории. Правило раньше жило
// целиком в отрисовке статистики: dayIndex, разбор по источникам, минимум
// даты — это арифметика хранилища, и view не должен её повторять, иначе
// следующая цифра на другом экране посчитала бы период иначе. values[i]
// отвечает dates[i]: день ищется через dayIndex, значение дня складывается,
// а не присваивается — appendFastHistory пишет по событию на запись, но
// правило суммы не вымирает вместе с этим обещанием. В значения и в done
// попадают только done-события: «Возместить 1 день» — факт; add растит
// остаток и идёт в added, set — перезапись счётчика, графику «Возмещено
// по дням» чужая. since — минимум по ВСЕЙ истории, а не по периоду:
// «История копится с» не должно меняться от выбранного окна, поэтому дата
// снимается до отсечения чужих дней. Истории нет или она не массив —
// нули и since null: читать нечего
export function fastPeriodStats(fast, dates) {
  const values = [];
  if (!Array.isArray(dates)) return { values: values, done: 0, added: 0, since: null };

  const dayIndex = {};
  for (let i = 0; i < dates.length; i++) {
    dayIndex[dates[i]] = i;
    values.push(0);
  }

  let done = 0;
  let added = 0;
  let since = null;

  const history = fast && Array.isArray(fast.history) ? fast.history : [];
  for (let i = 0; i < history.length; i++) {
    const event = history[i];
    // Начало истории — по всей истории, а не по периоду
    if (since === null || event.date < since) since = event.date;

    const day = dayIndex[event.date];
    if (day === undefined) continue;
    if (event.source === FAST_SOURCE_DONE) {
      done += event.count;
      values[day] += event.count;
    } else if (event.source === FAST_SOURCE_ADD) {
      added += event.count;
    }
  }

  return { values: values, done: done, added: added, since: since };
}
