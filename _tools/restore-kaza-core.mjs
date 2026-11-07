// Чистое ядро восстановления статистики каза (ЗАДАЧА 1.3).
//
// Здесь только ПЕРЕСЧЁТ: сколько записей/дней соответствует целевому числу
// выполнений, каким станет остаток очереди и что план оставит нетронутым.
// Ни сети, ни localStorage, ни Firebase — живые данные ядро не трогает,
// поэтому его можно проверять юнит-тестами (tests/restore-kaza.test.mjs).
// Ввод-вывод (аргументы, конфиг, fetch, печать) живёт в restore-kaza.mjs.
//
// Семантика целей (выбирает владелец, ровно одна за запуск):
//   done       — сколько ВЫПОЛНЕННЫХ каза должно быть в журнале ПОСЛЕ
//                восстановления. «Восстановить статистику — 1527 каза»
//                значит: в журнале станет 1527 записей source='done',
//                а в очереди останется 1530 − 1527 = 3.
//   remaining  — каким должен быть ОСТАТОК очереди; выполненных станет
//                1530 − remaining.
//   monthsDump — помесячная история {'ГГГГ-ММ': сколько сделано}; может
//                сочетаться только с done и обязана сходиться с ним суммой.
//
// Долг приложения — 1530 каза, по 306 на намаз (DEFAULT_QAZA в
// js/data/qaza.js): у нового пользователя очередь ровно такая, поэтому
// «сколько сделано» и «сколько осталось» связаны через него.
//
// Константы и валидаторы берутся ИЗ КОДА ПРИЛОЖЕНИЯ — план собирается теми
// же copyQaza/normalizeQazaCursor/validQazaLogEntries, какими приложение
// читает и пишет раздел. Дублировать числа здесь нельзя: разъедутся.

import {
  NAMAZ_ORDER,
  QAZA_DAILY_GOAL,
  QAZA_LOG_VERSION,
  QAZA_SOURCE_DONE,
  QAZA_SOURCE_MANUAL,
  QAZA_VERSION,
  copyQaza,
  normalizeQazaCursor,
  validQazaLogDate,
  validQazaLogEntries,
} from '../js/data/qaza.js';
import { SECTION_WRITE_TS_KEY } from '../js/data/storage.js';
import { toISODate, addDays, parseISODate, isDateLike } from '../js/core/dates.js';

// Стартовый долг одного намаза: 306 × 5 = 1530 (DEFAULT_QAZA до первых трёх)
export const DEFAULT_DEBT_PER_NAMAZ = 306;
// Дневная цель приложения — ориентир раскладки, не жёсткий лимит записи
export const DEFAULT_PER_DAY = QAZA_DAILY_GOAL;

// ── Ключ записи журнала ─────────────────────────────────────────────────────

// Тот же ключ дедупликации, что в слиянии журнала на устройствах
// (mergeQazaLogEntries, js/sync/merge.js): «дата|намаз|источник». Именно
// поэтому повторный запуск и последующие синхронизации не задваивают записи.
export function entryKey(entry) {
  return entry.date + '|' + entry.namaz + '|' + entry.source;
}

// ── Даты и раскладка по дням ────────────────────────────────────────────────

// Намаз для позиции внутри дня — чистая функция от САМОЙ ДАТЫ, а не от
// номера в последовательности: два запуска плана для одной даты обязаны
// выбрать один и тот же намаз, иначе ключи разъедутся и журнал задвоится.
// Обход по кругу NAMAZ_ORDER (Фаджр → … → Иша), старт сдвигается от даты.
export function namazForPosition(dateISO, positionInDay) {
  const day = parseISODate(dateISO);
  const epochDays = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 86400000;
  return NAMAZ_ORDER[(((epochDays % 5) + 5 + positionInDay) % 5)];
}

// Настоящая календарная дата 'YYYY-MM-DD': формат как у журнала плюс
// round-trip через parseISODate — иначе «2026-13-40» проходит проверку
// цифр и ломает лексические сравнения дат.
export function isRealISODate(value) {
  if (!validQazaLogDate(value)) return false;
  const day = parseISODate(value);
  return isDateLike(day) && toISODate(day) === value;
}

