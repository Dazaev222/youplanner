// 12 привычек по умолчанию (порядок и значения — из спеки, п.5)
const DEFAULT_HABITS = [
  { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
  { id: 'h2', name: 'Зухр', type: 'boolean', unit: '', goal: null },
  { id: 'h3', name: 'Аср', type: 'boolean', unit: '', goal: null },
  { id: 'h4', name: 'Магриб', type: 'boolean', unit: '', goal: null },
  { id: 'h5', name: 'Иша', type: 'boolean', unit: '', goal: null },
  { id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 },
  // time — необязательное время привычки: у привычек с уровнями оно задаёт
  // окно «вовремя» и цвет границы поля отметки (§1.1, §1.6)
  { id: 'h7', name: 'Спорт', type: 'choice', unit: '', goal: null, time: null },
  { id: 'h8', name: 'Коран', type: 'number', unit: 'стр.', goal: 5, time: null },
  { id: 'h9', name: 'Работа с текстами', type: 'number', unit: 'мин', goal: 10 },
  { id: 'h10', name: 'Чтение книги', type: 'number', unit: 'стр.', goal: 2 },
  { id: 'h11', name: 'Таблицы', type: 'boolean', unit: '', goal: null },
  { id: 'h12', name: 'Пресс', type: 'choice', unit: '', goal: null, time: null },
];
// Привычки с уровнями: у них запись — объект { value, level }, а у привычки
// есть необязательное время time (§1.1). Id из спеки трекера, как у каза.
const SPORT_HABIT_ID = 'h7';
const QURAN_HABIT_ID = 'h8';
const PRESS_HABIT_ID = 'h12';
// Уровни выполнения записи
const LEVEL_ON_TIME = 'on-time';
const LEVEL_LATE = 'late';
const LEVEL_TWO_MIN = 'two-min';
// Окно «вовремя» — ±60 минут от назначенного времени (§1.6)
const LEVEL_WINDOW_MIN = 60;
// Варианты привычек «Спорт» и «Пресс»: «да», «нет», «2 минуты», «отдых» (§3.1).
// «Отдых» — запланированный пропуск: уровня у него нет, серию он не рвёт
// и в прогресс не входит.
const SPORT_VALUES = ['yes', 'no', 'two-min', 'rest'];
const SPORT_VALUE_LABELS = {
  'yes': 'да',
  'no': 'нет',
  'two-min': '2 минуты',
  'rest': 'отдых',
};
// Коды прежней схемы. «Частично» убрано из списка, но в записях его
// достаточно, и оно читается как «2 минуты» (§3.2).
const SPORT_LEGACY_VALUES = {
  'да': 'yes',
  'нет': 'no',
  'частично': 'two-min',
  'отдых': 'rest',
};
// Варианты значения для привычек типа choice (пустая опция = «нет записи»).
// Коды привычек с уровнями лежат в SPORT_VALUES рядом с уровнями: у Спорта
// и Пресса список свой, и «частично» в нём больше нет (§3.1).
const CHOICE_OPTIONS = ['да', 'нет', 'частично', 'отдых'];
// Доступные типы привычек для формы
const HABIT_TYPES = [
  { value: 'boolean', label: 'Да / Нет' },
  { value: 'number', label: 'Число' },
  { value: 'choice', label: 'Выбор' },
];
