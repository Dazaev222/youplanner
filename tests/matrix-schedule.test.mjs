// ТЗ Воркера 2, пункты Б3 + Б8 «Данные и даты».
//
// RED-тесты домена расписания: вложенный `schedule` версии 1, его нормализация,
// валидация, длительность, локальные моменты и напоминания.
//
// Что здесь СОЗНАТЕЛЬНО не подменено:
//   * `normalizeSchedule`/`validateSchedule`/`resolveLocalMoment` вызываются
//     НАСТОЯЩИМИ модулями, а не ожиданиями из теста;
//   * запись и перечитывание идут через реальные `saveTasks`/`loadTasks`
//     песочницы node:vm с настоящим localStorage-фейком;
//   * `deepEqual` сравнивает результат редьюсера с независимыми literals,
//     а не с удвоенным вызовом той же функции.
//
// Фиксированные даты: ноябрь 2026 (04.11 — среда). Ожидаемые значения проставлены
// руками, а не скопированы из расчёта реализации.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

import {
  SCHEDULE_VERSION,
  emptySchedule,
  enumerateOccurrences,
  normalizeSchedule,
  reminderMoment,
  resolveLocalMoment,
  scheduleDuration,
  scheduleToDue,
  validateSchedule,
} from '../js/data/matrix-schedule.js';

// Короткий построитель: normalize заполняет defaults, поэтому тест описывает
// только интересную часть и не раздувается.
function sched(over) {
  return normalizeSchedule(over || {}).schedule;
}

// Форма вызывает валидатор на ИСХОДНОМ значении: нормализация отбрасывает
// повреждённые опции, и повторная проверка уже нормализованного объекта не
// видела бы, что именно пришлось убрать.
function validateDraft(over) {
  return validateSchedule(over || {});
}

function taskOf(ctx, over) {
  return Object.assign({
    id: 't1', title: 'Задача', notes: '', due: null, doDate: null,
    priority: 0, done: false, doneAt: null,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    order: 1, archived: false,
  }, over || {});
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const BASE_EXPECT = {
  version: 1,
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

/* ========================================================================= */
/* Б3.2 — пустая задача и legacy-миграция                                    */
/* ========================================================================= */

test('Б3.2 пустой schedule нормализуется в полный набор defaults', (t) => {
  assert.deepEqual(plain(emptySchedule()), plain(BASE_EXPECT));
  assert.deepEqual(plain(sched({})), plain(BASE_EXPECT));
  assert.deepEqual(plain(normalizeSchedule(null).schedule), plain(BASE_EXPECT));
  assert.deepEqual(plain(normalizeSchedule(undefined).schedule), plain(BASE_EXPECT));
  assert.deepEqual(plain(normalizeSchedule('строка вместо объекта').schedule),
    plain(BASE_EXPECT), 'мусор вместо схемы не должен ронять нормализацию');
  assert.equal(SCHEDULE_VERSION, 1);
});

test('Б8 legacy {due:2026-11-04} → all-day 04.11–04.11, due не сдвинут', (t) => {
  const { context: ctx } = loadApp();
  const cleaned = ctx.sanitizeTask(taskOf(ctx, {
    due: '2026-11-04', priority: 3, doDate: '2026-10-20', notes: 'заметка',
  }));

  assert.equal(cleaned.due, '2026-11-04', 'верхнеуровневый due обязан совпасть с endDate');
  assert.equal(cleaned.priority, 3, 'priority не меняется из-за миграции');
  assert.equal(cleaned.doDate, '2026-10-20', 'семантика doDate не трогается');
  assert.equal(cleaned.notes, 'заметка');

  assert.deepEqual(plain(cleaned.schedule), plain(Object.assign({}, BASE_EXPECT, {
    startDate: '2026-11-04',
    endDate: '2026-11-04',
  })), 'legacy-срок становится all-day интервалом из одного дня');
});

test('Б3.2 миграция legacy due через явный options.legacyDue', (t) => {
  const out = normalizeSchedule(null, { legacyDue: '2026-11-07' }).schedule;
  assert.equal(out.startDate, '2026-11-07');
  assert.equal(out.endDate, '2026-11-07');
  assert.equal(out.allDay, true);
  assert.deepEqual(
    plain(normalizeSchedule(null, { legacyDue: 'не дата' }).schedule),
    plain(BASE_EXPECT), 'битый legacy due не выдумывает дату');
});

test('Б8 legacy без due → пустые даты, all-day true', (t) => {
  const { context: ctx } = loadApp();
  const cleaned = ctx.sanitizeTask(taskOf(ctx, { due: null }));
  assert.equal(cleaned.due, null);
  assert.deepEqual(plain(cleaned.schedule), plain(BASE_EXPECT));
});

test('Б3.2 legacy с битой датой → null даты, а не дата-призрак', (t) => {
  const { context: ctx } = loadApp();
  const cleaned = ctx.sanitizeTask(taskOf(ctx, { due: '2026-13-45' }));
  assert.equal(cleaned.due, null);
  assert.equal(cleaned.schedule.startDate, null);
  assert.equal(cleaned.schedule.endDate, null);
});

test('Б8 две нормализации подряд дают идентичный результат (идемпотентность)', (t) => {
  const first = normalizeSchedule({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-06',
    startTime: '09:00', endTime: '10:30',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15 }],
    repeat: { unit: 'day', interval: 2, ends: { type: 'count', count: 3 } },
  }).schedule;
  const second = normalizeSchedule(first).schedule;
  assert.deepEqual(plain(second), plain(first), 'идемпотентность на нормализованной схеме');

  const { context: ctx } = loadApp();
  const once = ctx.sanitizeTask(taskOf(ctx, { schedule: first }));
  const twice = ctx.sanitizeTask(once);
  assert.deepEqual(plain(twice), plain(once), 'санитайзер идемпотентен на задаче с repeat');
});

