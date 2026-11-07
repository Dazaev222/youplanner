// Дочерний процесс для проверок сдвига дат (задача 1.4).
//
// Windows-оболочка не передаёт зону через `TZ=... node` (см. шапку
// tests/matrix-tz.test.mjs), поэтому зона задаётся env дочернего Node, а этот
// файл только ПРОБУЕТ функции и печатает JSON. Ожидаемые значения живут в
// тесте-родителе (tests/dates-shift.test.mjs) и выводятся из календаря, а не
// из реализации — иначе проверка копировала бы то, что проверяет.

import {
  addDays, getMonthDatesToToday, getWeekStart, isDateLike, parseISODate,
  toISODate,
} from '../../js/core/dates.js';
import { kazaDayBoundary, kazaDayFor } from '../../js/data/qaza.js';
import { prayerDateISO, prayerMinutes } from '../../js/data/prayer.js';

// Пачка «опасных» дат: граница года 2025→2026, невисокосный февраль 2026,
// високосный 2028, 31-е число перед коротким месяцем, границы месяцев.
const ROUND_TRIP_DATES = [
  '2025-12-31', '2026-01-01', '2026-02-28', '2026-03-01', '2026-06-30',
  '2026-10-31', '2026-11-07', '2026-11-30', '2026-12-31', '2027-01-01',
  '2028-02-28', '2028-02-29',
];

// Инстансы для каза/молитв задаются в UTC — ожидания считает тест-родитель
// по правилу «пояс молитв закреплён за UTC+3» (PRAYER_TZ = 3, js/data/prayer.js).
const UTC_INSTANTS = {
  beforeFajrUtc3: Date.UTC(2026, 10, 7, 1, 59),   // 04:59 UTC+3, до границы 05:00
  atFajrUtc3: Date.UTC(2026, 10, 7, 2, 0),        // 05:00 UTC+3 — ровно граница
  eveningUtc3: Date.UTC(2026, 10, 7, 20, 0),      // 23:00 UTC+3
  midnightUtc3: Date.UTC(2026, 10, 7, 21, 0),     // 00:00 UTC+3 следующего дня
  localNightAlmaty: Date.UTC(2026, 10, 7, 19, 0), // 00:00 в Алматы (+5) 8-го
};

function roundtripAll() {
  const out = {};
  for (const iso of ROUND_TRIP_DATES) {
    const parsed = parseISODate(iso);
    out[iso] = isDateLike(parsed) ? toISODate(parsed) : 'invalid';
  }
  return out;
}

function shiftAll() {
  const d = (iso) => parseISODate(iso);
  return {
    yearForward: toISODate(addDays(d('2025-12-31'), 1)),
    yearBack: toISODate(addDays(d('2026-01-01'), -1)),
    febNonLeap: toISODate(addDays(d('2026-02-28'), 1)),
    febLeap: toISODate(addDays(d('2028-02-28'), 1)),
    monthEnd31: toISODate(addDays(d('2026-10-31'), 1)),
    monthEnd30: toISODate(addDays(d('2026-06-30'), 1)),
    dstEuropeEnd: toISODate(addDays(d('2026-10-25'), 1)),
    dstUsEnd: toISODate(addDays(d('2026-11-01'), 1)),
    thirtyDays: toISODate(addDays(d('2026-11-07'), 30)),
  };
}

function weekStartAll() {
  const d = (iso) => toISODate(getWeekStart(parseISODate(iso)));
  return {
    thursdayNewYear: d('2026-01-01'),    // четверг → понедельник 2025-12-29
    mondayPlain: d('2026-11-02'),
    sundayPlain: d('2026-11-08'),
    sundayUsDstEnd: d('2026-11-01'),     // США: перевод 01.11.2026
    sundayEuropeDstEnd: d('2026-10-25'), // Европа: перевод 25.10.2026
  };
}

function monthDates() {
  const dates = getMonthDatesToToday(2026, 10); // индекс 10 = ноябрь 2026
  const now = new Date();
  return {
    todayDate: now.getDate(),
    allNovember: dates.every((iso) => /^2026-11-\d{2}$/.test(iso)),
    count: dates.length,
    first: dates[0] || null,
    last: dates[dates.length - 1] || null,
  };
}

function kazaProbes() {
  // В чистом процессе localStorage нет: loadPrayer() отвечает null, граница
  // дня берёт запасной Фаджр 05:00 UTC+3 (qaza.js kazaDayBoundary FALLBACK).
  const out = { boundary: kazaDayBoundary(new Date(UTC_INSTANTS.atFajrUtc3)) };
  for (const [name, instant] of Object.entries(UTC_INSTANTS)) {
    out[name] = kazaDayFor(new Date(instant));
  }
  return out;
}

function prayerProbes() {
  const out = {};
  for (const [name, instant] of Object.entries(UTC_INSTANTS)) {
    out[name] = {
      date: prayerDateISO(new Date(instant)),
      minutes: Math.round(prayerMinutes(new Date(instant))),
    };
  }
  return out;
}

// Мусор и несуществующие даты: parseISODate документированно разворачивает
// «31 ноября» в 1 декабря (валидацию делает isoDateOrNull в matrix-schedule.js
// круглой проверкой), а на нечисловой мусоре даёт Invalid Date.
function parseEdge() {
  const rolled = parseISODate('2026-11-31');
  const junk = parseISODate('мусор');
  return {
    rollover: isDateLike(rolled) ? toISODate(rolled) : 'invalid',
    junkInvalid: !isDateLike(junk),
  };
}

const report = {
  tz: process.env.TZ || null,
  roundtrip: roundtripAll(),
  shifts: shiftAll(),
  weekStarts: weekStartAll(),
  month: monthDates(),
  kaza: kazaProbes(),
  prayer: prayerProbes(),
  parseEdge: parseEdge(),
};

process.stdout.write(JSON.stringify(report));
