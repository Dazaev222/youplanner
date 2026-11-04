/* Локальные напоминания Матрицы (ТЗ Воркера 2, пункт Б5).

   Граница честности, которую этот файл не имеет права забывать: уведомления
   доставляются ТОЛЬКО пока приложение открыто. Скрытая вкладка и сон ОС
   задерживают JS, закрытая PWA не получает ничего. Поэтому здесь нет ни
   Notification API, ни fetch, ни service-worker-обработчика push — и просить
   разрешение на системные уведомления не нужно.

   Модуль ничего не делает на import: ни таймеров, ни DOM, ни чтения
   localStorage. Контроллер создаётся фабрикой с ВНЕДРЯЕМЫМИ now/timers/hidden/
   load/display/storage — те же самые точки подменяет тест, а в рабочей сборке их
   передаёт js/app.js. Отсюда же отсутствие циклов: core → data/matrix-schedule
   (чистые функции), и никаких импортов экрана. */

import { reminderFingerprint, reminderMoment } from '../data/matrix-schedule.js';

export const MATRIX_REMINDER_LEDGER_KEY = 'youplanner.matrix.reminderLedger.v1';

// 30 секунд — чаще не смысл: при видимой странице этого хватает, чтобы «в 09:45»
// превратилось в показ в пределах полуминуты (Б5.3).
export const DEFAULT_CHECK_MS = 30000;
// Догон после возвращения: старше пяти минут считается пропуском, а не «опоздал,
// но всё равно разбуди» — иначе возврат из сна превращается в пачку всплывающих.
export const DEFAULT_GRACE_MS = 5 * 60000;
// Ledger — небольшой журнал: 30 суток и не больше 2000 записей (Б5.5).
export const LEDGER_MAX_ENTRIES = 2000;
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60000;
export const LEDGER_LOCK = 'youplanner.matrix.reminders';

const DEFAULT_ACTIONS = ['Открыть', 'Закрыть'];

function reminderIntIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function reminderRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function clockLabel(at) {
  return twoDigits(at.getHours()) + ':' + twoDigits(at.getMinutes());
}

// Момент правила + отпечаток самого правила: меняем смещение или anchor —
// получается другой ключ, и человек получит уведомление от нового правила (Б5.5).
function fingerprintOf(task, reminder, at) {
  return reminderFingerprint(task, reminder, at);
}

function readLedger(storage) {
  if (!storage || typeof storage.getItem !== 'function') return { version: 1, entries: {} };
  let raw = null;
  try {
    raw = storage.getItem(MATRIX_REMINDER_LEDGER_KEY);
  } catch (e) {
    return { version: 1, entries: {} };
  }
  if (!raw) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!reminderRecord(parsed) || !reminderRecord(parsed.entries)) return { version: 1, entries: {} };
    return { version: 1, entries: parsed.entries };
  } catch (e) {
    // Битый журнал не будит заново всем подряд и не роняет цикл: начинается заново
    return { version: 1, entries: {} };
  }
}

// Очистка старого (Б5.5): сначала по давности, затем по объёму — самые свежие
// остаются, переполненный журнал не должен вытеснять сегодняшний день.
function pruneLedger(ledger, nowMs) {
  const items = [];
  for (const key of Object.keys(ledger.entries || {})) {
    const entry = ledger.entries[key];
    if (!reminderRecord(entry)) continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    if (nowMs - at > LEDGER_RETENTION_MS) continue;
    items.push({ key, entry, at });
  }
  items.sort((a, b) => b.at - a.at);
  const kept = items.slice(0, LEDGER_MAX_ENTRIES);
  const entries = {};
  for (const item of kept) entries[item.key] = item.entry;
  return { version: 1, entries };
}

function writeLedger(storage, ledger) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(MATRIX_REMINDER_LEDGER_KEY, JSON.stringify(ledger));
    return true;
  } catch (e) {
    return false;
  }
}

/* Активные напоминания задачи. Просроченные, выполненные, архивные и
   «неизвестной версии» сюда не попадают: Б3.3 прямо запрещает исполнять
   защищённую запись в scheduler. */
export function reminderPlanFor(task) {
  if (!reminderRecord(task) || task.done === true || task.archived === true) return [];
  if (task.scheduleUnsupported === true) return [];
  const schedule = reminderRecord(task.schedule) ? task.schedule : null;
  if (!schedule || Number(schedule.version) !== 1) return [];
  if (!Array.isArray(schedule.reminders) || schedule.reminders.length === 0) return [];

  const plan = [];
  for (const reminder of schedule.reminders) {
    if (!reminderRecord(reminder) || typeof reminder.id !== 'string') continue;
    const resolved = reminderMoment(schedule, reminder);
    if (!resolved.ok) {
      plan.push({ reminder, skipped: resolved.code, at: null });
      continue;
    }
    plan.push({ reminder, at: resolved.at, skipped: null, code: resolved.code });
  }
  return plan;
}

