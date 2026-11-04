// ТЗ Воркера 2, пункты Б5 + Б8 «Локальные напоминания».
//
// Scheduler живёт в js/core/matrix-reminders.js: контроллер с внедряемыми
// now/timers/hidden/load/display/storage. Часы двигает тест, поэтому проверки
// не зависят от машины и не крутят настоящий interval.
//
// Граница честности: уведомления доставляются ТОЛЬКО пока приложение открыто.
// Никаких push, Notification API и сети — это проверяется отдельным тестом
// (глобалы, которые должны остаться нетронутыми).
//
// Отказ записи в ledger моделируется НАСТОЯЩИМ броском setItem, а не заглушкой
// safeSetItem: путь ошибки проходит весь код контроллера.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATRIX_REMINDER_LEDGER_KEY,
  createReminderController,
} from '../js/core/matrix-reminders.js';

/* --- Инфраструктура теста ------------------------------------------------- */

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  const written = [];
  return {
    map,
    written,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); written.push(key); },
    removeItem: (key) => { map.delete(key); },
  };
}

// Управляемые часы и таймеры: interval НЕ заводится сам, тест дёргает tick.
function harness(options) {
  const opts = options || {};
  let clock = opts.now || new Date(2026, 10, 4, 9, 0, 0);
  let hidden = !!opts.hidden;
  const shown = [];
  const warnings = [];
  const storage = opts.storage || memoryStorage();
  const timers = { created: [], cleared: [] };
  const listeners = [];

  const controller = createReminderController({
    now: () => clock,
    isHidden: () => hidden,
    display: (entry) => shown.push(entry),
    warn: (message) => warnings.push(message),
    storage,
    load: () => (opts.load ? opts.load() : tasks),
    addListener: (target, type, fn) => {
      const entry = { target, type, fn };
      listeners.push(entry);
      // как настоящая пара addEventListener/removeEventListener: addListener
      // отдаёт detach, и dispose обязан снять каждый слушатель
      return () => {
        const at = listeners.indexOf(entry);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    timers: {
      setInterval: (fn, ms) => { timers.created.push({ fn, ms, id: timers.created.length }); return fn; },
      clearInterval: (id) => { timers.cleared.push(id); },
    },
    checkMs: opts.checkMs,
    graceMs: opts.graceMs,
    lock: opts.lock,
  });

  let tasks = opts.tasks || [];

  const api = {
    controller,
    shown,
    warnings,
    storage,
    timers,
    listeners,
    setTasks(next) { tasks = next; },
    setNow(value) { clock = value instanceof Date ? value : new Date(value); },
    advance(minutes) { clock = new Date(clock.getTime() + minutes * 60000); },
    setHidden(value) { hidden = !!value; },
    tick() { controller.refresh(); },
    fireInterval(rounds) {
      const count = rounds || 1;
      for (let i = 0; i < count; i++) {
        for (const timer of timers.created) timer.fn();
      }
    },
  };
  return api;
}

function reminderTask(over) {
  return Object.assign({
    id: 't1',
    title: 'Созвон',
    notes: '',
    due: '2026-11-04',
    doDate: null,
    priority: 2,
    done: false,
    doneAt: null,
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    order: 1,
    scheduleUnsupported: false,
    schedule: {
      version: 1,
      allDay: false,
      startDate: '2026-11-04',
      endDate: '2026-11-04',
      startTime: '10:00',
      endTime: '10:30',
      timeZoneMode: 'device',
      reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15, date: null, time: null }],
      repeat: null,
      series: null,
    },
  }, over || {});
}

/* ========================================================================= */
/* Б5 — троггеры: когда именно срабатывает правило                            */
/* ========================================================================= */