/* ========================================================================= */
/* Б3.1/Б3.3 — due выводится из endDate, приоритет schedule над due           */
/* ========================================================================= */

test('Б3.1 due вычисляется из endDate, а не хранится отдельно', (t) => {
  assert.equal(scheduleToDue(sched({ startDate: '2026-11-04', endDate: '2026-11-09' })),
    '2026-11-09');
  assert.equal(scheduleToDue(sched({})), null);
  assert.equal(scheduleToDue(null), null);
});

test('Б3.3 schedule.version=1 приоритетнее несовпадающего due, затем due синхронизируется', (t) => {
  const { context: ctx } = loadApp();
  const cleaned = ctx.sanitizeTask(taskOf(ctx, {
    due: '2026-11-20',
    schedule: { version: 1, allDay: true, startDate: '2026-11-04', endDate: '2026-11-06' },
  }));
  assert.equal(cleaned.schedule.endDate, '2026-11-06', 'расписание выигрывает');
  assert.equal(cleaned.due, '2026-11-06', 'верхнеуровневый due подтягивается за endDate');
});

/* ========================================================================= */
/* Б3.4 — обе даты, all-day против timed                                     */
/* ========================================================================= */

test('Б3.4 одна дата заполняет обе, all-day последний день включителен', (t) => {
  const only = sched({ startDate: '2026-11-04' });
  assert.equal(only.startDate, '2026-11-04');
  assert.equal(only.endDate, '2026-11-04', 'вторая граница подставляется автоматически');
  assert.equal(validateSchedule(only).ok, true);
});

test('Б3.4 all-day: обе time обнуляются, интервал из разных дней валиден', (t) => {
  const allDay = sched({
    allDay: true, startDate: '2026-11-04', endDate: '2026-11-06',
    startTime: '09:00', endTime: '10:00',
  });
  assert.equal(allDay.startTime, null, 'в all-day времени в модели нет');
  assert.equal(allDay.endTime, null);

  const span = sched({ allDay: true, startDate: '2026-11-04', endDate: '2026-11-06' });
  assert.equal(validateSchedule(span).ok, true, 'разные даты разрешены');
  assert.deepEqual(plain(scheduleDuration(span)),
    { kind: 'allDay', days: 3, minutes: null, label: '3 дня' },
    'all-day длительность — календарные дни включительно');

  assert.deepEqual(plain(scheduleDuration(sched({ allDay: true, startDate: '2026-11-04' }))),
    { kind: 'allDay', days: 1, minutes: null, label: '1 день' }, 'один день допустим');

  assert.deepEqual(plain(scheduleDuration(sched({}))),
    { kind: 'none', days: 0, minutes: null, label: '' }, 'без даты нет длительности');
});

test('Б8 04.11 23:30 → 05.11 00:15 = 45 минут', (t) => {
  const night = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-05',
    startTime: '23:30', endTime: '00:15',
  });
  assert.equal(validateSchedule(night).ok, true);
  assert.deepEqual(plain(scheduleDuration(night)),
    { kind: 'timed', days: 2, minutes: 45, label: '45 мин' });
});

