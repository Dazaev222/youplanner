// Тесты чистого ядра восстановления каза (_tools/restore-kaza-core.mjs).
//
// Ядро — это пересчёт, а не запись: сколько записей/дней соответствует
// целевому числу выполнений, каким станет остаток очереди и что план
// оставит нетронутым. Живые данные (localStorage, сеть, Firebase) ядро
// не трогает вовсе — тесты зовут чистые функции и подают им моки.
//
// Семантика, ради которой всё затеяно (ЗАДАЧА 1.3 «восстановить
// статистику — 1527 каза-намазов»):
//   done       — сколько ВЫПОЛНЕННЫХ каза должно быть в журнале ПОСЛЕ
//                восстановления (статистика снова показывает 1527);
//   remaining  — альтернативный вход: каким должен быть ОСТАТОК очереди.
// Связь жёсткая: долг приложения 1530 (по 306 на намаз, DEFAULT_QAZA
// в js/data/qaza.js), значит done = 1530 − remaining.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entryKey,
  planRestore,
  parseMonthsDump,
  parseEnvFile,
  parseStateDump,
  buildLocalSnippet,
  backfillDayCounts,
  monthDayCounts,
  remainingFromLog,
} from '../_tools/restore-kaza-core.mjs';

// Служебные: посчитать записи по дням и собрать карту ключей плана.
function countByDate(entries) {
  const byDate = {};
  for (const entry of entries) {
    byDate[entry.date] = (byDate[entry.date] || 0) + 1;
  }
  return byDate;
}

function keySet(entries) {
  return new Set(entries.map(entryKey));
}

// ── Раскладка count по дням и намазам ───────────────────────────────────────

test('1527 выполнений ложатся на 509 дней по 3, последний день — вчера', () => {
  const plan = planRestore({ done: 1527, todayISO: '2026-11-07' });

  assert.equal(plan.toAdd.length, 1527, 'одна запись — один выполненный намаз');
  const days = Object.keys(countByDate(plan.toAdd));
  assert.equal(days.length, 509, '1527 = 509 × 3 — без остатка');
  const lastDay = days.reduce((a, b) => (a > b ? a : b));
  assert.equal(lastDay, '2026-11-06', 'история заканчивается вчера, сегодня не трогаем');

  const byDate = countByDate(plan.toAdd);
  for (const date of days) {
    assert.ok(byDate[date] <= 3, 'в день не больше дневной цели (3)');
  }

  // Каждая запись — выполненный намаз из пяти известных
  for (const entry of plan.toAdd) {
    assert.equal(entry.source, 'done');
    assert.ok(['fajr', 'zuhr', 'asr', 'maghrib', 'isha'].includes(entry.namaz));
  }
});

test('остаток дня попадает на самый старый день (10 = 1+3+3+3)', () => {
  const days = backfillDayCounts(10, '2026-11-06', 3);

  assert.deepEqual(days, [
    { date: '2026-11-03', count: 1 },
    { date: '2026-11-04', count: 3 },
    { date: '2026-11-05', count: 3 },
    { date: '2026-11-06', count: 3 },
  ]);
});

test('намаз записи — чистая функция даты: один день — всегда один и тот же намаз', () => {
  // Стабильность нужна идемпотентности: повторный план для той же даты
  // обязан выбрать тот же намаз, иначе ключи разъедутся и журнал задвоится.
  // Проверяем через полные планы: два запуска с одинаковыми аргументами дают
  // одинаковые ключи записей.
  const p1 = keySet(planRestore({ done: 30, todayISO: '2026-11-07' }).toAdd);
  const p2 = keySet(planRestore({ done: 30, todayISO: '2026-11-07' }).toAdd);
  assert.deepEqual([...p1].sort(), [...p2].sort());
});

// ── Остаток очереди становится согласованным ────────────────────────────────

