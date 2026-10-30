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
import { defaultBackup } from './helpers/fixtures.mjs';

test('копия v11 с парой realWake/realSleepMin разбирается', () => {
  const { context } = loadApp();
  const data = context.parseBackup(JSON.stringify(defaultBackup()));
  assert.ok(data, 'валидная копия отвергнута');
  assert.equal(data.sleep.realSleepMin, 345);
});

test('копия v11 с actualWake/realWake из null (встал по плану) разбирается', () => {
  const { context } = loadApp();
  const backup = defaultBackup();
  backup.sleep.realWake = null;
  backup.sleep.realSleepMin = null;
  const data = context.parseBackup(JSON.stringify(backup));
  assert.ok(data, 'копия «встал по плану» отвергнута');
});

const invalidBackups = [
  {
    name: 'рассинхрон realWake и realSleepMin',
    mutate: (backup) => {
      // 400 минут не сходится с bed/fall/realWake — охрана должна сработать
      backup.sleep.realSleepMin = 400;
    },
    message: 'битая пара прошла разбор',
  },
  {
    name: 'половина пары realWake/realSleepMin',
    mutate: (backup) => { backup.sleep.realSleepMin = null; },
    message: 'половинчатая пара прошла разбор',
  },
  {
    name: 'копия чужой версии (10)',
    mutate: (backup) => { backup.version = 10; },
    message: 'копия версии 10 прошла разбор',
  },
  {
    name: 'не-время в actualWake',
    mutate: (backup) => { backup.sleep.actualWake = '25:99'; },
    message: 'битый actualWake прошёл разбор',
  },
  {
    name: 'не-целое sleepMin',
    mutate: (backup) => { backup.sleep.sleepMin = 1.5; },
    message: 'битый sleepMin прошёл разбор',
  },
];

for (const scenario of invalidBackups) {
  test(`${scenario.name} отвергается`, () => {
    const { context } = loadApp();
    const backup = defaultBackup();
    scenario.mutate(backup);
    const data = context.parseBackup(JSON.stringify(backup));
    assert.equal(data, null, scenario.message);
  });
}