// Сколько дней в месяце (month 1..12): 0-е число следующего месяца
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Равномерная раскладка count назад от endISO: по perDay в день, остаток
// от деления — на самом старом дне. Возвращает [{date, count}] по возрастанию.
// Пример: 10 при perDay=3 и конце 2026-11-06 → [03:1, 04:3, 05:3, 06:3].
export function backfillDayCounts(count, endISO, perDay) {
  const fullDays = Math.floor(count / perDay);
  const remainder = count % perDay;
  const result = [];
  let cursor = parseISODate(endISO);
  for (let i = 0; i < fullDays; i++) {
    result.push({ date: toISODate(cursor), count: perDay });
    cursor = addDays(cursor, -1);
  }
  if (remainder > 0) {
    result.push({ date: toISODate(cursor), count: remainder });
  }
  return result.reverse();
}

// Помесячный дамп → дни. Месяц заполняется с 1-го числа по perDay в день,
// остаток месяца достаётся первому неполному дню. Дни без записей в результат
// не попадают. Результат по возрастанию дат.
export function monthDayCounts(months, perDay) {
  const keys = Object.keys(months).sort();
  const result = [];
  for (const key of keys) {
    const year = parseInt(key.slice(0, 4), 10);
    const month = parseInt(key.slice(5, 7), 10);
    let left = months[key];
    if (left === 0) continue;
    const totalDays = daysInMonth(year, month);
    const capacity = totalDays * perDay;
    if (left > capacity) {
      throw new Error('Месяц ' + key + ' не вмещает ' + left +
        ' каза при ' + perDay + ' в день (максимум ' + capacity + ')');
    }
    for (let day = 1; left > 0 && day <= totalDays; day++) {
      const count = Math.min(perDay, left);
      left -= count;
      result.push({ date: key + '-' + String(day).padStart(2, '0'), count: count });
    }
  }
  return result;
}

// Дни → записи журнала: одна запись — один выполненный намаз дня.
export function dayCountsToEntries(dayCounts) {
  const entries = [];
  for (const day of dayCounts) {
    for (let pos = 0; pos < day.count; pos++) {
      entries.push({
        date: day.date,
        namaz: namazForPosition(day.date, pos),
        source: QAZA_SOURCE_DONE,
      });
    }
  }
  return entries;
}

// ── Остаток очереди из журнала ──────────────────────────────────────────────

// remaining = долг − выполненные + ручные добавления, не ниже нуля. Ручное
// добавление пропуска увеличивает очередь (addMissedQaza в qaza.js), поэтому
// оно и прибавляет. clamped перечисляет намазы, у которых выполненных больше
// долга: остаток прижат к нулю, владельцу об этом скажет предупреждение.
export function remainingFromLog(entries, debtPerNamaz) {
  const done = {};
  const manual = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.source === QAZA_SOURCE_DONE) {
      done[entry.namaz] = (done[entry.namaz] || 0) + 1;
    } else if (entry.source === QAZA_SOURCE_MANUAL) {
      manual[entry.namaz] = (manual[entry.namaz] || 0) + 1;
    }
  }
  const remaining = {};
  const clamped = [];
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const namaz = NAMAZ_ORDER[i];
    const raw = debtPerNamaz - (done[namaz] || 0) + (manual[namaz] || 0);
    if (raw < 0) {
      remaining[namaz] = 0;
      clamped.push(namaz);
    } else {
      remaining[namaz] = raw;
    }
  }
  return { remaining: remaining, clamped: clamped };
}

// ── Помесячный дамп: разбор и проверка ──────────────────────────────────────

// Принимает {'ГГГГ-ММ': n} или {months: {...}}, возвращает плоскую карту.
// Бросает понятную ошибку: владельцу читать её в терминале, а не в стеке.
export function parseMonthsDump(raw) {
  const source = raw && raw.months ? raw.months : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Дамп месяцев: ожидался объект вида {"2025-06": 90}');
  }
  const months = {};
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
      throw new Error('Ключ месяца обязан быть формата YYYY-MM (например 2025-06): ' +
        JSON.stringify(key));
    }
    const value = source[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('В месяце ' + key + ': только целые количества ≥ 0, получено ' +
        JSON.stringify(value));
    }
    months[key] = value;
  }
  return months;
}