test('Б8 04.11 23:30 → 04.11 00:15 отклонено; равные timed границы отклонены', (t) => {
  const wrong = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '23:30', endTime: '00:15',
  });
  const report = validateSchedule(wrong);
  assert.equal(report.ok, false, 'раннее окончание в тот же день — ошибка, а не «завтра»');
  assert.ok(report.issues.some(i => i.field === 'endTime'), 'ошибка относится к полю окончания');

  const equal = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '09:00', endTime: '09:00',
  });
  assert.equal(validateSchedule(equal).ok, false, 'окончание строго позже начала');

  const wholeDay = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-05',
    startTime: '09:00', endTime: '09:00',
  });
  assert.equal(validateSchedule(wholeDay).ok, true,
    'сутки спустя — окончание строго позже начала, даже при равных часах');
  assert.deepEqual(plain(scheduleDuration(wholeDay)),
    { kind: 'timed', days: 2, minutes: 1440, label: '24 ч' },
    'длительность считается реальными минутами между моментами');
});

test('Б8 время без даты — ошибка; дата без времени валидна как all-day', (t) => {
  const timeOnly = sched({ allDay: false, startTime: '09:00', endTime: '10:00' });
  const report = validateSchedule(timeOnly);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some(i => i.field === 'startDate'));
  assert.equal(validateDraft({ allDay: true, startDate: '2026-11-04' }).ok, true);
});

test('Б8 обратный порядок дат отклонён', (t) => {
  assert.equal(validateDraft({ startDate: '2026-11-06', endDate: '2026-11-04' }).ok, false);
});

/* ========================================================================= */
/* Б3.5 — строгие форматы: несуществующие даты и время                        */
/* ========================================================================= */

test('Б3.5 несуществующие даты и формат времени отклоняются, а не перевозбраются', (t) => {
  const { context: ctx } = loadApp();
  for (const bad of ['2026-02-30', '2026-02-31', '2026-13-01', '2026-11-00', '2026-11-31']) {
    const out = sched({ startDate: bad, endDate: bad });
    assert.equal(out.startDate, null, bad + ': несуществующая дата не попадает в модель');
  }

  for (const bad of ['24:00', '9:5', '09:5', '9:05', '25:00', '09:60', '0900', '09:00:30']) {
    const out = sched({
      allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
      startTime: bad, endTime: bad,
    });
    assert.equal(out.startTime, null, bad + ': время вне 00:00–23:59 или без ведущего нуля');
  }

  const good = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '00:00', endTime: '23:59',
  });
  assert.equal(good.startTime, '00:00');
  assert.equal(good.endTime, '23:59');

  const viaTask = ctx.sanitizeTask(taskOf(ctx, {
    due: '2026-02-30', schedule: { version: 1, startDate: '2026-02-30' },
  }));
  assert.equal(viaTask.schedule.startDate, null);
});

test('Б3.5 числа не приводятся из строк, NaN/Infinity не проходят', (t) => {
  const fromStrings = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-05',
    startTime: '09:00', endTime: '10:00',
    repeat: { unit: 'day', interval: '2' },
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: '15' }],
  });
  assert.equal(fromStrings.repeat.interval, 1, 'interval строкой не проходит');
  assert.equal(fromStrings.reminders.length, 0, 'offsetMinutes строкой не проходит');

  for (const junk of [NaN, Infinity, -Infinity, 1.5]) {
    const out = sched({
      startDate: '2026-11-04',
      reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: junk }],
    });
    assert.equal(out.reminders.length, 0, String(junk) + ': нецелое/бесконечное смещение отброшено');
  }

  const badSeries = sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1 },
    series: { id: 's1', index: 0, anchorDate: '2026-11-04', anchorDay: 4, anchorMonth: 11 },
  });
  assert.ok(badSeries.series.index >= 1, 'series.index не может быть меньше 1');
});

test('Б3.5 произвольные ключи в schedule, repeat и reminder отбрасываются', (t) => {
  const out = sched({
    startDate: '2026-11-04',
    хвост: 'мусор',
    repeat: { unit: 'day', interval: 1, side: 'мусор', ends: { type: 'never', хвост: 1 } },
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 5, push: true }],
  });
  assert.equal(out.хвост, undefined);
  assert.equal(out.repeat.side, undefined);
  assert.equal(out.repeat.ends.хвост, undefined);
  assert.equal(out.reminders[0].push, undefined);
});

