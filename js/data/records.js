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
// Версия данных записей. Всё, что мутирует recordsCache хотя бы in-place,
// обязано сдвигать счётчик touchRecordsVersion(), иначе кэш прогресса
// (calcProgress) отдаст устаревший процент. Сам счётчик наружу не
// экспортируется: снаружи от него нужен только touch.
let recordsVersion = 0;
export function touchRecordsVersion() {
  recordsVersion++;
}
export function invalidateRecordsCache() {
  recordsCache = null;
  // Следующая загрузка придёт из хранилища с чужими данными (applyBackup,
  // sync, событие storage из другой вкладки) — кэш прогресса обязан
  // пересчитаться с нуля
  touchRecordsVersion();
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
    // День может приехать битым (null вместо объекта) с чужого устройства
    // или из старой версии. Отсеваем по критерию дня validCloudRecords
    // (js/sync/core.js:100-101): иначе перебор дней в hasRecords/removeHabit
    // падает на hasOwnProperty.call(null, ...). Собираем новый объект —
    // кэш-инвариант «тот же объект уходит в saveRecords» сохранён.
    const days = {};
    const dates = Object.keys(parsed);
    for (let i = 0; i < dates.length; i++) {
      const day = parsed[dates[i]];
      if (!day || typeof day !== 'object' || Array.isArray(day)) continue;
      days[dates[i]] = day;
    }
    recordsCache = days;
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
  if (ok) {
    recordsCache = records;
    // Write-through закрепил новое состояние в кэше и на диске: версия
    // данных записей сменилась, кэш прогресса должен пересчитаться
    touchRecordsVersion();
  }
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
    // Откат — тоже мутация кэша in-place: версия обязана уйти вперёд,
    // даже если состояние вернулось к прежнему (лишний сдвиг безвреден,
    // устаревший процент — нет)
    touchRecordsVersion();
    return false;
  }
  // Запись изменила recordsCache in-place ещё до saveRecords: сдвигаем
  // версию в самой точке мутации, а не полагаемся на write-through ниже
  touchRecordsVersion();
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
function normalizeEntry(habitId, raw) {
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
function recordValue(date, habitId) {
  const entry = getEntry(date, habitId);
  return entry ? entry.value : undefined;
}
// 'HH:MM' → минуты от полуночи; null, если строка не время
function habitTimeMinutes(time) {
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
// date — день ячейки. Уровень по часам выводится ТОЛЬКО для сегодняшнего
// дня: вчерашнюю строку правят сегодня, и текущее время ничего не знает о
// том, во сколько человек сделал то вчера. Без этого правила вечерняя
// правка утренней привычки молча помечала прошлый день «поздно».
export function defaultLevel(habit, value, date) {
  if (value === LEVEL_TWO_MIN) return LEVEL_TWO_MIN;
  if (isChoiceLevelHabit(habit.id) && value !== 'yes') return null;
  if (date !== undefined && date !== null && date !== toISODate(new Date())) {
    return null;
  }
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
// Кэш процентов прогресса. Habit-объекты пересоздаются каждым рендером
// (loadHabits читает JSON из хранилища), держать значение по ссылке
// объекта нельзя — ключ собирается из полей, которые calcProgress реально
// читает (id, type, goal), плюс версии данных записей и периода.
const progressCache = new Map();

// Сигнатура периода для ключа кэша. Массивы дат пересоздаются каждым
// рендером, сравнение по ссылке даёт 0% попаданий; все источники —
// непрерывные диапазоны ISO-дат (год, неделя, месяц, одиночный день),
// поэтому содержимое массива однозначно задано краями и длиной.
// Одиночный день сводится к самой дате: habitMarked ходит однодневными
// массивами.
function periodSignature(dates) {
  if (dates.length === 1) return dates[0];
  return dates[0] + '..' + dates[dates.length - 1] + ':' + dates.length;
}

// Граница «возраста привычки» — самая ранняя дата с записью по этой привычке
// во ВСЕХ данных, а не внутри конкретного окна. Поля создания у привычки нет
// (js/data/habits.js хранит id, name, unit, type, goal, time), поэтому граница
// выводится из минимального ключа даты в youplanner.records, где встретилось
// непустое значение: дни раньше неё привычка вестись не могла. Дни, вынесенные
// в архив (js/data/archive.js), в расчёт не входят — они уже не читаются
// loadRecords, и процент считается по живым данным, как и весь экран.
// Снимок пересобирается один раз на версию данных записей: calcProgress —
// самая горячая функция рендера, и скан хранилища на каждый вызов был бы
// дороже самого подсчёта.
let habitStartDates = null;
let habitStartDatesVersion = -1;

function habitFirstRecordDate(habitId) {
  if (habitStartDates === null || habitStartDatesVersion !== recordsVersion) {
    const dates = {};
    const records = loadRecords();
    // Ключи идут в возрастающем порядке: первый найденный день привычки и
    // есть её начало, второй проход по тому же habitId не нужен
    const keys = Object.keys(records).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (let i = 0; i < keys.length; i++) {
      const day = records[keys[i]];
      if (!day || typeof day !== 'object') continue;
      const habitIds = Object.keys(day);
      for (let j = 0; j < habitIds.length; j++) {
        const id = habitIds[j];
        if (dates[id] !== undefined) continue;
        if (recordValue(keys[i], id) !== undefined) dates[id] = keys[i];
      }
    }
    habitStartDates = dates;
    habitStartDatesVersion = recordsVersion;
  }
  return habitStartDates[habitId];
}

// Тело calcProgress без кэша. Не экспортируется: наружу идёт обёртка
// ниже, вызывающие (stats, stats-view, main-table) кэш не замечают.
function calcProgressUncached(habit, dates) {
  if (!dates || dates.length === 0) return 0;

  // Веса вариантов ответа для типа "choice". Коды Спорта и Пресса и русские
  // значения привычек из формы — одно состояние, поэтому в таблице обе пары
  // ключей: без русских прогресс у привычки из формы всегда был бы нулевым.
  // «Отдых» — запланированный пропуск: вес не набирает, но и серию не рвёт.
  const weights = { 'yes': 1, 'да': 1, 'two-min': 0.5, 'частично': 0.5,
    'no': 0, 'нет': 0, 'rest': 0, 'отдых': 0 };

  // Граница ведения — возраст привычки глобально (habitFirstRecordDate), а не
  // первая запись внутри окна: week ⊂ month, и при обрезке по окну оба
  // периода усекались до одного и того же дня и давали побитово одинаковые
  // проценты. Даты идут от младшего к старшему.
  const habitStart = habitFirstRecordDate(habit.id);

  // Привычка ни разу не отмечена — 0%
  if (habitStart === undefined) return 0;

  // Из знаменателя выкидываем только дни ДО появления привычки: вести её
  // пользователь ещё не мог. Пустые дни ПОСЛЕ начала ведения остаются —
  // непроставленный день и есть пропуск, он честно разбавляет процент.
  let from = 0;
  while (from < dates.length && dates[from] < habitStart) from++;

  // Всё окно раньше привычки — считать нечего
  if (from >= dates.length) return 0;

  const base = dates.length - from;
  if (base <= 0) return 0;

  let sum = 0;

  for (let i = from; i < dates.length; i++) {
    // У Корана в прогресс идут введённые страницы, а не число отметок:
    // пустое поле даёт 0, две страницы — 2 (§2.6).
    const value = recordValue(dates[i], habit.id);
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

// Процент выполнения привычки за набор дат. Может быть больше 100.
// База — все дни периода, включая пустые: непроставленный день даёт 0.
// Знаменатель обрезается только днями ДО начала ведения привычки (её
// «возраст» — самая ранняя запись по привычке во всех данных): пользователь
// видит прогресс за период, когда реально мог её вести, а не за весь
// календарь. Внутри периода ведения пустые дни разбавляют процент — иначе
// любое окно схлопывалось бы в фактический диапазон данных, и неделя с
// месяцем при пустом начале месяца давали бы одно и то же число.
//
// Карточка привычки за «Все время» зовёт это ~1500 раз за рендер (график,
// сетка и серии — по одному дню), на телефонах это заметные лаги, поэтому
// пересчёт только на промахе кэша. Попадание валидно, пока жива версия
// данных записей и не сменился период.
export function calcProgress(habit, dates) {
  // Пустой период — 0 мимо кэша: считать нечего, ключ не построить
  if (!dates || dates.length === 0) return 0;

  // goal детерминированно через String: у привычки goal бывает undefined,
  // и 'undefined' в ключе — постоянное, всегда одинаковое значение
  const key = String(habit.id) + '|' + String(habit.type) + '|' +
    String(habit.goal) + '|' + recordsVersion + '|' + periodSignature(dates);

  // Попадание только при живой версии: сдвиг версии делает ключ новым
  const cached = progressCache.get(key);
  if (cached && cached.version === recordsVersion) return cached.value;

  const value = calcProgressUncached(habit, dates);

  // Потолок памяти: на длинной сессии привычек и периодов много, карте
  // распухать нельзя; само вычисление дешёвое, потеря кэша безболезненна
  if (progressCache.size > 1000) progressCache.clear();
  progressCache.set(key, { version: recordsVersion, value: value });

  return value;
}