export function createReminderController(options) {
  const opts = reminderRecord(options) ? options : {};

  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const isHidden = typeof opts.isHidden === 'function' ? opts.isHidden : () => false;
  const display = typeof opts.display === 'function' ? opts.display : () => {};
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {};
  const load = typeof opts.load === 'function' ? opts.load : () => [];
  const storage = opts.storage || null;
  const addListener = typeof opts.addListener === 'function' ? opts.addListener : null;
  const timers = reminderRecord(opts.timers) ? opts.timers : null;
  const lock = reminderRecord(opts.lock) && typeof opts.lock.request === 'function'
    ? opts.lock : null;

  const checkMs = reminderIntIn(opts.checkMs, 1000, 3600000) || DEFAULT_CHECK_MS;
  const graceMs = reminderIntIn(opts.graceMs, 0, 3600000);
  const grace = graceMs === null ? DEFAULT_GRACE_MS : graceMs;

  let started = false;
  let intervalId = null;
  let detach = [];
  let boundary = null;         // холодный старт: прошлое не догоняем (Б5.3)
  let session = new Set();     // память сессии — держит повтор, даже если ledger не записался
  let ledger = { version: 1, entries: {} };
  let ledgerLoaded = false;
  let warnedStorage = false;
  let counters = { shown: 0, missed: 0, skipped: 0, pending: 0 };

  function ensureLedger() {
    if (!ledgerLoaded) {
      ledger = pruneLedger(readLedger(storage), now().getTime());
      ledgerLoaded = true;
    }
  }

  function already(key) {
    return session.has(key) || Object.prototype.hasOwnProperty.call(ledger.entries, key);
  }

  function record(key, task, at, status) {
    session.add(key);
    ledger.entries[key] = { at: at.toISOString(), taskId: task && task.id ? task.id : null, status };
  }

  function entryFor(task, reminder, at, status) {
    return {
      taskId: task.id,
      title: task.title || '',
      reminderId: reminder.id,
      anchor: reminder.anchor,
      at,
      time: clockLabel(at),
      status: status || 'shown',
      text: 'Напоминание: ' + (task.title || 'задача') + ' · ' + clockLabel(at),
      actions: DEFAULT_ACTIONS.slice(),
    };
  }

  function collect() {
    const tasks = Array.isArray(load()) ? load() : [];
    const items = [];
    counters.skipped = 0;
    for (const task of tasks) {
      for (const planned of reminderPlanFor(task)) {
        if (!planned.at) {
          counters.skipped++;
          continue;
        }
        const key = fingerprintOf(task, planned.reminder, planned.at);
        if (already(key)) continue;
        items.push({ task, reminder: planned.reminder, at: planned.at, key });
      }
    }
    // Ранние сначала: «за 1 день» и «за 15 минут» не должны меняться местами
    items.sort((a, b) => a.at.getTime() - b.at.getTime());
    return items;
  }

  /* Один проход сверки. Реальный `now` спрашивается каждый раз: один
     многодневный setTimeout переполнился бы и уснул вместе с ОС (Б5.4), а
     часы могли повернуть и назад — повтор тогда отсекает ledger и память. */
  function pass() {
    ensureLedger();
    const current = now();
    const currentMs = current.getTime();
    const hidden = isHidden();
    const items = collect();
    let changed = false;

    counters.pending = items.filter(i => i.at.getTime() <= currentMs).length;

    for (const item of items) {
      const crossed = item.at.getTime() <= currentMs;
      if (!crossed) continue;

      // Граница старта: то, что прошло до открытия приложения, не догоняем.
      if (boundary !== null && item.at.getTime() <= boundary.getTime()) {
        record(item.key, item.task, item.at, 'missed');
        counters.missed++;
        changed = true;
        continue;
      }
      if (hidden) continue;                       // в фоне не показываем, но и не сжигаем

      const age = currentMs - item.at.getTime();
      if (age <= grace) {
        display(entryFor(item.task, item.reminder, item.at, 'shown'));
        counters.shown++;
        record(item.key, item.task, item.at, 'shown');
      } else {
        // Старый пропуск помечается, а не всплывает пачкой после сна
        counters.missed++;
        record(item.key, item.task, item.at, 'missed');
      }
      changed = true;
    }

    if (!changed) return;
    const pruned = pruneLedger(ledger, currentMs);
    const written = writeLedger(storage, pruned);
    ledger = pruned;
    if (!written && !warnedStorage) {
      // Одно ненавязчивое предупреждение на сессию: цикл ошибок каждые 30
      // секунд человек прочитал бы как сломанное приложение (Б5.6).
      warnedStorage = true;
      warn('Журнал напоминаний не сохранён: после перезагрузки возможен повтор одного и того же уведомления');
    }
  }

  function run() {
    if (!started) return;
    if (!lock) {
      pass();
      return;
    }
    // Межвкладочная сериализация: проверка и запись — внутри блокировки.
    // Без Web Locks путь best-effort, и мы этого не скрываем (state().locks).
    const result = lock.request(LEDGER_LOCK, () => { pass(); return undefined; });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }

  return {
    start() {
      if (started) return false;
      started = true;
      boundary = now();
      ensureLedger();
      if (timers && typeof timers.setInterval === 'function') {
        intervalId = timers.setInterval(() => run(), checkMs);
      }
      if (addListener) {
        const targets = [
          ['document', 'visibilitychange'],
          ['window', 'focus'],
          ['window', 'pageshow'],
        ];
        for (const [target, type] of targets) {
          // Один ответственный за все события путь: `run` сам учитывает
          // видимость и границу старта, поэтому слушатели не дублируют логику.
          const off = addListener(target, type, () => { if (started) run(); });
          if (typeof off === 'function') detach.push(off);
        }
      }
      run();
      return true;
    },

    refresh() {
      run();
      return started;
    },

    dispose() {
      if (!started) return false;
      started = false;
      if (intervalId !== null && timers && typeof timers.clearInterval === 'function') {
        timers.clearInterval(intervalId);
      }
      intervalId = null;
      for (const off of detach) {
        try { off(); } catch (e) { /* слушатель уже снят — не повод ронять выход */ }
      }
      detach = [];
      return true;
    },

    state() {
      return {
        started,
        shown: counters.shown,
        missed: counters.missed,
        skipped: counters.skipped,
        pending: counters.pending,
        ledger: Object.keys(ledger.entries).length,
        locks: lock ? 'web-locks' : (storage ? 'best-effort' : 'memory-only'),
      };
    },
  };
}