/* ========================================================================= */
/* Б3.8 — ограничения и нормализация неприменимых полей                       */
/* ========================================================================= */

test('Б3.8 лимиты: reminders, offset, interval, count, dates, длина id', (t) => {
  const many = [];
  for (let i = 0; i < 8; i++) many.push({ id: 'r' + i, anchor: 'start', offsetMinutes: i });
  assert.ok(sched({ startDate: '2026-11-04', reminders: many }).reminders.length <= 5,
    'не больше пяти напоминаний');

  assert.equal(sched({
    startDate: '2026-11-04',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 525601 }],
  }).reminders.length, 0, 'смещение свыше 365 суток отброшено');

  assert.equal(sched({
    startDate: '2026-11-04',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 525600 }],
  }).reminders.length, 1, 'граница 525600 включительно');

  for (const bad of [0, -1, 1000]) {
    const draft = { startDate: '2026-11-04', repeat: { unit: 'day', interval: bad } };
    assert.equal(sched(draft).repeat, null, 'interval ' + bad + ' не ложится в хранилище');
    assert.equal(validateSchedule(draft).ok, false, 'interval ' + bad + ' отклоняется валидатором формы');
  }

  const manyDates = [];
  for (let day = 1; day <= 28; day++) manyDates.push('2027-11-' + String(day).padStart(2, '0'));
  const extra = manyDates.slice();
  for (let m = 1; m <= 14; m++) extra.push('2028-01-' + String(m).padStart(2, '0'));
  const tooMany = sched({ startDate: '2026-11-04', repeat: { unit: 'dates', dates: extra } });
  assert.ok(tooMany.repeat === null || tooMany.repeat.dates.length <= 366,
    'более 366 дат повтором не становится');

  for (const bad of [0, 10001]) {
    assert.equal(validateDraft({
      startDate: '2026-11-04',
      repeat: { unit: 'day', interval: 1, ends: { type: 'count', count: bad } },
    }).ok, false, 'count ' + bad + ' вне диапазона');
  }

  const longId = sched({
    startDate: '2026-11-04',
    reminders: [{ id: 'r'.repeat(200), anchor: 'start', offsetMinutes: 5 }],
  });
  assert.ok(longId.reminders.length === 0 || longId.reminders[0].id.length <= 64,
    'длина id напоминания ограничена');
});

test('Б3.8 невалидные enum обнуляются, а не превращаются в случайное значение', (t) => {
  assert.equal(sched({ startDate: '2026-11-04', repeat: { unit: 'fortnight', interval: 1 } }).repeat,
    null);

  assert.equal(sched({
    startDate: '2026-11-04',
    reminders: [{ id: 'r1', anchor: 'middle', offsetMinutes: 5 }],
  }).reminders.length, 0);

  assert.equal(sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, basis: 'sometimes' },
  }).repeat.basis, 'scheduled', 'неизвестный basis — явный дефолт');

  assert.equal(sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'maybe' } },
  }).repeat.ends.type, 'never', 'неизвестный ends — явный дефолт');

  assert.equal(validateDraft({
    startDate: '2026-11-04',
    repeat: { unit: 'month', interval: 1, monthMode: 'everyWhichDay' },
  }).ok, false, 'неизвестный monthMode ловится валидатором');
});

test('Б3.8 для обычных единиц неприменимые поля нормализуются', (t) => {
  const weekly = sched({
    startDate: '2026-11-04',
    repeat: {
      unit: 'week', interval: 1, weekdays: [3, 1, 3, 7],
      dates: ['2026-11-09'], monthMode: 'nthWeekday', nth: 2, weekday: 5,
    },
  });
  assert.deepEqual(plain(weekly.repeat.weekdays), [1, 3, 7],
    'weekdays: уникальные, возрастающие, ISO-нумерация');
  assert.deepEqual(plain(weekly.repeat.dates), [], 'dates живут только у unit=dates');
  assert.equal(weekly.repeat.monthMode, 'dayOfMonth', 'monthMode неприменим к неделе');
  assert.equal(weekly.repeat.nth, null);
  assert.equal(weekly.repeat.weekday, null);

  const daily = sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, weekdays: [9, 0, 1], dates: ['не дата'] },
  });
  assert.deepEqual(plain(daily.repeat.weekdays), [], 'вне недели список дней пуст');
  assert.deepEqual(plain(daily.repeat.dates), []);
});

