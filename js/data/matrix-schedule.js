/* Расписание задачи: интервал, длительность, напоминания и повтор.
   (ТЗ Воркера 2, пункты Б3, Б5, Б7.)

   ЧИСТЫЙ модуль: не знает ни про DOM, ни про хранилище, ни про экран. Импорт
   идёт только из js/core/dates.js. Поэтому его можно проверить node:test без
   браузера и без песочницы, а экран и данные зовут одни и те же правила —
   расхождение «календарь рисует одно, а save пишет другое» здесь невозможно
   по построению.

   Нормализация отбрасывает повреждённые ОПЦИИ (unit='fortnight', interval=0,
   ends.type='until' без даты), но НЕ теряет причину: всё собранное уходит в
   `issues`. Экран вызывает `validateSchedule` на ИСХОДНОМ значении черновика,
   поэтому человек видит конкретное поле, а в хранилище ложится только чистая
   схема версии 1.

   Времена — локальные «настенные» (`timeZoneMode:'device'`): дата никогда не
   проходит через `new Date('YYYY-MM-DD')` и никогда не сериализуется в UTC.
   Перевод часов не сдвигает ни срок, ни длительность all-day. */

import { DAY_MS, isDateLike, parseISODate, pluralDays, toISODate } from '../core/dates.js';

export const SCHEDULE_VERSION = 1;

export const SCHEDULE_LIMITS = {
  reminders: 5,
  offsetMinMinutes: 0,
  offsetMaxMinutes: 525600,      // 365 суток
  intervalMin: 1,
  intervalMax: 999,
  countMin: 1,
  countMax: 10000,
  datesMin: 1,
  datesMax: 366,
  idMax: 64,
};

export const REMINDER_ANCHORS = ['start', 'end', 'absolute'];
export const REPEAT_UNITS = ['day', 'week', 'month', 'year', 'dates'];
export const REPEAT_BASES = ['scheduled', 'completion'];
export const REPEAT_MONTH_MODES = ['dayOfMonth', 'nthWeekday'];
export const REPEAT_ENDS_TYPES = ['never', 'until', 'count'];
export const REPEAT_NTH_VALUES = [1, 2, 3, 4, -1];
export const ALL_DAY_DEFAULT_TIME = '09:00';
export const MINUTES_PER_DAY = 1440;

// Потолок поиска продолжений (Б7.10): 100 лет и 1200 месяцев. Ровно чтобы
// неверное правило не превратилось в вечный while.
const MAX_YEAR_SEARCH = 100;
const MAX_MONTH_SEARCH = 1200;

/* --- Примитивы проверки --------------------------------------------------- */

function isoDateOrNull(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('-');
  if (parts.length !== 3) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = parseISODate(value);
  // Круглая проверка: '2026-11-31' Date разворачивает в 1 декабря, и молча
  // принять такую дату означало бы хранить не то, что человек выбрал.
  return isDateLike(parsed) && toISODate(parsed) === value ? value : null;
}

function timeOrNull(value) {
  if (typeof value !== 'string') return null;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value) ? value : null;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Строгий целый: числа из JSON не приводятся из строк (Б3.5), NaN и Infinity
// не проходят, дробные отбрасываются.
function intOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function intIn(value, min, max) {
  const n = intOrNull(value);
  return n !== null && n >= min && n <= max ? n : null;
}

function idOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SCHEDULE_LIMITS.idMax) return null;
  return trimmed;
}

function oneOf(value, list) {
  return list.indexOf(value) >= 0;
}

// Глубокая копия JSON-безопасного значения._protected_ режим Б3.3 обязан
// сохранить неизвестную схему без потери полей, но функции, циклы и поля вне
// JSON в хранилище всё равно не живут — поэтому копия структурная, а не
// «каждый ключ подряд».
function jsonClone(value, depth) {
  const level = depth || 0;
  if (level > 12) return null;
  const type = typeof value;
  if (value === null || type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(jsonClone(item, level + 1));
    return out;
  }
  if (type === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = jsonClone(value[key], level + 1);
    }
    return out;
  }
  return null;
}

/* --- Даты: календарные, а не миллисекундные -------------------------------- */

