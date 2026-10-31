import { bus } from '../core/bus.js';
import { safeSetItem } from '../core/storage.js';
// touchRecordsVersion живёт в records.js рядом с recordsCache, который
// он защищает: removeHabit ниже мутирует кэш записей in-place и обязан
// сдвигать версию кэша прогресса
import { loadRecords, saveRecords, touchRecordsVersion } from './records.js';
import { STORAGE_KEYS } from './storage.js';
// 12 привычек по умолчанию (порядок и значения — из спеки, п.5)
export const DEFAULT_HABITS = [
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
// Варианты значения для привычек типа choice (пустая опция = «нет записи»).
// Коды привычек с уровнями лежат в SPORT_VALUES рядом с уровнями: у Спорта
// и Пресса список свой, и «частично» в нём больше нет (§3.1).
export const CHOICE_OPTIONS = ['да', 'нет', 'частично', 'отдых'];
// Доступные типы привычек для формы
export const HABIT_TYPES = [
  { value: 'boolean', label: 'Да / Нет' },
  { value: 'number', label: 'Число' },
  { value: 'choice', label: 'Выбор' },
];

// Копия привычки по умолчанию по id. Копия, а не ссылка на элемент
// DEFAULT_HABITS: записанное в localStorage не должно править сам список.
// Ключ time переносится только если он у привычки есть вовсе.
export function defaultHabit(id) {
  for (let i = 0; i < DEFAULT_HABITS.length; i++) {
    const h = DEFAULT_HABITS[i];
    if (h.id !== id) continue;
    const copy = { id: h.id, name: h.name, type: h.type, unit: h.unit, goal: h.goal };
    if (h.time !== undefined) copy.time = h.time;
    return copy;
  }
  return null;
}
// Годен ли элемент списка привычек. Те же минимальные поля, что проверяет
// validCloudHabits (js/sync/validators.js): рендеру нужны id, name и тип из
// набора формы. Продублировано локально: data не импортирует sync
// (направление зависимостей core ← data ← sync/ui), а прямой импорт
// validators.js из habits.js дал бы цикл — validators.js сам импортирует
// habits.js. Битый элемент не должен ронять раздел и экран вместе с ним.
function validHabitItem(habit) {
  if (!habit || typeof habit !== 'object' || Array.isArray(habit)) return false;
  if (typeof habit.id !== 'string' || habit.id === '') return false;
  if (typeof habit.name !== 'string') return false;
  for (let i = 0; i < HABIT_TYPES.length; i++) {
    if (HABIT_TYPES[i].value === habit.type) return true;
  }
  return false;
}

// Возвращает список привычек как он лежит в хранилище. Отсутствие ключа,
// пустой список и битый JSON читаются одинаково — как «привычек нет».
// Битые элементы внутри списка (null, мусор, привычка без id) отбрасываются,
// а не роняют чтение: один битый элемент не должен прятать весь список.
// Дефолты здесь не пишутся: пустое хранилище значит «ещё не знаем», а не
// «привычек нет», и засевает его init после подтверждённой сверки (§13).
export function loadHabits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.habits);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validHabitItem);
  } catch (e) {
    return [];
  }
}
export function saveHabits(habits) {
  if (!safeSetItem(STORAGE_KEYS.habits, JSON.stringify(habits))) return false;
  bus.emit('data:changed');
  return true;
}
// Есть ли хотя бы одна запись у привычки
export function hasRecords(habitId) {
  const records = loadRecords();
  const dates = Object.keys(records);
  for (let i = 0; i < dates.length; i++) {
    if (Object.prototype.hasOwnProperty.call(records[dates[i]], habitId)) return true;
  }
  return false;
}
// Добавляет привычку, id генерируется автоматически
export function addHabit(habit) {
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
export function updateHabit(id, patch) {
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
// ── Надгробия удалённых привычек (tombstones) ───────────────────────────────
// Слияние снимков (js/sync/merge.js) аддитивно: привычка, которой нет
// локально, но она есть на сервере, привозится обратно — и удаление,
// сделанное на этом устройстве, отменялось бы каждой сверкой. Надгробие
// { habitId: ts } говорит слиянию: «эту привычку здесь удалили в момент ts».
// Пишется до удаления списка: между удалением и отправкой сервер ещё старый,
// и только надгробие не даёт ветке extra вернуть привычку при первом же
// обмене. Число ограничено (TOMBSTONES_LIMIT): привычек за жизнь устройства
// заведутся десятки, лимит — защита от раздувания ключа чужим мусором.
export const TOMBSTONES_LIMIT = 500;
// Максимальная длина id в надгробии: настоящие id короткие ('h' + base36),
// длинный ключ — мусор, место в лимите ему отдавать нельзя.
const TOMBSTONE_ID_MAX_LENGTH = 128;

// Оставляет только годные записи: ключ — непустая строка разумной длины,
// значение — конечное число не меньше нуля (метка Date.now()). Мусор
// отбрасывается по записи, а не роняет весь раздел: один битый элемент
// не должен отменять синхронизацию остальных надгробий. Значение обязано
// быть числом по типу: мягкое приведение превратило бы null и '' в 0 —
// надгробие «с самого начала времён», блокирующее привоз привычки вечно.
export function sanitizeTombstones(tombstones) {
  if (!tombstones || typeof tombstones !== 'object' || Array.isArray(tombstones)) return {};
  const clean = {};
  const ids = Object.keys(tombstones);
  for (let i = 0; i < ids.length && Object.keys(clean).length < TOMBSTONES_LIMIT; i++) {
    const id = ids[i];
    if (typeof id !== 'string' || id === '' || id.length > TOMBSTONE_ID_MAX_LENGTH) continue;
    const ts = tombstones[id];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) continue;
    clean[id] = ts;
  }
  return clean;
}

// Читает надгробия. Отсутствие ключа и битый JSON — «надгробий нет», как у
// loadHabits: пустое значение не должно ломать ни удаление, ни слияние.
export function loadTombstones() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.tombstones);
    if (!raw) return {};
    return sanitizeTombstones(JSON.parse(raw));
  } catch (e) {
    return {};
  }
}

