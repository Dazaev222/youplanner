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