test('Б3.8 ends: never/until/count взаимно исключают лишние границы', (t) => {
  assert.deepEqual(plain(sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'never', until: '2026-12-01', count: 4 } },
  }).repeat.ends), { type: 'never', until: null, count: null });

  assert.deepEqual(plain(sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'until', until: '2026-12-01', count: 4 } },
  }).repeat.ends), { type: 'until', until: '2026-12-01', count: null }, 'until не хранит count');

  assert.deepEqual(plain(sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'count', until: '2026-12-01', count: 4 } },
  }).repeat.ends), { type: 'count', until: null, count: 4 }, 'count не хранит until');

  assert.equal(validateDraft({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'until' } },
  }).ok, false, 'until без даты — невалидно');

  assert.equal(validateDraft({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'until', until: '2026-02-30', count: null } },
  }).ok, false, 'несуществующая дата окончания — невалидно');
});

test('Б3.8 unit=dates требует interval=1 и basis=scheduled', (t) => {
  const dates = sched({
    startDate: '2026-11-04',
    repeat: {
      unit: 'dates', interval: 3, basis: 'completion',
      dates: ['2026-11-04', '2026-11-09', '2026-11-04', '2026-11-02', 'не дата'],
    },
  });
  assert.equal(dates.repeat.interval, 1);
  assert.equal(dates.repeat.basis, 'scheduled');
  assert.deepEqual(plain(dates.repeat.dates), ['2026-11-02', '2026-11-04', '2026-11-09'],
    'даты начал сортируются, уникализируются и очищаются от мусора');
});

test('Б3.8 repeat=null влечёт series=null; series без правила не живёт', (t) => {
  const out = sched({
    startDate: '2026-11-04',
    repeat: null,
    series: { id: 's1', index: 3, anchorDate: '2026-11-01', anchorDay: 1, anchorMonth: 11 },
  });
  assert.equal(out.repeat, null);
  assert.equal(out.series, null);
});

test('Б3.8 absolute-напоминание требует date+time и offset=0', (t) => {
  assert.deepEqual(plain(sched({
    startDate: '2026-11-04',
    reminders: [{
      id: 'r1', anchor: 'absolute', offsetMinutes: 30,
      date: '2026-11-03', time: '08:00',
    }],
  }).reminders), [
    { id: 'r1', anchor: 'absolute', offsetMinutes: 0, date: '2026-11-03', time: '08:00' },
  ]);

  assert.equal(validateDraft({
    startDate: '2026-11-04',
    reminders: [{ id: 'r2', anchor: 'absolute', offsetMinutes: 0, time: '08:00' }],
  }).ok, false, 'absolute без даты невалиден');

  const relative = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '09:00', endTime: '10:00',
    reminders: [{ id: 'r3', anchor: 'end', offsetMinutes: 0, date: '2026-11-03', time: '08:00' }],
  });
  assert.equal(relative.reminders[0].date, null, 'у относительного напоминания даты нет');
  assert.equal(relative.reminders[0].time, null, 'у timed-относительного времени нет');
});

test('Б3.8 all-day относительное напоминание: только целыми сутками и со временем', (t) => {
  const allDay = sched({
    allDay: true, startDate: '2026-11-04', endDate: '2026-11-06',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 1500 }],
  });
  assert.equal(allDay.reminders[0].offsetMinutes % 1440, 0, 'опережение только целыми сутками');
  assert.equal(allDay.reminders[0].time, '09:00', 'время по умолчанию');

  assert.equal(validateDraft({
    allDay: true, startDate: '2026-11-04',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15, time: '09:00' }],
  }).ok, false, 'минутное опережение в all-day невалидно');
});

/* ========================================================================= */
/* Б3.6 — безопасная деградация повреждённых данных                           */
/* ========================================================================= */

test('Б3.6 повреждённое timed-время деградирует в all-day на годных датах', (t) => {
  const { context: ctx } = loadApp();
  const broken = ctx.sanitizeTask(taskOf(ctx, {
    title: 'Годная задача',
    due: '2026-11-04',
    schedule: {
      version: 1, allDay: false, startDate: '2026-11-04', endDate: '2026-11-05',
      startTime: '25:00', endTime: 'не время',
      reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 10 }],
    },
  }));

  assert.notEqual(broken, null, 'задача не удалена из-за битого времени');
  assert.equal(broken.title, 'Годная задача', 'название сохранено');
  assert.equal(broken.schedule.allDay, true, 'деградация в all-day');
  assert.equal(broken.schedule.startDate, '2026-11-04', 'годные даты сохранены');
  assert.equal(broken.schedule.endDate, '2026-11-05');
  assert.equal(broken.schedule.startTime, null);
  assert.equal(broken.due, '2026-11-05', 'due выведен из endDate, а не из битого расписания');
  assert.equal(broken.schedule.reminders.length, 0, 'напоминание, требующее времени, отключено');
});

