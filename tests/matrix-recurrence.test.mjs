// ТЗ Воркера 2, пункты Б7 + Б8 «Повтор».
//
// Повтор — полноценный расчёт, а не текстовая плашка: расписание повторяется
// целиком (интервал, календарная длина, wall-clock часы), серия считается
// от anchor, а не «от вчерашнего дня +1», поиск ограничен 100 годами и
// возвращает диагностируемый статус.
//
// Ожидаемые даты проставлены по календарю руками (04.11.2026 — среда,
// 02.11.2026 — понедельник ISO 1). Проверка транзакции выполнения идёт через
// реальный saveTasks/loadTasks песочницы; моками не подменено ничего.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

import {
  cloneSchedule,
  enumerateOccurrences,
  nextOccurrence,
  normalizeSchedule,
  validateSchedule,
} from '../js/data/matrix-schedule.js';

function sched(over) {
  return normalizeSchedule(over || {}).schedule;
}

function starts(schedule, count, options) {
  const out = enumerateOccurrences(schedule, Object.assign({ count }, options || {}));
  assert.ok(Array.isArray(out.occurrences), 'enumerate обязан вернуть массив');
  return out.occurrences.map(o => o.startDate);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const DAY = { unit: 'day', interval: 1, ends: { type: 'never' } };

/* ========================================================================= */
/* Б7.2 — календарные правила расчёта                                         */
/* ========================================================================= */

test('Б8 daily 04.11 → 05.11 с прежними часами и длиной', (t) => {
  const daily = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '09:00', endTime: '10:30', repeat: DAY,
  });
  assert.deepEqual(starts(daily, 4),
    ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);

  const out = enumerateOccurrences(daily, { count: 4 });
  assert.equal(out.status, 'ok');
  assert.equal(out.occurrences[1].startTime, '09:00', 'часы начала повторяются');
  assert.equal(out.occurrences[1].endTime, '10:30', 'часы окончания повторяются');
});

test('Б8 каждые 2 дня 04.11 → 06.11', (t) => {
  const every2 = sched({
    startDate: '2026-11-04', endDate: '2026-11-04',
    repeat: { unit: 'day', interval: 2 },
  });
  assert.deepEqual(starts(every2, 4),
    ['2026-11-04', '2026-11-06', '2026-11-08', '2026-11-10']);
});

test('Б8 интервал повторяется целиком: многодневный all-day сохраняет длину', (t) => {
  const span = sched({
    allDay: true, startDate: '2026-11-04', endDate: '2026-11-06', repeat: DAY,
  });
  const out = enumerateOccurrences(span, { count: 3 });
  assert.deepEqual(plain(out.occurrences.map(o => [o.startDate, o.endDate])),
    [['2026-11-04', '2026-11-06'], ['2026-11-05', '2026-11-07'], ['2026-11-06', '2026-11-08']],
    'сдвигается весь интервал, а не только начало');
});

test('Б8 weekly Пн/Ср/Пт: Ср 04.11 → Пт 06.11 → Пн 09.11', (t) => {
  const weekly = sched({
    startDate: '2026-11-04', endDate: '2026-11-04',
    repeat: { unit: 'week', interval: 1, weekdays: [1, 3, 5] },
  });
  assert.deepEqual(starts(weekly, 6), [
    '2026-11-04', '2026-11-06',
    '2026-11-09', '2026-11-11', '2026-11-13',
    '2026-11-16',
  ], 'первая неделя отдаёт только даты не раньше anchor');
});

test('Б8 weekly N=2 соблюдает anchor-неделю', (t) => {
  const biweekly = sched({
    startDate: '2026-11-04', endDate: '2026-11-04',
    repeat: { unit: 'week', interval: 2, weekdays: [1, 3, 5] },
  });
  // Eligible недели считаются от недели anchor (пн 02.11): 02.11, 16.11, 30.11.
  // В первой неделе отсекаются даты раньше anchor (пн 02.11 нет), в остальных —
  // все выбранные дни, поэтому понедельник 16.11 в ряду обязан быть.
  assert.deepEqual(starts(biweekly, 6), [
    '2026-11-04', '2026-11-06',
    '2026-11-16', '2026-11-18', '2026-11-20',
    '2026-11-30',
  ], 'недельные окна считаются от недели anchor, а не сдвигаются от последней даты');
});

