import { bus } from '../core/bus.js';
import { addDays, toISODate } from '../core/dates.js';
import { safeSetItem } from '../core/storage.js';
import { loadPrayer, prayerDateISO, prayerMinutes, prayerTimes } from './prayer.js';
import { getRecord, setRecord } from './records.js';
// Встречный импорт: stats.js берёт отсюда QAZA_HABIT_ID, отсюда нужен
// qazaDoneOn — второго читателя поля h6 нет, дублировать его нельзя. Цикл
// безвреден: обе стороны зовут друг друга только внутри функций, и на
// загрузке модулей ни одна ещё не работает
import { qazaDoneOn } from './stats.js';
import { saveNormalized } from '../sync/state.js';
export const QAZA_STORAGE_KEY = 'youplanner.qaza';
// Привычка, которая показывает счётчик каза за день. Id из спеки трекера:
// дефолтные привычки имеют стабильные id h1…h12.
export const QAZA_HABIT_ID = 'h6';
// Дневная цель — ориентир, а не жёсткий лимит
export const QAZA_DAILY_GOAL = 3;
// Порядок обхода очереди: Фаджр → Зухр → Аср → Магриб → Иша → снова Фаджр
export const NAMAZ_ORDER = ['fajr', 'zuhr', 'asr', 'maghrib', 'isha'];
export const NAMAZ_LABELS = {
  fajr: 'Фаджр',
  zuhr: 'Зухр',
  asr: 'Аср',
  maghrib: 'Магриб',
  isha: 'Иша',
};
// Версия схемы состояния. 2 — стартовый курсор перестал быть жёстким нулём
// и задаётся вручную в блоке «Откуда продолжаем?».
// 3 — запись истории получила поле source (обычное выполнение или ручное добавление).
export const QAZA_VERSION = 3;
// Источник записи в истории. Ручные записи не считаются выполнением:
// они увеличивают остаток, но не счётчик каза за день.
export const QAZA_SOURCE_DONE = 'done';
export const QAZA_SOURCE_MANUAL = 'manual';
// Магриб (индекс 3) — откуда продолжается очередь при начальных данных:
// сегодня уже выполнены Фаджр, Магриб и Иша.
export const QAZA_DEFAULT_CURSOR = 3;
// Начальные данные: 1530 каза, по 306 на намаз. Сегодня уже выполнены
// Фаджр, Магриб и Иша, поэтому у них 305.
export const DEFAULT_QAZA = {
  version: QAZA_VERSION,
  cursor: QAZA_DEFAULT_CURSOR,
  remaining: { fajr: 305, zuhr: 306, asr: 306, maghrib: 305, isha: 305 },
  history: [],
};
// Ключ растущего журнала выполнений — сосед youplanner.qaza, но не его
// часть: там стек отмены за сегодня, здесь история на годы (§5).
export const QAZA_LOG_KEY = 'youplanner.qaza.log';
// Версия схемы журнала. 1 — записи с полем source, как у истории уразы (§5).
export const QAZA_LOG_VERSION = 1;

