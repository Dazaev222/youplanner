import { bus } from '../core/bus.js';
import { addDays, toISODate } from '../core/dates.js';
import { safeSetItem } from '../core/storage.js';
import { STORAGE_KEYS } from './storage.js';
// Привычки с уровнями: у них запись — объект { value, level }, а у привычки
// есть необязательное время time (§1.1). Id из спеки трекера, как у каза.
export const SPORT_HABIT_ID = 'h7';
export const QURAN_HABIT_ID = 'h8';
export const PRESS_HABIT_ID = 'h12';
// Уровни выполнения записи
export const LEVEL_ON_TIME = 'on-time';
export const LEVEL_LATE = 'late';
export const LEVEL_TWO_MIN = 'two-min';
// Окно «вовремя» — ±60 минут от назначенного времени (§1.6)
export const LEVEL_WINDOW_MIN = 60;
// Варианты привычек «Спорт» и «Пресс»: «да», «нет», «2 минуты», «отдых» (§3.1).
// «Отдых» — запланированный пропуск: уровня у него нет, серию он не рвёт
// и в прогресс не входит.
export const SPORT_VALUES = ['yes', 'no', 'two-min', 'rest'];
export const SPORT_VALUE_LABELS = {
  'yes': 'да',
  'no': 'нет',
  'two-min': '2 минуты',
  'rest': 'отдых',
};
// Коды прежней схемы. «Частично» убрано из списка, но в записях его
// достаточно, и оно читается как «2 минуты» (§3.2).
export const SPORT_LEGACY_VALUES = {
  'да': 'yes',
  'нет': 'no',
  'частично': 'two-min',
  'отдых': 'rest',
};