// ── Главный пересчёт: план восстановления ───────────────────────────────────
//
// Ничего не пишет. Возвращает:
//   toAdd     — записи, которых не хватает (план добавляет ТОЛЬКО их);
//   finalLog  — каким станет youplanner.qaza.log (существующие + добавка);
//   finalQaza — каким станет youplanner.qaza (очередь под итоговую историю;
//               history пуст: стек отмены живёт только за сегодняшний день
//               и принадлежит устройству);
//   warnings  — тексты для владельца (печатаются в dry-run);
//   summary   — числа для отчёта (сколько добавлено, итог, окно дат).
//
// Идемпотентность: целевая раскладка строится от ПОЛНОЙ цели (а не от
// разницы), поэтому повторный запуск с теми же аргументами выбирает те же
// дни и намазы; уже существующие записи по ключу дата|намаз|источник
// исключаются из добавки, и второй план становится пустым (nothingToDo).
export function planRestore(input) {
  const options = input || {};

  // 1) Календарь: сегодняшний и будущие дни не трогаем никогда — счётчик
  //    сегодняшнего дня живёт в youplanner.records, им управляет приложение.
  if (!isRealISODate(options.todayISO)) {
    throw new Error('todayISO: нужна настоящая дата формата YYYY-MM-DD');
  }
  const todayISO = options.todayISO;

  const perDay = options.perDay === undefined ? DEFAULT_PER_DAY : options.perDay;
  if (!Number.isInteger(perDay) || perDay < 1) {
    throw new Error('per-day: минимум 1 запись в день, получено ' + JSON.stringify(options.perDay));
  }

  const debtPerNamaz = options.debtPerNamaz === undefined
    ? DEFAULT_DEBT_PER_NAMAZ
    : options.debtPerNamaz;
  if (!Number.isInteger(debtPerNamaz) || debtPerNamaz < 1) {
    throw new Error('debt: долг на один намаз — целое ≥ 1, получено ' +
      JSON.stringify(options.debtPerNamaz));
  }

  // 2) Цель: что именно восстанавливаем.
  const hasDone = options.done !== undefined;
  const hasRemaining = options.remaining !== undefined;
  if (hasDone && hasRemaining) {
    throw new Error('--count и --remaining одновременно указывать нельзя: задайте что-то одно');
  }
  const monthsDump = options.monthsDump ? parseMonthsDump(options.monthsDump) : null;
  if (monthsDump && hasRemaining) {
    throw new Error('Задайте что-то одно: --dump или --remaining');
  }
  if (!hasDone && !hasRemaining && !monthsDump) {
    throw new Error('Не задана цель: укажите --count N, --remaining N или --dump файл.json');
  }

  let doneTarget;
  if (hasRemaining) {
    const maxTotal = debtPerNamaz * NAMAZ_ORDER.length;
    if (!Number.isInteger(options.remaining) || options.remaining < 0) {
      throw new Error('remaining: целое от 0 до ' + maxTotal + ', получено ' +
        JSON.stringify(options.remaining));
    }
    if (options.remaining > maxTotal) {
      throw new Error('remaining ' + options.remaining + ' больше суммарного долга ' +
        maxTotal + ' (5 × ' + debtPerNamaz + '): очередь не бывает больше долга');
    }
    doneTarget = maxTotal - options.remaining;
  } else if (monthsDump) {
    const dumpTotal = Object.keys(monthsDump)
      .reduce(function (sum, key) { return sum + monthsDump[key]; }, 0);
    if (hasDone && options.done !== dumpTotal) {
      throw new Error('Сумма дампа (' + dumpTotal + ') не совпадает с --count (' +
        options.done + '). Согласуйте числа или передайте только что-то одно');
    }
    doneTarget = dumpTotal;
  } else {
    if (!Number.isInteger(options.done) || options.done < 0) {
      throw new Error('count: цель — целое количество выполнений ≥ 0, получено ' +
        JSON.stringify(options.done));
    }
    doneTarget = options.done;
  }

  // 3) Последний день истории. По умолчанию — вчера относительно todayISO.
  let endISO = options.endISO;
  if (endISO === undefined) {
    endISO = toISODate(addDays(parseISODate(todayISO), -1));
  }
  if (!isRealISODate(endISO)) {
    throw new Error('end: нужна настоящая дата формата YYYY-MM-DD, получено ' +
      JSON.stringify(options.endISO));
  }
  if (endISO >= todayISO) {
    throw new Error('end ' + endISO + ' — сегодняшний или будущий день. История пишется ' +
      'только до вчерашнего: сегодняшний счётчик ведёт само приложение');
  }

  // 4) Что уже есть. Записи прогоняются через валидатор приложения — битые
  //    строки он отбрасывает так же, как при чтении журнала приложением.
  const existingEntries = validQazaLogEntries(
    options.existingLog && options.existingLog.entries
  );
  const existingDone = existingEntries.filter(function (entry) {
    return entry.source === QAZA_SOURCE_DONE;
  });
  const existingManualCount = existingEntries.length - existingDone.length;

  const warnings = [];
  const nothingToDo = existingDone.length >= doneTarget;

  // 5) Целевая раскладка и добавка.
  let targetEntries = [];
  let toAdd = [];
  if (!nothingToDo) {
    let dayCounts;
    if (monthsDump) {
      dayCounts = monthDayCounts(monthsDump, perDay);
      for (let i = 0; i < dayCounts.length; i++) {
        if (dayCounts[i].date >= todayISO) {
          throw new Error('Дамп задаёт записи за сегодняшний или будущий день (' +
            dayCounts[i].date + '). Сегодняшний день не трогаем');
        }
      }
    } else {
      dayCounts = backfillDayCounts(doneTarget, endISO, perDay);
    }
    targetEntries = dayCountsToEntries(dayCounts);

    const existingKeys = {};
    for (let i = 0; i < existingEntries.length; i++) {
      existingKeys[entryKey(existingEntries[i])] = true;
    }
    toAdd = targetEntries.filter(function (entry) {
      return !existingKeys[entryKey(entry)];
    });
  }

  // 6) Итоговый журнал: существующие записи остаются как были, добавка
  //    дописывается, сортировка по дате — как в mergeQazaLogEntries.
  const finalEntries = existingEntries.concat(toAdd).sort(function (a, b) {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });

  // Окно журнала может сдвинуться только РАНЬШЕ: правило «журнал с since,
  // до него — записи h6» привязано к нему, и сдвиг позже спрятал бы уже
  // посчитанные дни (merge.js об окне журнала).
  let since = null;
  if (options.existingLog && validQazaLogDate(options.existingLog.since)) {
    since = options.existingLog.since;
  }
  for (let i = 0; i < finalEntries.length; i++) {
    if (since === null || finalEntries[i].date < since) since = finalEntries[i].date;
  }

  const finalLog = finalEntries.length > 0
    ? { version: QAZA_LOG_VERSION, since: since, entries: finalEntries }
    : null;

  // 7) Итоговая очередь — под итоговую историю, кодом приложения.
  const queue = remainingFromLog(finalEntries, debtPerNamaz);
  if (queue.clamped.length > 0) {
    warnings.push('Выполненных больше долга по намазам: ' + queue.clamped.join(', ') +
      ' — их остаток обнулён.');
  }
  let cursor = 0;
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    if (queue.remaining[NAMAZ_ORDER[i]] > 0) { cursor = i; break; }
  }
  const finalQaza = copyQaza({
    version: QAZA_VERSION,
    cursor: cursor,
    remaining: queue.remaining,
    history: [],
  });
  normalizeQazaCursor(finalQaza);

  // Стек отмены за сегодня принадлежит живому устройству; раздел qaza
  // заменяется целиком — владелец должен знать об этом заранее.
  if (options.existingQaza && Array.isArray(options.existingQaza.history) &&
      options.existingQaza.history.length > 0) {
    warnings.push('На устройстве есть стек отмены за сегодня (' +
      options.existingQaza.history.length + ' зап.): раздел qaza заменится целиком, ' +
      'стек станет пустым. Не применяйте план сразу после сегодняшних выполнений.');
  }

  const finalDone = finalEntries.filter(function (entry) {
    return entry.source === QAZA_SOURCE_DONE;
  }).length;
  if (finalDone > doneTarget) {
    warnings.push('Итоговых выполнений ' + finalDone + ' — больше цели ' + doneTarget +
      ': в журнале уже были свои записи вне целевых дней. План ничего не удаляет.');
  }
  if (existingDone.length > doneTarget) {
    warnings.push('В журнале уже ' + existingDone.length + ' выполнений — больше цели ' +
      doneTarget + '; добавок не будет.');
  }

  // 8) Отчёт.
  const addedDates = {};
  for (let i = 0; i < toAdd.length; i++) addedDates[toAdd[i].date] = true;
  const remainingTotal = NAMAZ_ORDER.reduce(function (sum, namaz) {
    return sum + finalQaza.remaining[namaz];
  }, 0);

  return {
    toAdd: toAdd,
    targetEntries: targetEntries,
    finalLog: finalLog,
    finalQaza: finalQaza,
    warnings: warnings,
    summary: {
      mode: hasRemaining ? 'remaining' : (monthsDump ? 'dump' : 'done'),
      doneTarget: doneTarget,
      existingDone: existingDone.length,
      existingManual: existingManualCount,
      addedCount: toAdd.length,
      addedDays: Object.keys(addedDates).length,
      addedEarliest: toAdd.length > 0 ? toAdd[0].date : null,
      addedLatest: toAdd.length > 0 ? toAdd[toAdd.length - 1].date : null,
      finalDone: finalDone,
      finalManual: existingManualCount,
      remainingTotal: remainingTotal,
      nothingToDo: nothingToDo,
    },
  };
}