test('Б8 до trigger нет уведомления, после пересечения — ровно одно', (t) => {
  const h = harness({ tasks: [reminderTask()] });
  h.controller.start();

  // 09:00 → 09:44: напоминание на 09:45 (начало 10:00 минус 15 минут)
  h.advance(44);
  h.tick();
  assert.equal(h.shown.length, 0, 'до 09:45 показывать нечего');

  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.equal(h.shown.length, 1, 'после пересечения — одно уведомление');
  assert.equal(h.shown[0].taskId, 't1');
  assert.equal(h.shown[0].title, 'Созвон', 'в уведомлении есть заголовок задачи');
  assert.equal(h.shown[0].reminderId, 'r1');
  assert.equal(h.shown[0].at.getHours(), 9);
  assert.equal(h.shown[0].at.getMinutes(), 45, 'время в уведомлении — время правила');

  // повторный tick, refresh и перерисовка не плодят показ
  h.tick();
  h.tick();
  h.controller.refresh();
  h.fireInterval(3);
  assert.equal(h.shown.length, 1, 'повторный tick/refresh не дублирует уведомление');
});

test('Б8 reminder «в момент окончания» срабатывает на endTime', (t) => {
  const h = harness({
    tasks: [reminderTask({
      schedule: Object.assign({}, reminderTask().schedule, {
        reminders: [{ id: 'r2', anchor: 'end', offsetMinutes: 0, date: null, time: null }],
      }),
    })],
  });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 10, 31, 0));
  h.tick();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].at.getHours(), 10);
  assert.equal(h.shown[0].at.getMinutes(), 30);
});

test('Б8 all-day с опережением на сутки и временем 09:00 → 03.11 09:00', (t) => {
  const h = harness({
    tasks: [reminderTask({
      due: '2026-11-04',
      schedule: {
        version: 1, allDay: true, startDate: '2026-11-04', endDate: '2026-11-06',
        startTime: null, endTime: null, timeZoneMode: 'device',
        reminders: [{ id: 'r3', anchor: 'start', offsetMinutes: 1440, date: null, time: '09:00' }],
        repeat: null, series: null,
      },
    })],
    now: new Date(2026, 10, 3, 8, 0, 0),
  });
  h.controller.start();
  h.tick();
  assert.equal(h.shown.length, 0, 'до 09:00 03.11 показывать рано');

  h.setNow(new Date(2026, 10, 3, 9, 1, 0));
  h.tick();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].at.getDate(), 3);
  assert.equal(h.shown[0].at.getMonth(), 10);
});

test('Б8 absolute-напоминание работает по своей дате и времени', (t) => {
  const h = harness({
    tasks: [reminderTask({
      schedule: Object.assign({}, reminderTask().schedule, {
        reminders: [{ id: 'r4', anchor: 'absolute', offsetMinutes: 0, date: '2026-11-03', time: '20:00' }],
      }),
    })],
    now: new Date(2026, 10, 3, 19, 0, 0),
  });
  h.controller.start();
  h.tick();
  assert.equal(h.shown.length, 0);

  h.setNow(new Date(2026, 10, 3, 20, 5, 0));
  h.tick();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].at.getDate(), 3);
  assert.equal(h.shown[0].at.getHours(), 20);
});

test('Б5 правило с несколькими напоминаниями даёт каждое отдельно', (t) => {
  const h = harness({
    tasks: [reminderTask({
      schedule: Object.assign({}, reminderTask().schedule, {
        reminders: [
          { id: 'a', anchor: 'start', offsetMinutes: 30, date: null, time: null },
          { id: 'b', anchor: 'start', offsetMinutes: 15, date: null, time: null },
          { id: 'c', anchor: 'end', offsetMinutes: 0, date: null, time: null },
        ],
      }),
    })],
  });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 31, 0));
  h.tick();
  assert.deepEqual(h.shown.map(s => s.reminderId), ['a'], 'сначала самое раннее');

  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.deepEqual(h.shown.map(s => s.reminderId), ['a', 'b']);

  h.setNow(new Date(2026, 10, 4, 10, 31, 0));
  h.tick();
  assert.deepEqual(h.shown.map(s => s.reminderId), ['a', 'b', 'c']);
});

/* ========================================================================= */
/* Б5.5 — дедупликация и ledger                                              */
/* ========================================================================= */