// Кэш записей: null — «ещё не загружено», {} — валидное «записей нет».
export let recordsCache = null;
export function invalidateRecordsCache() {
  recordsCache = null;
}
// Возвращает объект записей. Битый JSON или не-объект → пустой объект.
// Возвращает общий кэш-объект. Мутирующие пути (setRecord, removeHabit)
// опираются на то, что это тот же объект, что потом уходит в saveRecords.
// Наружу этот объект не передавай и не мутируй без отката.
export function loadRecords() {
  if (recordsCache !== null) return recordsCache;

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.records);
    if (!raw) {
      recordsCache = {};
      return recordsCache;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      recordsCache = {};
      return recordsCache;
    }
    recordsCache = parsed;
    return recordsCache;
  } catch (e) {
    recordsCache = {};
    return recordsCache;
  }
}
// write-through: после успешной записи кэш — тот же объект,
// что лёг на диск. При провале вызывающий (setRecord/removeHabit) откатит
// его in-place; кэш трогать нельзя, иначе откат разойдётся с кэшем.
export function saveRecords(records) {
  const ok = safeSetItem(STORAGE_KEYS.records, JSON.stringify(records));
  if (ok) recordsCache = records;
  return ok;
}
// Значение привычки в конкретный день или undefined, если записи нет
export function getRecord(date, habitId) {
  const records = loadRecords();
  const day = records[date];
  if (!day) return undefined;
  return Object.prototype.hasOwnProperty.call(day, habitId) ? day[habitId] : undefined;
}
// Запись значения. undefined/null/'' — удаление записи.
// Значения 0 и false значимы и сохраняются.
export function setRecord(date, habitId, value) {
  const records = loadRecords();
  const dayExisted = Object.prototype.hasOwnProperty.call(records, date);
  const daySnapshot = dayExisted ? JSON.parse(JSON.stringify(records[date])) : null;
  const isDelete = value === undefined || value === null || value === '';

  if (isDelete) {
    const day = records[date];
    if (!day || !Object.prototype.hasOwnProperty.call(day, habitId)) return true;
    delete day[habitId];
    // Если день опустел — удаляем и ключ даты
    if (Object.keys(day).length === 0) delete records[date];
  } else {
    if (!records[date]) records[date] = {};
    records[date][habitId] = value;
  }

  if (!saveRecords(records)) {
    // Запись не удалась: откатываем только изменённый день.
    if (dayExisted) {
      records[date] = daySnapshot;
    } else {
      delete records[date];
    }
    return false;
  }
  bus.emit('data:changed');
  return true;
}
// Спорт и Пресс — привычки типа choice со своим списком кодов вместо общего
export function isChoiceLevelHabit(habitId) {
  return habitId === SPORT_HABIT_ID || habitId === PRESS_HABIT_ID;
}
// Есть ли у привычки уровни
export function isLevelHabit(habitId) {
  return isChoiceLevelHabit(habitId) || habitId === QURAN_HABIT_ID;
}
// У кого есть попап уровня. Только у Корана: у Спорта «2 минуты» уже стоят
// пунктом в самом списке, и второй способ задать тот же уровень не нужен (§11r).
export function hasLevelPopup(habitId) {
  return habitId === QURAN_HABIT_ID;
}
// Приводит запись к виду { value, level }. Старые записи — скаляр (число
// страниц или строка варианта) — читаются как { value: оно, level: null };
// перезапись в localStorage при чтении не делается. null — записи нет.
export function normalizeEntry(habitId, raw) {
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      value: raw.value === undefined ? null : raw.value,
      level: raw.level || null,
    };
  }

  if (isChoiceLevelHabit(habitId)) {
    // Старое «частично» — это и есть «2 минуты», и уровень у него голубой
    const value = SPORT_LEGACY_VALUES[raw] || raw;
    return { value: value, level: value === LEVEL_TWO_MIN ? LEVEL_TWO_MIN : null };
  }

  return { value: raw, level: null };
}
// Запись в виде { value, level } или null. У привычек без уровней запись
// остаётся скаляром и просто оборачивается.
export function getEntry(date, habitId) {
  const raw = getRecord(date, habitId);
  if (raw === undefined) return null;
  if (!isLevelHabit(habitId)) return { value: raw, level: null };
  return normalizeEntry(habitId, raw);
}
// Значение записи без уровня — то, что показывает поле отметки
export function recordValue(date, habitId) {
  const entry = getEntry(date, habitId);
  return entry ? entry.value : undefined;
}
// 'HH:MM' → минуты от полуночи; null, если строка не время
export function habitTimeMinutes(time) {
  if (typeof time !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
// Уровень по времени отметки: 'on-time' — в окне ±60 минут от назначенного,
// 'late' — вне окна, null — время у привычки не задано (§1.6). При null
// граница поля не красится вовсе.
export function habitLevelByTime(habit, now) {
  if (!habit || habit.time === null || habit.time === undefined) return null;
  const plan = habitTimeMinutes(habit.time);
  if (plan === null) return null;

  const minutes = now.getHours() * 60 + now.getMinutes();
  // Окно вокруг назначенного момента может переходить через полночь: при
  // time = '23:30' отметка в 00:15 ближе по короткой дуге (45 минут), чем
  // линейно (1395). Расстояние берём меньшее из двух — тем же правилом живёт
  // habitMarkDate (§4), иначе две функции одного окна расходятся (§11aa, В1).
  const forward = Math.abs(minutes - plan);
  const around = 1440 - forward;
  const distance = Math.min(forward, around);
  return distance <= LEVEL_WINDOW_MIN ? LEVEL_ON_TIME : LEVEL_LATE;
}
// День, к которому относится отметка (§4). time = '23:30', отметка в 00:15 —
// это ещё вчера: окно вокруг назначенного момента переходит через полночь.
// Правило смотрит только на сегодняшнюю колонку: день, выбранный руками,
// человек выбрал осознанно.
export function habitMarkDate(habit, date, now) {
  if (!habit || !isLevelHabit(habit.id)) return date;
  if (date !== toISODate(now)) return date;

  const plan = habitTimeMinutes(habit.time);
  if (plan === null) return date;

  // Сколько минут от назначенного момента до полуночи плюс сколько прошло
  // после неё — расстояние по часовой стрелке через границу суток
  const beforeMidnight = 24 * 60 - plan;
  const afterMidnight = now.getHours() * 60 + now.getMinutes();
  if (beforeMidnight + afterMidnight > LEVEL_WINDOW_MIN) return date;

  return toISODate(addDays(now, -1));
}
// Уровень обычного выполнения: «2 минуты» — само себе уровень (§3.4),
// у Спорта выполнением считается только ответ «да» — «нет» и «отдых»
// уровнем не отмечаются, а у Корана и «да» он выводится из времени
// отметки и бывает пустым, когда время у привычки не задано (§1.6).
export function defaultLevel(habit, value) {
  if (value === LEVEL_TWO_MIN) return LEVEL_TWO_MIN;
  if (isChoiceLevelHabit(habit.id) && value !== 'yes') return null;
  return habitLevelByTime(habit, new Date());
}
// Запись отметки вместе с уровнем. value: undefined — запись удаляется,
// вместе с ней уходит и уровень. Объектную запись получают только привычки
// с уровнями: у остальных значение остаётся скаляром, как было, — иначе
// чужая схема разошлась бы с уже сохранёнными записями.
export function writeHabitEntry(habit, date, value, level) {
  if (!habit) return false;
  if (value === undefined || !isLevelHabit(habit.id)) {
    if (!setRecord(date, habit.id, value)) return false;
    return true;
  }
  if (!setRecord(date, habit.id, { value: value, level: level })) return false;
  return true;
}
// Процент выполнения привычки за набор дат. Может быть больше 100.
// База — все дни периода, включая пустые: непроставленный день даёт 0.
// Знаменатель обрезается до первой записи: пользователь видит прогресс за
// тот период, когда реально вёл привычку, а не за весь календарь.
export function calcProgress(habit, dates) {
  if (!dates || dates.length === 0) return 0;

  // Веса вариантов ответа для типа "choice". Коды Спорта и Пресса и русские
  // значения привычек из формы — одно состояние, поэтому в таблице обе пары
  // ключей: без русских прогресс у привычки из формы всегда был бы нулевым.
  // «Отдых» — запланированный пропуск: вес не набирает, но и серию не рвёт.
  const weights = { 'yes': 1, 'да': 1, 'two-min': 0.5, 'частично': 0.5,
    'no': 0, 'нет': 0, 'rest': 0, 'отдых': 0 };

  // Находим самую раннюю дату с записью по этой привычке
  let minDate = null;
  for (let i = 0; i < dates.length; i++) {
    if (recordValue(dates[i], habit.id) !== undefined) {
      minDate = dates[i];
      break; // даты идут от младшего к старшему
    }
  }

  // Нет записей — 0%
  if (minDate === null) return 0;

  // Обрезаем даты до первой записи (даты уже отсортированы)
  let filteredDates = dates;
  if (minDate > dates[0]) {
    const firstIdx = dates.indexOf(minDate);
    filteredDates = dates.slice(firstIdx);
  }

  const base = filteredDates.length;
  if (base <= 0) return 0;

  let sum = 0;

  for (let i = 0; i < filteredDates.length; i++) {
    // У Корана в прогресс идут введённые страницы, а не число отметок:
    // пустое поле даёт 0, две страницы — 2 (§2.6).
    const value = recordValue(filteredDates[i], habit.id);
    if (value === undefined) continue;

    if (habit.type === 'boolean') {
      sum += value === true ? 1 : 0;
    } else if (habit.type === 'choice') {
      sum += Object.prototype.hasOwnProperty.call(weights, value) ? weights[value] : 0;
    } else if (habit.type === 'number') {
      const num = Number(value);
      sum += isNaN(num) ? 0 : num;
    } else {
      sum += value === true ? 1 : 0;
    }
  }

  if (habit.type === 'number') {
    if (!habit.goal || habit.goal <= 0) return 0;
    return (sum / base) / habit.goal * 100;
  }
  return sum / base * 100;
}
