// Юнит-тесты прогресса привычек (js/data/records.js: calcProgress) и
// кэша прогресса.
//
// calcProgress — самая горячая функция рендера: карточка за «Все время»
// зовёт её ~1500 раз (график, сетка, серии по одному дню), поэтому она
// мемоизирована. Кэш не имеет права менять семантику: сначала базовая
// математика, потом только реакция на сдвиги данных (версия записей)
// и смену периода.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Привычка для теста: calcProgress читает из habit ровно id, type и goal
function habit(id, type, goal) {
  return { id: id, name: 'Тест', unit: '', type: type, goal: goal };
}

// Сев записей напрямую в хранилище, минуя loadRecords: формат тот же,
// что читает loadRecords — { 'YYYY-MM-DD': { habitId: значение } }
function seedRecords(sandbox, records) {
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
}

// Непрерывный диапазон ISO-дат, как его отдают statsPeriodDates и
// getMonthDatesToToday: от младшего дня к старшему
function monthDates() {
  const dates = [];
  for (let d = 1; d <= 30; d++) {
    dates.push('2026-05-' + (d < 10 ? '0' + d : String(d)));
  }
  return dates;
}

// Короткий диапазон из первых n дней мая
function mayDates(n) {
  return monthDates().slice(0, n);
}

const recordsCases = [
  {
    name: 'calcProgress: база обрезается возрастом привычки — пустые дни ведения разбавляют',
    run: (context, sandbox) => {
      // Дни ДО начала ведения (привычка заведена 3-го числа) из знаменателя
      // выпадают: вести привычку пользователь ещё не мог. База — восемь дней
      // (2/8 = 25%), а не все десять (было бы 2/10 = 20%)
      seedRecords(sandbox, {
        '2026-05-03': { h1: true },
        '2026-05-04': { h1: true },
        '2026-05-05': { h1: false },
      });
      const h = habit('h1', 'boolean', null);
      assert.equal(context.calcProgress(h, mayDates(10)), 25);

      // А пустые дни ПОСЛЕ начала ведения — разбавляют: это и есть честный
      // пропуск. Отметки 3-го и 10-го числа при ведении с 3-го дают 2/8, а не
      // 2/2 = 100% («половина записанных дней»)
      context.invalidateRecordsCache();
      seedRecords(sandbox, {
        '2026-05-03': { h1: true },
        '2026-05-10': { h1: true },
      });
      context.invalidateRecordsCache();
      assert.equal(context.calcProgress(h, mayDates(10)), 25);

      // Отметки в конце периода: граница — 9-е число, база два дня (1/2 = 50%)
      context.invalidateRecordsCache();
      seedRecords(sandbox, {
        '2026-05-09': { h1: true },
        '2026-05-10': { h1: false },
      });
      context.invalidateRecordsCache();
      assert.equal(context.calcProgress(h, mayDates(10)), 50);
    },
  },
  {
    name: 'проценты: неделя и месяц разные, когда начало месяца пропущено',
    run: (context, sandbox) => {
      // Механика бага: неделя ⊂ месяц, оба окна заканчиваются сегодня. Привычка
      // ведётся с апреля, а первые дни мая пропущены. Старая обрезка «до
      // первой записи ВНУТРИ окна» усекала месяц ровно до понедельника —
      // знаменатель, сумма и процент совпадали с недельными побитово.
      seedRecords(sandbox, {
        '2026-04-20': { h1: true },   // начало ведения — до обоих окон
        '2026-05-18': { h1: true },   // понедельник недели
        '2026-05-19': { h1: true },
        '2026-05-20': { h1: false },  // пропуск уже внутри недели
        '2026-05-21': { h1: true },
        '2026-05-22': { h1: true },
      });
      const h = habit('h1', 'boolean', null);
      const week = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22'];
      const month = [];
      for (let d = 1; d <= 22; d++) month.push('2026-05-' + (d < 10 ? '0' + d : String(d)));

      // Неделя: 4 отметки из пяти дней. Месяц: те же 4 отметки, но база — все
      // 22 дня месяца, пустое начало считается пропуском, а не обрезается
      assert.equal(context.calcProgress(h, week), 80);
      assert.equal(context.calcProgress(h, month), 4 / 22 * 100);
      assert.notEqual(context.calcProgress(h, week), context.calcProgress(h, month),
        'неделя и месяц схлопнулись в один процент');
    },
  },
  {
    name: 'проценты: неделя и месяц равны, когда привычка начата в этом же окне',
    run: (context, sandbox) => {
      // Легитимное совпадение, его надо закрепить, чтобы не «починить» обратно:
      // привычка реально заведена в понедельник недели. Граница ведения — та же
      // дата и для недели, и для месяца, поэтому оба окна дают одну базу (5
      // дней) и один процент. Разница с прежним поведением — не в обрезке, а в
      // том, что граница теперь глобальная: стоителям «сегодня созданной»
      // привычки месяц и неделя честно равны
      seedRecords(sandbox, {
        '2026-05-18': { h1: true },
        '2026-05-19': { h1: true },
        '2026-05-20': { h1: false },
        '2026-05-21': { h1: true },
        '2026-05-22': { h1: true },
      });
      const h = habit('h1', 'boolean', null);
      const week = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22'];
      const month = [];
      for (let d = 1; d <= 22; d++) month.push('2026-05-' + (d < 10 ? '0' + d : String(d)));

      assert.equal(context.calcProgress(h, week), 80);
      assert.equal(context.calcProgress(h, month), 80);
    },
  },
  {
    name: 'проценты: number с goal, choice с весами и одиночный день у новой границы',
    run: (context, sandbox) => {
      seedRecords(sandbox, {
        // h10 заведена 2 мая, h7 — 3 мая: дни раньше начала не в базе
        '2026-05-02': { h10: 2 },
        '2026-05-03': { h7: 'да' },
        '2026-05-04': { h7: 'частично' },
        '2026-05-05': { h10: 4, h7: 'отдых' },
      });
      context.invalidateRecordsCache();

      // number: сумма 6 за 5 дней базы (05-02..05-06) = средний день 1.2 при
      // цели 2 → 60%. Пустые 05-06 разбавляют, 05-01 — нет
      const num = habit('h10', 'number', 2);
      assert.equal(context.calcProgress(num, mayDates(6)), 60);

      // choice: веса «да» 1 + «частично» 0.5 + «отдых» 0 при базе 4 (с 05-03)
      // → 37.5%, как и раньше, но база задана началом ведения, а не окном
      const choice = habit('h7', 'choice', null);
      assert.equal(context.calcProgress(choice, mayDates(6)), 37.5);

      // Одиночный день раньше начала ведения — 0, а не деление на пустоту;
      // одиночный день внутри ведения — честные 100/0
      assert.equal(context.calcProgress(num, ['2026-05-01']), 0);
      assert.equal(context.calcProgress(num, ['2026-05-02']), 100);
      assert.equal(context.calcProgress(choice, ['2026-05-04']), 50);
      // Привычка без единой записи — 0 мимо всякой границы
      assert.equal(context.calcProgress(habit('h99', 'boolean', null), mayDates(6)), 0);
    },
  },
  {
    name: 'проценты: «Все время» (365 дней) считает по полной базе',
    run: (context, sandbox) => {
      // stats.js подменяет «all» окном из STATS_ALL_DAYS дней; проверка, что
      // новая граница не съедает длинное окно и не схлопывает его в месяц
      const today = new Date(2026, 4, 31);
      const all = context.statsPeriodDates('all', today);
      const month = context.statsPeriodDates('month', today);
      assert.equal(all.length, 365, 'окно «Все время» — подмена на 365 дней');
      assert.equal(month.length, 31);

      seedRecords(sandbox, {
        [all[0]]: { h1: true },     // самый край 365-дневного окна: база полная
        '2026-05-31': { h1: true },
      });
      context.invalidateRecordsCache();
      const h = habit('h1', 'boolean', null);
      assert.equal(context.calcProgress(h, all), 2 / 365 * 100);
      // Месяц той же привычки не схлопывается к «одной отметке из одного дня»:
      // база — все 31 день мая, отметка одна
      assert.equal(context.calcProgress(h, month), 1 / 31 * 100);
    },
  },
  {
    name: 'граница ведения: удаление самой ранней записи сдвигает базу',
    run: (context, sandbox) => {
      // Снимок первых записей мемоизирован по версии данных: удалить первую
      // запись и получить прежний процент кэш не имеет права
      seedRecords(sandbox, {
        '2026-04-20': { h1: true },
        '2026-05-18': { h1: true },
      });
      const h = habit('h1', 'boolean', null);
      const month = [];
      for (let d = 1; d <= 22; d++) month.push('2026-05-' + (d < 10 ? '0' + d : String(d)));
      assert.equal(context.calcProgress(h, month), 1 / 22 * 100);

      assert.equal(context.setRecord('2026-04-20', 'h1', undefined), true);
      // April-записи больше нет: начало ведения — 18 мая, база — пять дней
      assert.equal(context.calcProgress(h, month), 20);
    },
  },
  {
    name: 'calcProgress: веса choice — да 1, частично 0.5, нет и отдых 0',
    run: (context, sandbox) => {
      seedRecords(sandbox, {
        '2026-05-01': { h7: 'да' },
        '2026-05-02': { h7: 'частично' },
        '2026-05-03': { h7: 'нет' },
        '2026-05-04': { h7: 'отдых' },
      });
      const h = habit('h7', 'choice', null);
      // (1 + 0.5 + 0 + 0) / 4 * 100
      assert.equal(context.calcProgress(h, mayDates(4)), 37.5);
    },
  },
  {
    name: 'calcProgress: number с goal 2 и без goal, пустой период — 0',
    run: (context, sandbox) => {
      seedRecords(sandbox, {
        '2026-05-01': { h10: 1 },
        '2026-05-02': { h10: 3 },
      });
      const h = habit('h10', 'number', 2);
      // Сумма 4 при базе 2 — средний день 2 — это ровно цель: 100%
      assert.equal(context.calcProgress(h, mayDates(2)), 100);

      // Без цели прогресс не определён — 0, а не деление на undefined
      assert.equal(context.calcProgress(habit('h10', 'number', undefined), mayDates(2)), 0);
      assert.equal(context.calcProgress(habit('h10', 'number', 0), mayDates(2)), 0);

      // Пустой и отсутствующий период — 0 без падений
      assert.equal(context.calcProgress(h, []), 0);
      assert.equal(context.calcProgress(h, null), 0);
    },
  },
  {
    name: 'calcProgress: результат больше 100, когда цель перекрыта',
    run: (context, sandbox) => {
      seedRecords(sandbox, { '2026-05-01': { h10: 3 } });
      const h = habit('h10', 'number', 1);
      // (3/1)/1*100 — прогресс не зажимается сотней
      assert.equal(context.calcProgress(h, ['2026-05-01']), 300);
    },
  },
  {
    name: 'кэш: повторный вызов стабилен, setRecord сдвигает версию и пересчитывает',
    run: (context, sandbox) => {
      seedRecords(sandbox, { '2026-05-01': { h1: true } });
      const h = habit('h1', 'boolean', null);
      const dates = ['2026-05-01', '2026-05-02'];
      assert.equal(context.calcProgress(h, dates), 50);
      // Второй вызов — попадание в кэш, значение то же
      assert.equal(context.calcProgress(h, dates), 50);

      // Запись того же периода: версия данных сменилась, процент обязан
      // отрасти — иначе кэш отдал бы устаревшее
      assert.equal(context.setRecord('2026-05-02', 'h1', true), true);
      assert.equal(context.calcProgress(h, dates), 100);

      // Удаление записи — тоже мутация: кэш снова пересчитан
      assert.equal(context.setRecord('2026-05-02', 'h1', undefined), true);
      assert.equal(context.calcProgress(h, dates), 50);
    },
  },
  {
    name: 'кэш: смена goal при том же id даёт независимые значения',
    run: (context, sandbox) => {
      seedRecords(sandbox, {
        '2026-05-01': { h10: 2 },
        '2026-05-02': { h10: 2 },
      });
      const dates = mayDates(2);
      const goal2 = habit('h10', 'number', 2);
      const goal4 = habit('h10', 'number', 4);
      assert.equal(context.calcProgress(goal2, dates), 100);
      // Тот же id и тот же период, другая цель — пересчитано, а не взято
      // из кэша по id
      assert.equal(context.calcProgress(goal4, dates), 50);
      // Оба ключа живут одновременно и не подменяют друг друга
      assert.equal(context.calcProgress(goal2, dates), 100);
    },
  },
  {
    name: 'кэш: длинный период и одиночный день — независимые значения',
    run: (context, sandbox) => {
      // Знаменатель — от первой записи до КОНЦА периода: при записях
      // 05-01 и 05-02 четырёхдневный период даёт 1/4 = 25%, а не 50%
      // («половина записанных дней»). Короткий период — чтобы числа были
      // целыми: у настоящего мая было бы 1/30
      seedRecords(sandbox, {
        '2026-05-01': { h1: true },
        '2026-05-02': { h1: false },
      });
      const h = habit('h1', 'boolean', null);
      const period = mayDates(4);
      assert.equal(context.calcProgress(h, period), 25);
      // habitMarked ходит однодневными массивами: первый день периода —
      // 100%, не 25 из кэша длинного периода
      assert.equal(context.calcProgress(h, ['2026-05-01']), 100);
      assert.equal(context.calcProgress(h, ['2026-05-02']), 0);
      // Длинный период не перезаписался однодневными вызовами
      assert.equal(context.calcProgress(h, period), 25);
    },
  },
  {
    name: 'кэш: invalidateRecordsCache сбрасывает прогресс после прямой записи в хранилище',
    run: (context, sandbox) => {
      seedRecords(sandbox, { '2026-05-01': { h1: true } });
      const h = habit('h1', 'boolean', null);
      assert.equal(context.calcProgress(h, ['2026-05-01']), 100);

      // Так делают applyBackup, sync и событие storage из другой вкладки:
      // хранилище меняется мимо setRecord
      sandbox.localStorage.setItem('youplanner.records', JSON.stringify({
        '2026-05-01': { h1: false },
      }));
      // Без invalidate кэш честно держит прежнее значение
      assert.equal(context.calcProgress(h, ['2026-05-01']), 100);

      context.invalidateRecordsCache();
      assert.equal(context.calcProgress(h, ['2026-05-01']), 0);
    },
  },
  {
    name: 'кэш: привычки с разными id не влияют друг на друга',
    run: (context, sandbox) => {
      seedRecords(sandbox, {
        '2026-05-01': { h1: true, h2: false },
      });
      const h1 = habit('h1', 'boolean', null);
      const h2 = habit('h2', 'boolean', null);
      assert.equal(context.calcProgress(h1, ['2026-05-01']), 100);
      assert.equal(context.calcProgress(h2, ['2026-05-01']), 0);

      // Мутация записей h2 не задевает кэш h1: версия общая, ключи разные
      assert.equal(context.setRecord('2026-05-01', 'h2', true), true);
      assert.equal(context.calcProgress(h2, ['2026-05-01']), 100);
      assert.equal(context.calcProgress(h1, ['2026-05-01']), 100);
    },
  },
];

for (const scenario of recordsCases) {
  test(scenario.name, () => {
    const { context, sandbox } = loadApp();
    scenario.run(context, sandbox);
  });
}