test('Б8 weekly с единственным днём раньше anchor: следующий — понедельник следующей недели', (t) => {
  // anchor — среда 04.11 и он же первый экземпляр (index=1); выбран только
  // понедельник, поэтому второе вхождение — 09.11, а не «04.11 + 7 дней».
  const mondays = sched({
    startDate: '2026-11-04', endDate: '2026-11-04',
    repeat: { unit: 'week', interval: 1, weekdays: [1] },
  });
  assert.deepEqual(starts(mondays, 3), ['2026-11-04', '2026-11-09', '2026-11-16'],
    'первый экземпляр — сам срок задачи, правило начинает считать со второго');
});

test('Б8 month dayOfMonth: 31.01.2027 → 28.02 → 31.03 (не застреваем в 28)', (t) => {
  const monthly = sched({
    startDate: '2027-01-31', endDate: '2027-01-31',
    repeat: { unit: 'month', interval: 1, monthMode: 'dayOfMonth' },
  });
  assert.deepEqual(starts(monthly, 5), [
    '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31',
  ]);
});

test('Б8 month nthWeekday: последний понедельник ноября 2026 → последний понедельника декабря', (t) => {
  const lastMonday = sched({
    startDate: '2026-11-30', endDate: '2026-11-30',
    repeat: { unit: 'month', interval: 1, monthMode: 'nthWeekday', nth: -1, weekday: 1 },
  });
  assert.deepEqual(starts(lastMonday, 3), ['2026-11-30', '2026-12-28', '2027-01-25'],
    '-1 = последний такой день месяца');
});

test('Б8 month nthWeekday: 4-й понедельник каждые 3 месяца', (t) => {
  const fourthMonday = sched({
    startDate: '2026-11-23', endDate: '2026-11-23',
    repeat: { unit: 'month', interval: 3, monthMode: 'nthWeekday', nth: 4, weekday: 1 },
  });
  // понедельники: ноябрь 2026 — 2,9,16,23,30 (4-й = 23.11);
  // февраль 2027 — 1,8,15,22 (4-й = 22.02); май 2027 — 3,10,17,24,31 (4-й = 24.05)
  assert.deepEqual(starts(fourthMonday, 3), ['2026-11-23', '2027-02-22', '2027-05-24'],
    'nth считается внутри каждого подходящего месяца, а не «+3*7 недель»');
});

test('Б3.8 nth вне 1..4 и -1 CONTRACTOM запрещён и ловится валидатором', (t) => {
  const draft = {
    startDate: '2026-11-30',
    repeat: { unit: 'month', interval: 1, monthMode: 'nthWeekday', nth: 5, weekday: 1 },
  };
  const report = validateSchedule(draft);
  assert.equal(report.ok, false, 'пятого вхождения в схеме нет — форма не применит такое правило');
  assert.ok(report.issues.some(i => i.field === 'repeat.nth'));
  assert.equal(sched(draft).repeat, null, 'в хранилище повреждённое правило не ложится');
});

test('Б8 year: 29.02.2028 → 28.02.2029 → ... → 29.02.2032', (t) => {
  const leap = sched({
    startDate: '2028-02-29', endDate: '2028-02-29',
    repeat: { unit: 'year', interval: 1 },
  });
  assert.deepEqual(starts(leap, 5), [
    '2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29',
  ], 'несуществующее 29 февраля деградирует в 28, а следующий високосный снова 29');
});

test('Б7.2 year с intervaл 4 держит день и месяц anchor', (t) => {
  const quadrennial = sched({
    startDate: '2028-02-29', endDate: '2028-02-29',
    repeat: { unit: 'year', interval: 4 },
  });
  assert.deepEqual(starts(quadrennial, 3), ['2028-02-29', '2032-02-29', '2036-02-29']);
});