// Прямая запись без событий и без safeSetItem: надгробие — служебная метка,
// её провал не должен ни ронять удаление, ни показывать тост о квоте.
// Место в хранилище освобождает само удаление привычки, идущее следом.
// Опустошение (последняя метка снята) стирает и ключ: «надгробий нет»
// выражается отсутствием ключа, а не пустым объектом — иначе пустые
// надгробия плодили бы ключ у каждого устройства.
function saveTombstonesRaw(tombstones) {
  try {
    if (Object.keys(tombstones).length === 0) {
      localStorage.removeItem(STORAGE_KEYS.tombstones);
    } else {
      localStorage.setItem(STORAGE_KEYS.tombstones, JSON.stringify(tombstones));
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Отмечает удаление привычки в момент ts. Повторное удаление того же id
// (после воскрешения чужой правкой) перезаписывает метку свежей — верна
// последняя, а не первая.
//
// Лимит вытесняет самые СТАРЫЕ метки, а не свежую: sanitizeTombstones
// режет по порядку ключей, и на переполнении не влезла бы именно новая
// метка — только что удалённая привычка воскресла бы при первом же слиянии
// (аудит 2026-10-31). Вытеснение по минимуму ts: надгробие долгой давности
// менее всего способно понадобиться.
export function writeTombstone(id, ts) {
  const tombstones = loadTombstones();
  if (!Object.prototype.hasOwnProperty.call(tombstones, id)) {
    while (Object.keys(tombstones).length >= TOMBSTONES_LIMIT) {
      let oldestId = null;
      let oldestTs = Infinity;
      const ids = Object.keys(tombstones);
      for (let i = 0; i < ids.length; i++) {
        if (tombstones[ids[i]] < oldestTs) {
          oldestTs = tombstones[ids[i]];
          oldestId = ids[i];
        }
      }
      delete tombstones[oldestId];
    }
  }
  tombstones[id] = ts;
  return saveTombstonesRaw(sanitizeTombstones(tombstones));
}

// Снимает надгробие: привычка с этим id снова в списке. Вызывается, когда
// удаление не состоялось (откат в removeHabit) и когда привычка вернулась
// со снимком или из копии (pruneResolvedTombstones) — надгробие висящей
// в воздухе меткой уезжать на сервер не должно.
export function clearTombstone(id) {
  const tombstones = loadTombstones();
  if (!Object.prototype.hasOwnProperty.call(tombstones, id)) return;
  delete tombstones[id];
  saveTombstonesRaw(tombstones);
}

// Убирает надгробия привычек, снова присутствующих в списке. После возврата
// привычки со снимком метка больше не нужна: без очистки она уезжала бы
// наверх при каждой отправке и блокировала бы привоз привычки на других
// устройствах, пока метка раздела habits не переросла её.
export function pruneResolvedTombstones() {
  const tombstones = loadTombstones();
  const ids = Object.keys(tombstones);
  if (ids.length === 0) return;
  const habits = loadHabits();
  const present = {};
  for (let i = 0; i < habits.length; i++) {
    const h = habits[i];
    if (h && h.id != null) present[h.id] = true;
  }
  let changed = false;
  for (let i = 0; i < ids.length; i++) {
    if (!present[ids[i]]) continue;
    delete tombstones[ids[i]];
    changed = true;
  }
  if (changed) saveTombstonesRaw(tombstones);
}

// Удаляет привычку и вычищает все её значения из записей.
// true — только если сохранены и привычки, и записи; при провале записи
// привычек на диске пробуем вернуть список как был (best-effort).
export function removeHabit(id) {
  // Надгробие пишется ДО удаления списка: привычка без метки исчезает из
  // списка, и аддитивное слияние с ещё старым сервером вернуло бы её при
  // первом же обмене. Запись best-effort: провал метки (квота) не отменяет
  // удаление — без надгробия привычка может воскреснуть, но удаление-то
  // человек сделал.
  const tombstoneWritten = writeTombstone(id, Date.now());
  const habitsSnapshot = JSON.parse(JSON.stringify(loadHabits()));
  const habits = habitsSnapshot.filter(function (h) { return h.id !== id; });
  // Глубокая копия снимка: filter выше даёт новый массив, но объекты привычек
  // в нём общие со снимком, а восстановление нужно независимое.
  const habitsRestore = JSON.parse(JSON.stringify(habitsSnapshot));

  if (!saveHabits(habits)) {
    // Удаление не состоялось — привычка осталась, метка ей не положена
    if (tombstoneWritten) clearTombstone(id);
    return false;
  }

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
  // Мутации выше правят recordsCache in-place: сдвигаем версию кэша
  // прогресса сразу, не дожидаясь исхода записи. Откат ниже сдвинет ещё
  // раз — лишний сдвиг безвреден, устаревший процент нет
  if (changed) touchRecordsVersion();
  if (changed && !saveRecords(records)) {
    // Локальный объект записей возвращаем к снимку до мутаций.
    Object.keys(records).forEach(function (key) { delete records[key]; });
    Object.assign(records, recordsSnapshot);
    // Откат — тоже мутация кэша in-place: версия обязана уйти вперёд
    touchRecordsVersion();
    // Записи на диск не легли (там прежние, с удаляемой привычкой), а список
    // привычек уже записан без неё — возвращаем его к снимку. Если и это
    // не удалось, всё равно возвращаем false (best-effort).
    saveHabits(habitsRestore);
    // Привычка вернулась в список — надгробие снимаем, она не удалена
    if (tombstoneWritten) clearTombstone(id);
    return false;
  }
  bus.emit('data:changed');
  return true;
}