function ordinalOfDay(iso) {
  const d = parseISODate(iso);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

// Прибавить календарные дни/месяцы/годы без помощи Date-арифметики с
// переполнением месяцев: addMonths(2027-01-31, 1) обязан дать 2027-02-28.
function addCalendarMonths(iso, months) {
  const d = parseISODate(iso);
  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();
  const targetMonth = month + months;
  const yearShift = Math.floor(targetMonth / 12);
  const monthIndex = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(year + yearShift, monthIndex + 1, 0).getDate();
  return toISODate(new Date(year + yearShift, monthIndex, Math.min(day, lastDay)));
}

function addCalendarDays(iso, days) {
  const d = parseISODate(iso);
  return toISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// ISO-нумерация: понедельник = 1 ... воскресенье = 7
function isoWeekday(iso) {
  const d = parseISODate(iso);
  return (d.getDay() + 6) % 7 + 1;
}

function mondayOf(iso) {
  return addCalendarDays(iso, 1 - isoWeekday(iso));
}

/* --- Локальные моменты (Б3.10) -------------------------------------------- */

function offsetAt(instant) {
  return new Date(instant).getTimezoneOffset();
}

/* Найти момент перевода часов внутри суток даты, если он есть.
   Возвращает {before, after, transition} в миллисекундах или null. */
function dayTransition(dateIso) {
  const startLocal = new Date(dateIso.slice(0, 4), Number(dateIso.slice(5, 7)) - 1,
    Number(dateIso.slice(8, 10)), 0, 0, 0, 0);
  if (!isDateLike(startLocal)) return null;
  const start = startLocal.getTime();
  const end = start + 26 * 3600000;          // с запасом через переход
  const offsetStart = offsetAt(start);
  const offsetEnd = offsetAt(end);
  if (offsetStart === offsetEnd) return null;

  let low = start;
  let high = end;
  while (high - low > 60000) {
    const mid = Math.floor((low + high) / 2);
    if (offsetAt(mid) === offsetStart) low = mid;
    else high = mid;
  }
  // high — первый момент с новым смещением; именно он и есть «первый
  // существующий момент вперёд» для времени, попавшего в провал.
  return { before: offsetStart, after: offsetEnd, transition: high };
}

/* Разобрать локальный настенный момент.

   Ручной ввод несуществующих часов ОТКЛОНЯЕТСЯ, неоднозначные осенние часы
   дают ПЕРВОЕ вхождение — оба правила проверяются в отдельных процессах с
   env.TZ (tests/matrix-tz.test.mjs), потому что `TZ=... node` в Windows зону
   не передаёт и тест проверял бы часовую пояс машины. */
export function resolveLocalMoment(dateIso, timeIsoOrNull) {
  const date = isoDateOrNull(dateIso);
  if (!date) return { ok: false, code: 'invalid-date', at: null, ambiguous: false };

  const time = timeIsoOrNull === undefined || timeIsoOrNull === null
    ? '00:00'
    : timeOrNull(timeIsoOrNull);
  if (!time) return { ok: false, code: 'invalid-time', at: null, ambiguous: false };

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  const wallUtc = Date.UTC(year, month, day, hour, minute);

  // Возможны ровно два кандидата — смещения на полуночи и на конце суток.
  const dayStart = new Date(year, month, day, 0, 0, 0, 0).getTime();
  const dayEnd = new Date(year, month, day, 23, 59, 0, 0).getTime();
  const offsets = [offsetAt(dayStart), offsetAt(dayEnd)];
  const seen = new Set();
  const matches = [];
  for (const offset of offsets) {
    const instant = wallUtc + offset * 60000;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const rendered = new Date(instant);
    if (rendered.getFullYear() === year && rendered.getMonth() === month
      && rendered.getDate() === day && rendered.getHours() === hour
      && rendered.getMinutes() === minute) {
      matches.push(instant);
    }
  }

  if (matches.length === 0) {
    return { ok: false, code: 'nonexistent', at: null, ambiguous: false, date, time };
  }
  const chosen = Math.min.apply(null, matches);
  return {
    ok: true,
    at: new Date(chosen),
    code: matches.length > 1 ? 'ambiguous' : null,
    ambiguous: matches.length > 1,
    date,
    time,
  };
}

// «Первый существующий момент вперёд» для вычисленного повторения, попавшего
// в весенний провал (Б3.10). Возвращает уже нормализованное настенное время.
function shiftToFirstExisting(dateIso, timeIso) {
  const transition = dayTransition(dateIso);
  if (!transition) return null;
  const rendered = new Date(transition.transition);
  if (rendered.getTimezoneOffset() !== transition.after) return null;
  const iso = toISODate(rendered);
  if (iso !== dateIso) return null;
  const hh = String(rendered.getHours()).padStart(2, '0');
  const mm = String(rendered.getMinutes()).padStart(2, '0');
  return { time: hh + ':' + mm, instant: transition.transition };
}

function momentOf(schedule, which) {
  const date = which === 'end' ? schedule.endDate : schedule.startDate;
  const time = which === 'end' ? schedule.endTime : schedule.startTime;
  return resolveLocalMoment(date, schedule.allDay ? null : time);
}

/* --- Длительность --------------------------------------------------------- */

// Склонение «день / дня / дней» — общее (core/dates.js, pluralDays)

function minutesLabel(total) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours && minutes) return hours + ' ч ' + minutes + ' мин';
  if (hours) return hours + ' ч';
  return minutes + ' мин';
}

// All-day — календарные дни включительно, а НЕ деление миллисекунд на 86400000:
// в сутки перевода часов второе дало бы 2.96 «дня».
export function scheduleDuration(schedule) {
  const none = { kind: 'none', days: 0, minutes: null, label: '' };
  if (!isRecord(schedule)) return none;
  const start = schedule.startDate;
  const end = schedule.endDate;
  if (!start || !end) return none;

  const days = ordinalOfDay(end) - ordinalOfDay(start) + 1;
  if (days < 1) return none;

  if (schedule.allDay) {
    return { kind: 'allDay', days, minutes: null, label: days + ' ' + pluralDays(days) };
  }

  const from = momentOf(schedule, 'start');
  const to = momentOf(schedule, 'end');
  if (!from.ok || !to.ok) {
    return { kind: 'timed', days, minutes: null, label: '' };
  }
  const minutes = Math.round((to.at.getTime() - from.at.getTime()) / 60000);
  if (!(minutes > 0)) return { kind: 'timed', days, minutes: null, label: '' };
  return { kind: 'timed', days, minutes, label: minutesLabel(minutes) };
}

export function scheduleToDue(schedule) {
  if (!isRecord(schedule)) return null;
  return schedule.endDate || null;
}

/* --- Напоминания: моменты (Б5) -------------------------------------------- */

export function reminderMoment(schedule, reminder) {
  if (!isRecord(schedule) || !isRecord(reminder)) {
    return { ok: false, code: 'invalid-reminder', at: null };
  }
  const fail = (code) => ({ ok: false, code, at: null });

  if (reminder.anchor === 'absolute') {
    const out = resolveLocalMoment(reminder.date, reminder.time);
    return out.ok ? { ok: true, at: out.at, code: null } : fail(out.code);
  }
  if (reminder.anchor !== 'start' && reminder.anchor !== 'end') return fail('invalid-anchor');
  if (!schedule.startDate || !schedule.endDate) return fail('no-date');

  const offset = intIn(reminder.offsetMinutes, SCHEDULE_LIMITS.offsetMinMinutes,
    SCHEDULE_LIMITS.offsetMaxMinutes);
  if (offset === null) return fail('invalid-offset');

  if (schedule.allDay) {
    if (offset % MINUTES_PER_DAY !== 0) return fail('all-day-offset');
    const out = resolveLocalMoment(
      reminder.anchor === 'end' ? schedule.endDate : schedule.startDate,
      reminder.time || ALL_DAY_DEFAULT_TIME);
    if (!out.ok) return fail(out.code);
    const shifted = addCalendarDays(out.date, -offset / MINUTES_PER_DAY);
    const resolved = resolveLocalMoment(shifted, out.time);
    if (!resolved.ok) {
      const nudged = shiftToFirstExisting(shifted, out.time);
      if (!nudged) return fail('unresolvable');
      return { ok: true, at: new Date(nudged.instant), code: 'dst-shifted' };
    }
    return { ok: true, at: resolved.at, code: null };
  }

  const base = momentOf(schedule, reminder.anchor);
  if (!base.ok) return fail(base.code);
  return { ok: true, at: new Date(base.at.getTime() - offset * 60000), code: null };
}