test('Б8 dates: конкретные даты — начала, следующее больше текущего', (t) => {
  const dated = sched({
    startDate: '2026-11-04', endDate: '2026-11-04',
    repeat: { unit: 'dates', dates: ['2026-11-04', '2026-11-09', '2026-11-30'] },
  });
  assert.deepEqual(starts(dated, 3), ['2026-11-04', '2026-11-09', '2026-11-30']);
  assert.equal(enumerateOccurrences(dated, { count: 5 }).occurrences.length, 3,
    'список конечен: лишнего не выдумывается');
});

test('Б7.4 dates без будущего — серия заканчивается', (t) => {
  const spent = sched({
    startDate: '2026-11-30', endDate: '2026-11-30',
    repeat: { unit: 'dates', dates: ['2026-11-04', '2026-11-30'] },
  });
  const out = nextOccurrence(spent, {});
  assert.equal(out.status, 'none');
  assert.equal(out.occurrence, null);
});

test('Б7.4 dates без текущей даты в списке — invalid с диагностикой', (t) => {
  const mismatch = sched({
    startDate: '2026-11-05', endDate: '2026-11-05',
    repeat: { unit: 'dates', dates: ['2026-11-04', '2026-11-09'] },
  });
  const out = enumerateOccurrences(mismatch, { count: 3 });
  assert.equal(out.status, 'invalid');
  assert.equal(typeof out.reason, 'string');
  assert.equal(validateSchedule(mismatch).ok, false,
    'UI не позволит сохранить правило, где первый экземпляр не входит в даты');
});

/* ========================================================================= */
/* Б7.3 — basis: scheduled против completion                                  */
/* ========================================================================= */

test('Б8 completion daily от 04.11, завершение 10.11 → 11.11; scheduled → 05.11', (t) => {
  const base = {
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '09:00', endTime: '10:00',
  };
  const byCompletion = sched(Object.assign({}, base, {
    repeat: { unit: 'day', interval: 1, basis: 'completion' },
  }));
  const bySchedule = sched(Object.assign({}, base, { repeat: DAY }));

  const done = nextOccurrence(byCompletion, {
    completionDate: new Date(2026, 10, 10, 12, 0, 0),
  });
  assert.equal(done.status, 'ok');
  assert.equal(done.occurrence.startDate, '2026-11-11', 'отсчёт от даты завершения');
  assert.equal(done.occurrence.startTime, '09:00', 'часы прежние');
  assert.equal(done.occurrence.endDate, '2026-11-11');
  assert.equal(done.occurrence.endTime, '10:00');

  const late = nextOccurrence(bySchedule, {});
  assert.equal(late.status, 'ok');
  assert.equal(late.occurrence.startDate, '2026-11-05',
    'scheduled считает от расписания: следующий может быть уже просрочен');
});

test('Б7.3 completion monthly держит календарный шаг от завершения', (t) => {
  const monthly = sched({
    startDate: '2026-11-04', endDate: '2026-11-04',
    repeat: { unit: 'month', interval: 1, basis: 'completion' },
  });
  const out = nextOccurrence(monthly, { completionDate: new Date(2026, 10, 20, 9, 0) });
  assert.equal(out.occurrence.startDate, '2026-12-20',
    'месяц прибавляется к дате завершения, а не к первичному anchor');
});

test('Б7 completion допускается только простым каждые N day/week/month/year', (t) => {
  const wrongWeekday = sched({
    startDate: '2026-11-04',
    repeat: { unit: 'week', interval: 1, basis: 'completion', weekdays: [1, 3] },
  });
  assert.equal(validateSchedule(wrongWeekday).ok, false,
    'completion + список дней недели не имеет однозначной семантики');

  const wrongNth = sched({
    startDate: '2026-11-30',
    repeat: {
      unit: 'month', interval: 1, basis: 'completion',
      monthMode: 'nthWeekday', nth: -1, weekday: 1,
    },
  });
  assert.equal(validateSchedule(wrongNth).ok, false, 'completion + nth запрещён');

  const wrongDates = sched({
    startDate: '2026-11-04',
    repeat: { unit: 'dates', basis: 'completion', dates: ['2026-11-04', '2026-11-09'] },
  });
  assert.equal(wrongDates.repeat.basis, 'scheduled',
    'normalize не даёт dates жить на completion-базе');
});

/* ========================================================================= */
/* Б7.5 — завершение серии                                                    */
/* ========================================================================= */

