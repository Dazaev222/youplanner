// Слияние облачного снимка с локальным состоянием. Гонка бэкапов двух
// устройств (аудит 2026-10-31): PUT затирает узел целиком, и правки, которые
// другое устройство записало после нашей последней сверки, гибли молча.
// Теперь перед отправкой снимок с сервера сливается с локальным состоянием,
// и наверх уходит объединение, а не перезапись.
//
// Правила по разделам:
//   habits, records, sleep.history, qazaLog.entries — коллекции с ключами
//   (id привычки, дата дня, тройка записи журнала): сливаются аддитивно,
//   локальные элементы не пропадают никогда;
//   habits особая оговорка: привычка, чьё надгробие удаления (tombstones)
//   не старше метки раздела habits снимка, в ветке extra не привозится —
//   иначе удаление отменялось бы каждой сверкой (B.3);
//   qaza, prayer, fast, schedule, скаляры сна — цельные объекты: применяются
//   с сервера, только если метка раздела (sectionTs, fallback updatedAt)
//   строго новее нашей последней сверки, и только когда нет правки, которой
//   сервер ещё не видел (pending);
//   archive — производные месячные сводки: объединение по месяцам;
//   tombstones — надгробия удалённых привычек: слияние по max(ts) на id,
//   аддитивно, метка раздела не участвует (надгробие не воскрешается).
//
// При pending (правка ещё не уезжала наверх) слияние консервативнее: коллекции
// только «заполняют дыры» (день/привычка/день сна, которых локально нет),
// цельные разделы и журнал каза не трогаются вовсе — иначе серверное снятое
// состояние стёр бы несработавшую локальную правку или вернул бы отменённую
// запись журнала (dropLastQazaLog). Модуль чистый: ни bus, ни хранилища —
// только функции над данными; записи делает applyMergedFromCloud (sync.js).
import {
  hasData, validCloudArchive, validCloudFast, validCloudHabits,
  validCloudPrayer, validCloudQaza, validCloudQazaLog, validCloudRecords,
  validCloudSchedule, validCloudSleep, validCloudTombstones,
} from './validators.js';
import { validQazaLogEntries } from '../data/qaza.js';
import { validSleepHistory } from '../data/sleep.js';

// Метка свежести раздела из снимка. Снимки до введения sectionTs метки не
// несут — тогда свежесть раздела равна свежести всего снимка.
export function sectionTsOf(cloud, section, fallbackTs) {
  const map = cloud && cloud.sectionTs;
  const value = map && typeof map === 'object' ? Number(map[section]) : NaN;
  if (Number.isFinite(value)) return value;
  return Number(fallbackTs) || 0;
}

// Надгробия удалённых привычек: слияние по max(ts) на id, аддитивно.
// Надгробие никогда не «воскрешается»: отсутствие пары на чужой стороне
// локальную не отменяет — снятие метки локальное решение устройства
// (pruneResolvedTombstones), а не содержимое снимка. Обе стороны приходят
// уже очищенными (loadTombstones/validCloudTombstones), битые значения
// и здесь отбрасываются — защита от вызова с сырыми данными.
export function mergeTombstonesById(localTombstones, cloudTombstones) {
  const merged = {};
  const sides = [localTombstones, cloudTombstones];
  for (let s = 0; s < sides.length; s++) {
    const side = sides[s];
    if (!side || typeof side !== 'object' || Array.isArray(side)) continue;
    const ids = Object.keys(side);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const ts = side[id];
      // Только числа по типу: мягкое приведение сделало бы из null и ''
      // нулевую метку — надгробие «с самого начала времён»
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) continue;
      if (merged[id] === undefined || ts > merged[id]) merged[id] = ts;
    }
  }
  return merged;
}

