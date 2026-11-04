// Дочерний процесс для DST-проверок (ТЗ Б8 «Данные и даты», пункт про TZ).
//
// Windows-оболочка не даёт задать часовую зону командой `TZ=... node`, а
// проверки «несуществующих» и «неоднозначных» часов обязаны идти в нужной зоне.
// Поэтому зона задаётся через env дочернего Node processes (tests/matrix-tz.test.mjs),
// а этот файл только ПРОБУЕТ функции и печатает JSON: ожидаемые значения живут в
// тесте-родителе, а не здесь — иначе проверка копировала бы реализацию.

import {
  enumerateOccurrences,
  nextOccurrence,
  normalizeSchedule,
  resolveLocalMoment,
  scheduleDuration,
  scheduleToDue,
} from '../../js/data/matrix-schedule.js';

function probe(date, time) {
  const out = resolveLocalMoment(date, time);
  return {
    ok: out.ok === true,
    code: out.code || null,
    ambiguous: out.ambiguous === true,
    hour: out.ok ? out.at.getHours() : null,
    minute: out.ok ? out.at.getMinutes() : null,
    epoch: out.ok ? out.at.getTime() : null,
  };
}

const report = {
  tz: process.env.TZ || null,

  // Настенные моменты вокруг переходов времени в разных зонах
  moments: {
    plain: probe('2026-11-04', '09:30'),
    berlinSpring: probe('2026-03-29', '02:30'),
    newYorkSpring: probe('2026-03-08', '02:30'),
    berlinAutumn: probe('2026-10-25', '02:30'),
    newYorkAutumn: probe('2026-11-01', '01:30'),
    midnight: probe('2026-11-04', '00:00'),
    lastMinute: probe('2026-11-04', '23:59'),
  },

  // Длительность: календарные дни для all-day и реальные минуты для timed
  durations: {
    allDayAcrossSpring: scheduleDuration(normalizeSchedule({
      allDay: true, startDate: '2026-03-28', endDate: '2026-03-30',
    }).schedule),
    timedAcrossBerlinSpring: scheduleDuration(normalizeSchedule({
      allDay: false, startDate: '2026-03-29', endDate: '2026-03-29',
      startTime: '01:00', endTime: '03:30',
    }).schedule),
    timedOvernight: scheduleDuration(normalizeSchedule({
      allDay: false, startDate: '2026-11-04', endDate: '2026-11-05',
      startTime: '23:30', endTime: '00:15',
    }).schedule),
  },

  // Дата без времени не имеет права сдвигаться ни в одной зоне
  allDayRoundtrip: [
    '2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26',
  ].map(date => {
    const s = normalizeSchedule({ allDay: true, startDate: date, endDate: date }).schedule;
    return { input: date, startDate: s.startDate, endDate: s.endDate, due: scheduleToDue(s) };
  }),

  // Повтор, чьё вычисленное время попадает в весенний провал
  dailyAcrossGap: (() => {
    const s = normalizeSchedule({
      allDay: false, startDate: '2026-03-28', endDate: '2026-03-28',
      startTime: '02:30', endTime: '03:15',
      repeat: { unit: 'day', interval: 1 },
    }).schedule;
    const out = nextOccurrence(s, {});
    const o = out.occurrence || {};
    return {
      status: out.status,
      startDate: o.startDate || null,
      startTime: o.startTime || null,
      endTime: o.endTime || null,
      requestedStartTime: o.requestedStartTime || null,
      dstShifted: o.dstShifted === true,
      valid: validateDurationOf(o),
    };
  })(),

  // Месячный и годовой ряд через границу перехода времени
  monthlyAcrossGap: (() => {
    const s = normalizeSchedule({
      allDay: true, startDate: '2026-03-31', endDate: '2026-03-31',
      repeat: { unit: 'month', interval: 1, monthMode: 'dayOfMonth' },
    }).schedule;
    return enumerateOccurrences(s, { count: 4 }).occurrences.map(o => o.startDate);
  })(),
};

function validateDurationOf(occurrence) {
  if (!occurrence || !occurrence.startDate) return null;
  const d = scheduleDuration(normalizeSchedule(Object.assign({}, occurrence, {
    allDay: false,
    reminders: [],
    repeat: null,
    series: null,
  })).schedule);
  return d.minutes === null ? null : d.minutes;
}

process.stdout.write(JSON.stringify(report));
process.exit(0);