test('Б8 count включает текущий экземпляр: count=1 не порождает продолжения', (t) => {
  const once = sched({
    startDate: '2026-11-04', repeat: { unit: 'day', interval: 1, ends: { type: 'count', count: 1 } },
  });
  assert.deepEqual(starts(once, 3), ['2026-11-04'], 'только сам экземпляр');
  assert.equal(nextOccurrence(once, {}).status, 'none');

  const twice = sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'count', count: 2 } },
  });
  assert.deepEqual(starts(twice, 4), ['2026-11-04', '2026-11-05']);
});

test('Б8 until ограничивает дату НАЧАЛА следующего экземпляра включительно', (t) => {
  const untilled = sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'until', until: '2026-11-06' } },
  });
  assert.deepEqual(starts(untilled, 5), ['2026-11-04', '2026-11-05', '2026-11-06'],
    '06.11 включительно, 07.11 — уже нет');

  const exclusiveProbe = sched({
    startDate: '2026-11-04',
    repeat: { unit: 'day', interval: 1, ends: { type: 'until', until: '2026-11-05' } },
  });
  assert.equal(nextOccurrence(exclusiveProbe, {}).occurrence.startDate, '2026-11-05',
    'nextOccurrence honour включительной границы');
});

test('Б7.10 поиск ограничен: вечно не крутим, отдаём none с причиной', (t) => {
  const monthly = sched({ startDate: '2026-11-04', repeat: DAY });
  const out = enumerateOccurrences(monthly, { count: 400 });
  assert.equal(out.occurrences.length, 400);
  assert.equal(out.occurrences[399].startDate, '2027-12-08',
    '400 шагов по суткам от 04.11.2026 считаются точно');

  // Продолжений нет, но текущий экземпляр остаётся: 'until' ограничивает дату
  // НАЧАЛА следующего, а не отменяет уже существующий (Б7.5).
  const bounded = enumerateOccurrences(sched({
    startDate: '2026-11-04',
    repeat: { unit: 'year', interval: 1, ends: { type: 'until', until: '2020-01-01' } },
  }), { count: 5 });
  assert.equal(bounded.occurrences.length, 1, 'ряд обрывается на текущем экземпляре');
  assert.equal(nextOccurrence(sched({
    startDate: '2026-11-04',
    repeat: { unit: 'year', interval: 1, ends: { type: 'until', until: '2020-01-01' } },
  }), {}).status, 'none', 'правило, завершившееся до первого продолжения, отдаёт none');
});

test('Б7.10 редкий шаг по месяцам не зависает и считает точно', (t) => {
  // Последний понедельник каждого ноября от 30.11.2026: ноябрь 2026 — 2,9,16,23,30;
  // ноябрь 2027 — 1,8,15,22,29; ноябрь 2028 — 6,13,20,27.
  const out = enumerateOccurrences(sched({
    startDate: '2026-11-30',
    repeat: {
      unit: 'month', interval: 12, monthMode: 'nthWeekday', nth: -1, weekday: 1,
    },
  }), { count: 3 });
  assert.deepEqual(out.occurrences.map(o => o.startDate),
    ['2026-11-30', '2027-11-29', '2028-11-27']);
});

/* ========================================================================= */
/* Б7.1 — напоминания следуют за правилом                                     */
/* ========================================================================= */

test('Б7.1 relative-напоминание копируется в следующий экземпляр', (t) => {
  const withReminder = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '10:00', endTime: '11:00',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15 }],
    repeat: DAY,
  });
  const out = nextOccurrence(withReminder, {});
  assert.deepEqual(plain(out.occurrence.reminders), [
    { id: 'r1', anchor: 'start', offsetMinutes: 15, date: null, time: null },
  ], 'правило напоминания переезжает целиком');
  assert.equal(out.occurrence.startTime, '10:00');
});

test('Б7.1 absolute-напоминание с repeat — явная ошибка, а не молчаливый сброс', (t) => {
  const clash = sched({
    startDate: '2026-11-04', endDate: '2026-11-04',
    allDay: false, startTime: '10:00', endTime: '11:00',
    reminders: [{ id: 'r1', anchor: 'absolute', date: '2026-11-03', time: '20:00', offsetMinutes: 0 }],
    repeat: DAY,
  });
  const report = validateSchedule(clash);
  assert.equal(report.ok, false);
  const issue = report.issues.find(i => i.field === 'reminders');
  assert.ok(issue, 'ошибка названа полем reminders');
  assert.equal(issue.code, 'absolute-with-repeat', 'код говорит, что именно несовместимо');
});