// Привычки: объединение по id. Порядок локального списка сохраняется,
// чужие привычки дописываются в конец в своём порядке. Совпадающий id:
// при cloudWins объект сервера, иначе локальный — список и так видел
// серверную версию при прошлой сверке.
//
// opts.tombstones и opts.sectionTs (необязательно, B.3): ветка extra не
// привозит привычку, чьё надгробие не старше метки раздела habits снимка —
// иначе удалённая на этом устройстве привычка воскресала бы с сервера.
// Метка раздела НОВЕЕ надгробия — чужая правка привычки победила, привычка
// привозится как раньше; равные метки читаются консервативно — удаление
// считается последней известной правкой, привычка не привозится.
export function mergeHabitsById(localHabits, cloudHabits, cloudWins, opts) {
  const options = opts || {};
  const tombstones = options.tombstones || {};
  const sectionTs = Number(options.sectionTs) || 0;
  const tombstoned = function (id) {
    const ts = tombstones[id];
    // Мусорная метка (не число) не блокирует: блокирует только настоящая
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
    return ts >= sectionTs;
  };
  const local = Array.isArray(localHabits) ? localHabits : [];
  const cloud = Array.isArray(cloudHabits) ? cloudHabits : [];
  const byId = {};
  const order = [];
  for (let i = 0; i < local.length; i++) {
    const habit = local[i];
    if (habit && habit.id != null && byId[habit.id] === undefined) {
      byId[habit.id] = habit;
      order.push(habit.id);
    }
  }
  const extra = [];
  for (let i = 0; i < cloud.length; i++) {
    const habit = cloud[i];
    if (!habit || habit.id == null) continue;
    if (byId[habit.id] !== undefined) {
      if (cloudWins) byId[habit.id] = habit;
    } else if (!tombstoned(habit.id)) {
      byId[habit.id] = habit;
      extra.push(habit.id);
    }
  }
  const merged = [];
  for (let i = 0; i < order.length; i++) merged.push(byId[order[i]]);
  for (let i = 0; i < extra.length; i++) merged.push(byId[extra[i]]);
  return merged;
}

// Записи по дням. День, которого локально нет, приезжает с сервера целиком;
// существующий день при pending не трогается (удаление поля на этом
// устройстве не должно воскрешаться), при !pending — слияние по полям:
// поле, которое есть только локально, сохраняется, разошедшиеся значения
// уходят серверной стороне (её снимок новее нашей последней сверки).
export function mergeRecordsByDay(localRecords, cloudRecords, cloudWins) {
  const merged = Object.assign({}, localRecords);
  const dates = Object.keys(cloudRecords);
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const cloudDay = cloudRecords[date];
    if (!cloudDay || typeof cloudDay !== 'object' || Array.isArray(cloudDay)) continue;
    if (!Object.prototype.hasOwnProperty.call(merged, date)) {
      merged[date] = cloudDay;
      continue;
    }
    if (!cloudWins) continue;
    const day = Object.assign({}, merged[date]);
    const fields = Object.keys(cloudDay);
    for (let j = 0; j < fields.length; j++) {
      const field = fields[j];
      if (!Object.prototype.hasOwnProperty.call(day, field)) {
        day[field] = cloudDay[field];
        continue;
      }
      if (JSON.stringify(day[field]) !== JSON.stringify(cloudDay[field])) {
        day[field] = cloudDay[field];
      }
    }
    merged[date] = day;
  }
  return merged;
}

// История сна: одна запись на день, дни не удаляются. Совпадающий день:
// при cloudWins запись сервера, иначе локальная. Список сортируется по дате —
// детерминированный JSON, стабильные сравнения при следующем слиянии.
export function mergeSleepHistories(localHistory, cloudHistory, cloudWins) {
  const local = Array.isArray(localHistory) ? localHistory : [];
  const cloud = Array.isArray(cloudHistory) ? cloudHistory : [];
  const byDate = {};
  const order = [];
  for (let i = 0; i < local.length; i++) {
    const entry = local[i];
    if (entry && entry.date && byDate[entry.date] === undefined) {
      byDate[entry.date] = entry;
      order.push(entry.date);
    }
  }
  for (let i = 0; i < cloud.length; i++) {
    const entry = cloud[i];
    if (!entry || !entry.date) continue;
    if (byDate[entry.date] === undefined) {
      byDate[entry.date] = entry;
      order.push(entry.date);
    } else if (cloudWins) {
      byDate[entry.date] = entry;
    }
  }
  order.sort();
  const merged = [];
  for (let i = 0; i < order.length; i++) merged.push(byDate[order[i]]);
  return merged;
}

