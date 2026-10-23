import { bus } from '../core/bus.js';
import { toISODate } from '../core/dates.js';
import { pad2 } from '../core/dom.js';
import { safeSetItem } from '../core/storage.js';
// Длина одного цикла сна в минутах и потолок расчёта. Циклов шесть:
// от 90 минут до 9 часов. Раздел живёт по ключу youplanner.sleep и ходит
// и в синхронизацию, и в файл копии восьмым разделом (§5).
// Версия 2 добавила к трём опорам расчёта пару actualWake/sleepMin — время,
// которое пойдёт в историю, и длительность сна. У записи версии 1 её нет,
// и это не порча, а другой возраст: читается она по-прежнему, а недостающая
// пара подставляется целью («встаю в своё время»).
// Версия 3 добавила историю — массив записей по дням, растущий, как у уразы.
// Отдельного ключа у неё нет: запись дня ищется проходом по полю date
// Версия 4 добавила пару realWake/realSleepMin и флаг excluded: во сколько
// человек встал на самом деле и не выбросить ли день из статистики.
// Отсутствие пары — признак версии 1 или 3, и это возраст, а не порча
export const SLEEP_KEY = 'youplanner.sleep';
export const SLEEP_VERSION = 4;
// Больше суток от засыпания до подъёма быть не может: оба конца лежат
// на одной ночи. Потолок нужен только для чтения чужой записи
export const SLEEP_MAX_MINUTES = 1440;
export const SLEEP_CYCLE_MIN = 90;
export const SLEEP_CYCLE_COUNT = 6;
// Больше двух часов засыпания в поле не влезает: это уже не засыпание
export const SLEEP_MAX_FALL = 120;