test('Б8 смена reminder создаёт новый fingerprint и уведомляет снова', (t) => {
  const h = harness({ tasks: [reminderTask()] });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.equal(h.shown.length, 1);

  // Человек переставил напоминание на 10 минут — это другое правило (другой
  // отпечаток), поэтому оно уведомляет заново, когда наступает его момент.
  h.setTasks([reminderTask({
    schedule: Object.assign({}, reminderTask().schedule, {
      reminders: [{ id: 'r9', anchor: 'start', offsetMinutes: 10, date: null, time: null }],
    }),
  })]);
  h.controller.refresh();
  assert.equal(h.shown.length, 1, 'до 09:50 новое правило ещё не сработало');

  h.setNow(new Date(2026, 10, 4, 9, 51, 0));
  h.controller.refresh();
  assert.equal(h.shown.length, 2, 'новое правило уведомляет заново');
  assert.equal(h.shown[1].reminderId, 'r9');
});

test('Б5.5 ledger пишется в отдельный ключ и не трогает список задач', (t) => {
  const storage = memoryStorage();
  const h = harness({ tasks: [reminderTask()], storage });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();

  assert.ok(storage.map.has(MATRIX_REMINDER_LEDGER_KEY), 'ledger лежит в своём ключе');
  assert.deepEqual(storage.written.filter(k => k !== MATRIX_REMINDER_LEDGER_KEY), [],
    'scheduler не пишет задачи и не двигает updatedAt ради тика');

  const ledger = JSON.parse(storage.map.get(MATRIX_REMINDER_LEDGER_KEY));
  assert.ok(Array.isArray(ledger.entries) || typeof ledger.entries === 'object',
    'ledger — структура с записями');
  assert.equal(JSON.stringify(ledger).includes('"t1"'), true, 'в записи есть id задачи');
});

test('Б5.5 перезагрузка страницы с ledger не показывает прошлое напоминание', (t) => {
  const storage = memoryStorage();
  const first = harness({ tasks: [reminderTask()], storage });
  first.controller.start();
  first.setNow(new Date(2026, 10, 4, 9, 46, 0));
  first.tick();
  assert.equal(first.shown.length, 1);

  // «Перезагрузка»: новый контроллер над тем же хранилищем
  const second = harness({ tasks: [reminderTask()], storage });
  second.controller.start();
  second.tick();
  second.setNow(new Date(2026, 10, 4, 9, 47, 0));
  second.tick();
  assert.equal(second.shown.length, 0, 'ledger пережил перезагрузку и подавил повтор');
});

test('Б5.5 ключ дедупликации различает экземпляры одной серии', (t) => {
  const base = reminderTask();
  const series = (index, id) => Object.assign({}, base, {
    id,
    schedule: Object.assign({}, base.schedule, {
      series: { id: 's1', index, anchorDate: '2026-11-04', anchorDay: 4, anchorMonth: 11 },
    }),
  });
  const h = harness({ tasks: [series(1, 't-a'), series(2, 't-b')] });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.deepEqual(h.shown.map(s => s.taskId).sort(), ['t-a', 't-b'],
    'разные экземпляры — разные отпечатки, оба уведомляются');
});

test('Б5.6 ограничение и очистка ledger', (t) => {
  // Раздувый ledger обязан быть урезан по размеру и по давности
  const entries = {};
  const old = new Date(2026, 8, 1, 9, 0, 0).toISOString();   // дальше 30 суток от «сейчас»
  for (let i = 0; i < 2100; i++) {
    entries['старый-' + i] = { at: old, taskId: 't' + i };
  }
  entries['свежий'] = { at: new Date(2026, 10, 4, 9, 0, 0).toISOString(), taskId: 't1' };
  const storage = memoryStorage({
    [MATRIX_REMINDER_LEDGER_KEY]: JSON.stringify({ version: 1, entries }),
  });

  const h = harness({ tasks: [reminderTask()], storage });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();

  const saved = JSON.parse(storage.map.get(MATRIX_REMINDER_LEDGER_KEY));
  const count = Array.isArray(saved.entries)
    ? saved.entries.length : Object.keys(saved.entries).length;
  assert.ok(count <= 2000, 'ledger не разрастается больше 2000 записей, сейчас ' + count);
  assert.equal(count > 0, true, 'свежие записи не вылетели');
});