test('после 1527 выполнений в очереди остаётся 3 каза', () => {
  const plan = planRestore({ done: 1527, todayISO: '2026-11-07' });

  const remaining = plan.finalQaza.remaining;
  const total = Object.values(remaining).reduce((sum, n) => sum + n, 0);
  assert.equal(total, 3, 'долг 1530 минус 1527 выполненных');

  // Инвариант очереди: курсор указывает на намаз с ненулевым остатком
  const cursorNamaz = ['fajr', 'zuhr', 'asr', 'maghrib', 'isha'][plan.finalQaza.cursor];
  assert.ok(remaining[cursorNamaz] > 0, 'курсор стоит на намазе с остатком');
  assert.deepEqual(plan.finalQaza.history, [], 'стек отмены за сегодня пуст');
  assert.equal(plan.finalQaza.version, 3, 'версия схемы — текущая');
});

test('по каждому намазу остаток = долг минус выполненные этого намаза', () => {
  const plan = planRestore({ done: 12, todayISO: '2026-11-07' });

  const donePerNamaz = {};
  for (const entry of plan.toAdd) {
    donePerNamaz[entry.namaz] = (donePerNamaz[entry.namaz] || 0) + 1;
  }
  for (const namaz of ['fajr', 'zuhr', 'asr', 'maghrib', 'isha']) {
    assert.equal(plan.finalQaza.remaining[namaz], 306 - (donePerNamaz[namaz] || 0),
      'остаток ' + namaz + ' согласован с журналом');
  }
});

test('--remaining 1527: цель становится 3 выполнения, очередь возвращается к 1527', () => {
  const plan = planRestore({ remaining: 1527, todayISO: '2026-11-07' });

  assert.equal(plan.toAdd.length, 3, '1530 − 1527 = 3 выполнения в истории');
  const total = Object.values(plan.finalQaza.remaining).reduce((s, n) => s + n, 0);
  assert.equal(total, 1527, 'остаток очереди восстановлен');
});

// ── Помесячный дамп ─────────────────────────────────────────────────────────

test('дамп месяца: 10 каза за 2025-06 раскладываются по 3 с остатком на 4-й день', () => {
  const plan = planRestore({
    monthsDump: { '2025-06': 10 },
    todayISO: '2026-11-07',
  });

  assert.equal(plan.toAdd.length, 10);
  const byDate = countByDate(plan.toAdd);
  assert.deepEqual(byDate, {
    '2025-06-01': 3,
    '2025-06-02': 3,
    '2025-06-03': 3,
    '2025-06-04': 1,
  });
  assert.equal(plan.finalLog.since, '2025-06-01', 'окно журнала открывается с первой записи');
});

test('дамп и count вместе обязаны сходиться, иначе владелец путается в целях', () => {
  assert.throws(
    () => planRestore({ done: 1527, monthsDump: { '2025-06': 10 }, todayISO: '2026-11-07' }),
    /не совпадает/,
  );
});

test('месяц не вмещает больше дней, чем в нём есть при дневном лимите', () => {
  assert.throws(
    () => planRestore({ monthsDump: { '2025-06': 200 }, todayISO: '2026-11-07' }),
    /не вмещает/,
  );
  // 30 дней июня × 3 = 90 — ровно вмещается
  const counts = monthDayCounts({ '2025-06': 90 }, 3);
  assert.equal(counts.reduce((s, d) => s + d.count, 0), 90);
});

test('дамп не может писать в сегодняшний день и в будущее', () => {
  assert.throws(
    () => planRestore({ monthsDump: { '2026-11': 90 }, todayISO: '2026-11-07' }),
    /сегодняшн/,
  );
});