// Запись о сне: скаляры (bed/wake/fall и пары) по правилу цельных разделов,
// история — аддитивно при любом раскладе.
function mergeSleepEntry(localSleep, cloudSleep, cloudWinsCore, cloudWinsHistory) {
  if (!cloudSleep || typeof cloudSleep !== 'object' || Array.isArray(cloudSleep)) {
    return localSleep;
  }
  if (!localSleep || typeof localSleep !== 'object' || Array.isArray(localSleep)) {
    return cloudSleep;
  }
  const history = validSleepHistory(
    mergeSleepHistories(localSleep.history, cloudSleep.history, cloudWinsHistory)
  );
  const base = cloudWinsCore ? cloudSleep : localSleep;
  return Object.assign({}, base, { history: history });
}

// Журнал каза: записи аддитивны. Совпадение даты, намаза и источника в обеих
// сторонах — одна и та же запись, приехавшая синком: дубль не заводим. Ровно
// одинаковые записи внутри одной стороны сохраняются (два ручных добавления
// одного намаза за день — законная история). Окно журнала (since) не
// переезжает: правило «журнал с since, до него h6» привязано к нему, и сдвиг
// границы менял бы уже посчитанные дни (§5, qazaDayCounts).
export function mergeQazaLogEntries(localEntries, cloudEntries) {
  const local = Array.isArray(localEntries) ? localEntries : [];
  const cloud = Array.isArray(cloudEntries) ? cloudEntries : [];
  const localKeys = {};
  for (let i = 0; i < local.length; i++) {
    const entry = local[i];
    if (entry) localKeys[entry.date + '|' + entry.namaz + '|' + entry.source] = true;
  }
  const merged = local.slice();
  const addedKeys = {};
  for (let i = 0; i < cloud.length; i++) {
    const entry = cloud[i];
    if (!entry) continue;
    const key = entry.date + '|' + entry.namaz + '|' + entry.source;
    if (localKeys[key] || addedKeys[key]) continue;
    addedKeys[key] = true;
    merged.push(entry);
  }
  merged.sort(function (a, b) {
    if (!a || !b) return 0;
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });
  return merged;
}

// ── Архив: объединение месячных сводок ──────────────────────────────────────
// Сводки — производные данные (пересчитываются при каждой архивации),
// поэтому месяц с сервера заменяет локальный месяц без разбору: расхождение
// возможно только у устройств с разными поколениями детализации.

function mergeMonthsPart(localPart, cloudPart) {
  return {
    months: Object.assign(
      {},
      localPart && localPart.months,
      cloudPart && cloudPart.months
    ),
  };
}

function mergeFastArchive(localPart, cloudPart) {
  const merged = mergeMonthsPart(localPart, cloudPart);
  const candidates = [];
  if (localPart && typeof localPart.since === 'string') candidates.push(localPart.since);
  if (cloudPart && typeof cloudPart.since === 'string') candidates.push(cloudPart.since);
  candidates.sort();
  if (candidates.length > 0) merged.since = candidates[0];
  return merged;
}

function mergeArchive(localArchive, cloudArchive) {
  if (!cloudArchive || typeof cloudArchive !== 'object' || Array.isArray(cloudArchive)) {
    return localArchive;
  }
  if (!localArchive || typeof localArchive !== 'object' || Array.isArray(localArchive)) {
    return cloudArchive;
  }
  return {
    version: typeof localArchive.version === 'number' ? localArchive.version : 1,
    sleep: mergeMonthsPart(localArchive.sleep, cloudArchive.sleep),
    fast: mergeFastArchive(localArchive.fast, cloudArchive.fast),
    qaza: mergeMonthsPart(localArchive.qaza, cloudArchive.qaza),
    records: mergeMonthsPart(localArchive.records, cloudArchive.records),
  };
}