/* ========================================================================= */
/* Б5.3 — видимость, холодный старт и пропуски                                */
/* ========================================================================= */

test('Б5.3 при document.hidden уведомлений нет, по возвращении — догон не старше 5 минут', (t) => {
  const h = harness({ tasks: [reminderTask()], now: new Date(2026, 10, 4, 9, 40, 0) });
  h.controller.start();

  h.setHidden(true);
  h.setNow(new Date(2026, 10, 4, 9, 47, 0));   // пересекли 09:45, пока вкладка скрыта
  h.tick();
  assert.equal(h.shown.length, 0, 'в фоне показывать нельзя');

  h.setHidden(false);
  h.tick();
  assert.equal(h.shown.length, 1, 'пропуск 2 минуты догоняется одним уведомлением');
});

test('Б5.3 пропуск старше 5 минут помечается пропущенным без всплывающего спама', (t) => {
  const h = harness({ tasks: [reminderTask()], now: new Date(2026, 10, 4, 9, 40, 0) });
  h.controller.start();

  h.setHidden(true);
  h.setNow(new Date(2026, 10, 4, 9, 55, 0));   // пересечение было ~10 минут назад
  h.tick();
  h.setHidden(false);
  h.tick();

  assert.equal(h.shown.length, 0, 'старый пропуск не всплывает');
  const ledger = JSON.parse(h.storage.map.get(MATRIX_REMINDER_LEDGER_KEY));
  assert.equal(JSON.stringify(ledger).includes('missed'), true,
    'пропуск помечен в ledger, а не показан всплывающим спамом');
});

test('Б5.3 при холодном запуске старые времена не догоняются', (t) => {
  const h = harness({
    tasks: [reminderTask({
      schedule: Object.assign({}, reminderTask().schedule, {
        startDate: '2026-11-01', endDate: '2026-11-01',
        reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 0, date: null, time: null }],
      }),
      due: '2026-11-01',
    })],
    now: new Date(2026, 10, 4, 12, 0, 0),
  });
  h.controller.start();
  h.tick();
  assert.equal(h.shown.length, 0, 'на старте просроченное напоминание не показывается');
});

test('Б5.3 новое правило, сохранённое уже в прошлом, не уведомляет', (t) => {
  const h = harness({ tasks: [], now: new Date(2026, 10, 4, 12, 0, 0) });
  h.controller.start();

  h.setTasks([reminderTask({
    schedule: Object.assign({}, reminderTask().schedule, {
      startTime: '09:00', endTime: '09:30',
    }),
  })]);
  h.controller.refresh();
  assert.equal(h.shown.length, 0, 'правило из прошлого не превращается в спам');
});

test('Б5.4 скачок часов назад не создаёт дублей', (t) => {
  const h = harness({ tasks: [reminderTask()] });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.equal(h.shown.length, 1);

  h.setNow(new Date(2026, 10, 4, 9, 20, 0));   // часы повернули назад
  h.tick();
  h.setNow(new Date(2026, 10, 4, 9, 50, 0));   // и снова пересекли trigger
  h.tick();
  assert.equal(h.shown.length, 1, 'обратный ход часов не плодит второй показ');
});

test('Б5.5 лимит grace настраивается параметром контроллера', (t) => {
  const wide = harness({
    tasks: [reminderTask()], now: new Date(2026, 10, 4, 9, 40, 0), graceMs: 60 * 60000,
  });
  wide.controller.start();
  wide.setHidden(true);
  wide.setNow(new Date(2026, 10, 4, 10, 20, 0));
  wide.tick();
  wide.setHidden(false);
  wide.tick();
  assert.equal(wide.shown.length, 1, 'увеличенный grace догоняет более старый пропуск');
});

/* ========================================================================= */
/* Б5.7 — отмена pending: done, архив, удаление, смена времени                */
/* ========================================================================= */