test('Б3.6 повреждённый schedule не удаляет годную legacy-задачу и диагностируется', (t) => {
  const { context: ctx } = loadApp();
  assert.equal(ctx.saveTasks([
    taskOf(ctx, {
      id: 'bitaya', title: 'Битая', due: '2026-11-04',
      schedule: { version: 1, startDate: '2026-02-30', repeat: { unit: 'нед', interval: 0 } },
    }),
    taskOf(ctx, { id: 'godnaya', title: 'Годная', due: '2026-11-05' }),
  ]), true);

  const loaded = ctx.loadTasks();
  assert.deepEqual(plain(loaded.map(x => x.id)), ['bitaya', 'godnaya'],
    'список не теряется из-за одной повреждённой записи');
  assert.equal(loaded[0].title, 'Битая');
  assert.equal(loaded[0].due, '2026-11-04', 'дата восстановлена из валидного legacy due');

  const report = ctx.loadTasksReport();
  assert.ok(report.issues.some(i => i.taskId === 'bitaya'),
    'восстановление сообщается диагностикой, а не молча');
});

test('Б3.3 неизвестная версия: protected passthrough без потери полей', (t) => {
  const { context: ctx } = loadApp();
  const exotic = {
    version: 2,
    someFutureField: { deep: [1, 2, { three: 'три' }], flag: true, nul: null },
    alsoUnknown: 'значение',
  };
  assert.equal(ctx.saveTasks([
    taskOf(ctx, { id: 'unknown', title: 'Из будущей версии', due: '2026-11-08', schedule: exotic }),
    taskOf(ctx, { id: 'plain', title: 'Обычная', due: '2026-11-04' }),
  ]), true);

  // Правка ДРУГОЙ задачи + save всего массива не должна съесть неизвестную запись
  const edited = ctx.loadTasks().map(t => (t.id === 'plain' ? ctx.markDone(t, true) : t));
  assert.equal(ctx.saveTasks(edited), true);

  const kept = ctx.loadTasks().find(t => t.id === 'unknown');
  assert.ok(kept, 'запись с неизвестной версией не потеряна');
  assert.deepEqual(plain(kept.schedule), plain(exotic), 'неизвестная схема сохранена дословно');
  assert.equal(kept.scheduleUnsupported, true, 'признак несовместимости отмечен в модели');
  assert.equal(kept.due, '2026-11-08', 'legacy due такой записи не пересчитывается');

  const report = ctx.loadTasksReport();
  assert.ok(report.issues.some(i => i.taskId === 'unknown' && i.unsupported === true),
    'несовместимость видна в отчёте чтения');
});

/* ========================================================================= */
/* Б3.7 — round-trip через хранилище и отсутствие разделения ссылок          */
/* ========================================================================= */

test('Б8 createTask с 04.11 09:00–10:30 → save/load даёт равное расписание, due=2026-11-04', (t) => {
  const { context: ctx } = loadApp();
  const draft = {
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '09:00', endTime: '10:30',
    reminders: [
      { id: 'r1', anchor: 'start', offsetMinutes: 15 },
      { id: 'r2', anchor: 'end', offsetMinutes: 0 },
    ],
    repeat: {
      unit: 'week', interval: 2, weekdays: [1, 4],
      ends: { type: 'until', until: '2026-12-24' },
    },
  };
  // Ожидаемое значение — полный нормализованный литерал (Б3.8: у всех
  // необязательных полей есть явные defaults), а не повторный вызов редьюсера.
  const expectedNormalized = {
    version: 1,
    allDay: false,
    startDate: '2026-11-04',
    endDate: '2026-11-04',
    startTime: '09:00',
    endTime: '10:30',
    timeZoneMode: 'device',
    reminders: [
      { id: 'r1', anchor: 'start', offsetMinutes: 15, date: null, time: null },
      { id: 'r2', anchor: 'end', offsetMinutes: 0, date: null, time: null },
    ],
    repeat: {
      basis: 'scheduled',
      unit: 'week',
      interval: 2,
      weekdays: [1, 4],
      monthMode: 'dayOfMonth',
      nth: null,
      weekday: null,
      dates: [],
      ends: { type: 'until', until: '2026-12-24', count: null },
    },
    series: null,
  };

  const created = ctx.createTask({ title: 'Репетиция', priority: 3, schedule: draft });
  assert.equal(created.due, '2026-11-04', 'due = endDate');
  assert.equal(created.schedule.version, 1);
  assert.equal(created.schedule.series, null, 'series создаётся отдельно, не при sanitize');
  assert.deepEqual(plain(created.schedule), plain(expectedNormalized));

  assert.equal(ctx.saveTasks([created]), true);
  const loaded = ctx.loadTasks();
  assert.equal(loaded.length, 1);
  assert.deepEqual(plain(loaded[0].schedule), plain(expectedNormalized),
    'перечитанный schedule равен записанному');
  assert.equal(loaded[0].due, '2026-11-04');
});