/* ========================================================================= */
/* Б7.6/Б7.8 — транзакция «выполнить экземпляр» одним写                       */
/* ========================================================================= */

function recurringTask(ctx, over) {
  const created = ctx.createTask(Object.assign({
    title: 'Повторяется',
    priority: 2,
    schedule: {
      allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
      startTime: '09:00', endTime: '10:00',
      reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15 }],
      repeat: DAY,
    },
  }, over || {}));
  return ctx.startSeries(created, new Date(2026, 10, 3));
}

test('Б7.6 выполнение даёт completed + ровно один next за одну запись', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  assert.equal(ctx.saveTasks([first]), true);
  assert.equal(first.schedule.series.index, 1);
  assert.ok(first.schedule.series.id, 'series.id создаётся при включении repeat');

  const result = ctx.completeOccurrence(ctx.loadTasks(), first.id, new Date(2026, 10, 4, 12, 0));
  assert.equal(result.ok, true);
  assert.equal(result.completed.done, true, 'текущий экземпляр помечен выполненным');
  assert.equal(result.next.schedule.series.index, 2, 'следующий — index+1');
  assert.equal(result.next.schedule.series.id, first.schedule.series.id, 'та же серия');
  assert.equal(result.next.previousOccurrenceId, first.id, 'ссылка на предыдущий экземпляр');
  assert.equal(result.next.id !== first.id, true, 'у следующего новая id');
  assert.equal(result.next.done, false);
  assert.equal(result.next.schedule.startDate, '2026-11-05', 'следующий по расписанию');
  assert.deepEqual(plain(result.next.schedule.reminders), plain(first.schedule.reminders),
    'relative-напоминание унаследовано');
  assert.deepEqual(plain(result.completed.schedule.repeat), plain(first.schedule.repeat),
    'Б7.7: выполненный экземпляр хранит правило для отображения истории');

  assert.equal(ctx.saveTasks(result.tasks), true);
  const stored = ctx.loadTasks();
  assert.equal(stored.length, 2, 'один commit — две записи: completed и next');
});

test('Б7.6 выполненный экземпляр сохраняет исходные даты и признак экземпляра', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const result = ctx.completeOccurrence([first], first.id, new Date(2026, 10, 4, 12, 0));
  assert.equal(result.completed.schedule.startDate, '2026-11-04',
    'в истории остаются ДАТЫ выполненного экземпляра');
  assert.equal(result.completed.schedule.series.index, 1);
  assert.equal(result.completed.done, true);
});

test('Б8 двойное выполнение не создаёт два следующих', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const once = ctx.completeOccurrence([first], first.id, new Date(2026, 10, 4, 12, 0));
  assert.equal(once.tasks.length, 2);

  const twice = ctx.completeOccurrence(once.tasks, first.id, new Date(2026, 10, 4, 12, 30));
  assert.equal(twice.status, 'noop', 'повторное complete уже выполненного — no-op, не undo');
  assert.deepEqual(plain(twice.tasks.map(t => t.id)), plain(once.tasks.map(t => t.id)));

  const activeNext = twice.tasks.find(t => !t.done);
  const again = ctx.completeOccurrence(twice.tasks, activeNext.id, new Date(2026, 10, 6, 9, 0));
  assert.equal(again.ok, true, 'выполнить СЛЕДУЮЩИЙ экземпляр можно');
  assert.equal(again.next.schedule.series.index, 3);
});

