// ТЗ Б8 «Данные и даты», пункт про DST: проверки выполняются в ОТДЕЛЬНЫХ
// Node-процессах с env.TZ через launcher (в Windows `TZ=... node` зону не
// передаёт, а без этого тест проверял бы одну зону машины).
//
// Ожидаемые значения проставлены по правилу переходов времени (Европа:
// 29.03.2026 02:00→03:00 и 25.10.2026 03:00→02:00; США: 08.03.2026 02:00→03:00
// и 01.11.2026 02:00→01:00), а не считываются из реализации.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'tz-checks.mjs');

function run(tz) {
  const result = spawnSync(process.execPath, [CHILD], {
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0,
    tz + ': дочерняя проверка завершилась с ошибкой: ' + (result.stderr || result.stdout));
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    assert.fail(tz + ': дочерняя проверка не вернула JSON: ' + result.stdout.slice(0, 200));
  }
}

// Ссылки на «полночь по Гринвичу» считаются здесь и не берутся из модуля.
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi);

test('UTC: никаких переходов, все моменты существуют и round-trip-ятся', (t) => {
  const r = run('UTC');
  assert.equal(r.tz, 'UTC');
  for (const [name, probe] of Object.entries(r.moments)) {
    assert.equal(probe.ok, true, name + ': в UTC существует любое настенное время');
    assert.equal(probe.ambiguous, false, name + ': в UTC нет неоднозначных часов');
  }
  assert.equal(r.moments.plain.epoch, utc(2026, 10, 4, 9, 30));
  assert.equal(r.moments.midnight.epoch, utc(2026, 10, 4, 0, 0));
  assert.equal(r.moments.lastMinute.epoch, utc(2026, 10, 4, 23, 59));
  assert.equal(r.durations.timedAcrossBerlinSpring.minutes, 150, 'в UTC это ровно 150 минут');
  assert.equal(r.durations.timedAcrossBerlinSpring.label, '2 ч 30 мин');
  assert.equal(r.durations.timedOvernight.minutes, 45);
  assert.equal(r.dailyAcrossGap.dstShifted, false, 'в UTC сдвигать нечего');
  assert.equal(r.dailyAcrossGap.startTime, '02:30');
});

test('Europe/Berlin: 29.03.2026 02:30 не существует, 25.10.2026 02:30 — первый момент', (t) => {
  const r = run('Europe/Berlin');

  assert.equal(r.moments.berlinSpring.ok, false,
    'ручной ввод несуществующих часов отклоняется, а не перевозбирается');
  assert.equal(r.moments.berlinSpring.code, 'nonexistent');

  assert.equal(r.moments.berlinAutumn.ok, true);
  assert.equal(r.moments.berlinAutumn.ambiguous, true, 'осенние часы повторяются дважды');
  assert.equal(r.moments.berlinAutumn.epoch, utc(2026, 9, 25, 0, 30),
    'неоднозначное время выбирает ПЕРВОЕ вхождение (02:30 CEST = 00:30 UTC)');
  assert.equal(r.moments.berlinAutumn.hour, 2);
  assert.equal(r.moments.berlinAutumn.minute, 30);

  assert.equal(r.moments.plain.epoch, utc(2026, 10, 4, 8, 30), 'ноябрь — CET (+1)');
  assert.equal(r.durations.timedAcrossBerlinSpring.minutes, 90,
    '01:00→03:30 в ночь перехода = 90 реальных минут');
  assert.equal(r.durations.allDayAcrossSpring.days, 3,
    'all-day считается календарными днями, а не делением миллисекунд');

  assert.equal(r.dailyAcrossGap.startDate, '2026-03-29');
  assert.equal(r.dailyAcrossGap.dstShifted, true,
    'вычисленное повторение в провале сдвигается к первому существующему моменту');
  assert.equal(r.dailyAcrossGap.requestedStartTime, '02:30', 'запрошенное время сохранено');
  assert.equal(r.dailyAcrossGap.startTime, '03:00', 'нормализованное время показано');
  assert.equal(r.dailyAcrossGap.valid, 45, 'после сдвига окончание строго позже начала');
});

test('America/New_York: отрицательный offset, свои даты переходов', (t) => {
  const r = run('America/New_York');

  assert.equal(r.moments.newYorkSpring.ok, false, '08.03.2026 02:30 в США не существует');
  assert.equal(r.moments.newYorkSpring.code, 'nonexistent');
  assert.equal(r.moments.newYorkAutumn.ok, true);
  assert.equal(r.moments.newYorkAutumn.ambiguous, true);
  assert.equal(r.moments.newYorkAutumn.epoch, utc(2026, 10, 1, 5, 30),
    'первое вхождение 01:30 по EDT (-4) = 05:30 UTC');

  assert.equal(r.moments.plain.epoch, utc(2026, 10, 4, 14, 30), 'ноябрь — EST (-5)');
  assert.equal(r.dailyAcrossGap.dstShifted, false,
    'в конце марта США уже живут по летнему времени — сдвига нет');
  assert.equal(r.dailyAcrossGap.startTime, '02:30');
});

test('Asia/Almaty: положительный offset без переходов времени', (t) => {
  const r = run('Asia/Almaty');
  assert.equal(r.moments.plain.epoch, utc(2026, 10, 4, 4, 30), '+05:00');
  assert.equal(r.moments.berlinSpring.ok, true, 'в этой зоне 29.03.2026 02:30 существует');
  assert.equal(r.moments.berlinAutumn.ambiguous, false);
  assert.equal(r.durations.timedAcrossBerlinSpring.minutes, 150);
});

test('Б3.9 all-day даты не сдвигаются ни в одной зоне', (t) => {
  for (const tz of ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Almaty']) {
    const r = run(tz);
    for (const item of r.allDayRoundtrip) {
      assert.equal(item.startDate, item.input, tz + ': startDate не уехал');
      assert.equal(item.endDate, item.input, tz + ': endDate не уехал');
      assert.equal(item.due, item.input, tz + ': due не уехал');
    }
    assert.deepEqual(r.monthlyAcrossGap, ['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'],
      tz + ': месячный ряд не зависит от перевода часов');
  }
});