// Отпечаток правила для ledger (Б5.5): задача + экземпляр серии + reminder +
// сам момент. Меняется время или смещение — получается новое правило.
export function reminderFingerprint(task, reminder, at) {
  const series = isRecord(task && task.schedule) && isRecord(task.schedule.series)
    ? task.schedule.series.index : 1;
  return [
    task.id,
    intOrNull(series) === null ? 1 : Math.max(1, series),
    reminder.id,
    reminder.anchor,
    intOrNull(reminder.offsetMinutes) === null ? 0 : reminder.offsetMinutes,
    reminder.date || '',
    reminder.time || '',
    toISODate(at) + 'T' + String(at.getHours()).padStart(2, '0') + ':'
      + String(at.getMinutes()).padStart(2, '0'),
  ].join('|');
}

/* --- Нормализация (Б3.8) -------------------------------------------------- */

function normalizeReminder(raw, allDay, issues) {
  if (!isRecord(raw)) return null;
  const id = idOrNull(raw.id);
  if (!id) {
    issues.push({ field: 'reminders', code: 'invalid-id', message: 'у напоминания нет годного id' });
    return null;
  }
  if (!oneOf(raw.anchor, REMINDER_ANCHORS)) {
    issues.push({ field: 'reminders', code: 'enum', message: 'неизвестный момент напоминания' });
    return null;
  }

  if (raw.anchor === 'absolute') {
    const date = isoDateOrNull(raw.date);
    const time = timeOrNull(raw.time);
    if (!date || !time) {
      issues.push({ field: 'reminders', code: 'absolute-needs-date-time', message: 'абсолютное требует даты и времени' });
      return null;
    }
    return { id, anchor: 'absolute', offsetMinutes: 0, date, time };
  }

  const offset = intOrNull(raw.offsetMinutes);
  if (offset === null || offset < SCHEDULE_LIMITS.offsetMinMinutes
    || offset > SCHEDULE_LIMITS.offsetMaxMinutes) {
    issues.push({ field: 'reminders', code: 'offset', message: 'смещение напоминания вне диапазона' });
    return null;
  }
  let time = timeOrNull(raw.time);
  let offsetMinutes = offset;
  if (allDay) {
    if (!time) time = ALL_DAY_DEFAULT_TIME;
    offsetMinutes = Math.floor(offset / MINUTES_PER_DAY) * MINUTES_PER_DAY;
    if (offsetMinutes !== offset) {
      issues.push({ field: 'reminders', code: 'all-day-offset', message: 'весь день считает опережение целыми сутками' });
    }
  } else {
    time = null;
  }
  return { id, anchor: raw.anchor, offsetMinutes, date: null, time };
}

function normalizeRepeat(raw, issues) {
  if (!isRecord(raw)) return null;

  /* unit — единственное поле, без которого правила не существует. Само
     нарушение при этом НЕ теряется: validateSchedule вызывается на исходном
     значении формы и получает эти issues вместе со своими. */
  if (!oneOf(raw.unit, REPEAT_UNITS)) {
    issues.push({ field: 'repeat.unit', code: 'enum', message: 'неизвестная единица повтора' });
    return null;
  }
  const unit = raw.unit;

  let interval = 1;
  if (raw.interval !== undefined && raw.interval !== null) {
    const n = intOrNull(raw.interval);
    if (n === null) {
      issues.push({ field: 'repeat.interval', code: 'type', message: 'интервал не является числом' });
    } else if (n < SCHEDULE_LIMITS.intervalMin || n > SCHEDULE_LIMITS.intervalMax) {
      issues.push({ field: 'repeat.interval', code: 'range', message: 'интервал вне 1..999' });
      return null;
    } else {
      interval = n;
    }
  }

  let basis = 'scheduled';
  if (raw.basis !== undefined && raw.basis !== null) {
    if (oneOf(raw.basis, REPEAT_BASES)) basis = raw.basis;
    else issues.push({ field: 'repeat.basis', code: 'enum', message: 'неизвестная база повтора' });
  }

  const weekdays = [];
  if (unit === 'week' && Array.isArray(raw.weekdays)) {
    const set = new Set();
    for (const item of raw.weekdays) {
      const n = intIn(item, 1, 7);
      if (n !== null) set.add(n);
    }
    weekdays.push(...Array.from(set).sort((a, b) => a - b));
  }

  const dates = [];
  if (unit === 'dates' && Array.isArray(raw.dates)) {
    const set = new Set();
    for (const item of raw.dates) {
      const iso = isoDateOrNull(item);
      if (iso) set.add(iso);
    }
    dates.push(...Array.from(set).sort());
    if (dates.length > SCHEDULE_LIMITS.datesMax) {
      issues.push({ field: 'repeat.dates', code: 'range', message: 'слишком много дат в правиле' });
      dates.length = SCHEDULE_LIMITS.datesMax;
    }
    interval = 1;
    basis = 'scheduled';
  }

  let monthMode = 'dayOfMonth';
  if (unit === 'month') {
    if (oneOf(raw.monthMode, REPEAT_MONTH_MODES)) monthMode = raw.monthMode;
    else if (raw.monthMode !== undefined && raw.monthMode !== null) {
      issues.push({ field: 'repeat.monthMode', code: 'enum', message: 'неизвестный режим месяца' });
    }
  }

  let nth = null;
  let weekday = null;
  if (unit === 'month' && monthMode === 'nthWeekday') {
    nth = intOrNull(raw.nth);
    if (nth === null) {
      issues.push({
        field: 'repeat.nth',
        code: raw.nth === undefined || raw.nth === null ? 'missing' : 'type',
        message: 'режим месяца требует номера вхождения (1..4 или -1)',
      });
      return null;
    }
    if (!oneOf(nth, REPEAT_NTH_VALUES)) {
      issues.push({ field: 'repeat.nth', code: 'enum', message: 'nth вне 1..4 и -1' });
      return null;
    }
    weekday = intIn(raw.weekday, 1, 7);
    if (weekday === null) {
      issues.push({ field: 'repeat.weekday', code: 'missing', message: 'режим месяца требует дня недели' });
      return null;
    }
  }

  const ends = normalizeEnds(raw.ends, issues);

  return {
    basis,
    unit,
    interval,
    weekdays,
    monthMode,
    nth,
    weekday,
    dates,
    ends,
  };
}