test('Б8 отказ записи не создаёт ни completed, ни next', (t) => {
  const app = loadApp();
  const ctx = app.context;
  const first = recurringTask(ctx);
  assert.equal(ctx.saveTasks([first]), true);
  const before = plain(ctx.loadTasks());

  const result = ctx.completeOccurrence(ctx.loadTasks(), first.id, new Date(2026, 10, 4, 12, 0));
  app.sandbox.localStorage.setItem = () => {
    const error = new Error('QuotaExceededError');
    error.name = 'QuotaExceededError';
    throw error;
  };
  assert.equal(ctx.saveTasks(result.tasks), false, 'запись всего массива не состоялась');
  assert.deepEqual(plain(ctx.loadTasks()), before,
    'хранилище осталось прежним: исходная задача активна, истории нет');
});

test('Б8 архив не генерирует следующий экземпляр, удаление — тоже', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const archived = ctx.sanitizeTask(Object.assign({}, first, { archived: true }));
  const result = ctx.completeOccurrence([archived], first.id, new Date(2026, 10, 4, 12, 0));
  assert.equal(result.next, null, 'архивная задача не завершается серией');
  assert.equal(result.ok, false);

  const undone = ctx.completeOccurrence([first], 'нет-такого', new Date(2026, 10, 4));
  assert.equal(undone.ok, false, 'чужой id не превращается в новую задачу');
});

test('Б7.6 следующий экземпляр рождается с generatedAt == начальный updatedAt', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const result = ctx.completeOccurrence([first], first.id, new Date(2026, 10, 4, 12, 0));
  assert.equal(typeof result.next.generatedAt, 'string', 'generatedAt входит в whitelist');
  assert.equal(result.next.generatedAt, result.next.updatedAt,
    'сравнение «не редактировали ли следующий» должно быть однозначным');
});

test('Б7.8 undo последнего нетронутого next сворачивает генерацию', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const done = ctx.completeOccurrence([first], first.id, new Date(2026, 10, 4, 12, 0));
  const reopened = ctx.reopenOccurrence(done.tasks, first.id, new Date(2026, 10, 4, 13, 0));

  assert.equal(reopened.ok, true);
  assert.equal(reopened.removedId, done.next.id, 'снят именно сгенерированный следующий');
  assert.equal(reopened.tasks.length, 1, 'осталась одна возвращённая в работу задача');
  assert.equal(reopened.tasks[0].done, false);
  assert.equal(reopened.tasks[0].doneAt, null);
  assert.equal(reopened.tasks[0].schedule.series.index, 1);
});

test('Б7.8 изменённый next не удаляется молча: требуется отдельное восстановление', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const done = ctx.completeOccurrence([first], first.id, new Date(2026, 10, 4, 12, 0));
  // Настоящая правка всегда двигает updatedAt — ровно по нему и по generatedAt
  // контроллер отличает «следующий не трогали» (Б7.8).
  const editedNext = done.tasks.map(t => (t.id === done.next.id
    ? ctx.sanitizeTask(Object.assign({}, t, {
      title: 'Его уже правили',
      updatedAt: new Date(2026, 10, 4, 12, 40, 0).toISOString(),
    }))
    : t));

  const reopened = ctx.reopenOccurrence(editedNext, first.id, new Date(2026, 10, 4, 13, 0));
  assert.equal(reopened.ok, false);
  assert.equal(reopened.needsNewTask, true,
    'предложение «Восстановить как отдельную задачу без повтора»');
  assert.equal(reopened.tasks.length, 2, 'ни одна ветвь серии не потеряна');
});

test('Б7.8 следующий, который уже выполнен, не убирается при возврате назад', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const done = ctx.completeOccurrence([first], first.id, new Date(2026, 10, 4, 12, 0));
  const nextDone = ctx.markDone(done.next, true);
  const list = done.tasks.map(t => (t.id === done.next.id ? nextDone : t));

  const reopened = ctx.reopenOccurrence(list, first.id, new Date(2026, 10, 5, 9, 0));
  assert.equal(reopened.ok, false);
  assert.equal(reopened.needsNewTask, true);
});

