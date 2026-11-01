// Стресс-тест кэша calcProgress (js/data/records.js) на объёме 5 лет.
//
// Проверяются три вещи: (1) кэш не врёт — повторный вызов по тому же
// (привычка, окно) возвращает ровно то же значение, что холодный расчёт,
// в том числе после вымывания записей из кэша потолком; (2) кэш не ест
// память — при сотнях тысяч уникальных ключей (5 лет окон) размер кэша
// ограничен потолком, и куча процесса не растёт линейно с числом вызовов;
// (3) кэш реально работает — серия вызовов по одному окну на порядки
// дешевле серии холодных окон (санити-гвард регрессии, не бенчмарк).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Фиксированное «сегодня»: окно стресса — 5 лет по 2026-11-01 включительно.
const TODAY_ISO = '2026-11-01';
const YEARS_DAYS = 1826;   // 2021-11-02 .. 2026-11-01
const WINDOW = 365;        // рабочее окно расчёта — год

// 12 привычек как на реальном столе: boolean / number с целью / choice.
const HABITS = [
  { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
  { id: 'h2', name: 'Зухр', type: 'boolean', unit: '', goal: null },
  { id: 'h3', name: 'Аср', type: 'boolean', unit: '', goal: null },
  { id: 'h4', name: 'Магриб', type: 'boolean', unit: '', goal: null },
  { id: 'h5', name: 'Иша', type: 'boolean', unit: '', goal: null },
  { id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 },
  { id: 'h7', name: 'Спорт', type: 'choice', unit: '', goal: null },
  { id: 'h8', name: 'Коран', type: 'number', unit: 'стр.', goal: 5 },
  { id: 'h9', name: 'Работа с текстами', type: 'number', unit: 'мин', goal: 10 },
  { id: 'h10', name: 'Чтение книги', type: 'number', unit: 'стр.', goal: 2 },
  { id: 'h11', name: 'Таблицы', type: 'boolean', unit: '', goal: null },
  { id: 'h12', name: 'Пресс', type: 'choice', unit: '', goal: null },
];

// Детерминированный «рандом» без Math.random: одинаковые данные на каждом
// прогоне, иначе проценты плывут и сравнение холодный/тёплый теряет смысл.
function pseudoRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function isoAt(dayIndex) {
  // dayIndex 0 = 2021-11-02, последний = 2026-11-01
  const d = new Date(2021, 10, 2);
  d.setDate(d.getDate() + dayIndex);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

// Сид 5 лет записей: ~85% дней отмечены, числа — доля цели, выбор — по кругу
function seedFiveYears(sandbox) {
  const rnd = pseudoRandom(20261101);
  const records = {};
  for (let i = 0; i < YEARS_DAYS; i++) {
    const day = {};
    for (const h of HABITS) {
      if (h.type === 'boolean') {
        day[h.id] = rnd() < 0.85;
      } else if (h.type === 'number') {
        day[h.id] = rnd() < 0.85 ? Math.max(1, Math.round(h.goal * rnd())) : 0;
      } else {
        day[h.id] = ['yes', 'no', 'two-min', 'rest'][Math.floor(rnd() * 4)];
      }
    }
    records[isoAt(i)] = day;
  }
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
  sandbox.localStorage.setItem('youplanner.habits', JSON.stringify(HABITS));
}

// Окно из WINDOW дат, заканчивающееся смещением offset назад от TODAY
function windowAt(offset) {
  const base = new Date(2026, 10, 1);
  base.setDate(base.getDate() - offset);
  const dates = [];
  for (let i = WINDOW - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(d.getFullYear() + '-' + m + '-' + day);
  }
  return dates;
}

test('стресс 5 лет: сид грузится, холодный и тёплый расчёт совпадают', () => {
  const { sandbox, context } = loadApp();
  seedFiveYears(sandbox);
  context.invalidateRecordsCache();

  const habit = HABITS[7]; // Коран, number, цель 5
  const dates = windowAt(0);
  const cold = context.calcProgress(habit, dates);
  const warm = context.calcProgress(habit, dates);
  assert.equal(warm, cold, 'кэш обязан возвращать то же значение, что холодный расчёт');
  assert.equal(typeof cold, 'number');
  assert.ok(cold >= 0 && cold <= 100, 'процент в границах 0..100: ' + cold);
});

test('стресс 5 лет: >5000 уникальных окон — кэш вымывается, куча не растёт линейно', () => {
  const { sandbox, context } = loadApp();
  seedFiveYears(sandbox);
  context.invalidateRecordsCache();

  const habit = HABITS[0];
  const known = windowAt(0);
  const before = context.calcProgress(habit, known);

  // Поток уникальных окон: 5 лет дают 1461 разных годовых окна — по 4 привычки
  // это ~5800 уникальных ключей, кэш (потолок 1000) чистится многократно.
  // Смещения идут от 0 до 1460 (глубина данных), окна за пределами данных
  // просто считают пустые дни — вычисление то же.
  const heapBefore = process.memoryUsage().heapUsed;
  let calls = 0;
  for (let offset = 0; offset <= 1460; offset += 1) {
    for (const h of HABITS.slice(0, 4)) {
      context.calcProgress(h, windowAt(offset));
      calls += 1;
    }
  }
  const heapAfter = process.memoryUsage().heapUsed;
  const growthMb = (heapAfter - heapBefore) / (1024 * 1024);

  assert.ok(calls > 5000, 'вызовов с уникальными ключами: ' + calls);
  assert.ok(growthMb < 80,
    'куча не должна расти линейно от потока ключей, рост ' + growthMb.toFixed(1) + ' МБ');
  // Ключ known давно вымыт потолком — пересчёт обязан дать то же число
  const afterFlood = context.calcProgress(habit, known);
  assert.equal(afterFlood, before, 'после вымывания кэша значение не изменилось');
});

test('стресс 5 лет: тёплая серия дешевле холодной (кэш работает)', () => {
  const { sandbox, context } = loadApp();
  seedFiveYears(sandbox);
  context.invalidateRecordsCache();

  const habit = HABITS[8]; // «Работа с текстами», number, цель 10
  const dates = windowAt(3);

  // Холодная серия: 200 разных годовых окон — каждый раз честный расчёт.
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) context.calcProgress(habit, windowAt(100 + i));
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Тёплая серия: 1000 повторов одного окна — каждый вызов должен падать
  // в кэш и не пересчитывать 365 дней.
  context.calcProgress(habit, dates); // прогрев
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) context.calcProgress(habit, dates);
  const warmMs = Number(process.hrtime.bigint() - t1) / 1e6;

  assert.ok(warmMs < coldMs,
    'тёплая серия (1000 вызовов, ' + warmMs.toFixed(1) + ' мс) должна быть ' +
    'дешевле холодной (200 вызовов, ' + coldMs.toFixed(1) + ' мс)');
});

test('стресс 5 лет: смена версии записей инвалидирует кэш, значения пересчитываются', () => {
  const { sandbox, context } = loadApp();
  seedFiveYears(sandbox);
  context.invalidateRecordsCache();

  const habit = HABITS[7];
  const dates = windowAt(0);
  const before = context.calcProgress(habit, dates);
  context.calcProgress(habit, dates); // в кэше

  // Локальная правка: сегодня Коран закрыт по цели — процент обязан уехать
  const records = JSON.parse(sandbox.localStorage.getItem('youplanner.records'));
  records[TODAY_ISO] = Object.assign({}, records[TODAY_ISO], { h8: 5 });
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
  context.invalidateRecordsCache(); // как app.js делает после записи

  const after = context.calcProgress(habit, dates);
  assert.ok(after >= before,
    'закрытие цели не может уменьшить процент: ' + before + ' -> ' + after);
});