// Главная точка входа. Возвращает слитый снимок той же формы, что local, или
// null, если сливать нечего: сервер не новее последней сверки — всё, что на
// нём было к прошлому обмену, локально уже есть, и PUT уходит как раньше.
export function mergeCloudIntoLocal(local, cloud, opts) {
  const options = opts || {};
  const pending = !!options.pending;
  const localTs = Number(options.localTs) || 0;
  if (!cloud || typeof cloud !== 'object' || Array.isArray(cloud)) return null;
  const cloudTs = Number(cloud.updatedAt) || 0;
  if (cloudTs <= localTs) return null;

  const merged = {
    habits: local.habits,
    records: local.records,
    qaza: local.qaza,
    prayer: local.prayer,
    fast: local.fast,
    qazaLog: local.qazaLog,
    sleep: local.sleep,
    schedule: local.schedule,
    archive: local.archive,
    tombstones: local.tombstones,
  };

  // Надгробия приезжают вместе со снимком и нужны дважды: слиянию привычек
  // ниже (не вернуть удалённое) и самому разделу (слияние по max(ts)).
  // Снимки до введения надгробий раздела не несут — тогда слияние идёт
  // только с локальными.
  const cloudTombstones = validCloudTombstones(cloud.tombstones);
  if (cloudTombstones && hasData(cloudTombstones)) {
    merged.tombstones = mergeTombstonesById(local.tombstones, cloudTombstones);
  }

  // Коллекции с ключами: аддитивное слияние при любом раскладе. При pending —
  // только «заполнение дыр» (cloudWins=false): существующие локально элементы
  // не трогаются, приезжают лишь отсутствующие.
  if (validCloudHabits(cloud.habits) && hasData(cloud.habits)) {
    // Ветке extra видны и локальные надгробия, и приехавшие с этим снимком:
    // снимок только что принят к слиянию, его метки — часть одного решения
    const tombstonesForHabits = cloudTombstones
      ? mergeTombstonesById(local.tombstones, cloudTombstones)
      : local.tombstones;
    merged.habits = mergeHabitsById(local.habits, cloud.habits, !pending, {
      tombstones: tombstonesForHabits,
      sectionTs: sectionTsOf(cloud, 'habits', cloudTs),
    });
  }
  if (validCloudRecords(cloud.records) && hasData(cloud.records)) {
    merged.records = mergeRecordsByDay(local.records, cloud.records, !pending);
  }

  if (pending) {
    // Правка, которой сервер не видел: цельные разделы не применяем вовсе —
    // они затёрли бы её. Сну хватает «заполнения дыр» по истории.
    if (validCloudSleep(cloud.sleep) && hasData(cloud.sleep)) {
      merged.sleep = mergeSleepEntry(local.sleep, cloud.sleep, false, false);
    }
  } else {
    const cloudWins = function (section) {
      return sectionTsOf(cloud, section, cloudTs) > localTs;
    };
    if (validCloudQaza(cloud.qaza) && hasData(cloud.qaza) && cloudWins('qaza')) {
      merged.qaza = cloud.qaza;
    }
    if (validCloudPrayer(cloud.prayer) && hasData(cloud.prayer) && cloudWins('prayer')) {
      merged.prayer = cloud.prayer;
    }
    if (validCloudFast(cloud.fast) && hasData(cloud.fast) && cloudWins('fast')) {
      merged.fast = cloud.fast;
    }
    if (validCloudSchedule(cloud.schedule) && cloudWins('schedule')) {
      merged.schedule = cloud.schedule;
    }
    if (validCloudSleep(cloud.sleep) && hasData(cloud.sleep)) {
      merged.sleep = mergeSleepEntry(local.sleep, cloud.sleep, cloudWins('sleep'), true);
    }
  }

  // Журнал каза: аддитивное слияние только без pending — pending-правка может
  // быть отменой записи (dropLastQazaLog), и возврат записи с сервера сломал
  // бы отмену. Журнала локально нет — берём серверный целиком.
  if (!pending && validCloudQazaLog(cloud.qazaLog) && hasData(cloud.qazaLog)) {
    if (local.qazaLog) {
      merged.qazaLog = {
        version: local.qazaLog.version,
        since: local.qazaLog.since,
        entries: validQazaLogEntries(
          mergeQazaLogEntries(local.qazaLog.entries, cloud.qazaLog.entries)
        ),
      };
    } else {
      merged.qazaLog = cloud.qazaLog;
    }
  }

  merged.archive = mergeArchive(local.archive, cloud.archive);
  return merged;
}