// ── Парсеры для CLI (тоже чистые — проверяются теми же тестами) ─────────────

// .env-подобный конфиг: KEY=VALUE, пробелы вокруг, «#комментарий» целиком,
// значения в двойных или одинарных кавычках. Секреты сюда — не в код.
export function parseEnvFile(text) {
  const config = {};
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.indexOf('#') === 0) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
         (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'"))) {
      value = value.slice(1, -1);
    }
    if (key) config[key] = value;
  }
  return config;
}

// Ключи состояния каза в localStorage. Третий ключ — «youplanner.qazaLog»:
// его ищет _tools/dump-localstorage.html (там опечатка, настоящего ключа
// 'youplanner.qaza.log' он не показывает) — принимаем оба, чтобы дамп
// владельца разбирался в любом случае.
const STATE_KEY_SLOTS = {
  'youplanner.qaza': 'qaza',
  'youplanner.qaza.log': 'qazaLog',
  'youplanner.qazaLog': 'qazaLog',
};

// Строка → объект, если это JSON; иначе строка как есть
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

// Текущее состояние для --target local. Понимает две формы:
//   1) JSON-объект с ключами localStorage;
//   2) текстовый дамп _tools/dump-localstorage.html («--- ключ ---» + тело).
// Разделы не-казы собираются в other без разбора — парсер не должен падать
// от сопутствующего текста диагностического дампа.
export function parseStateDump(text) {
  const result = { qaza: null, qazaLog: null, other: {} };
  const trimmed = String(text || '').trim();
  if (!trimmed) return result;

  // Форма 1: целиком JSON
  if (trimmed.charAt(0) === '{') {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        for (let i = 0; i < keys.length; i++) {
          const slot = STATE_KEY_SLOTS[keys[i]];
          if (slot) result[slot] = parseMaybeJson(parsed[keys[i]]);
          else result.other[keys[i]] = parsed[keys[i]];
        }
        return result;
      }
    } catch (e) { /* не JSON — пробуем текстовый дамп */ }
  }

  // Форма 2: текстовый дамп. split с захватом даёт пары [ключ, тело].
  const sections = String(text).split(/^---\s*(.+?)\s*---\s*$/m);
  for (let i = 1; i < sections.length; i += 2) {
    const key = sections[i].trim();
    const body = (sections[i + 1] || '').trim();
    const slot = STATE_KEY_SLOTS[key];
    if (slot) result[slot] = parseMaybeJson(body);
    else result.other[key] = body;
  }
  return result;
}