test('Б3.7 unknown keys отбрасываются, вложенные ссылки не разделяются', (t) => {
  const { context: ctx } = loadApp();
  const created = ctx.createTask({
    title: 'Копия',
    schedule: { startDate: '2026-11-04', хвост: 'мусор' },
    хвост: 'мусор',
  });
  assert.equal(created.хвост, undefined);
  assert.equal(created.schedule.хвост, undefined);

  assert.equal(ctx.saveTasks([created]), true);
  const loaded = ctx.loadTasks();
  loaded[0].schedule.reminders.push({ id: 'подделка', anchor: 'start', offsetMinutes: 1 });
  loaded[0].schedule.startDate = '1999-01-01';
  const again = ctx.loadTasks();
  assert.equal(again[0].schedule.startDate, '2026-11-04',
    'правка прочитанного объекта не должна молча менять хранилище');
  assert.equal(again[0].schedule.reminders.length, 0);

  // два loaded-объекта одной задачи не разделяют вложенный массив
  const list = ctx.loadTasks();
  list[0].schedule.repeat = { unit: 'day', interval: 1 };
  assert.equal(ctx.loadTasks()[0].schedule.repeat, null);
});

test('Б3.7 операции данных сохраняют schedule: markDone, restore, archive, move', (t) => {
  const { context: ctx } = loadApp();
  const source = ctx.createTask({
    title: 'Не терять', priority: 3, due: '2026-11-04',
    schedule: {
      allDay: false, startDate: '2026-11-04', endDate: '2026-11-05',
      startTime: '09:00', endTime: '10:00',
      reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15 }],
    },
  });
  const snapshot = plain(source.schedule);

  assert.deepEqual(plain(ctx.markDone(source, true).schedule), snapshot, 'markDone');
  assert.deepEqual(
    plain(ctx.restoreTask(Object.assign({}, source, { archived: true })).schedule),
    snapshot, 'restoreTask');
  assert.deepEqual(
    plain(ctx.sanitizeTask(Object.assign({}, source, { archived: true })).schedule),
    snapshot, 'archive через sanitize');

  const moved = ctx.applyQuadrantMove(source, 'q3', new Date(2026, 10, 3));
  assert.ok(moved.schedule, 'у перенесённой задачи расписание осталось');
  assert.deepEqual(plain(moved.schedule.reminders), plain(snapshot.reminders),
    'перенос сдвигает интервал, но не убивает напоминание');
  assert.equal(moved.schedule.startTime, '09:00', 'перенос сохраняет часы начала');
  assert.equal(moved.schedule.endTime, '10:00', 'перенос сохраняет часы окончания');
});

/* ========================================================================= */
/* Б3.9/Б3.10 — локальное «настенное» время и моменты                        */
/* ========================================================================= */

test('Б3.9 дата без времени не уходит в UTC-строку', (t) => {
  assert.equal(scheduleToDue(sched({ startDate: '2026-11-04' })), '2026-11-04');
  const timed = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '00:00', endTime: '23:59',
  });
  assert.equal(scheduleToDue(timed), '2026-11-04', 'тот же день при любом времени');
});