test('месяц-дамп обязан быть настоящим месяцем', () => {
  assert.throws(() => parseMonthsDump({ '2025-13': 5 }), /YYYY-MM/);
  assert.throws(() => parseMonthsDump({ июнь: 5 }), /YYYY-MM/);
  assert.throws(() => parseMonthsDump({ '2025-06': -1 }), /цел/);
  assert.throws(() => parseMonthsDump({ '2025-06': 1.5 }), /цел/);
  // Допустимы обе формы: голая карта и { months: ... }
  assert.deepEqual(parseMonthsDump({ months: { '2025-06': 5 } }), { '2025-06': 5 });
});

// ── Идемпотентность повторного запуска ──────────────────────────────────────

test('повторный запуск по уже восстановленному состоянию — ничего не делает', () => {
  const first = planRestore({ done: 12, todayISO: '2026-11-07' });

  // «Применение» в тесте — план сам становится живым состоянием: именно
  // finalLog и finalQaza уходят в хранилище при --apply.
  const second = planRestore({
    done: 12,
    todayISO: '2026-11-07',
    existingLog: first.finalLog,
    existingQaza: first.finalQaza,
  });

  assert.equal(second.toAdd.length, 0, 'все целевые записи уже в журнале');
  assert.equal(second.summary.nothingToDo, true, 'план честно говорит: делать нечего');
  assert.deepEqual(second.finalLog, first.finalLog, 'журнал не изменился');
  assert.deepEqual(second.finalQaza, first.finalQaza, 'очередь не изменилась');
});

test('частично восстановленный журнал дополняется без дублей', () => {
  const full = planRestore({ done: 6, todayISO: '2026-11-07' });

  // Владелец успел сделать два из шести целевых — план добавляет остальные
  const partialEntries = full.toAdd.slice(0, 2);
  const partialLog = {
    version: 1,
    since: partialEntries[0].date,
    entries: partialEntries.slice(),
  };
  const again = planRestore({
    done: 6,
    todayISO: '2026-11-07',
    existingLog: partialLog,
  });

  assert.equal(again.toAdd.length, 4, 'добавляются только недостающие');
  const mergedKeys = keySet(again.finalLog.entries);
  assert.equal(again.finalLog.entries.length, mergedKeys.size,
    'в итоговом журнале нет повторов по ключу дата|намаз|источник');
  assert.equal(again.summary.finalDone, 6);
});

test('ключ записи совпадает с ключом слияния sync (дата|намаз|источник)', () => {
  assert.equal(entryKey({ date: '2026-11-05', namaz: 'fajr', source: 'done' }),
    '2026-11-05|fajr|done');
});

// ── Живые записи владельца не стираются ─────────────────────────────────────

test('ручные добавления (manual) учитываются в остатке и остаются в журнале', () => {
  const existingLog = {
    version: 1,
    since: '2026-11-01',
    entries: [{ date: '2026-11-05', namaz: 'zuhr', source: 'manual' }],
  };
  const plan = planRestore({ done: 2, todayISO: '2026-11-07', existingLog: existingLog });

  const manualEntries = plan.finalLog.entries.filter((e) => e.source === 'manual');
  assert.equal(manualEntries.length, 1, 'ручная запись сохранена');

  // 1530 − 2 выполненных + 1 ручное добавление = 1529
  const total = Object.values(plan.finalQaza.remaining).reduce((s, n) => s + n, 0);
  assert.equal(total, 1529);
});

test('если в журнале уже не меньше цели — план ничего не добавляет', () => {
  const existingLog = {
    version: 1,
    since: '2026-11-01',
    entries: [
      { date: '2026-11-05', namaz: 'fajr', source: 'done' },
      { date: '2026-11-05', namaz: 'zuhr', source: 'done' },
      { date: '2026-11-06', namaz: 'fajr', source: 'done' },
    ],
  };
  const plan = planRestore({ done: 3, todayISO: '2026-11-07', existingLog: existingLog });

  assert.equal(plan.toAdd.length, 0);
  assert.equal(plan.summary.nothingToDo, true);
  assert.deepEqual(plan.finalLog.entries, existingLog.entries, 'журнал не переписывается');
});

