// Период — отметка устройства, как youplanner.mainView: в синхронизацию
// и в файл резервной копии не входит (§5)
const STATS_PERIOD_KEY = 'youplanner.stats.period';
const STATS_PERIODS = ['week', 'month', 'year', 'all'];
const STATS_PERIOD_DEFAULT = 'month';
// Пять категорий статистики: у каждой свой период
const STATS_PERIOD_CATEGORIES = ['hub', 'qaza', 'habits', 'fast', 'sleep'];
// Блок периодов → категория. Блоков шесть, категорий пять: список привычек
// и карточка одной привычки делят период категории «habits»
const STATS_PERIOD_BOXES = {
  'stats-period': 'hub',
  'stats-qaza-period': 'qaza',
  'stats-habits-period': 'habits',
  'stats-habit-period': 'habits',
  'stats-fast-period': 'fast',
  'stats-sleep-period': 'sleep',
};
// «Всё время» — окно в 365 дней от сегодня, а не от первой записи: иначе
// одна старая запись растянула бы график на годы пустых дней
const STATS_ALL_DAYS = 365;

// Содержимое ключа как объект периодов. Ключа нет и мусор в нём — пустой
// объект: обе ветки читаются как «Месяц». Строка из списка — след прежней
// версии, где период был один: переносится на все шесть категорий, и первая
// же правка периода кладёт в ключ объект
function readStatsPeriods() {
  const raw = localStorage.getItem(STATS_PERIOD_KEY);
  if (!raw) return {};

  if (STATS_PERIODS.indexOf(raw) !== -1) {
    const legacy = {};
    for (let i = 0; i < STATS_PERIOD_CATEGORIES.length; i++) {
      legacy[STATS_PERIOD_CATEGORIES[i]] = raw;
    }
    return legacy;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}
// Период одной категории. Битое значение, отсутствие поля и отсутствие ключа —
// одно и то же: «Месяц»
function loadStatsPeriod(category) {
  const value = readStatsPeriods()[category];
  return STATS_PERIODS.indexOf(value) === -1 ? STATS_PERIOD_DEFAULT : value;
}
// Пишет одно поле, остальные пять не трогает. Значение вне списка не
// пишется — как и у единственного периода до этой правки
function saveStatsPeriod(category, period) {
  if (STATS_PERIODS.indexOf(period) === -1) return;
  const periods = readStatsPeriods();
  periods[category] = period;
  return safeSetItem(STATS_PERIOD_KEY, JSON.stringify(periods));
}
// Дни периода по сегодня включительно. Даты собираются существующими
// toISODate и addDays, начало недели — getWeekStart.
function statsPeriodDates(period, today) {
  const dates = [];
  let from;

  if (period === 'week') {
    from = getWeekStart(today);
  } else if (period === 'year') {
    from = new Date(today.getFullYear(), 0, 1);
  } else if (period === 'all') {
    from = addDays(today, -(STATS_ALL_DAYS - 1));
  } else {
    // «Месяц» и всё неизвестное: с 1-го числа по сегодня
    from = new Date(today.getFullYear(), today.getMonth(), 1);
  }

  const last = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cur <= last) {
    dates.push(toISODate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
// Сколько каза выполнено в конкретный день: поле h6 в записях дня (§5, §8).
// Работает по готовому снимку записей — за период в 365 дней читать
// хранилище на каждый день незачем.
function qazaDoneOn(records, date) {
  const day = records ? records[date] : null;
  const value = day ? day[QAZA_HABIT_ID] : undefined;
  return typeof value === 'number' && value > 0 ? value : 0;
}
// Текущая серия: сколько дней подряд по сегодня включительно есть хотя бы
// один каза. Считается назад от сегодня и периода не касается. Цикл всегда
// конечен: первый день без записи его обрывает.
function qazaStreak(records, today) {
  let streak = 0;
  while (qazaDoneOn(records, toISODate(addDays(today, -streak))) > 0) streak++;
  return streak;
}
// Средний процент по всем привычкам за набор дат. База — calcProgress,
// поэтому непроставленный день даёт ноль, как и в кругах таблицы.
function habitsAveragePercent(habits, dates) {
  if (!habits || habits.length === 0 || !dates || dates.length === 0) return null;

  let sum = 0;
  for (let i = 0; i < habits.length; i++) sum += calcProgress(habits[i], dates);
  return sum / habits.length;
}
// Отмечен ли день: вес больше нуля. Единый критерий серии, сетки и счётчика
// отметок — считается через calcProgress по одному дню, как прогресс в кругах
function habitMarked(habit, date) {
  return calcProgress(habit, [date]) > 0;
}
// Дни периода с отметкой
function habitMarkedDays(habit, dates) {
  const days = [];
  for (let i = 0; i < dates.length; i++) {
    if (habitMarked(habit, dates[i])) days.push(dates[i]);
  }
  return days;
}
// Текущая серия: сколько дней подряд по сегодня включительно привычка отмечена.
// Как у каза, периода не касается — серия принадлежит сегодняшнему дню, и цикл
// конечен: первый неотмеченный день его обрывает
function habitCurrentStreak(habit, today) {
  let streak = 0;
  while (habitMarked(habit, toISODate(addDays(today, -streak)))) streak++;
  return streak;
}
// Лучшая серия внутри периода: самый длинный ряд подряд идущих отмеченных дней
function habitBestStreak(habit, dates) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < dates.length; i++) {
    run = habitMarked(habit, dates[i]) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