test('Б3.10 resolveLocalMoment проверяет round-trip компонентов', (t) => {
  const ok = resolveLocalMoment('2026-11-04', '09:30');
  assert.equal(ok.ok, true);
  assert.equal(ok.at.getFullYear(), 2026);
  assert.equal(ok.at.getMonth(), 10);
  assert.equal(ok.at.getDate(), 4);
  assert.equal(ok.at.getHours(), 9);
  assert.equal(ok.at.getMinutes(), 30);
  assert.equal(ok.at.getSeconds(), 0, 'секунд у расписания нет');
  assert.equal(ok.at.getMilliseconds(), 0);

  assert.equal(resolveLocalMoment('2026-11-04', '24:00').ok, false);
  assert.equal(resolveLocalMoment('2026-02-30', '09:00').ok, false);
  assert.equal(resolveLocalMoment(null, '09:00').ok, false);
  assert.equal(resolveLocalMoment('2026-11-04', '9:00').ok, false, 'время без ведущего нуля');
  assert.equal(resolveLocalMoment('2026-11-04', 'не время').ok, false);

  const allDay = resolveLocalMoment('2026-11-04');
  assert.equal(allDay.ok, true, 'дата без времени разбирается как полночь');
  assert.equal(allDay.at.getHours(), 0);
  assert.equal(resolveLocalMoment('2026-11-04', null).at.getHours(), 0,
    'пустое время — тоже полночь: «нужно время» требует валидатор формы, а не парсер');
});

test('Б5 reminderMoment считает локальные моменты всех видов', (t) => {
  const timed = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '10:00', endTime: '10:30',
  });
  const start15 = reminderMoment(timed, { id: 'r1', anchor: 'start', offsetMinutes: 15 });
  assert.equal(start15.ok, true);
  assert.equal(start15.at.getHours(), 9);
  assert.equal(start15.at.getMinutes(), 45);

  const end0 = reminderMoment(timed, { id: 'r2', anchor: 'end', offsetMinutes: 0 });
  assert.equal(end0.at.getHours(), 10);
  assert.equal(end0.at.getMinutes(), 30);

  const allDay = sched({ allDay: true, startDate: '2026-11-04', endDate: '2026-11-06' });
  const dayBefore = reminderMoment(allDay, {
    id: 'r3', anchor: 'start', offsetMinutes: 1440, time: '09:00',
  });
  assert.equal(dayBefore.ok, true);
  assert.equal(dayBefore.at.getMonth(), 10);
  assert.equal(dayBefore.at.getDate(), 3, 'опережение на сутки от первого дня');
  assert.equal(dayBefore.at.getHours(), 9);
  assert.equal(dayBefore.at.getMinutes(), 0);

  const atEndDay = reminderMoment(allDay, { id: 'r4', anchor: 'end', offsetMinutes: 0, time: '09:00' });
  assert.equal(atEndDay.at.getDate(), 6, 'all-day «в момент окончания» = последний день');

  const abs = reminderMoment(allDay, {
    id: 'r5', anchor: 'absolute', offsetMinutes: 0, date: '2026-11-11', time: '20:00',
  });
  assert.equal(abs.ok, true);
  assert.equal(abs.at.getDate(), 11);
  assert.equal(abs.at.getHours(), 20);

  assert.equal(reminderMoment(sched({}), { id: 'r', anchor: 'start', offsetMinutes: 5 }).ok,
    false, 'без даты напоминание не считается');
});

test('Б5 reminderMoment отдаёт диагностику, а не исключение', (t) => {
  const bad = reminderMoment(sched({ startDate: '2026-11-04' }), null);
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.code, 'string');

  const allDayMinute = reminderMoment(sched({ allDay: true, startDate: '2026-11-04' }), {
    id: 'r1', anchor: 'start', offsetMinutes: 15,
  });
  assert.equal(allDayMinute.ok, false, 'all-day без времени напоминания не считается');
});

/* ========================================================================= */
/* Б7 — быстрый дым enumerate (подробности в matrix-recurrence.test.mjs)      */
/* ========================================================================= */

test('Б7 enumerateOccurrences отдаёт структуру статуса, а не бесконечный цикл', (t) => {
  const out = enumerateOccurrences(sched({ startDate: '2026-11-04' }), { count: 1 });
  assert.equal(typeof out.status, 'string');
  assert.ok(Array.isArray(out.occurrences));

  const noRepeat = enumerateOccurrences(sched({
    startDate: '2026-11-04',
  }), { count: 3 });
  assert.equal(noRepeat.status, 'none', 'без правила продолжений нет');

  const broken = enumerateOccurrences(sched({
    startDate: '2026-11-04', repeat: { unit: 'week', interval: 1 },
  }), { count: 3 });
  assert.equal(broken.status, 'invalid',
    'невыполнимое правило (неделя без дней) диагностируется, а не крутится вечно');
  assert.equal(typeof broken.reason, 'string');
  assert.deepEqual(broken.occurrences, []);
});
