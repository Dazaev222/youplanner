// Тесты чтения расписания (loadSchedule). Аудит 2026-10-31: серверный снимок
// { weekday: [null] } доезжал до renderScheduleView и ронял его TypeError'ом
// на item.time — валидация раздела на сервере проверяет только массивы.
// Ожидание: чтение само отбрасывает битые пункты, годные данные пользователя
// сохраняются, а не-массивный тип дня не роняет чтение.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Ключ из js/data/storage.js: в песочнице константа живёт в лексической
// области контекста, снаружи виден только литерал
const SCHEDULE_KEY = 'youplanner.schedule';

function setSchedule(app, value) {
  app.sandbox.localStorage.setItem(SCHEDULE_KEY, JSON.stringify(value));
}

test('годный снимок расписания читается как есть', () => {
  const app = loadApp();
  setSchedule(app, {
    weekday: [
      { time: '07:00', text: 'Пробежка' },
      { time: '22:00', text: 'Дневник' },
    ],
    weekend: [{ time: '09:00', text: 'Сон' }],
    fasting: [],
    physical: [],
  });

  const schedule = app.context.loadSchedule();
  assert.equal(schedule.weekday.length, 2);
  assert.equal(schedule.weekday[0].time, '07:00');
  assert.equal(schedule.weekday[0].text, 'Пробежка');
  assert.equal(schedule.weekday[1].text, 'Дневник');
  assert.equal(schedule.weekend.length, 1);
  assert.equal(schedule.weekend[0].text, 'Сон');
  assert.equal(schedule.fasting.length, 0);
  assert.equal(schedule.physical.length, 0);
});

test('битые пункты отбрасываются, годный остаётся', () => {
  const app = loadApp();
  setSchedule(app, {
    weekday: [
      null,
      'битый пункт',
      42,
      {},
      { time: '06:00' },
      { text: 'Без времени' },
      { time: 6, text: 'Число вместо времени' },
      ['06:00', 'Массив вместо пункта'],
      { time: '06:00', text: 'Зарядка' },
    ],
    weekend: [],
    fasting: [],
    physical: [],
  });

  const weekday = app.context.loadSchedule().weekday;
  assert.equal(weekday.length, 1, 'остался не только годный пункт');
  assert.equal(weekday[0].time, '06:00');
  assert.equal(weekday[0].text, 'Зарядка');
});

test('частично битый список не теряет данные пользователя', () => {
  const app = loadApp();
  setSchedule(app, {
    weekday: [null, { time: '05:00', text: 'Фаджр' }, 'мусор'],
    weekend: [{ time: '08:00', text: 'Подъём' }, 7],
    fasting: [],
    physical: [],
  });

  const schedule = app.context.loadSchedule();
  assert.equal(schedule.weekday.length, 1);
  assert.equal(schedule.weekday[0].time, '05:00');
  assert.equal(schedule.weekday[0].text, 'Фаджр');
  assert.equal(schedule.weekend.length, 1);
  assert.equal(schedule.weekend[0].time, '08:00');
  assert.equal(schedule.weekend[0].text, 'Подъём');
});

// Контракт loadSchedule: неполные четыре типа дня читаются как расписание
// по умолчанию целиком (комментарий в js/data/schedule.js). Тест — регресс
// от падения чтения, а не от подмены на пустой список
test('не-массив weekday читается как расписание по умолчанию', () => {
  const app = loadApp();
  setSchedule(app, {
    weekday: null,
    weekend: [{ time: '09:00', text: 'Сон' }],
    fasting: [],
    physical: [],
  });

  const schedule = app.context.loadSchedule();
  assert.equal(Array.isArray(schedule.weekday), true);
  assert.ok(schedule.weekday.length > 0, 'weekday не подменён дефолтным расписанием');
  assert.equal(schedule.weekday[0].time, '04:30');
  assert.equal(schedule.weekday[0].text, 'Подъём');
});