test('Б8 возврат из архива и перенос не сбрасывают правило серии', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const snapshot = plain(first.schedule.repeat);
  const seriesSnapshot = plain(first.schedule.series);

  assert.deepEqual(plain(ctx.markDone(first, true).schedule.repeat), snapshot);
  assert.deepEqual(plain(ctx.markDone(first, true).schedule.series), seriesSnapshot);
  assert.deepEqual(plain(ctx.restoreTask(first).schedule.repeat), snapshot, 'restoreTask');

  const moved = ctx.applyQuadrantMove(first, 'q1', new Date(2026, 10, 3));
  assert.deepEqual(plain(moved.schedule.repeat), snapshot,
    'Б6.5: перенос сдвигает текущий экземпляр, но правило серии остаётся');
  assert.equal(moved.schedule.series.id, first.schedule.series.id, 'series.id сохранён');
  assert.equal(moved.schedule.series.anchorDate, first.schedule.series.anchorDate,
    'anchor серии не пересчитывается от переноса');
  assert.equal(moved.schedule.endDate, '2026-11-03', 'Б6.4: в срочный — окончание становится сегодня');
  assert.equal(moved.due, '2026-11-03', 'due следует за endDate');
});

/* ========================================================================= */
/* Б7.9 — смена правила перезапускает серию, правка текста — нет              */
/* ========================================================================= */

test('Б7.9 новое правило даёт новую series с index=1 и тем же anchor-днём', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const oldSeriesId = first.schedule.series.id;

  const changed = ctx.setTaskRepeat(first, { unit: 'week', interval: 1, weekdays: [2] },
    new Date(2026, 10, 3));
  assert.equal(changed.schedule.series.id !== oldSeriesId, true, 'правило изменилось — серия новая');
  assert.equal(changed.schedule.series.index, 1);
  assert.equal(changed.schedule.series.anchorDate, '2026-11-04', 'anchor — начало текущего экземпляра');
  assert.equal(changed.schedule.startDate, '2026-11-04', 'смена правила не двигает текущий экземпляр');

  const untouched = ctx.setTaskRepeat(first, first.schedule.repeat, new Date(2026, 10, 3));
  assert.equal(untouched.schedule.series.id, oldSeriesId,
    'то же правило не перезапускает серию');

  const titleOnly = ctx.sanitizeTask(Object.assign({}, first, { title: 'Другое название' }));
  assert.equal(titleOnly.schedule.series.id, oldSeriesId, 'правка заголовка серию не трогает');
});

test('Б7.9 снятие repeat обнуляет series', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const cleared = ctx.setTaskRepeat(first, null, new Date(2026, 10, 3));
  assert.equal(cleared.schedule.repeat, null);
  assert.equal(cleared.schedule.series, null);
  assert.equal(cleared.due, '2026-11-04', 'срок при снятии повтора остаётся');
});

test('Б7.9 история выполненных экземпляров не переписывается при смене правила', (t) => {
  const { context: ctx } = loadApp();
  const first = recurringTask(ctx);
  const done = ctx.completeOccurrence([first], first.id, new Date(2026, 10, 4, 12, 0));
  const ruleChanged = ctx.setTaskRepeat(done.next, { unit: 'day', interval: 3 },
    new Date(2026, 10, 5));
  const list = done.tasks.map(t => (t.id === done.next.id ? ruleChanged : t));

  const history = list.find(t => t.done);
  assert.equal(history.schedule.series.index, 1, 'выполненный экземпляр остался index=1');
  assert.deepEqual(plain(history.schedule.repeat), plain(first.schedule.repeat),
    'старое правило сохранено для отображения истории');
});

/* ========================================================================= */
/* Б3 — копия schedule не разделяется с оригиналом                            */
/* ========================================================================= */

test('Б3.7 cloneSchedule отдаёт глубокую копию', (t) => {
  const source = sched({
    allDay: false, startDate: '2026-11-04', endDate: '2026-11-04',
    startTime: '09:00', endTime: '10:00',
    reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15 }],
    repeat: { unit: 'week', interval: 1, weekdays: [1, 3] },
  });
  const copy = cloneSchedule(source);
  copy.reminders[0].offsetMinutes = 999;
  copy.repeat.weekdays.push(7);
  copy.series = { id: 'x', index: 1, anchorDate: '2026-11-04', anchorDay: 4, anchorMonth: 11 };

  assert.equal(source.reminders[0].offsetMinutes, 15, 'исходный reminder не затронут');
  assert.deepEqual(plain(source.repeat.weekdays), [1, 3], 'список дней не расширен');
  assert.equal(source.series, null, 'series не протёк в оригинал');
});