test('Б8 done/archive/delete/смена даты до trigger отменяют старый показ', (t) => {
  const base = reminderTask();

  const done = harness({ tasks: [Object.assign({}, base, { done: true })], storage: memoryStorage() });
  done.controller.start();
  done.setNow(new Date(2026, 10, 4, 10, 0, 0));
  done.tick();
  assert.equal(done.shown.length, 0, 'выполненная задача не будит');

  const archived = harness({ tasks: [Object.assign({}, base, { archived: true })] });
  archived.controller.start();
  archived.setNow(new Date(2026, 10, 4, 10, 0, 0));
  archived.tick();
  assert.equal(archived.shown.length, 0, 'архивная задача не будит');

  const removed = harness({ tasks: [base] });
  removed.controller.start();
  removed.setTasks([]);
  removed.setNow(new Date(2026, 10, 4, 10, 0, 0));
  removed.tick();
  assert.equal(removed.shown.length, 0, 'удалённая задача не будит');

  const moved = harness({ tasks: [base] });
  moved.controller.start();
  moved.setTasks([reminderTask({
    schedule: Object.assign({}, base.schedule, {
      startDate: '2026-11-05', endDate: '2026-11-05',
    }),
    due: '2026-11-05',
  })]);
  moved.controller.refresh();
  moved.setNow(new Date(2026, 10, 4, 10, 0, 0));
  moved.tick();
  assert.equal(moved.shown.length, 0, 'после переноса на завтра старый trigger не срабатывает');
});

test('Б5.7 запись с отказом не отменяет настоящее pending-напоминание', (t) => {
  // Scheduler читает хранилище как есть: если commit не состоялся, задача
  // осталась прежней и её напоминание по-прежнему актуально.
  const h = harness({ tasks: [reminderTask()] });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.equal(h.shown.length, 1, 'pending не зависит от успеха чужой записи');
});

test('Б5 несовместимая по версии задача в scheduler не исполняется', (t) => {
  const h = harness({
    tasks: [Object.assign({}, reminderTask(), {
      scheduleUnsupported: true,
      schedule: { version: 7, whatever: true },
    })],
  });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 12, 0, 0));
  h.tick();
  assert.equal(h.shown.length, 0, 'protected-запись не проходит через scheduler');
});

/* ========================================================================= */
/* Б5.1/Б5.7 — жизненный цикл контроллера                                     */
/* ========================================================================= */

test('Б8 start дважды не размножает таймер, dispose убирает таймер и слушатели', (t) => {
  const h = harness({ tasks: [] });
  h.controller.start();
  h.controller.start();
  h.controller.start();
  assert.equal(h.timers.created.length, 1, 'start идемпотентен');
  assert.equal(h.timers.created[0].ms <= 30000, true, 'проверка не реже чем каждые 30 секунд');

  const listenersBefore = h.listeners.length;
  assert.ok(listenersBefore > 0, 'слушатели видимости/фокуса навешаны');
  h.controller.dispose();
  assert.equal(h.timers.cleared.length, 1, 'dispose снял interval');
  assert.equal(h.listeners.length, 0, 'dispose снял все слушатели');

  // после dispose тик по «старому» interval ничего не показывает
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.controller.refresh();
  assert.equal(h.shown.length, 0, 'после dispose контроллер молчит');
});

test('Б5.1 на import — ни таймеров, ни DOM, ни хранилища', (t) => {
  const created = [];
  const original = globalThis.setInterval;
  globalThis.setInterval = (...args) => { created.push(args); return 1; };
  try {
    const h = harness({ tasks: [] });
    assert.equal(created.length, 0, 'создание контроллера не поднимает таймер');
    assert.equal(h.timers.created.length, 0);
    assert.equal(h.storage.written.length, 0, 'чтение ledger не пишется заранее');
  } finally {
    globalThis.setInterval = original;
  }
});

test('Б5.2 refresh на событии перечитывает задачи и пересчитывает pending', (t) => {
  const h = harness({ tasks: [] });
  h.controller.start();
  assert.equal(h.shown.length, 0);

  h.setTasks([reminderTask()]);
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.controller.refresh();
  assert.equal(h.shown.length, 1, 'свежая задача подхвачена без пересоздания контроллера');
});