function normalizeEnds(raw, issues) {
  const never = { type: 'never', until: null, count: null };
  if (raw === undefined || raw === null) return never;
  if (!isRecord(raw)) {
    issues.push({ field: 'repeat.ends', code: 'type', message: 'ends не объект' });
    return never;
  }
  let type = raw.type;
  if (!oneOf(type, REPEAT_ENDS_TYPES)) {
    issues.push({ field: 'repeat.ends.type', code: 'enum', message: 'неизвестный способ завершения' });
    type = 'never';
  }

  if (type === 'never') {
    if (raw.until !== undefined && raw.until !== null) {
      issues.push({ field: 'repeat.ends', code: 'never-has-until', message: '«никогда» не хранит дату' });
    }
    if (raw.count !== undefined && raw.count !== null) {
      issues.push({ field: 'repeat.ends', code: 'never-has-count', message: '«никогда» не хранит число' });
    }
    return never;
  }

  if (type === 'until') {
    const until = isoDateOrNull(raw.until);
    if (!until) issues.push({ field: 'repeat.ends.until', code: 'missing', message: 'until требует дату' });
    if (intOrNull(raw.count) !== null) {
      issues.push({ field: 'repeat.ends', code: 'until-has-count', message: 'until не хранит count' });
    }
    return { type: 'until', until, count: null };
  }

  const count = intOrNull(raw.count);
  if (count === null) {
    issues.push({ field: 'repeat.ends.count', code: 'missing', message: 'count требует число' });
    return { type: 'never', until: null, count: null };
  }
  if (count < SCHEDULE_LIMITS.countMin || count > SCHEDULE_LIMITS.countMax) {
    issues.push({ field: 'repeat.ends.count', code: 'range', message: 'count вне 1..10000' });
    return { type: 'never', until: null, count: null };
  }
  if (raw.until !== undefined && raw.until !== null) {
    issues.push({ field: 'repeat.ends', code: 'count-has-until', message: 'count не хранит until' });
  }
  return { type: 'count', until: null, count };
}

function emptyRepeat() {
  return {
    basis: 'scheduled',
    unit: 'day',
    interval: 1,
    weekdays: [],
    monthMode: 'dayOfMonth',
    nth: null,
    weekday: null,
    dates: [],
    ends: { type: 'never', until: null, count: null },
  };
}

function normalizeSeries(raw, repeat, schedule, issues) {
  if (!repeat) {
    if (raw !== undefined && raw !== null) {
      issues.push({ field: 'series', code: 'series-without-repeat', message: 'repeat=null влечёт series=null' });
    }
    return null;
  }
  if (raw === undefined || raw === null) return null;   // создаётся при включении правила
  if (!isRecord(raw)) return null;

  const anchorDate = isoDateOrNull(raw.anchorDate) || schedule.startDate;
  const index = intOrNull(raw.index);
  return {
    id: idOrNull(raw.id) || null,
    index: index === null || index < 1 ? 1 : index,
    anchorDate: anchorDate || null,
    anchorDay: intIn(raw.anchorDay, 1, 31) !== null ? raw.anchorDay
      : (anchorDate ? Number(anchorDate.slice(8, 10)) : 1),
    anchorMonth: intIn(raw.anchorMonth, 1, 12) !== null ? raw.anchorMonth
      : (anchorDate ? Number(anchorDate.slice(5, 7)) : 1),
  };
}

export function emptySchedule() {
  return {
    version: SCHEDULE_VERSION,
    allDay: true,
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    timeZoneMode: 'device',
    reminders: [],
    repeat: null,
    series: null,
  };
}

export function cloneSchedule(schedule) {
  if (!isRecord(schedule)) return emptySchedule();
  const out = jsonClone(schedule);
  return isRecord(out) ? out : emptySchedule();
}

/* Привести произвольную запись к схеме версии 1.

   (raw, {legacyDue}) → { schedule, issues, unsupported }
   ВХОД: raw — любое значение из хранилища или черновика формы; legacyDue —
   верхнеуровневый `due` задачи для миграции.
   ВЫХОД: schedule — законная схема версии 1 (или защищённая копия неизвестной
   версии), issues — что убрано и почему, unsupported — версия не 1.

   Повреждённые ОПЦИИ отбрасываются, а не «починяются догадкой»: причина
   остаётся в issues, и `validateSchedule`, который форма вызывает на ИСХОДНОМ
   значении, показывает её человеку. Задача при этом сохраняется целиком (Б3.6). */
