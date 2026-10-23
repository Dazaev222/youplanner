// Регрессионные тесты разбора резервной копии (parseBackup).
//
// Отправная точка — баг, найденный аудитом 2026-10-23: внутри ветки
// realWake/realSleepMin parseBackup звал sleepDurationMinutes с двумя
// аргументами вместо трёх (fall и realWake вместо bed, fall, realWake),
// поэтому функция всегда возвращала null и ЛЮБАЯ копия версии 11 с парой
// realWake/realSleepMin отвергалась при импорте.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Копия версии 11 с согласованной парой realWake/realSleepMin.
// Согласованность: bed 23:30, fall 15 → засыпание 1425 мин.
// actualWake 06:00 → сон 375 мин; realWake 05:30 → факт 345 мин.
function validBackup() {
  return {
    version: 11,
    exportedAt: '2026-10-23T20:00:00.000Z',
    habits: [
      { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
    ],
    records: { '2026-10-23': { h1: true } },
    qaza: {
      version: 3,
      cursor: 3,
      remaining: { fajr: 1, zuhr: 1, asr: 1, maghrib: 1, isha: 1 },
      history: [],
    },
    prayer: { lat: 43.38085, lng: 45.83479, madhhab: 'shafi', method: 'dum-chr' },
    fast: { version: 1, remaining: 5, history: [] },
    qazaLog: { version: 1, since: '2026-10-01', entries: [] },
    sleep: {
      version: 4,
      bed: '23:30',
      fall: 15,
      wake: '06:00',
      actualWake: '06:00',
      sleepMin: 375,
      realWake: '05:30',
      realSleepMin: 345,
      excluded: false,
      history: [],
    },
    schedule: { weekday: [], weekend: [], fasting: [], physical: [] },
  };
}

test('копия v11 с парой realWake/realSleepMin разбирается', () => {
  const { context } = loadApp();
  const data = context.parseBackup(JSON.stringify(validBackup()));
  assert.ok(data, 'валидная копия отвергнута');
  assert.equal(data.sleep.realSleepMin, 345);
});

test('копия v11 с actualWake/realWake из null (встал по плану) разбирается', () => {
  const { context } = loadApp();
  const backup = validBackup();
  backup.sleep.realWake = null;
  backup.sleep.realSleepMin = null;
  const data = context.parseBackup(JSON.stringify(backup));
  assert.ok(data, 'копия «встал по плану» отвергнута');
});

test('рассинхрон realWake и realSleepMin отвергается', () => {
  const { context } = loadApp();
  const backup = validBackup();
  // 400 минут не сходится с bed/fall/realWake — охрана должна сработать
  backup.sleep.realSleepMin = 400;
  const data = context.parseBackup(JSON.stringify(backup));
  assert.equal(data, null, 'битая пара прошла разбор');
});

test('половина пары realWake/realSleepMin отвергается', () => {
  const { context } = loadApp();
  const backup = validBackup();
  backup.sleep.realSleepMin = null;
  const data = context.parseBackup(JSON.stringify(backup));
  assert.equal(data, null, 'половинчатая пара прошла разбор');
});

test('копия чужой версии (10) отвергается', () => {
  const { context } = loadApp();
  const backup = validBackup();
  backup.version = 10;
  const data = context.parseBackup(JSON.stringify(backup));
  assert.equal(data, null, 'копия версии 10 прошла разбор');
});

test('не-время в actualWake отвергается', () => {
  const { context } = loadApp();
  const backup = validBackup();
  backup.sleep.actualWake = '25:99';
  const data = context.parseBackup(JSON.stringify(backup));
  assert.equal(data, null, 'битый actualWake прошёл разбор');
});

test('не-целое sleepMin отвергается', () => {
  const { context } = loadApp();
  const backup = validBackup();
  backup.sleep.sleepMin = 1.5;
  const data = context.parseBackup(JSON.stringify(backup));
  assert.equal(data, null, 'битый sleepMin прошёл разбор');
});