// Среднее по массиву минут от полуночи — точка на циферблате, а не сумма.
// Время живёт на сутках, и обычное среднее на нём врёт: отбой 23:30 и 00:30
// — это полночь, а не 12:00. Поэтому значение строго меньше 18:00 (1080)
// считается после полуночи и сдвигается на сутки вперёд, а 1080 и больше
// не сдвигается. Порог — не догадка: отбой вечером, подъём утром, и 18:00
// лежит между ними. Среднее сворачивается по модулю 1440 — обратно
// на циферблат. Пустой массив — null: среднего нет
export function sleepAverageMinutes(minutes) {
  if (!minutes || minutes.length === 0) return null;

  // Только числа: null, undefined и строки сюда не проходят.
  // Проверка стояла бы и без фильтра — validSleepHistory их
  // отбрасывает, — но инвариант «на входе числа» держится тогда
  // на комментарии в другом месте, а не на самой функции
  const clean = minutes.filter(Number.isFinite);
  if (clean.length === 0) return null;

  let sum = 0;
  for (let i = 0; i < clean.length; i++) {
    sum += clean[i] < 18 * 60 ? clean[i] + SLEEP_MAX_MINUTES : clean[i];
  }

  return Math.round(sum / clean.length) % SLEEP_MAX_MINUTES;
}
// 'HH:MM' → минуты от полуночи. Всё прочее, включая '7:30' и '24:00', —
// null: поле времени браузера даёт ровно такой формат
export function sleepTimeMinutes(text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
// Минуты от полуночи → 'HH:MM'. Значение сворачивается по суткам: конец
// шестого цикла у позднего отхода уходит на следующий день
export function sleepTimeLabel(minutes) {
  const day = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return pad2(Math.floor(day / 60)) + ':' + pad2(day % 60);
}
// Значение поля «Через сколько заснул» — и оно же поле хранилища: целое
// 0…120. Пустая строка, дробное, отрицательное и большее потолка — null
export function sleepFallMinutes(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const minutes = Number(text);
  return minutes > SLEEP_MAX_FALL ? null : minutes;
}
// Три момента на одной шкале: отход, засыпание и подъём. Будильник раньше
// отхода — значит следующие сутки, поэтому к нему прибавляется 1440.
// Сравнивается он с отходом, а не с засыпанием: «встать раньше, чем лёг»
// и «встать раньше, чем заснул» — разные вещи, и первое и есть смена суток
export function sleepAnchors(bed, fall, wake) {
  const bedMinutes = sleepTimeMinutes(bed);
  const wakeMinutes = sleepTimeMinutes(wake);
  if (bedMinutes === null || wakeMinutes === null) return null;
  if (!Number.isInteger(fall) || fall < 0 || fall > SLEEP_MAX_FALL) return null;

  return {
    bedMinutes: bedMinutes,
    asleepMinutes: bedMinutes + fall,
    wakeMinutes: wakeMinutes < bedMinutes ? wakeMinutes + 1440 : wakeMinutes,
  };
}
// Концы циклов и рекомендуемый будильник. Время в cycle.time свёрнуто
// по суткам, а в recommended — нет: слева и справа ищется ближайший
// по времени, и пара «раньше / позже» должна остаться парой
export function sleepCycleTimes(bed, fall, wake) {
  const anchors = sleepAnchors(bed, fall, wake);
  if (!anchors) return null;

  const cycles = [];
  for (let n = 1; n <= SLEEP_CYCLE_COUNT; n++) {
    cycles.push({
      time: sleepTimeLabel(anchors.asleepMinutes + n * SLEEP_CYCLE_MIN),
      cycles: n,
      sleepMinutes: n * SLEEP_CYCLE_MIN,
    });
  }

  // Будильник ровно на конце цикла — один вариант. Иначе берутся соседние
  // слева и справа; за пределами шести циклов соседа с одной стороны нет,
  // и остаётся один — ближайший
  let exact = null;
  let left = null;
  let right = null;
  for (let i = 0; i < cycles.length; i++) {
    const end = anchors.asleepMinutes + cycles[i].sleepMinutes;
    if (end === anchors.wakeMinutes) exact = cycles[i];
    else if (end < anchors.wakeMinutes) left = cycles[i];
    else if (!right) right = cycles[i];
  }

  return {
    cycles: cycles,
    recommended: exact ? [exact] : left && right ? [left, right] : [left || right],
  };
}
// Ближайший к будильнику конец цикла. Перебираются все шесть; при равном
// расстоянии побеждает более поздний — «<=» вместо «<» при переборе
// по возрастанию. Обоснование: встать на сорок минут позже, чем просил,
// безобиднее, чем оборвать цикл ровно на середине
export function nearestSleepCycle(anchors) {
  let best = null;
  for (let n = 1; n <= SLEEP_CYCLE_COUNT; n++) {
    const end = anchors.asleepMinutes + n * SLEEP_CYCLE_MIN;
    if (best === null ||
        Math.abs(end - anchors.wakeMinutes) <= Math.abs(best - anchors.wakeMinutes)) {
      best = end;
    }
  }
  return best;
}
// Время, которое пойдёт в историю. Галочка снята — своё время; отмечена —
// ближайший конец цикла. Считается из состояния галочки при каждом рендере:
// отдельной константы режима нет, второй источник правды не нужен.
// Возврат свёрнут по суткам — как и всё, что показывается человеку
export function actualWakeTime(bed, fall, wake, followRec) {
  const anchors = sleepAnchors(bed, fall, wake);
  if (!anchors) return null;
  if (followRec !== true) return sleepTimeLabel(anchors.wakeMinutes);
  return sleepTimeLabel(nearestSleepCycle(anchors));
}
// Минуты от засыпания до подъёма. Подъём раньше засыпания по циферблату —
// значит следующие сутки, и они добавляются, пока конец не окажется позже
// засыпания. «Пока», а не «если»: при отходе 23:30 и засыпании 120 минут
// засыпание (25:30) уже перевалило за полночь, и одного добавления мало —
// разница ушла бы в минус
export function sleepDurationMinutes(bed, fall, actualWake) {
  const bedMinutes = sleepTimeMinutes(bed);
  const wakeMinutes = sleepTimeMinutes(actualWake);
  if (bedMinutes === null || wakeMinutes === null) return null;
  if (!Number.isInteger(fall) || fall < 0 || fall > SLEEP_MAX_FALL) return null;

  const asleepMinutes = bedMinutes + fall;
  let end = wakeMinutes;
  while (end < asleepMinutes) end += SLEEP_MAX_MINUTES;
  return end - asleepMinutes;
}
// «30 мин», «1 ч», «1 ч 30 мин», «9 ч»
export function sleepFormatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return rest + ' мин';
  if (rest === 0) return hours + ' ч';
  return hours + ' ч ' + rest + ' мин';
}
// «1 цикл», «4 цикла», «5 циклов»
export function sleepCycleLabel(count) {
  const word = count === 1 ? 'цикл' : count >= 2 && count <= 4 ? 'цикла' : 'циклов';
  return count + ' ' + word;
}
// История сна: массив записей по дням. Чистится при чтении, как история уразы:
// битый элемент отбрасывается молча, массив из-за него не отклоняется (§5).
// Годная запись — объект, у которого date — день, bed и wake — время суток,
// fall — целое 0…120, actualWake — время суток, sleepMin — целое 0…1439,
// и оно сходится с полями. Сходимость проверяется не для порядка: битая пара
// роняет всю запись и при чтении ключа, и в истории ей не место — иначе
// однажды день вернулся бы в раздел с чужой длительностью.
// Пара realWake/realSleepMin и флаг excluded — версия 4. Запись без них
// годна: отсутствие пары значит «встал по плану». Половинчатая пара —
// realWake без длительности или наоборот — отбрасывается: собрать из неё
// нечего, а день с ней всё равно попал бы в статистику наполовину
export function validSleepHistory(history) {
  if (!Array.isArray(history)) return [];

  return history.filter(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return false;
    if (sleepTimeMinutes(item.bed) === null) return false;
    if (sleepTimeMinutes(item.wake) === null) return false;
    const fall = sleepFallMinutes(item.fall);
    if (fall === null) return false;
    if (sleepTimeMinutes(item.actualWake) === null) return false;
    if (!Number.isInteger(item.sleepMin) ||
        item.sleepMin < 0 || item.sleepMin >= SLEEP_MAX_MINUTES) return false;
    if (sleepDurationMinutes(item.bed, fall, item.actualWake) !== item.sleepMin) return false;
    if (item.excluded !== undefined && typeof item.excluded !== 'boolean') return false;
    if (item.realWake === null || item.realWake === undefined) {
      return item.realSleepMin === null || item.realSleepMin === undefined;
    }
    if (sleepTimeMinutes(item.realWake) === null) return false;
    if (!Number.isInteger(item.realSleepMin) ||
        item.realSleepMin < 0 || item.realSleepMin >= SLEEP_MAX_MINUTES) return false;
    return sleepDurationMinutes(item.bed, fall, item.realWake) === item.realSleepMin;
  });
}
// Запись дня в историю. Одна запись на день: день ищется проходом по полю
// date и перезаписывается на месте — второй записи об одном дне не заводится.
// Прохода, а не отдельного ключа с датой: ещё один ключ пришлось бы гасить
// при импорте копии, и он разошёлся бы с содержимым истории. Дата — день
// сохранения формы, тем же toISODate, что и у истории уразы: раздел
// заполняют перед сном, и она отвечает на вопрос «день, когда лёг»
export function sleepHistoryEntry(history, entry) {
  const entries = Array.isArray(history) ? history.slice() : [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].date === entry.date) {
      entries[i] = entry;
      return entries;
    }
  }
  entries.push(entry);
  return entries;
}
// Чтение с проверкой. null — записей нет: нет ключа, битый JSON, не объект,
// bed или wake не в виде 'HH:MM', fall не целое 0…120, пара actualWake/sleepMin
// битая. Ничего не пишет: незаполненный раздел и есть отсутствие ключа
export function loadSleep() {
  try {
    const raw = localStorage.getItem(SLEEP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (sleepTimeMinutes(parsed.bed) === null) return null;
    if (sleepTimeMinutes(parsed.wake) === null) return null;

    // Засыпание читается тем же правилом, что и поле ввода: строка '20'
    // из чужой записи принимается, 20.5 и 200 — нет
    const fall = sleepFallMinutes(parsed.fall);
    if (fall === null) return null;

    // Пары в записи нет вовсе — это версия 1, а не порча: подставляется цель,
    // «встаю в своё время», и запись читается как читалась. Пара есть, но
    // битая — запись отбрасывается целиком: битое значение не чинится
    // подстановкой, иначе поле на экране разошлось бы с хранилищем
    let actualWake = parsed.wake;
    let sleepMin = sleepDurationMinutes(parsed.bed, fall, parsed.wake);
    if (parsed.actualWake !== undefined || parsed.sleepMin !== undefined) {
      if (sleepTimeMinutes(parsed.actualWake) === null) return null;
      if (!Number.isInteger(parsed.sleepMin) ||
          parsed.sleepMin < 0 || parsed.sleepMin >= SLEEP_MAX_MINUTES) return null;
      actualWake = parsed.actualWake;
      sleepMin = parsed.sleepMin;
    }

    // Пары realWake/realSleepMin в записи нет вовсе — это версия 1 или 3:
    // подставляется «встал по плану», факт равен плану. Пара есть, но
    // половинчатая или битая — запись отбрасывается целиком, как и пара
    // actualWake/sleepMin выше: длительность из неё сверяется с полями,
    // и подстановка разошлась бы с тем, что человек ввёл
    let realWake = null;
    let realSleepMin = null;
    if (parsed.realWake !== null && parsed.realWake !== undefined ||
        parsed.realSleepMin !== null && parsed.realSleepMin !== undefined) {
      if (sleepTimeMinutes(parsed.realWake) === null) return null;
      if (!Number.isInteger(parsed.realSleepMin) ||
          parsed.realSleepMin < 0 || parsed.realSleepMin >= SLEEP_MAX_MINUTES) return null;
      if (sleepDurationMinutes(parsed.bed, fall, parsed.realWake) !== parsed.realSleepMin) return null;
      realWake = parsed.realWake;
      realSleepMin = parsed.realSleepMin;
    }

    // Признак исключения — только true. Прочее значение (строка, число)
    // читается как false, но запись не роняет: спорный флаг — не повод
    // терять день, а «исключить» — это ровно true, ничего больше
    const excluded = parsed.excluded === true;

    // Истории может не быть вовсе — это запись версий 1–2, и её возраст,
    // а не порча: раздел читается как читался, а история заводится пустой
    // и наполнится при следующем сохранении формы. История есть, но
    // не массив — теряется только она: три опоры расчёта важнее дневника,
    // как счётчик уразы важнее её истории (§5)
    return {
      version: SLEEP_VERSION,
      bed: parsed.bed,
      fall: fall,
      wake: parsed.wake,
      actualWake: actualWake,
      sleepMin: sleepMin,
      realWake: realWake,
      realSleepMin: realSleepMin,
      excluded: excluded,
      history: validSleepHistory(parsed.history),
    };
  } catch (e) {
    return null;
  }
}
// Запись ключа. Проверки те же, что при чтении: неверный набор не пишется
// вовсе, а не подменяется дефолтом. Пара actualWake/sleepMin здесь обязательна,
// хотя при чтении её отсутствие — признак версии 1: пишем только полный набор,
// а неполный оставляем версии 1. Сохранённая пара обязана сходиться с полями —
// время из неё и уходит в историю, — поэтому проверяется и это. Отложенная
// отправка ставится здесь же: запись входит в снимок узла и в файл копии
// восьмым разделом (§5)
export function saveSleep(sleep) {
  if (!sleep || typeof sleep !== 'object') return;
  if (sleepTimeMinutes(sleep.bed) === null) return;
  if (sleepTimeMinutes(sleep.wake) === null) return;
  const fall = sleepFallMinutes(sleep.fall);
  if (fall === null) return;
  if (sleepTimeMinutes(sleep.actualWake) === null) return;
  if (!Number.isInteger(sleep.sleepMin) ||
      sleep.sleepMin < 0 || sleep.sleepMin >= SLEEP_MAX_MINUTES) return;
  if (sleepDurationMinutes(sleep.bed, fall, sleep.actualWake) !== sleep.sleepMin) return;

  // Пара realWake/realSleepMin: фактический подъём. Правила те же, что у пары
  // actualWake/sleepMin: смешанные состояния (одно задано, другое нет) —
  // не писать. realWake задан — realSleepMin обязан быть целым 0…1439
  // и сходиться с sleepDurationMinutes(bed, fall, realWake)
  const realWake = sleep.realWake !== undefined ? sleep.realWake : null;
  const realSleepMin = sleep.realSleepMin !== undefined ? sleep.realSleepMin : null;
  if (realWake !== null && sleepTimeMinutes(realWake) === null) return;
  if (realWake === null && realSleepMin !== null) return;
  if (realWake !== null) {
    if (realSleepMin === null) return;
    if (!Number.isInteger(realSleepMin) ||
        realSleepMin < 0 || realSleepMin >= SLEEP_MAX_MINUTES) return;
    if (sleepDurationMinutes(sleep.bed, fall, realWake) !== realSleepMin) return;
  }

  // Признак исключения — только true. Прочее значение (строка, число)
  // читается как false, но запись не роняет: спорный флаг — не повод
  // терять день, а «исключить» — это ровно true, ничего больше
  const excluded = sleep.excluded === true;

  // История ведётся тем же сохранением, что и ядро: каждое сохранение формы
  // кладёт день в дневник. Прежняя история берётся из хранилища, а не из
  // аргумента: вызывающему нечего о ней знать, а передача её снаружи означала
  // бы, что любой вызов без неё стирает дневник. Читается она тем же
  // loadSleep(): копится в дневник только то, что прошло проверку. Дата —
  // день сохранения формы: раздел заполняют перед сном, и другой даты
  // у записи нет
  const previous = loadSleep();
  const entry = {
    date: toISODate(new Date()),
    bed: sleep.bed,
    fall: fall,
    wake: sleep.wake,
    actualWake: sleep.actualWake,
    sleepMin: sleep.sleepMin,
    realWake: realWake,
    realSleepMin: realSleepMin,
    excluded: excluded,
  };

  if (!safeSetItem(SLEEP_KEY, JSON.stringify({
    version: SLEEP_VERSION,
    bed: sleep.bed,
    fall: fall,
    wake: sleep.wake,
    actualWake: sleep.actualWake,
    sleepMin: sleep.sleepMin,
    realWake: realWake,
    realSleepMin: realSleepMin,
    excluded: excluded,
    history: sleepHistoryEntry(previous ? previous.history : [], entry),
  }))) return false;
  bus.emit('data:changed');
  return true;
}