export function normalizeSchedule(raw, options) {
  const opts = isRecord(options) ? options : {};
  const issues = [];

  if (isRecord(raw) && raw.version !== undefined && raw.version !== SCHEDULE_VERSION) {
    issues.push({ field: 'schedule.version', code: 'unsupported-version', message: 'неизвестная версия расписания' });
    return { schedule: jsonClone(raw), issues, unsupported: true };
  }

  const source = isRecord(raw) ? raw : {};
  const schedule = emptySchedule();

  const start = isoDateOrNull(source.startDate);
  const end = isoDateOrNull(source.endDate);
  let startDate = start;
  let endDate = end;

  if (!startDate && !endDate) {
    const legacy = isoDateOrNull(opts.legacyDue);
    if (legacy) {
      startDate = legacy;
      endDate = legacy;
    }
  } else if (!startDate) startDate = endDate;
  else if (!endDate) endDate = startDate;

  schedule.startDate = startDate;
  schedule.endDate = endDate;

  // allDay: явно false — timed; всё остальное — весь день (Б3.2 дефолт)
  schedule.allDay = source.allDay !== false;
  let degraded = false;

  if (schedule.allDay) {
    if (timeOrNull(source.startTime) || timeOrNull(source.endTime)) {
      issues.push({ field: 'allDay', code: 'times-in-all-day', message: 'весь день не хранит часы' });
    }
    schedule.startTime = null;
    schedule.endTime = null;
  } else {
    schedule.startTime = timeOrNull(source.startTime);
    schedule.endTime = timeOrNull(source.endTime);
    const brokenTime = (source.startTime && !schedule.startTime)
      || (source.endTime && !schedule.endTime);
    if (brokenTime) {
      issues.push({
        field: schedule.startTime ? 'endTime' : 'startTime',
        code: 'invalid-time',
        message: 'время вне 00:00–23:59 или без ведущего нуля',
      });
    }
    // Б3.6: битое время в хранилисе не стоит удалённой задачи — годовые даты
    // остаются, интервал деградирует до «весь день», а часы уходят.
    if (brokenTime && startDate && endDate) {
      degraded = true;
      schedule.allDay = true;
      schedule.startTime = null;
      schedule.endTime = null;
      issues.push({ field: 'allDay', code: 'degraded-to-all-day', message: 'битое время: интервал стал днём целиком' });
    }
  }
  schedule.timeZoneMode = 'device';

  const reminders = [];
  if (Array.isArray(source.reminders)) {
    for (const item of source.reminders) {
      const reminder = normalizeReminder(item, schedule.allDay && !degraded, issues);
      if (!reminder) continue;
      if (degraded && reminder.anchor !== 'absolute' && reminder.time === null) {
        // Б3.6: напоминание, которому нужно время, при деградации выключается
        // с диагностикой, а не будит человека в произвольную минуту.
        issues.push({ field: 'reminders', code: 'reminder-disabled-no-time', message: 'напоминание отключено: время потерялось' });
        continue;
      }
      reminders.push(reminder);
    }
    if (reminders.length > SCHEDULE_LIMITS.reminders) {
      issues.push({ field: 'reminders', code: 'too-many', message: 'не больше пяти напоминаний' });
      reminders.length = SCHEDULE_LIMITS.reminders;
    }
  }
  schedule.reminders = reminders;

  schedule.repeat = source.repeat === undefined || source.repeat === null
    ? null
    : normalizeRepeat(source.repeat, issues);

  schedule.series = normalizeSeries(source.series, schedule.repeat, schedule, issues);

  if (start === null && typeof source.startDate === 'string') {
    issues.push({ field: 'startDate', code: 'invalid-date', message: 'несуществующая дата начала' });
  }
  if (end === null && typeof source.endDate === 'string') {
    issues.push({ field: 'endDate', code: 'invalid-date', message: 'несуществующая дата окончания' });
  }

  return { schedule, issues, unsupported: false };
}

/* --- Валидация (Б3.4, Б3.5, Б5, Б7) --------------------------------------- */

export function validateSchedule(value) {
  const issues = [];
  const push = (field, code, message) => issues.push({ field, code, message });
  const normalized = normalizeSchedule(value);
  issues.push(...normalized.issues);
  const s = normalized.schedule;

  if (normalized.unsupported) {
    push('schedule', 'unsupported-version', 'расписание создано более новой версией приложения');
    return { ok: false, issues };
  }

  const hasStart = !!s.startDate;
  const hasEnd = !!s.endDate;
  if (!hasStart && !hasEnd) {
    if (s.startTime || s.endTime) push('startDate', 'time-without-date', 'время требует дату');
    return { ok: issues.length === 0, issues };
  }
  if (!hasStart) push('startDate', 'missing', 'нужны обе даты интервала');
  if (!hasEnd) push('endDate', 'missing', 'нужны обе даты интервала');
  if (hasStart && hasEnd && ordinalOfDay(s.endDate) < ordinalOfDay(s.startDate)) {
    push('endDate', 'before-start', 'окончание раньше начала');
  }

  if (s.allDay) {
    if (s.startTime || s.endTime) push('startTime', 'times-in-all-day', 'весь день не хранит часы');
  } else {
    if (!s.startTime) push('startTime', 'missing', 'нужно время начала');
    if (!s.endTime) push('endTime', 'missing', 'нужно время окончания');
    if (s.startTime && s.endTime) {
      const from = momentOf(s, 'start');
      const to = momentOf(s, 'end');
      if (!from.ok) push('startTime', from.code, 'такое время в этот день не существует');
      if (!to.ok) push('endTime', to.code, 'такое время в этот день не существует');
      if (from.ok && to.ok && !(to.at.getTime() > from.at.getTime())) {
        push('endTime', 'not-after-start', 'окончание должно быть строго позже начала');
      }
    }
  }

  if (s.reminders.length > SCHEDULE_LIMITS.reminders) push('reminders', 'too-many', 'не больше пяти');

  const seenIds = new Set();
  for (const reminder of s.reminders) {
    if (seenIds.has(reminder.id)) push('reminders', 'duplicate-id', 'повторяющийся id напоминания');
    seenIds.add(reminder.id);
    if (reminder.anchor === 'absolute') {
      if (s.repeat) {
        push('reminders', 'absolute-with-repeat',
          'абсолютное напоминание нельзя переносить по серии — замените на относительное');
      }
      if (!isoDateOrNull(reminder.date)) push('reminders', 'absolute-needs-date-time', 'absolute требует дату');
      if (!timeOrNull(reminder.time)) push('reminders', 'absolute-needs-date-time', 'absolute требует время');
      if (reminder.offsetMinutes !== 0) push('reminders', 'absolute-offset', 'у absolute смещения нет');
    } else {
      if (reminder.date !== null) push('reminders', 'relative-has-date', 'у относительного напоминания нет даты');
      if (reminder.time !== null && !s.allDay) push('reminders', 'relative-has-time', 'у timed-напоминания нет времени');
      if (s.allDay && reminder.time === null) push('reminders', 'all-day-needs-time', 'весь день требует время');
      if (s.allDay && reminder.offsetMinutes % MINUTES_PER_DAY !== 0) {
        push('reminders', 'all-day-offset', 'весь день опережает целыми сутками');
      }
    }
  }

  if (s.repeat) validateRepeat(s, push);
  return { ok: issues.length === 0, issues };
}