// Копия состояния каза с проверкой типов. Возвращает новые объекты,
// чтобы правки никогда не задели константу DEFAULT_QAZA.
export function copyQaza(source) {
  const remaining = {};
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const key = NAMAZ_ORDER[i];
    const value = source && source.remaining ? source.remaining[key] : undefined;
    remaining[key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  const history = [];
  if (source && Array.isArray(source.history)) {
    for (let i = 0; i < source.history.length; i++) {
      const entry = source.history[i];
      if (entry && NAMAZ_ORDER.indexOf(entry.namaz) !== -1 &&
          typeof entry.date === 'string') {
        history.push({
          namaz: entry.namaz,
          date: entry.date,
          // Записи версий 1–2 поля не имеют: они все были выполнениями
          source: entry.source === QAZA_SOURCE_MANUAL ? QAZA_SOURCE_MANUAL : QAZA_SOURCE_DONE,
        });
      }
    }
  }

  let cursor = source && Number.isInteger(source.cursor) ? source.cursor : 0;
  if (cursor < 0 || cursor >= NAMAZ_ORDER.length) cursor = 0;

  return { version: QAZA_VERSION, cursor: cursor, remaining: remaining, history: history };
}
// Следующий по кругу индекс с ненулевым остатком. Поиск начинается с from + 1,
// сам from не проверяется. Если ненулевых нет вовсе — возвращается from.
export function nextQazaIndex(qaza, from) {
  const total = NAMAZ_ORDER.length;
  for (let step = 1; step <= total; step++) {
    const index = (from + step) % total;
    if (qaza.remaining[NAMAZ_ORDER[index]] > 0) return index;
  }
  return from;
}
// Инвариант очереди: курсор обязан указывать на намаз с остатком > 0.
// Если остаток на текущем стал нулём, курсор сдвигается к следующему
// ненулевому по кругу; при полностью пустой очереди остаётся на месте.
export function normalizeQazaCursor(qaza) {
  if (qaza.remaining[NAMAZ_ORDER[qaza.cursor]] === 0) {
    qaza.cursor = nextQazaIndex(qaza, qaza.cursor);
  }
}
// План на сегодня: до трёх намазов по кругу от курсора, нулевые пропускаются.
// Нигде не сохраняется — считается заново на каждый рендер.
export function getQazaPlan(qaza) {
  const total = NAMAZ_ORDER.length;
  const plan = [];
  for (let step = 0; step < total && plan.length < QAZA_DAILY_GOAL; step++) {
    const index = (qaza.cursor + step) % total;
    if (qaza.remaining[NAMAZ_ORDER[index]] > 0) plan.push(index);
  }
  return plan;
}
// Сумма остатков по всем пяти намазам
export function qazaTotalRemaining(qaza) {
  let sum = 0;
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    sum += qaza.remaining[NAMAZ_ORDER[i]];
  }
  return sum;
}
// Состояние каза. Отсутствие ключа — первый запуск: начальные данные
// пишутся сразу (init кладёт стартовую очередь до первого показа, пустой
// сервер заполняется своей копией). Битый JSON — другое дело: запись дефолта
// поверх него цементировала бы дефолт и сбрасывала счётчик лет накоплений.
// Политика loadFast (js/data/fast.js): чтение ничего не пишет, свежий
// дефолт возвращается как временное состояние (UI работает), а валидный
// облачный раздел при следующей сверке перезапишет битый ключ
// (applyCloudData, js/sync/sync.js). История обрезается до сегодняшнего
// дня: стек нужен только для отмены, поэтому он не растёт бесконечно.
export function loadQaza(skipSave = false) {
  // День каза: до Фаджра это ещё вчера, поэтому и журнал хранит вчерашние
  // записи — иначе выполнение, сделанное ночью, нечем было бы отменить (§7)
  const today = kazaDayFor(new Date());

  let raw = null;
  try {
    raw = localStorage.getItem(QAZA_STORAGE_KEY);
  } catch (e) {
    raw = null;   // хранилище недоступно — живём как при первом запуске
  }

  // Нет ключа — первый запуск: дефолт пишется, это не временное состояние
  if (!raw) {
    const fresh = copyQaza(DEFAULT_QAZA);
    if (!skipSave) {
      saveNormalized(function () { saveQaza(fresh); });
    }
    return fresh;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = null;   // битый JSON — ниже вернётся временный дефолт
  }

  // Битые данные (не распарсилось или не объект): хранилище не трогаем,
  // данные важнее дефолта. copyQaza дальше разбирает любой объект без
  // бросков — защитные проверки уже внутри
  if (!parsed || typeof parsed !== 'object') {
    return copyQaza(DEFAULT_QAZA);
  }

  const qaza = copyQaza(parsed);

  // Состояние прежней версии ставило стартовый курсор на Фаджр, который уже
  // выполнен. Правим только нетронутую очередь: если выполнения есть, курсор
  // осмысленный и трогать его нельзя.
  if (parsed.version === 1 && qaza.history.length === 0) {
    qaza.cursor = QAZA_DEFAULT_CURSOR;
  }

  qaza.history = qaza.history.filter(function (entry) {
    return entry.date === today;
  });

  // Курсор обязан указывать на намаз с остатком > 0
  normalizeQazaCursor(qaza);

  if (!skipSave) {
    saveNormalized(function () { saveQaza(qaza); });
  }
  return qaza;
}
export function saveQaza(qaza) {
  if (!safeSetItem(QAZA_STORAGE_KEY, JSON.stringify(qaza))) return false;
  bus.emit('data:changed');
  return true;
}
// Календарный день 'YYYY-MM-DD' — и у since, и у даты записи
export function validQazaLogDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
// Чистка записей журнала. Правило то же, что у истории уразы
// (validFastHistory, §5): элемент годится, если это объект с датой
// 'YYYY-MM-DD', известным намазом и известным источником. Битые записи
// отбрасываются молча: журнал растёт годами, и одна испорченная строка
// не должна ронять статистику
export function validQazaLogEntries(entries) {
  if (!Array.isArray(entries)) return [];

  return entries.filter(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (!validQazaLogDate(item.date)) return false;
    if (NAMAZ_ORDER.indexOf(item.namaz) === -1) return false;
    return item.source === QAZA_SOURCE_DONE || item.source === QAZA_SOURCE_MANUAL;
  });
}
// Чтение журнала. null — единственный признак «журнала нет»: нет ключа,
// битый JSON, не объект, since не дата или entries не массив. Записи при
// чтении чистятся, а не отклоняются: из-за одной битой строки журнал
// не теряется (§5). Как loadFast(), ничего не пишет.
export function loadQazaLog() {
  try {
    const raw = localStorage.getItem(QAZA_LOG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!validQazaLogDate(parsed.since)) return null;
    if (!Array.isArray(parsed.entries)) return null;

    return {
      version: QAZA_LOG_VERSION,
      since: parsed.since,
      entries: validQazaLogEntries(parsed.entries),
    };
  } catch (e) {
    return null;
  }
}
// Запись ключа. Журнал не чистится по датам и не обрезается: ограничения
// размера нет, как у истории уразы (§5).
export function saveQazaLog(log) {
  if (!log || !validQazaLogDate(log.since)) return;

  if (!safeSetItem(QAZA_LOG_KEY, JSON.stringify({
    version: QAZA_LOG_VERSION,
    since: log.since,
    entries: Array.isArray(log.entries) ? log.entries : [],
  }))) return false;
  bus.emit('data:changed');
  return true;
}
// Одно событие в журнал. Журнала нет — он заводится с since по дате первой
// записи: за дни до неё статистика читает h6, за неё и позже — журнал (§5).
export function appendQazaLog(namaz, date, source) {
  if (NAMAZ_ORDER.indexOf(namaz) === -1) return false;
  if (source !== QAZA_SOURCE_DONE && source !== QAZA_SOURCE_MANUAL) return false;
  if (!validQazaLogDate(date)) return false;

  const log = loadQazaLog() ||
    { version: QAZA_LOG_VERSION, since: date, entries: [] };
  log.entries.push({ date: date, namaz: namaz, source: source });
  if (!saveQazaLog(log)) return false;
  return true;
}
// Снятие последней подходящей записи. Отмена в очереди (§6.4) снимает
// и запись журнала: иначе отменённое выполнение навсегда осталось бы
// в статистике дня. Ищется с конца — тем же порядком, каким записи
// добавлялись. Журнала нет или записи в нём нет (она старше since) —
// ничего не делается.
export function dropLastQazaLog(namaz, date, source) {
  const log = loadQazaLog();
  // Журнала или подходящей записи нет — снимать нечего, это не ошибка записи.
  if (!log) return true;

  for (let i = log.entries.length - 1; i >= 0; i--) {
    const entry = log.entries[i];
    if (entry.date === date && entry.namaz === namaz && entry.source === source) {
      log.entries.splice(i, 1);
      if (!saveQazaLog(log)) return false;
      return true;
    }
  }
  return true;
}
// Выполнения каза по дням из журнала: одна запись — один выполненный намаз.
// Ручные добавления пропусков не считаются: намаз не выполнен, а вспомнен
// (§6.6). Возвращается карта «день → число», а не поиск по журналу на каждый
// день периода: на окне в 365 дней это был бы квадрат (§11y)
export function qazaLogDoneByDay(log) {
  const byDay = {};
  if (!log || !Array.isArray(log.entries)) return byDay;

  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i];
    if (entry.source === QAZA_SOURCE_MANUAL) continue;
    byDay[entry.date] = (byDay[entry.date] || 0) + 1;
  }
  return byDay;
}
// Сколько каза выполнено в указанный день. Считается по журналу, а не по длине
// стека: если страница открыта через полночь, в журнале остаются записи прошлого
// дня, и длина стека дала бы завышенный счётчик.
// Ручные добавления пропусков в счётчик не входят: намаз не выполнен, а вспомнен.
export function qazaDoneCount(qaza, date) {
  let count = 0;
  for (let i = 0; i < qaza.history.length; i++) {
    const entry = qaza.history[i];
    if (entry.date === date && entry.source !== QAZA_SOURCE_MANUAL) count += 1;
  }
  return count;
}
// Каза за каждый день периода и сумма за период (§5). Правило источника за
// день — «журнал с since, до него поле h6 записей» — раньше жило только
// в отрисовке статистики, но это правило хранилища, а не разметки: view
// не должен знать про log.since, иначе следующая цифра на другом экране
// посчитала бы день по-другому. values[i] отвечает dates[i]: день с since
// и позже читается из журнала (qazaLogDoneByDay уже отфильтровала ручные
// добавления пропусков), раньше — qazaDoneOn по готовому снимку записей.
// Журнала нет — все дни из записей, как до заведения журнала. total —
// сумма значений: «Выполнено за период» и средний темп считают те же числа,
// что и график
export function qazaDayCounts(records, log, dates) {
  const values = [];
  if (!Array.isArray(dates)) return { values: values, total: 0 };

  const logDone = qazaLogDoneByDay(log);
  let total = 0;
  for (let i = 0; i < dates.length; i++) {
    const count = log && dates[i] >= log.since
      ? (logDone[dates[i]] || 0)
      : qazaDoneOn(records, dates[i]);
    values.push(count);
    total += count;
  }
  return { values: values, total: total };
}
// Выполнение текущего намаза: остаток уменьшается, курсор сдвигается дальше.
// Счётчик каза за сегодня пишется в youplanner.records как привычка h6 —
// это единственное место, откуда его читают прогресс-круги таблицы.
// Начало дня каза в минутах от полуночи (§5): намаз, сделанный до Фаджра,
// относится к предыдущему дню. Фаджр берётся из prayerTimes() по текущим
// координатам; координат нет или расчёт не удался — 05:00 UTC+3.
export function kazaDayBoundary(now) {
  const FALLBACK = 5 * 60;

  const prayer = loadPrayer();
  if (!prayer) return FALLBACK;

  try {
    const times = prayerTimes(prayerDateISO(now), prayer.lat, prayer.lng,
      prayer.madhhab, prayer.method);
    // Number.isFinite, а не isFinite: за полярным кругом Фаджр приходит
    // как null, а isFinite(null) истинно и дал бы границу 00:00
    if (!times || !Number.isFinite(times.fajr)) return FALLBACK;
    return times.fajr;
  } catch (e) {
    return FALLBACK;
  }
}
// День, к которому относится выполнение каза прямо сейчас. До Фаджра это
// вчерашний день: ночью человек завершает вчерашний намаз, а не сегодняшний.
// Часы сверяются по UTC+3 — тому же поясу, в котором считает prayerTimes(),
// а ключ дня берётся общим toISODate, как у остальных записей.
export function kazaDayFor(now) {
  const minutes = prayerMinutes(now);
  return minutes >= kazaDayBoundary(now)
    ? toISODate(now)
    : toISODate(addDays(now, -1));
}
export function markQazaDone(qaza, today) {
  const key = NAMAZ_ORDER[qaza.cursor];
  if (!key || qaza.remaining[key] <= 0) return false;

  const snapshot = JSON.parse(JSON.stringify(qaza));
  const previousRecord = getRecord(today, QAZA_HABIT_ID);
  let logAppended = false;
  let recordWritten = false;

  function rollback() {
    Object.keys(qaza).forEach(function (field) { delete qaza[field]; });
    Object.assign(qaza, snapshot);
    // Уже успевшие записаться изменения откатываются в обратном порядке.
    if (recordWritten) setRecord(today, QAZA_HABIT_ID, previousRecord);
    if (logAppended) dropLastQazaLog(key, today, QAZA_SOURCE_DONE);
  }

  qaza.remaining[key] -= 1;
  qaza.history.push({ namaz: key, date: today, source: QAZA_SOURCE_DONE });

  if (!appendQazaLog(key, today, QAZA_SOURCE_DONE)) {
    rollback();
    return false;
  }
  logAppended = true;

  if (!setRecord(today, QAZA_HABIT_ID, qazaDoneCount(qaza, today))) {
    rollback();
    return false;
  }
  recordWritten = true;

  qaza.cursor = nextQazaIndex(qaza, qaza.cursor);
  if (!saveQaza(qaza)) {
    rollback();
    return false;
  }
  return true;
}
// Ручное добавление пропущенного намаза: «вспомнил, что не сделал».
// Остаток растёт, а счётчик дня и курсор очереди остаются на месте —
// очередь продолжается с того намаза, на котором стояла.
export function addMissedQaza(qaza, key, today) {
  if (NAMAZ_ORDER.indexOf(key) === -1) return false;

  const snapshot = JSON.parse(JSON.stringify(qaza));
  const previousRecord = getRecord(today, QAZA_HABIT_ID);
  let logAppended = false;
  // Ручное добавление счётчик дня не записывает, поэтому флаг всегда false:
  // он нужен откату, чтобы не трогать запись, которой операция не касалась.
  let recordWritten = false;

  function rollback() {
    Object.keys(qaza).forEach(function (field) { delete qaza[field]; });
    Object.assign(qaza, snapshot);
    // Уже успевшие записаться изменения откатываются в обратном порядке.
    if (recordWritten) setRecord(today, QAZA_HABIT_ID, previousRecord);
    if (logAppended) dropLastQazaLog(key, today, QAZA_SOURCE_MANUAL);
  }

  qaza.remaining[key] += 1;
  qaza.history.push({ namaz: key, date: today, source: QAZA_SOURCE_MANUAL });

  if (!appendQazaLog(key, today, QAZA_SOURCE_MANUAL)) {
    rollback();
    return false;
  }
  logAppended = true;

  // Если очередь была исчерпана, курсор стоял на нулевом остатке.
  // Возвращаем инвариант «курсор указывает на намаз с остатком > 0».
  normalizeQazaCursor(qaza);

  if (!saveQaza(qaza)) {
    rollback();
    return false;
  }
  return true;
}
// Отмена последней записи за сегодня. Отменять вчерашнее нельзя,
// поэтому при пустой или вчерашней истории функция ничего не делает.
// Откат ручного добавления возвращает только остаток: курсор оно не двигало,
// а счётчик дня его не учитывал.
// Запись журнала снимается вместе со стековой: журнал — второй свидетель
// того же события, и без снятия отменённое выполнение осталось бы в статистике
// дня навсегда (§5).
export function undoQazaDone(qaza, today) {
  if (qaza.history.length === 0) return false;

  const last = qaza.history[qaza.history.length - 1];
  if (last.date !== today) return false;

  const snapshot = JSON.parse(JSON.stringify(qaza));
  const previousRecord = getRecord(today, QAZA_HABIT_ID);
  const logBefore = loadQazaLog();
  const logHadEntry = !!logBefore && logBefore.entries.some(function (entry) {
    return entry.date === last.date && entry.namaz === last.namaz &&
      entry.source === last.source;
  });
  let logDropped = false;
  let recordWritten = false;

  function rollback() {
    Object.keys(qaza).forEach(function (field) { delete qaza[field]; });
    Object.assign(qaza, snapshot);
    // Уже успевшие записаться изменения откатываются в обратном порядке.
    if (recordWritten) setRecord(today, QAZA_HABIT_ID, previousRecord);
    if (logDropped) appendQazaLog(last.namaz, last.date, last.source);
  }

  qaza.history.pop();
  if (!dropLastQazaLog(last.namaz, last.date, last.source)) {
    rollback();
    return false;
  }
  // dropLastQazaLog возвращает true и когда снимать было нечего: откатывать
  // потом нужно только реально снятую запись.
  logDropped = logHadEntry;

  if (last.source === QAZA_SOURCE_MANUAL) {
    // Ручное добавление остаток увеличивало — откат его уменьшает.
    // Курсора и счётчика дня оно не касалось, значит и здесь они на месте.
    if (qaza.remaining[last.namaz] !== undefined) qaza.remaining[last.namaz] -= 1;
  } else {
    qaza.remaining[last.namaz] += 1;

    qaza.cursor = NAMAZ_ORDER.indexOf(last.namaz);
    if (qaza.cursor < 0) qaza.cursor = 0;

    // Ноль записывается как значимое значение, а не как удаление записи
    if (!setRecord(today, QAZA_HABIT_ID, qazaDoneCount(qaza, today))) {
      rollback();
      return false;
    }
    recordWritten = true;
  }

  // Курсор не должен указывать на намаз с нулевым остатком
  normalizeQazaCursor(qaza);

  if (!saveQaza(qaza)) {
    rollback();
    return false;
  }
  return true;
}