test('окно журнала (since) может сдвинуться только раньше, не позже', () => {
  const existingLog = {
    version: 1,
    since: '2024-01-01',
    entries: [{ date: '2024-01-05', namaz: 'fajr', source: 'done' }],
  };
  const plan = planRestore({ done: 3, todayISO: '2026-11-07', existingLog: existingLog });

  assert.equal(plan.finalLog.since, '2024-01-01',
    'существующее раннее окно сохраняется: дни до restored-дат читают журнал');

  // И наоборот: восстановленные дни старше окна — окно открывается раньше
  const lateLog = {
    version: 1,
    since: '2026-10-01',
    entries: [{ date: '2026-10-05', namaz: 'fajr', source: 'done' }],
  };
  const plan2 = planRestore({
    done: 3,
    endISO: '2026-09-20',
    todayISO: '2026-11-07',
    existingLog: lateLog,
  });
  assert.equal(plan2.finalLog.since, '2026-09-20',
    'восстановленные дни старше окна обязаны попасть внутрь окна');
});

// ── Защита от мусорных целей ────────────────────────────────────────────────

test('отрицательные, дробные и заоблачные цели отвергаются', () => {
  assert.throws(() => planRestore({ done: -1, todayISO: '2026-11-07' }), /цел/);
  assert.throws(() => planRestore({ done: 1.5, todayISO: '2026-11-07' }), /цел/);
  assert.throws(() => planRestore({ remaining: -5, todayISO: '2026-11-07' }), /цел/);
  assert.throws(() => planRestore({ remaining: 9999, todayISO: '2026-11-07' }), /долг/);
  assert.throws(() => planRestore({ done: 0, remaining: 3, todayISO: '2026-11-07' }), /одновремен/);
  assert.throws(() => planRestore({ todayISO: '2026-11-07' }), /цель/);
  assert.throws(() => planRestore({ done: 3, perDay: 0, todayISO: '2026-11-07' }), /день/);
});

test('история не пишется в сегодняшний день и в будущее', () => {
  assert.throws(
    () => planRestore({ done: 3, endISO: '2026-11-07', todayISO: '2026-11-07' }),
    /сегодняшн/,
  );
  assert.throws(
    () => planRestore({ done: 3, endISO: '2026-11-08', todayISO: '2026-11-07' }),
    /сегодняшн/,
  );
  assert.throws(
    () => planRestore({ done: 3, endISO: '2026-13-40', todayISO: '2026-11-07' }),
    /YYYY-MM-DD/,
  );
});

test('предупреждение, если на устройстве был стек отмены за сегодня', () => {
  const plan = planRestore({
    done: 3,
    todayISO: '2026-11-07',
    existingQaza: {
      version: 3,
      cursor: 0,
      remaining: { fajr: 300, zuhr: 306, asr: 306, maghrib: 305, isha: 305 },
      history: [{ namaz: 'fajr', date: '2026-11-07', source: 'done' }],
    },
  });

  assert.ok(plan.warnings.some((w) => /отмен/.test(w)),
    'владелец должен знать: стек отмены за сегодня заменится пустым');
});

// ── Остаток из журнала (переиспользуемая чистая функция) ────────────────────

test('remainingFromLog: долг минус done плюс manual, без отрицательных', () => {
  const entries = [
    { date: '2026-01-01', namaz: 'fajr', source: 'done' },
    { date: '2026-01-02', namaz: 'fajr', source: 'done' },
    { date: '2026-01-03', namaz: 'fajr', source: 'done' }, // больше долга — кламп в 0
    { date: '2026-01-04', namaz: 'zuhr', source: 'manual' },
  ];
  const { remaining, clamped } = remainingFromLog(entries, 2);

  assert.deepEqual(remaining, { fajr: 0, zuhr: 3, asr: 2, maghrib: 2, isha: 2 });
  assert.deepEqual(clamped, ['fajr'], 'по fajr долг исчерпан — клампится в ноль');
});