function validateRepeat(s, push) {
  const r = s.repeat;
  if (!oneOf(r.unit, REPEAT_UNITS)) {
    push('repeat.unit', 'enum', 'неизвестная единица повтора');
    return;
  }
  if (!oneOf(r.basis, REPEAT_BASES)) push('repeat.basis', 'enum', 'неизвестная база повтора');
  if (r.interval < SCHEDULE_LIMITS.intervalMin || r.interval > SCHEDULE_LIMITS.intervalMax) {
    push('repeat.interval', 'range', 'интервал вне 1..999');
  }
  if (!s.startDate) push('repeat', 'needs-date', 'повтор требует даты');

  if (r.unit === 'week' && r.weekdays.length === 0) {
    push('repeat.weekdays', 'missing', 'выберите хотя бы один день недели');
  }
  if (r.unit !== 'week' && r.weekdays.length) push('repeat.weekdays', 'not-applicable', 'дни недели только для недель');
  if (r.unit !== 'dates' && r.dates.length) push('repeat.dates', 'not-applicable', 'список дат только для режима «по датам»');
  if (r.unit === 'month' && !oneOf(r.monthMode, REPEAT_MONTH_MODES)) {
    push('repeat.monthMode', 'enum', 'неизвестный режим месяца');
  }
  if (r.unit === 'month' && r.monthMode === 'nthWeekday') {
    if (!oneOf(r.nth, REPEAT_NTH_VALUES)) push('repeat.nth', 'enum', 'nth вне 1..4 и -1');
    if (intIn(r.weekday, 1, 7) === null) push('repeat.weekday', 'missing', 'нужен день недели');
  }
  if (r.unit === 'dates') {
    if (r.dates.length < SCHEDULE_LIMITS.datesMin || r.dates.length > SCHEDULE_LIMITS.datesMax) {
      push('repeat.dates', 'range', 'от одной до 366 дат');
    }
    if (r.dates.length && r.dates.indexOf(s.startDate) < 0) {
      push('repeat.dates', 'start-not-in-dates', 'текущая дата не входит в список дат');
    }
  }

  const ends = r.ends;
  if (!oneOf(ends.type, REPEAT_ENDS_TYPES)) push('repeat.ends.type', 'enum', 'неизвестный способ завершения');
  if (ends.type === 'until') {
    if (!isoDateOrNull(ends.until)) push('repeat.ends.until', 'missing', '«до даты» требует годную дату');
    if (ends.count !== null) push('repeat.ends', 'until-has-count', '«до даты» не хранит число');
    if (isoDateOrNull(ends.until) && s.startDate && ordinalOfDay(ends.until) < ordinalOfDay(s.startDate)) {
      push('repeat.ends.until', 'before-start', 'дата окончания раньше начала');
    }
  }
  if (ends.type === 'count') {
    if (intIn(ends.count, SCHEDULE_LIMITS.countMin, SCHEDULE_LIMITS.countMax) === null) {
      push('repeat.ends.count', 'range', 'число повторов вне 1..10000');
    }
    if (ends.until !== null) push('repeat.ends', 'count-has-until', '«после N» не хранит дату');
  }
  if (ends.type === 'never' && (ends.until !== null || ends.count !== null)) {
    push('repeat.ends', 'never-has-bounds', '«никогда» не хранит границ');
  }

  // Б7: completion имеет смысл только у простого «каждые N day/week/month/year»
  const complex = r.weekdays.length > 0 || r.dates.length > 0
    || (r.unit === 'month' && r.monthMode === 'nthWeekday');
  if (r.basis === 'completion' && (complex || r.unit === 'dates')) {
    push('repeat.basis', 'completion-needs-simple-rule',
      'отсчёт от выполнения доступен только для простого «каждые N»');
  }
}

/* --- Повтор: расчёт продолжений (Б7.2) ------------------------------------ */

/* N-е вхождение дня недели в месяце. -1 = ПОСЛЕДНЕЕ: оно ищется с конца
   месяца, а не «последний день, если он попал на понедельник», — иначе ряд
   «последних понедельников» рассыпался бы в большинство месяцев. */
function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  const last = lastDayOfMonth(year, monthIndex);
  if (nth === -1) {
    const lastIso = toISODate(new Date(year, monthIndex, last));
    const back = (isoWeekday(lastIso) - weekday + 7) % 7;
    return toISODate(new Date(year, monthIndex, last - back));
  }
  if (!(nth >= 1 && nth <= 4)) return null;
  const firstWeekday = isoWeekday(toISODate(new Date(year, monthIndex, 1)));
  const dayOfMonth = 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
  return dayOfMonth > last ? null : toISODate(new Date(year, monthIndex, dayOfMonth));
}

function firstOfMonthIso(iso) {
  return iso.slice(0, 7) + '-01';
}

function anchorDayOf(iso) {
  return Number(iso.slice(8, 10));
}

// Дата на `months` месяцев дальше от начала месяца baseIso, с обрезкой числа
// до длины месяца: 31.01 +1 → 28.02, +2 → 31.03 — число возвращается, а не
// застревает в 28 (Б7.2).
function occurrenceAtMonthDay(baseIso, day, months) {
  const base = parseISODate(firstOfMonthIso(baseIso));
  const target = base.getMonth() + months;
  const year = base.getFullYear() + Math.floor(target / 12);
  const monthIndex = ((target % 12) + 12) % 12;
  return toISODate(new Date(year, monthIndex,
    Math.min(day, lastDayOfMonth(year, monthIndex))));
}

/* Ряд дат ПРАВИЛА строго после указанной даты.

   Индекс 1 ряда = ВТОРОЙ экземпляр: первый — всегда собственная дата задачи,
   иначе «повторяется по понедельникам», поставленное в среду, сдвинуло бы уже
   созданную задачу.

   Поиск ограничен (Б7.10): сутки и недели — 100 годами, месяцы и годы —
   1200 месяцев. ВЫХОД: {status:'ok'|'none'|'invalid', reason, dates}. */