// Готовый сниппет для консоли браузера (--target local): пишет теми же
// ключами и той же JSON-формой, какими приложение пишет разделы (saveQaza),
// и двигает метку записи раздела qaza — без неё облачный конверт затёр бы
// локальную правку при следующей сверке (sectionEnvelopeWins, sync.js).
export function buildLocalSnippet(finalQaza, finalLog, writeTs) {
  const qazaJson = JSON.stringify(JSON.stringify(finalQaza));
  const lines = [
    '// Вставьте в консоль вкладки с открытым YouPlanner (F12 → Console), нажмите',
    '// Enter и перезагрузите страницу. Ключи и формы — те же, что у saveQaza.',
    '(function () {',
    "  var mark = JSON.parse(localStorage.getItem('" + SECTION_WRITE_TS_KEY + "') || '{}');",
    "  localStorage.setItem('youplanner.qaza', " + qazaJson + ');',
  ];
  if (finalLog) {
    const logJson = JSON.stringify(JSON.stringify(finalLog));
    lines.push("  localStorage.setItem('youplanner.qaza.log', " + logJson + ');');
  }
  lines.push('  mark.qaza = ' + String(writeTs) + ';');
  lines.push("  localStorage.setItem('" + SECTION_WRITE_TS_KEY + "', JSON.stringify(mark));");
  lines.push('  location.reload();');
  lines.push('})();');
  lines.push('');
  return lines.join('\n');
}
