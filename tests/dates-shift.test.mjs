// Задача 1.4: «сдвиг дат» — проверка календарного слоя на классические грабли.
//
// Жалоба владельца: даты сдвигаются (подозрение на new Date()-парсинг или
// таймзону). Классические грабли:
//   * new Date('YYYY-MM-DD') парсится как UTC и в ОТРИЦАТЕЛЬНОМ смещении
//     (западнее Гринвича) уезжает на сутки назад;
//   * ручной new Date(y, m, d) с месяцем без -1 (или с двойным -1);
//   * toISOString() от локальной полуночи — та же UTC-сериализация.
//
// Проверка идёт в ОТДЕЛЬНЫХ Node-процессах с env.TZ (Windows зону командой не
// передаёт — приём tests/matrix-tz.test.mjs): зоны восточнее и западнее
// Гринвича, включая зону владельца UTC+3 и переходы часов 2026 года (Европа —
// 25.10, США — 01.11). Ожидаемые значения выведены из календаря, не из
// реализации. Ребёнок — tests/helpers/date-shift-checks.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'date-shift-checks.mjs');

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

const ZONES = ['UTC', 'Europe/Moscow', 'Asia/Almaty', 'Europe/Berlin', 'America/New_York'];

// ── 1. Round-trip: parseISODate → toISODate возвращает строку как есть ──────
// Лови здесь new Date('YYYY-MM-DD')-регрессию: в зонах западнее Гринвича она
// даёт вчерашний день ровно на этой проверке.

for (const tz of ZONES) {
  test(tz + ': parseISODate→toISODate не сдвигает ни одну опасную дату', () => {
    const r = run(tz);
    assert.equal(r.tz, tz);
    for (const [iso, back] of Object.entries(r.roundtrip)) {
      assert.equal(back, iso, tz + ': дата ' + iso + ' вернулась как ' + back);
    }
  });
}

// ── 2. Календарная арифметика: год, февраль, 31-е число, переходы часов ─────

for (const tz of ZONES) {
  test(tz + ': addDays не теряет дни на границах года, февраля и месяцев', () => {
    const r = run(tz);
    assert.deepEqual(r.shifts, {
      yearForward: '2026-01-01',   // 2025-12-31 + 1
      yearBack: '2025-12-31',      // 2026-01-01 - 1
      febNonLeap: '2026-03-01',    // 2026 год не високосный
      febLeap: '2028-02-29',       // 2028 год високосный
      monthEnd31: '2026-11-01',    // 31 октября + 1
      monthEnd30: '2026-07-01',    // 30 июня + 1
      dstEuropeEnd: '2026-10-26',  // ночь перевода часов в Европе
      dstUsEnd: '2026-11-02',      // ночь перевода часов в США
      thirtyDays: '2026-12-07',    // месяц вперёд по дням
    }, tz + ': сдвиг дней разошёлся с календарём');
  });
}

// ── 3. Неделя: понедельник по ISO, включая недели с переходом часов ─────────

for (const tz of ZONES) {
  test(tz + ': getWeekStart держит понедельник через границу года и DST', () => {
    const r = run(tz);
    assert.deepEqual(r.weekStarts, {
      thursdayNewYear: '2025-12-29', // четверг 2026-01-01 → понедельник прошлой недели
      mondayPlain: '2026-11-02',
      sundayPlain: '2026-11-02',     // воскресенье → понедельник этой недели
      sundayUsDstEnd: '2026-10-26',
      sundayEuropeDstEnd: '2026-10-19',
    }, tz + ': начало недели разошлось с календарём');
  });
}

// ── 4. Месячный прогресс: окно ноября 2026 не вылезает за месяц ─────────────

for (const tz of ZONES) {
  test(tz + ': getMonthDatesToToday(ноябрь 2026) — только ноябрь, без сдвига месяца', () => {
    const r = run(tz);
    assert.equal(r.month.allNovember, true,
      tz + ': в окне месяца появились чужие месяцы: ' + JSON.stringify(r.month));
    assert.equal(r.month.count, Math.min(30, r.month.todayDate),
      tz + ': длина окна не совпала с «1-е число…сегодня»');
    assert.equal(r.month.first, '2026-11-01');
  });
}

// ── 5. Граница суток в UTC+3 (зона владельца): каза и молитвы ───────────────
// Расписание молитв закреплено за UTC+3 (PRAYER_TZ = 3, js/data/prayer.js:11):
// до Фаджра (запас 05:00 UTC+3) день каза — ещё вчера; молитвенная дата
// меняется в полночь UTC+3 независимо от зоны устройства.

test('Europe/Moscow (UTC+3): граница дня каза — Фаджр 05:00, до него «вчера»', () => {
  const r = run('Europe/Moscow');
  assert.equal(r.kaza.boundary, 300, 'без координат граница — запасной Фаджр 05:00');
  assert.equal(r.kaza.beforeFajrUtc3, '2026-11-06', 'до Фаджра день каза — ещё вчера');
  assert.equal(r.kaza.atFajrUtc3, '2026-11-07', 'ровно в 05:00 UTC+3 наступил сегодняшний день');
  assert.equal(r.kaza.eveningUtc3, '2026-11-07');
});

test('молитвенная дата закреплена за UTC+3 в любой зоне устройства', () => {
  const inOwnerZone = run('Europe/Moscow');
  assert.equal(inOwnerZone.prayer.eveningUtc3.date, '2026-11-07');
  assert.equal(inOwnerZone.prayer.midnightUtc3.date, '2026-11-08',
    'в полночь UTC+3 молитвенный день сменился');
  assert.equal(inOwnerZone.prayer.eveningUtc3.minutes, 1380, '23:00 UTC+3 = 1380 минут');
  assert.equal(inOwnerZone.prayer.atFajrUtc3.minutes, 300, '05:00 UTC+3 = 300 минут');

  // Западнее и восточнее Гринвича молитвенная дата та же, что в UTC+3:
  // пояс расчёта не зависит от настроек устройства (prayer.js:8-10)
  const west = run('America/New_York');
  assert.equal(west.prayer.eveningUtc3.date, '2026-11-07',
    'Нью-Йорк 15:00 EST — в UTC+3 ещё 07-е');
  assert.equal(west.prayer.midnightUtc3.date, '2026-11-08');
  const east = run('Asia/Almaty');
  assert.equal(east.prayer.eveningUtc3.date, '2026-11-07',
    'Алматы 01:00 (+5) — в UTC+3 ещё 07-е');
  assert.equal(east.prayer.midnightUtc3.date, '2026-11-08');
});

// ── 6. Мусор на входе: документированное поведение parseISODate ─────────────

test('Europe/Moscow: «31 ноября» разворачивается в декабрь (ловится round-trip), мусор — Invalid', () => {
  const r = run('Europe/Moscow');
  assert.equal(r.roundtrip['2028-02-29'], '2028-02-29', 'високосный февраль 2028 существует');
  // Несуществующая дата разворачивается, а не молча принимается: round-trip
  // валидацию таких строк делает isoDateOrNull (matrix-schedule.js:53-62)
  assert.equal(r.parseEdge.rollover, '2026-12-01');
  assert.equal(r.parseEdge.junkInvalid, true, 'мусор обязан быть Invalid Date');
});
