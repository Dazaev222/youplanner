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

// Копия привычки по умолчанию по id. Копия, а не ссылка на элемент
// DEFAULT_HABITS: записанное в localStorage не должно править сам список.
// Ключ time переносится только если он у привычки есть вовсе.
function defaultHabit(id) {
  for (let i = 0; i < DEFAULT_HABITS.length; i++) {
    const h = DEFAULT_HABITS[i];
    if (h.id !== id) continue;
    const copy = { id: h.id, name: h.name, type: h.type, unit: h.unit, goal: h.goal };
    if (h.time !== undefined) copy.time = h.time;
    return copy;
  }
  return null;
}
// Возвращает список привычек как он лежит в хранилище. Отсутствие ключа,
// пустой список и битый JSON читаются одинаково — как «привычек нет».
// Дефолты здесь не пишутся: пустое хранилище значит «ещё не знаем», а не
// «привычек нет», и засевает его init после подтверждённой сверки (§13).
function loadHabits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.habits);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    return [];
  }
}
function saveHabits(habits) {
  if (!safeSetItem(STORAGE_KEYS.habits, JSON.stringify(habits))) return false;
  bus.emit('data:changed');
  return true;
}
// Есть ли хотя бы одна запись у привычки
function hasRecords(habitId) {
  const records = loadRecords();
  const dates = Object.keys(records);
  for (let i = 0; i < dates.length; i++) {
    if (Object.prototype.hasOwnProperty.call(records[dates[i]], habitId)) return true;
  }
  return false;
}
// Добавляет привычку, id генерируется автоматически
function addHabit(habit) {
  const habits = loadHabits();
  const newHabit = {
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: habit.name,
    type: habit.type,
    unit: habit.unit || '',
    goal: habit.goal === undefined ? null : habit.goal,
    // time ставится сразу и пустым: иначе привычка без ключа и привычка
    // с time: null — два формата одного состояния
    time: null,
  };
  habits.push(newHabit);
  if (!saveHabits(habits)) return null;
  return newHabit;
}
// Меняет поля привычки. Неизвестный id → null. id менять нельзя.
function updateHabit(id, patch) {
  const habits = loadHabits();
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id !== id) continue;
    const merged = Object.assign({}, habits[i], patch, { id: habits[i].id });
    habits[i] = merged;
    if (!saveHabits(habits)) return null;
    return merged;
  }
  return null;
}
// Удаляет привычку и вычищает все её значения из записей.
// true — только если сохранены и привычки, и записи; при провале записи
// привычек на диске пробуем вернуть список как был (best-effort).
function removeHabit(id) {
  const habitsSnapshot = JSON.parse(JSON.stringify(loadHabits()));
  const habits = habitsSnapshot.filter(function (h) { return h.id !== id; });
  // Глубокая копия снимка: filter выше даёт новый массив, но объекты привычек
  // в нём общие со снимком, а восстановление нужно независимое.
  const habitsRestore = JSON.parse(JSON.stringify(habitsSnapshot));

  if (!saveHabits(habits)) return false;

  const records = loadRecords();
  const recordsSnapshot = JSON.parse(JSON.stringify(records));
  const dates = Object.keys(records);
  let changed = false;
  for (let i = 0; i < dates.length; i++) {
    const day = records[dates[i]];
    if (!Object.prototype.hasOwnProperty.call(day, id)) continue;
    delete day[id];
    changed = true;
    if (Object.keys(day).length === 0) delete records[dates[i]];
  }
  if (changed && !saveRecords(records)) {
    // Локальный объект записей возвращаем к снимку до мутаций.
    Object.keys(records).forEach(function (key) { delete records[key]; });
    Object.assign(records, recordsSnapshot);
    // Записи на диск не легли (там прежние, с удаляемой привычкой), а список
    // привычек уже записан без неё — возвращаем его к снимку. Если и это
    // не удалось, всё равно возвращаем false (best-effort).
    saveHabits(habitsRestore);
    return false;
  }
  bus.emit('data:changed');
  return true;
}
