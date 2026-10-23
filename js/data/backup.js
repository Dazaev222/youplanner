// Версия формата резервной копии. Растёт, если меняется состав полей файла:
// версия 2 добавила раздел tasks, версия 3 — раздел prayer, версия 4 —
// время у привычки и уровень у записи (§8), версия 5 — раздел fast (§11x),
// версия 6 — раздел qazaLog (§5), 7 — раздел sleep, 8 — история сна (§11ab),
// 10 — раздел tasks снят, 11 — раздел schedule (§11ac).
// Разбор принимает файлы ровно этой версии: расписание ходит разделом целиком,
// и старые копии (до 11) расписание за собой не тянут — их отвергаем, чтобы
// не соединять два поколения формата.
const BACKUP_VERSION = 11;

// Что попадает в файл. Метка синхронизации и режим главного экрана — состояние
// устройства, а не данные, поэтому в копию не входят. Координат может не быть;
// тогда раздел уходит пустым объектом и читается по общим правилам.
function buildBackup() {
  const backup = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    habits: loadHabits(),
    records: loadRecords(),
    qaza: loadQaza(),
    prayer: loadPrayer() || {},
    schedule: loadSchedule(),
  };

  // Счётчика уразы может не быть вовсе: отсутствие ключа — это первый запуск,
  // и записывать в файл нечего. Пустым объектом тут не отделаешься, как
  // у координат: разбор считает fast без remaining битым и отверг бы
  // собственную копию. Поэтому раздела просто нет — старые файлы и файлы
  // без счётчика читаются одинаково, и текущий счётчик они не трогают.
  const fast = loadFast();
  if (fast) backup.fast = fast;

  // Журнала выполнений может не быть по той же причине: ключа нет — заводить
  // нечего, а пустым объектом не отделаешься: разбор считает qazaLog без
  // since битым и отверг бы собственную копию.
  const qazaLog = loadQazaLog();
  if (qazaLog) backup.qazaLog = qazaLog;

  // Записи о сне может не быть по той же причине: ключа нет — заводить
  // нечего, а пустым объектом не отделаешься: разбор считает sleep без
  // bed, wake или fall битым и отверг бы собственную копию.
  const sleep = loadSleep();
  if (sleep) backup.sleep = sleep;

  return backup;
}
// Разбор файла копии. Возвращает данные или null, если файл не подходит:
// непонятный файл не должен затирать рабочие данные.
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
    // Копии прошлых версий (например, v10-файлы) отвергаются так же, как
    // битые: раздел schedule у них может отсутствовать целиком, и соединять
    // поколения формата нельзя — файл обязан быть ровно BACKUP_VERSION
    if (data.version !== undefined &&
        (typeof data.version !== 'number' ||
         data.version !== BACKUP_VERSION)) return null;
  } catch (e) {
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Array.isArray(data.habits)) return null;
  if (!data.records || typeof data.records !== 'object' || Array.isArray(data.records)) return null;
  if (data.qaza !== undefined &&
      (!data.qaza || typeof data.qaza !== 'object' || Array.isArray(data.qaza))) return null;
  // Старый раздел задач отвергает файл целиком, до применения любых данных.
  if (data.tasks !== undefined) return null;
  if (data.prayer !== undefined &&
      (!data.prayer || typeof data.prayer !== 'object' || Array.isArray(data.prayer))) return null;
  // Раздел fast необязателен, но если он есть — проверяется целиком:
  // не объект, остаток не число и история не массив роняют разбор.
  // Так битый счётчик не подменит рабочий нулём или мусором.
  if (data.fast !== undefined &&
      (!data.fast || typeof data.fast !== 'object' || Array.isArray(data.fast))) return null;
  if (data.fast && (!Number.isFinite(data.fast.remaining) || data.fast.remaining < 0)) return null;
  if (data.fast && !Array.isArray(data.fast.history)) return null;
  // История чистится после проверок: битая запись внутри копии разбор
  // не роняет, а молча отбрасывается (§5, validFastHistory)
  if (data.fast) data.fast.history = validFastHistory(data.fast.history);

  // Раздел qazaLog необязателен, но если он есть — проверяется так же
  // целиком: не объект, since не дата и entries не массив роняют разбор.
  // Так битый журнал не подменит рабочий — пустым или мусором, который
  // при следующем чтении пропал бы вовсе (§5, loadQazaLog).
  if (data.qazaLog !== undefined &&
      (!data.qazaLog || typeof data.qazaLog !== 'object' ||
        Array.isArray(data.qazaLog))) return null;
  if (data.qazaLog && !validQazaLogDate(data.qazaLog.since)) return null;
  if (data.qazaLog && !Array.isArray(data.qazaLog.entries)) return null;
  // Записи чистятся после проверок: битая запись внутри entries разбор
  // не роняет, а молча отбрасывается (§5, validQazaLogEntries)
  if (data.qazaLog) data.qazaLog.entries = validQazaLogEntries(data.qazaLog.entries);

  // Раздел sleep необязателен, но если он есть — проверяется целиком:
  // не объект, bed или wake не в виде 'HH:MM' и fall не целое 0…120
  // роняют разбор. Так битая запись о сне не подменит рабочую (§5).
  if (data.sleep !== undefined &&
      (!data.sleep || typeof data.sleep !== 'object' ||
       Array.isArray(data.sleep))) return null;
  if (data.sleep) {
    // Время проверяется тем же разбором, что и при чтении ключа: он один
    // знает и про тип, и про часы 0…23, и про минуты 0…59. Своя регулярка
    // пропускала '25:00' и '99:99' — файл разбирался, а следующий loadSleep()
    // возвращал null, и заведённая запись пропадала
    if (sleepTimeMinutes(data.sleep.bed) === null) return null;
    if (sleepTimeMinutes(data.sleep.wake) === null) return null;
    if (!Number.isInteger(data.sleep.fall) ||
        data.sleep.fall < 0 || data.sleep.fall > 120) return null;

    // Пара actualWake/sleepMin есть только у файла версии 2 и моложе: файл
    // без неё — старая копия, и разбирается как разбирался, а loadSleep()
    // подставит недостающее целью. Пара есть, но битая — отказ целиком,
    // иначе loadSleep() на следующем чтении вернул бы null и подменил
    // заведённую запись пустотой
    if (data.sleep.actualWake !== undefined || data.sleep.sleepMin !== undefined) {
      if (sleepTimeMinutes(data.sleep.actualWake) === null) return null;
      if (!Number.isInteger(data.sleep.sleepMin) ||
          data.sleep.sleepMin < 0 || data.sleep.sleepMin >= SLEEP_MAX_MINUTES) return null;
    }

    // Пара realWake/realSleepMin и флаг excluded — версия 4. Файл без них
    // разбирается как раньше: значения подставляются null, null, false. Файл
    // с ними проверяется по тем же правилам, что loadSleep: realWake — null
    // или время суток, realSleepMin — null или целое 0…1439, смешанные
    // состояния — отказ разбора
    if (data.sleep.realWake !== undefined || data.sleep.realSleepMin !== undefined) {
      if (data.sleep.realWake === null && data.sleep.realSleepMin === null) {
        // Оба null — «встал по плану», допустимо
      } else if (data.sleep.realWake === null || data.sleep.realSleepMin === null) {
        return null; // Половина пары — отказ
      } else {
        if (sleepTimeMinutes(data.sleep.realWake) === null) return null;
        if (!Number.isInteger(data.sleep.realSleepMin) ||
            data.sleep.realSleepMin < 0 ||
            data.sleep.realSleepMin >= SLEEP_MAX_MINUTES) return null;
        if (sleepDurationMinutes(data.sleep.bed, data.sleep.fall, data.sleep.realWake) !==
            data.sleep.realSleepMin) return null;
      }
    }
    if (data.sleep.excluded !== undefined && typeof data.sleep.excluded !== 'boolean') return null;

    // История необязательна, как и у уразы: файл версии 7 её не знает, и он
    // разбирается как разбирался. История есть, но не массив — отказ целиком:
    // запись легла бы в ключ, а следующий loadSleep() отбросил бы историю,
    // и она бы молча пропала. Битые элементы внутри массива разбор, наоборот,
    // не роняют — они отбрасываются (validSleepHistory, §5)
    if (data.sleep.history !== undefined && !Array.isArray(data.sleep.history)) return null;
    if (data.sleep.history) data.sleep.history = validSleepHistory(data.sleep.history);
  }

  return data;
}
// Замена локальных данных копией. Пишем в localStorage напрямую: saveHabits и
// saveQaza поставили бы по отправке на каждый ключ, а нужен один PUT на замену.
// Раздела qaza в файле может не быть — тогда очередь остаётся текущей.
function applyBackup(data) {
  localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(data.habits));
  localStorage.setItem(STORAGE_KEYS.records, JSON.stringify(data.records));
  invalidateRecordsCache();
  if (data.qaza) localStorage.setItem(QAZA_STORAGE_KEY, JSON.stringify(data.qaza));
  if (data.prayer && typeof data.prayer === 'object' && !Array.isArray(data.prayer)) {
    localStorage.setItem(PRAYER_KEY, JSON.stringify(data.prayer));
  }
  // Счётчик уразы заменяется целиком, как очередь. Раздела в файле
  // нет — текущий счётчик остаётся: импорт его не стирает.
  if (data.fast && typeof data.fast === 'object' && !Array.isArray(data.fast)) {
    localStorage.setItem(FAST_KEY, JSON.stringify(data.fast));
  }
  // Журнал выполнений каза заменяется целиком, как счётчик уразы. Раздела
  // в файле нет — текущий журнал остаётся: импорт его не стирает.
  if (data.qazaLog && typeof data.qazaLog === 'object' &&
      !Array.isArray(data.qazaLog)) {
    localStorage.setItem(QAZA_LOG_KEY, JSON.stringify(data.qazaLog));
  }
  // Запись о сне заменяется целиком, как счётчик уразы. Раздела в файле
  // нет — текущая запись остаётся: импорт её не стирает.
  if (data.sleep && typeof data.sleep === 'object' &&
      !Array.isArray(data.sleep)) {
    localStorage.setItem(SLEEP_KEY, JSON.stringify(data.sleep));
  }
  // Расписание заменяется целиком, как запись о сне. validCloudSchedule —
  // та же проверка, что для снимка с сервера; раздела в файле нет —
  // текущее расписание остаётся: импорт его не стирает.
  if (data.schedule && validCloudSchedule(data.schedule)) {
    localStorage.setItem(STORAGE_KEYS.schedule, JSON.stringify(data.schedule));
  }

  // Слой данных не трогает состояние интерфейса и рендеры: замена данных
  // целиком — событие data:replaced, подписчик в проводке обновит appState,
  // qazaState и перерисует экраны (как sync:applied у серверного снимка)
  bus.emit('data:changed');
  bus.emit('data:replaced');
}