function ruleDatesAfter(schedule, afterIso, limit, context) {
  const repeat = isRecord(schedule.repeat) ? schedule.repeat : null;
  if (!repeat) return { status: 'none', reason: 'no-repeat', dates: [] };
  if (!oneOf(repeat.unit, REPEAT_UNITS)) {
    return { status: 'invalid', reason: 'unknown-unit', dates: [] };
  }
  if (!afterIso) return { status: 'invalid', reason: 'no-start-date', dates: [] };

  const interval = intIn(repeat.interval, SCHEDULE_LIMITS.intervalMin,
    SCHEDULE_LIMITS.intervalMax);
  if (interval === null) return { status: 'invalid', reason: 'invalid-interval', dates: [] };

  const ends = isRecord(repeat.ends) ? repeat.ends
    : { type: 'never', until: null, count: null };
  if (ends.type === 'count') {
    const total = intIn(ends.count, SCHEDULE_LIMITS.countMin, SCHEDULE_LIMITS.countMax);
    if (total === null) return { status: 'invalid', reason: 'invalid-count', dates: [] };
    // count включает текущий экземпляр: после экземпляра с номером N остаются
    // total - N продолжений, а не total - 1, — иначе серия «после N» плодила
    // бы следующий экземпляр на каждом выполнении бесконечно.
    limit = Math.min(limit, total - context.seriesIndex);
    if (limit <= 0) return { status: 'none', reason: 'count-exhausted', dates: [] };
  }
  if (ends.type === 'until' && !isoDateOrNull(ends.until)) {
    return { status: 'invalid', reason: 'invalid-until', dates: [] };
  }

  const dates = [];
  let stopped = false;
  const accept = (iso) => {
    if (!iso || stopped) return false;
    if (ordinalOfDay(iso) <= ordinalOfDay(afterIso)) return false;
    if (ends.type === 'until' && ordinalOfDay(iso) > ordinalOfDay(ends.until)) {
      stopped = true;
      return true;
    }
    dates.push(iso);
    if (dates.length >= limit) stopped = true;
    return true;
  };
  const done = () => dates.length >= limit || stopped;

  if (repeat.unit === 'dates') {
    for (const iso of repeat.dates) {
      accept(iso);
      if (done()) break;
    }
    return finishDates(dates, 'dates-exhausted');
  }

  if (repeat.unit === 'week' && repeat.weekdays.length > 0 && context.basis !== 'completion') {
    // Недели — окна от недели anchor: подходящая неделя даёт все выбранные
    // дни по возрастанию, а в первой отсекается только то, что раньше срока.
    const monday = mondayOf(afterIso);
    let week = 0;
    while (!done() && week < 52 * MAX_YEAR_SEARCH) {
      const windowStart = addCalendarDays(monday, week * interval * 7);
      for (const weekday of repeat.weekdays) {
        accept(addCalendarDays(windowStart, weekday - 1));
        if (done()) break;
      }
      week++;
    }
    return finishDates(dates, 'exhausted');
  }

  if (repeat.unit === 'month' && repeat.monthMode === 'nthWeekday'
    && context.basis !== 'completion') {
    let months = 0;
    while (!done() && months < MAX_MONTH_SEARCH) {
      const cursor = occurrenceAtMonthDay(afterIso, 1, months);
      const parsed = parseISODate(cursor);
      accept(nthWeekdayOfMonth(parsed.getFullYear(), parsed.getMonth(),
        repeat.weekday, repeat.nth));
      months += interval;
    }
    return finishDates(dates, 'exhausted');
  }

  /* Простые «каждые N единиц». На базе «от выполнения» ряд идёт от локальной
     даты завершения, а не от первичного anchor (Б7.3). */
  const base = context.basis === 'completion' && context.completionIso
    ? context.completionIso : afterIso;
  const perYear = repeat.unit === 'year' ? 12 : 1;
  const dayStep = repeat.unit === 'week' ? 7 : 1;
  const guardLimit = repeat.unit === 'day' || repeat.unit === 'week'
    ? MAX_YEAR_SEARCH * 366 : MAX_MONTH_SEARCH;
  let p = 1;
  while (!done() && p <= guardLimit) {
    let iso;
    if (repeat.unit === 'day' || repeat.unit === 'week') {
      iso = addCalendarDays(base, p * interval * dayStep);
    } else {
      /* День «по числу» — от якоря серии (Б7.2): ряд «31-го числа» обязан
         вернуть 31 после короткого месяца, а не застрять в обрезанном 28.
         От выполнения число следует дате завершения (контракт Б7.3). */
      const day = context.basis === 'completion' || context.anchorDay === null
        ? anchorDayOf(base) : context.anchorDay;
      iso = occurrenceAtMonthDay(base, day, p * interval * perYear);
    }

    if (context.basis === 'completion') {
      if (!schedule.allDay && schedule.startTime) {
        // Timed-продолжение не позже момента завершения переходит к
        // следующему допустимому периоду — без этого шага series встала бы.
        const resolved = resolveLocalMoment(iso, schedule.startTime);
        const forward = resolved.ok
          && (context.completionInstant === null || resolved.at.getTime() > context.completionInstant);
        if (!forward) { p++; continue; }
      } else if (ordinalOfDay(iso) <= ordinalOfDay(base)) {
        p++;
        continue;
      }
    }
    accept(iso);
    p++;
  }
  return finishDates(dates, 'exhausted');
}

function finishDates(dates, emptyReason) {
  if (dates.length === 0) return { status: 'none', reason: emptyReason, dates: [] };
  return { status: 'ok', reason: null, dates };
}

/* Собрать экземпляр по дате начала: интервал, календарная длина и wall-clock
   часы сохраняются; вычисленное время, попавшее в DST-провал, нормализуется
   к первому существующему моменту вперёд (Б7.1, Б3.10). */
function buildOccurrence(schedule, startDateIso, index) {
  const lengthDays = schedule.startDate && schedule.endDate
    ? Math.max(0, ordinalOfDay(schedule.endDate) - ordinalOfDay(schedule.startDate)) : 0;
  const occurrence = {
    index,
    startDate: startDateIso,
    endDate: addCalendarDays(startDateIso, lengthDays),
    startTime: schedule.allDay ? null : schedule.startTime,
    endTime: schedule.allDay ? null : schedule.endTime,
    dstShifted: false,
    requestedStartTime: null,
  };
  if (schedule.allDay || !occurrence.startTime) return occurrence;

  const resolved = resolveLocalMoment(occurrence.startDate, occurrence.startTime);
  if (resolved.ok) return occurrence;

  const nudged = shiftToFirstExisting(occurrence.startDate, occurrence.startTime);
  if (!nudged) return occurrence;

  occurrence.requestedStartTime = occurrence.startTime;
  occurrence.startTime = nudged.time;
  occurrence.dstShifted = true;

  /* Длина интервала сохраняется в минутах: сдвинулось начало — сдвигается и
     окончание, иначе 45-минутная встреча превратилась бы в 15-минутную.
     Проверка «окончание позже начала» выполняется уже по нормализованным
     границам (Б3.10). */
  const from = resolveLocalMoment(occurrence.startDate, occurrence.startTime);
  const length = intervalMinutes(schedule);
  if (from.ok && length !== null && length > 0) {
    const endInstant = new Date(from.at.getTime() + length * 60000);
    occurrence.endTime = clockPad(endInstant.getHours()) + ':' + clockPad(endInstant.getMinutes());
    occurrence.endDate = toISODate(endInstant);
  }
  return occurrence;
}