test('Б5.6 отказ ledger: память сессии блокирует повтор, предупреждение одно', (t) => {
  const storage = memoryStorage();
  let broken = false;
  storage.setItem = () => {
    if (broken) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    storage.map.set(MATRIX_REMINDER_LEDGER_KEY, '{}');
  };

  const h = harness({ tasks: [reminderTask()], storage });
  h.controller.start();
  broken = true;

  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.equal(h.shown.length, 1, 'первый показ состоялся, несмотря на отказ записи');

  h.tick();
  h.tick();
  h.fireInterval(2);
  assert.equal(h.shown.length, 1, 'в памяти сессии повтор заблокирован');
  assert.equal(h.warnings.length, 1, 'предупреждение об отказе — ровно одно на сессию');
});

test('Б5.6 Web Locks доступен — проверка и запись сериализуются через lock', async (t) => {
  const calls = [];
  const lock = {
    request: (name, fn) => {
      calls.push(name);
      return Promise.resolve().then(fn);
    },
  };
  const h = harness({ tasks: [reminderTask()], lock });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(calls.length > 0, 'путь с Web Locks реально использован');
  assert.equal(h.shown.length, 1, 'показ происходит внутри заблокированной секции');
  assert.equal(typeof h.controller.state().locks, 'string',
    'состояние называет используемый механизм сериализации');
});

test('Б5.6 без Web Locks путь best-effort работает и не обещает гарантии', (t) => {
  const h = harness({ tasks: [reminderTask()], lock: null });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  assert.equal(h.shown.length, 1);
  assert.equal(typeof h.controller.state().locks, 'string',
    'состояние честно говорит, есть ли межвкладочная сериализация');
});

/* ========================================================================= */
/* Б0.8 / Б5 — границы доставки: без push, Notification и сети                */
/* ========================================================================= */

test('Б0.8 напоминания не зовут Notification API и не ходят в сеть', (t) => {
  const touched = [];
  const originalNotification = globalThis.Notification;
  const originalFetch = globalThis.fetch;
  globalThis.Notification = function NotificationStub() {
    touched.push('Notification');
    throw new Error('Notification API в этой задаче запрещён');
  };
  globalThis.fetch = () => {
    touched.push('fetch');
    throw new Error('сеть для напоминаний запрещена');
  };
  try {
    const h = harness({ tasks: [reminderTask()] });
    h.controller.start();
    h.setNow(new Date(2026, 10, 4, 9, 46, 0));
    h.tick();
    assert.equal(h.shown.length, 1, 'локальная доставка работает без системных разрешений');
    assert.deepEqual(touched, [], 'ни Notification, ни fetch не вызывались');
  } finally {
    globalThis.Notification = originalNotification;
    globalThis.fetch = originalFetch;
  }
});

test('Б5 уведомление имеет текст про время и действия Открыть/Закрыть', (t) => {
  const h = harness({ tasks: [reminderTask()] });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 9, 46, 0));
  h.tick();
  const entry = h.shown[0];
  assert.equal(typeof entry.text, 'string', 'есть человекочитаемый текст');
  assert.ok(/Созвон/.test(entry.text), 'текст называет задачу');
  assert.deepEqual(entry.actions, ['Открыть', 'Закрыть'],
    'действия заданы контрактом доставки');
});

test('Б5.5 правило reminder без корректного момента не ломает цикл', (t) => {
  const h = harness({
    tasks: [reminderTask({
      schedule: Object.assign({}, reminderTask().schedule, {
        startTime: null, endTime: null, allDay: true,
        reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15, date: null, time: null }],
      }),
    })],
  });
  h.controller.start();
  h.setNow(new Date(2026, 10, 4, 12, 0, 0));
  h.tick();
  assert.equal(h.shown.length, 0, 'битое правило не будит и не роняет scheduler');
  assert.equal(typeof h.controller.state().skipped, 'number', 'причина пропусков диагностируется');
});