// ── Конфиг и состояние: парсеры для CLI ─────────────────────────────────────

test('parseEnvFile читает KEY=VALUE с комментариями, пробелами и кавычками', () => {
  const text = [
    '# комментарий целиком',
    '',
    'FIREBASE_URL=https://example.firebaseio.com/node',
    'OWNER_EMAIL = owner@example.com ',
    'OWNER_PASSWORD="пароль с пробелами"',
    "TOKEN='одинарные'",
    'EMPTY=',
  ].join('\n');

  assert.deepEqual(parseEnvFile(text), {
    FIREBASE_URL: 'https://example.firebaseio.com/node',
    OWNER_EMAIL: 'owner@example.com',
    OWNER_PASSWORD: 'пароль с пробелами',
    TOKEN: 'одинарные',
    EMPTY: '',
  });
});

test('parseStateDump понимает и JSON, и текстовый дамп dump-localstorage.html', () => {
  // Форма 1: обычный JSON с ключами localStorage
  const jsonForm = JSON.stringify({
    'youplanner.qaza': { version: 3, cursor: 0, remaining: {}, history: [] },
    'youplanner.qaza.log': { version: 1, since: '2026-01-01', entries: [] },
  });
  const fromJson = parseStateDump(jsonForm);
  assert.equal(fromJson.qaza.version, 3);
  assert.equal(fromJson.qazaLog.since, '2026-01-01');

  // Форма 2: текстовый дамп с разделами "--- ключ ---" (значения могут быть
  // и сырыми строками localStorage, и красивыми JSON)
  const textForm = [
    '=== localStorage YouPlanner ===',
    '',
    '--- youplanner.qaza ---',
    '{"version":3,"cursor":2,"remaining":{"fajr":1},"history":[]}',
    '',
    '--- youplanner.qazaLog ---',   // ключ-сосед с багом дампера — тоже принимаем
    '{"version":1,"since":"2026-01-01","entries":[]}',
    '',
    '--- youplanner.records ---',
    '  Записей дней: 43',           // не-JSON — не роняет парсер
    '',
  ].join('\n');
  const fromText = parseStateDump(textForm);
  assert.equal(fromText.qaza.cursor, 2);
  assert.equal(fromText.qazaLog.since, '2026-01-01');
  assert.equal(fromText.other['youplanner.records'], 'Записей дней: 43');
});

test('сниппет для браузера пишет теми же ключами, что saveQaza и loadQazaLog', () => {
  const plan = planRestore({ done: 3, todayISO: '2026-11-07' });
  const snippet = buildLocalSnippet(plan.finalQaza, plan.finalLog, 1700000000000);

  assert.ok(snippet.includes("'youplanner.qaza'"), 'ключ состояния очереди');
  assert.ok(snippet.includes("'youplanner.qaza.log'"), 'ключ журнала');
  assert.ok(snippet.includes("'youplanner.sync.section-writes'"),
    'метка записи раздела — без неё облако затрёт локальную правку');
  assert.ok(snippet.includes(JSON.stringify(JSON.stringify(plan.finalQaza))),
    'состояние вставляется той же JSON-формой, что пишет saveQaza (экранированной внутри JS-строки)');
  assert.ok(snippet.includes(JSON.stringify(JSON.stringify(plan.finalLog))),
    'журнал вставляется той же JSON-формой, что пишет saveQazaLog');
  assert.ok(snippet.includes('1700000000000'), 'метка записи передана');
});

// ── Скрипт CLI: импорт ничего не исполняет ──────────────────────────────────

test('_tools/restore-kaza.mjs импортируется и не запускает main на импорте', async () => {
  const cli = await import('../_tools/restore-kaza.mjs');
  assert.equal(typeof cli.main, 'function', 'main — функция, зовётся только из CLI-запуска');
});