function clockPad(value) {
  return String(value).padStart(2, '0');
}

// Реальная длительность авторского интервала в минутах; если сами авторские
// моменты разобрать нельзя — wall-clock разница внутри одного дня.
function intervalMinutes(schedule) {
  if (!schedule.startTime || !schedule.endTime) return null;
  const from = resolveLocalMoment(schedule.startDate, schedule.startTime);
  const to = resolveLocalMoment(schedule.endDate, schedule.endTime);
  if (from.ok && to.ok) return Math.round((to.at - from.at) / 60000);
  const a = Number(schedule.startTime.slice(0, 2)) * 60 + Number(schedule.startTime.slice(3, 5));
  const b = Number(schedule.endTime.slice(0, 2)) * 60 + Number(schedule.endTime.slice(3, 5));
  return b > a ? b - a : null;
}

function occurrenceView(schedule, occurrence) {
  const copy = cloneSchedule({
    allDay: schedule.allDay,
    reminders: schedule.reminders,
    repeat: schedule.repeat,
  });
  return Object.assign({}, occurrence, {
    allDay: schedule.allDay,
    reminders: copy.reminders,
    repeat: copy.repeat,
  });
}

function completionContext(schedule, options) {
  const repeat = isRecord(schedule.repeat) ? schedule.repeat : {};
  const given = options && isDateLike(options.completionDate) ? options.completionDate : null;
  return {
    basis: repeat.basis === 'completion' && given ? 'completion' : repeat.basis,
    completionIso: given ? toISODate(given) : null,
    completionInstant: given ? given.getTime() : null,
    // Номер текущего экземпляра в серии (Б7.5): ряд enumerateOccurrences
    // всегда начинается с первого экземпляра, поэтому по умолчанию 1.
    // nextOccurrence подставляет настоящий номер из series.index — иначе
    // «после N» считал потолок от начала правила и серия не заканчивалась.
    seriesIndex: 1,
    // Якорный день серии для месячного/годового «по числу» (Б7.2): по
    // умолчанию день base — для ряда enumerate base и есть якорь.
    anchorDay: null,
  };
}

/* Экземпляры серии, начиная с собственного (index=1).

   (schedule, {count, completionDate}) →
   {status, reason, occurrences:[{index, startDate, endDate, startTime,
   endTime, allDay, reminders, repeat, dstShifted, requestedStartTime}]} */
export function enumerateOccurrences(schedule, options) {
  const s = isRecord(schedule) ? normalizeSchedule(schedule).schedule : emptySchedule();
  const opts = isRecord(options) ? options : {};
  const requested = intIn(opts.count, 1, 2000) || 1;

  if (!s.repeat) return { status: 'none', reason: 'no-repeat', occurrences: [] };
  if (!oneOf(s.repeat.unit, REPEAT_UNITS)) {
    return { status: 'invalid', reason: 'unknown-unit', occurrences: [] };
  }
  if (!s.startDate) return { status: 'invalid', reason: 'no-start-date', occurrences: [] };
  if (s.repeat.unit === 'week' && s.repeat.weekdays.length === 0) {
    return { status: 'invalid', reason: 'no-weekdays', occurrences: [] };
  }
  if (s.repeat.unit === 'dates' && s.repeat.dates.indexOf(s.startDate) < 0) {
    return { status: 'invalid', reason: 'start-not-in-dates', occurrences: [] };
  }

  const occurrences = [occurrenceView(s, buildOccurrence(s, s.startDate, 1))];
  if (requested > 1) {
    const result = ruleDatesAfter(s, s.startDate, requested - 1, completionContext(s, opts));
    if (result.status === 'invalid') {
      return { status: 'invalid', reason: result.reason, occurrences: [] };
    }
    for (const iso of result.dates) {
      occurrences.push(occurrenceView(s, buildOccurrence(s, iso, occurrences.length + 1)));
    }
  }
  return { status: 'ok', reason: null, occurrences };
}

// Следующий экземпляр после текущего (index+1) или диагностируемый 'none'.
export function nextOccurrence(schedule, options) {
  const s = isRecord(schedule) ? normalizeSchedule(schedule).schedule : emptySchedule();
  const series = isRecord(s.series) ? s.series : null;
  const currentIndex = series && intOrNull(series.index) !== null
    ? Math.max(1, series.index) : 1;

  if (!s.repeat || !s.startDate) {
    return { status: 'none', reason: s.repeat ? 'no-start-date' : 'no-repeat', occurrence: null, series: null };
  }

  // Настоящий номер экземпляра и якорный день серии: потолок «после N» и
  // день «по числу» считаются от них, а не от начала правила (Б7.5, Б7.2).
  const context = Object.assign(completionContext(s, options || {}), {
    seriesIndex: currentIndex,
    anchorDay: series && series.anchorDay ? series.anchorDay : anchorDayOf(s.startDate),
  });
  const result = ruleDatesAfter(s, s.startDate, 1, context);
  if (result.status === 'invalid') {
    return { status: 'invalid', reason: result.reason, occurrence: null, series: null };
  }
  if (result.dates.length === 0) {
    return { status: 'none', reason: result.reason, occurrence: null, series: null };
  }

  const occurrence = occurrenceView(s, buildOccurrence(s, result.dates[0], currentIndex + 1));
  return {
    status: 'ok',
    reason: null,
    occurrence,
    series: {
      id: series ? series.id : null,
      index: currentIndex + 1,
      anchorDate: series && series.anchorDate ? series.anchorDate : s.startDate,
      anchorDay: series ? series.anchorDay : anchorDayOf(s.startDate),
      anchorMonth: series ? series.anchorMonth : Number(s.startDate.slice(5, 7)),
    },
  };
}

// База серии: создаётся один раз при включении правила и НЕ пересчитывается
// от обрезанного февраля (Б3).
export function seriesAnchor(startDateIso, seriesId) {
  const iso = isoDateOrNull(startDateIso);
  if (!iso) return null;
  return {
    id: idOrNull(seriesId),
    index: 1,
    anchorDate: iso,
    anchorDay: anchorDayOf(iso),
    anchorMonth: Number(iso.slice(5, 7)),
  };
}
