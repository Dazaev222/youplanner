import { bus } from './core/bus.js';
import { addDays, getMonthDatesToToday, getWeekStart, parseISODate, toISODate } from './core/dates.js';
import { cssEscape, escapeHtml, pad2, showToast } from './core/dom.js';
import { applyBackup, buildBackup, parseBackup } from './data/backup.js';
import { FAST_HISTORY_MIN, FAST_KEY, FAST_MAX_INPUT, FAST_SOURCE_ADD, FAST_SOURCE_DONE, FAST_VERSION, addFast, fastRemainingLabel, loadFast, markFastDone, parseFastInput, setFast, validFastHistory } from './data/fast.js';
import { CHOICE_OPTIONS, DEFAULT_HABITS, HABIT_TYPES, addHabit, defaultHabit, hasRecords, loadHabits, removeHabit, saveHabits, updateHabit } from './data/habits.js';
import { markMigration, migrateDropTasks, migratePressHabit } from './data/migrations.js';
import { PRAYER_KEY, PRAYER_LABELS, PRAYER_MADHHABS, PRAYER_MADHHAB_LABELS, PRAYER_METHODS, PRAYER_METHOD_DEFAULT, PRAYER_METHOD_LABELS, PRAYER_ORDER, PRAYER_SHADOW, PRAYER_WINDOWS, loadPrayer, prayerDateISO, prayerMinutes, prayerRound, prayerTimes, savePrayer } from './data/prayer.js';
import { NAMAZ_LABELS, NAMAZ_ORDER, QAZA_DAILY_GOAL, QAZA_HABIT_ID, QAZA_LOG_KEY, QAZA_LOG_VERSION, QAZA_STORAGE_KEY, addMissedQaza, getQazaPlan, kazaDayFor, loadQaza, loadQazaLog, markQazaDone, normalizeQazaCursor, qazaLogDoneByDay, qazaTotalRemaining, saveQaza, undoQazaDone, validQazaLogEntries } from './data/qaza.js';
import { LEVEL_LATE, LEVEL_ON_TIME, LEVEL_TWO_MIN, QURAN_HABIT_ID, SPORT_VALUES, SPORT_VALUE_LABELS, calcProgress, defaultLevel, getEntry, getRecord, habitMarkDate, hasLevelPopup, invalidateRecordsCache, isChoiceLevelHabit, isLevelHabit, loadRecords, writeHabitEntry } from './data/records.js';
import { SCHEDULE_TYPES, loadSchedule, saveSchedule } from './data/schedule.js';
import { SLEEP_KEY, actualWakeTime, loadSleep, saveSleep, sleepAnchors, sleepAverageMinutes, sleepCycleLabel, sleepCycleTimes, sleepDurationMinutes, sleepFallMinutes, sleepFormatDuration, sleepTimeLabel, sleepTimeMinutes, validSleepHistory } from './data/sleep.js';
import { STATS_PERIOD_BOXES, habitBestStreak, habitCurrentStreak, habitMarked, habitMarkedDays, habitsAveragePercent, loadStatsPeriod, qazaDoneOn, qazaStreak, saveStatsPeriod, statsPeriodDates } from './data/stats.js';
import { STORAGE_KEYS } from './data/storage.js';
import { BACKUP_LIMIT, FIREBASE_BACKUPS_URL, FIREBASE_URL, SYNC_DEBOUNCE_MS, SYNC_STATUS_MS, SYNC_TS_KEY } from './data/sync.js';
import { APP_BUILD, APP_VERSION, CIRCLE_CENTER, CIRCLE_LENGTH, CIRCLE_RADIUS, CIRCLE_SIZE, MONTHS_GENITIVE, MONTHS_NOMINATIVE, MONTHS_SHORT } from './data/ui.js';
import { clearSyncPending, markSyncPending, normalizing, saveNormalized, syncPending, syncTs } from './sync/state.js';
import { hasData, validCloudFast, validCloudHabits, validCloudPrayer, validCloudQaza, validCloudQazaLog, validCloudRecords, validCloudSchedule, validCloudSleep } from './sync/validators.js';

/* YouPlanner — слой данных.
   Модульная сборка утрачена (§3 Spec.md), поэтому весь скрипт — один файл,
   а функции объявлены в глобальной области. Никаких внешних загрузок
   и обёрток-IIFE. */

/* ---------- Синхронизация с Firebase (REST, без SDK) --------------------- */

export let syncTimer = null;
export let syncStatusTimer = null;
// Идёт обмен с сервером. Свои же сохранения в этот момент не должны ставить
// встречную отправку: loadQaza() зовёт saveQaza(), а syncToCloud() зовёт
// loadQaza() — без флага каждая отправка планировала бы следующую.
export let syncing = false;
// Первая сверка с сервером пройдена. До неё отправлять нельзя: локальное
// состояние ещё не сверено с серверным, и PUT затёр бы на сервере чужие
// данные. Гонка настоящая: loadQaza() при чтении зовёт saveQaza(), то есть
// на каждом старте ставит отправку, а ответа сервера при медленной сети
// ещё нет — отправка уходила вперёд ответа и затирала чужой снимок.
export let cloudReady = false;
// Сервер ответил на сверку. Отдельно от cloudReady: тот взводится и при
// недоступном сервере, а пустая таблица должна отличать «не загрузили»
// от «человек всё удалил» (§13).
export let cloudReachable = false;

// --- Проверки разделов снимка с сервера -----------------------------------
//
// Один снимок приходит из Firebase целиком, и каждый раздел в нём проверяется
// содержимым, а не только типом «объект/массив»: раздел, не прошедший проверку,
// не применяется, а локальный остаётся как есть. Проверки повторяют те, что уже
// работают при чтении ключей и в parseBackup: молитвы — как loadPrayer, сон —
// как loadSleep, истории чистятся теми же valid* при записи раздела.

// Применяет данные с сервера. Пишем прямо в localStorage: saveHabits/saveQaza
// поставили бы отправку и вернули бы на сервер только что полученное.
// Пустой раздел на сервере не затирает непустой локальный: это след неполного
// снимка, а не осознанное удаление — иначе чужая пустая копия съест записи.
export function applyCloudData(data, ts) {
  syncing = true;
  try {
    // Снимок локального берём под флагом: loadHabits/loadQaza при первом
    // прогоне пишут дефолты и иначе поставили бы отправку
    const local = {
      habits: loadHabits(),
      records: loadRecords(),
      qaza: loadQaza(true),
      prayer: loadPrayer() || {},
      fast: loadFast() || null,
      qazaLog: loadQazaLog() || null,
      sleep: loadSleep() || null,
      schedule: loadSchedule(),
    };

    // Снимок считается принятым, если хотя бы один раздел прошёл проверку
    // и был применён. Только тогда двигаем SYNC_TS_KEY: отметка времени
    // на отброшенных данных заставила бы считать сервер свежее, чем он есть.
    let cloudApplied = false;

    if (validCloudHabits(data.habits) && (hasData(data.habits) || !hasData(local.habits))) {
      localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(data.habits));
      cloudApplied = true;
    }
    if (validCloudRecords(data.records) &&
        (hasData(data.records) || !hasData(local.records))) {
      localStorage.setItem(STORAGE_KEYS.records, JSON.stringify(data.records));
      invalidateRecordsCache();
      cloudApplied = true;
    }
    // Раздел каза не применяется, пока есть неотправленная правка:
    // серверной копии она ещё не видела, и снимок затёр бы её молча.
    if (!syncPending && validCloudQaza(data.qaza) &&
        (hasData(data.qaza) || !hasData(local.qaza))) {
      localStorage.setItem(QAZA_STORAGE_KEY, JSON.stringify(data.qaza));
      cloudApplied = true;
    }
    // Координаты — один раздел целиком. Пустой объект с сервера
    // не затирает заданные координаты: это след неполного снимка.
    if (validCloudPrayer(data.prayer) &&
        (hasData(data.prayer) || !hasData(local.prayer))) {
      localStorage.setItem(PRAYER_KEY, JSON.stringify(data.prayer));
      cloudApplied = true;
    }
    // Счётчик уразы — один раздел целиком, как координаты. Ноль
    // здесь значимое значение: объект с remaining: 0 непуст по ключам,
    // поэтому hasData даёт true и счётчик с сервера применяется. Пустым
    // (null) с сервера приходит только «счётчика нет» — он не затирает
    // заведённый счётчик на этом устройстве.
    // История из снимка чистится, но раздел из-за неё не отклоняется:
    // битая запись — не повод терять счётчик (§5, validFastHistory)
    // Остаток обязан быть целым неотрицательным числом: снимок вида
    // { remaining: "15" } или { junk: 1 } ключами непуст и раньше проходил
    // проверку целиком. Дальше в счётчик писалась строка или undefined,
    // undefined исчезал при JSON.stringify, следующий loadFast() возвращал
    // null — и экран уразы показывал форму первого запуска, теряя остаток
    // и историю. Раздел, не прошедший проверку, не применяется вовсе:
    // локальный счётчик остаётся нетронутым (уровень защиты 1, §11aa, В2)
    if (validCloudFast(data.fast) &&
        (hasData(data.fast) || !hasData(local.fast))) {
      localStorage.setItem(FAST_KEY, JSON.stringify({
        version: FAST_VERSION,
        remaining: data.fast.remaining,
        history: validFastHistory(data.fast.history),
      }));
      cloudApplied = true;
    }
    // Журнал выполнений каза — отдельный раздел, один целиком, как счётчик
    // уразы. Пустой журнал (entries: []) ключами непуст, поэтому hasData даёт
    // true и он применяется, затирая локальный: «журнала нет» выражается
    // только null. Битый since раздел не пропускает — иначе журнал записался
    // бы и при следующем чтении пропал бы вовсе (§5, loadQazaLog).
    // Записи из снимка чистятся, но раздел из-за них не отклоняется:
    // битая запись — не повод терять историю (§5, validQazaLogEntries)
    // Журнал каза защищён тем же правилом: неотправленная правка дороже
    // серверного снимка, который её ещё не содержит.
    if (!syncPending && validCloudQazaLog(data.qazaLog) &&
        (hasData(data.qazaLog) || !hasData(local.qazaLog))) {
      localStorage.setItem(QAZA_LOG_KEY, JSON.stringify({
        version: QAZA_LOG_VERSION,
        since: data.qazaLog.since,
        entries: validQazaLogEntries(data.qazaLog.entries),
      }));
      cloudApplied = true;
    }
    // Запись о сне — отдельный раздел, один целиком, как счётчик уразы.
    // Пустой объект с сервера не затирает заведённую запись: он приходит
    // следом неполного снимка, а не осознанным удалением (§5)
    if (validCloudSleep(data.sleep) &&
        (hasData(data.sleep) || !hasData(local.sleep))) {
      localStorage.setItem(SLEEP_KEY, JSON.stringify(Object.assign({}, data.sleep, {
        history: validSleepHistory(data.sleep.history),
      })));
      cloudApplied = true;
    }
    // Расписание заменяется целиком, как запись о сне. Дефолтов здесь нет:
    // loadSchedule подставляет их сама, поэтому раздел с сервера, прошедший
    // проверку, применяется всегда — пустым он быть не может. Перерисовка
    // открытого экрана расписания — у подписчика sync:applied, вместе
    // с остальными экранами (§11v)
    if (validCloudSchedule(data.schedule)) {
      localStorage.setItem(STORAGE_KEYS.schedule, JSON.stringify(data.schedule));
      cloudApplied = true;
    }
    if (cloudApplied) localStorage.setItem(SYNC_TS_KEY, String(ts));

    appState.habits = loadHabits();
    qazaState = loadQaza(true);
  } finally {
    syncing = false;
  }

  bus.emit('sync:applied');
}

// Уступает ли локальное состояние серверному снимку. Правило одно на все
// сверки: снимок должен быть новее и не спорить с правкой, которой сервер
// ещё не видел. Второе условие закрывает гонку первых секунд: правка, сделанная
// во время незавершённой сверки, уходит наверх (init после сверки зовёт
// syncToCloud), а пришедший снимок её уже не трогает — иначе правка пропала бы,
// не дойдя до сервера. Другое устройство получит её при следующей сверке.
export function cloudSnapshotWins(serverTs) {
  return serverTs > syncTs() && !syncPending;
}

// Забирает данные с сервера. Промис разрешается true, если на сервере пусто —
// тогда init отправляет наверх локальную копию.
// Ошибки сети глотаем: приложение работает на локальных данных.
export function syncFromCloud() {
  return fetch(FIREBASE_URL + '.json')
    .then(function (response) {
      if (!response.ok) throw new Error('нет ответа');
      return response.json();
    })
    .then(function (data) {
      cloudReachable = true;
      if (!data || typeof data !== 'object') {
        return { reachable: true, serverEmpty: true };
      }

      const serverTs = Number(data.updatedAt) || 0;
      if (!cloudSnapshotWins(serverTs)) {
        // Снимок отвергнут, но привычек у нас нет вовсе — значит правка,
        // которой сервер ещё не видел, привычек не касалась: править было
        // нечего. Берём серверный список, иначе пустой уехал бы наверх
        // и стёр серверный.
        if (Array.isArray(data.habits) && hasData(data.habits) && !hasData(loadHabits())) {
          localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(data.habits));
          // Список только что сменился, а DOM остался прежним: показываем его
          // тем же путём, что и применённый снимок (§11v)
          appState.habits = loadHabits();
          bus.emit('sync:applied');
        }
        return { reachable: true, serverEmpty: false };
      }

      applyCloudData(data, serverTs);
      return { reachable: true, serverEmpty: false };
    })
    .catch(function () {
      cloudReachable = false;
      return { reachable: false, serverEmpty: false };
    });
}

// Единовременно идёт один обмен. Флаг syncing ниже защищает только
// синхронные участки и не держится во время await fetch: параллельные
// вызовы (debounce-таймер + уход со вкладки + ручная кнопка) конкурировали
// за узел бэкапов GET→PUT, теряя записи истории, и могли записать SYNC_TS
// задним числом. Вызов во время идущего обмена ставится в очередь и
// выполняется сразу после его конца: правка, случившаяся уже после
// сериализации тела PUT, доедет повторным обменом, а не будет ждать
// следующей правки.
export let syncExchange = null;
export let syncQueued = false;

export function syncToCloud() {
  if (syncExchange) {
    syncQueued = true;
    return syncExchange;
  }
  function settled() {
    syncExchange = null;
    if (syncQueued) {
      syncQueued = false;
      syncToCloud();
    }
  }
  syncExchange = syncToCloudNow().then(settled, settled);
  return syncExchange;
}

// Отправляет локальные данные наверх. Ключ времени пишется ПОСЛЕ успешного
// PUT: если отправка не дошла, локальная копия и в реальности не новее
// серверной, и завышенный таймстамп помешал бы принять следующий снимок.
export function syncToCloudNow() {
  const ts = Date.now();

  // Сначала копия, потом запись: сбой копирования данные всё равно отправит.
  // Заодно оттуда берётся предыдущий узел — он нужен телу запроса.
  return Promise.resolve()
    .then(backupCloudSnapshot)
    .catch(function () { return null; })
    .then(function (previous) {
      return fetch(FIREBASE_URL + '.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: syncBody(ts, previous),
      }).then(function (response) {
        if (response.ok) {
          localStorage.setItem(SYNC_TS_KEY, String(ts));
          if (!syncTimer) clearSyncPending();
        }
        return response;
      });
    })
    .catch(function () {
      // Сеть отвалилась на PUT: до следующего успешного ответа сервер
      // считается недоступным, иначе cloudReachable залипает в true
      // и syncBody перестаёт беречь серверные привычки при пустом локальном списке.
      cloudReachable = false;
    });
}

// Тело PUT. Привычки берём локальные — кроме одного случая: сверка ни разу
// не дошла до сервера, а список у нас пуст. Пустой список здесь значит
// «не загрузили», а не «привычек нет», и PUT стёр бы серверные привычки,
// которых мы просто не видели. Тогда отправляем серверные (§13).
export function syncBody(ts, previous) {
  syncing = true;
  try {
    let habits = loadHabits();
    if (!cloudReachable && !hasData(habits) && previous && hasData(previous.habits)) {
      habits = previous.habits;
    }
    return JSON.stringify({
      habits: habits,
      records: loadRecords(),
      qaza: loadQaza(),
      prayer: loadPrayer() || {},
      // Счётчика нет — наверх уходит null. Ноль счётчиком быть не перестаёт:
      // объект с remaining: 0 остаётся объектом и уезжает как есть.
      fast: loadFast() || null,
      // Журнала нет — наверх уходит null. Пустой журнал (entries: [])
      // остаётся объектом и уезжает как есть.
      qazaLog: loadQazaLog() || null,
      // Записи о сне нет — наверх уходит null. Пустого объекта здесь быть
      // не может: loadSleep() возвращает либо полную запись, либо null.
      sleep: loadSleep() || null,
      schedule: loadSchedule(),
      updatedAt: ts,
    });
  } finally {
    syncing = false;
  }
}

// Кладёт в отдельный узел бэкапов копию того, что сейчас лежит на сервере:
// запись затирает чужой снимок, и без копии его не вернуть. Свежая версия
// сверху, всего не больше BACKUP_LIMIT — самая старая уходит. Пустой узел
// копировать нечего. Узел бэкапов — соседний корень (FIREBASE_BACKUPS_URL),
// а не ребёнок данных: иначе PUT основного узла стирал бы копии (см. выше).
// Возвращает предыдущий узел: не вышло записать копию — отправку это
// не отменяет, и узел всё равно нужен вызывающему.
export function backupCloudSnapshot() {
  return fetch(FIREBASE_URL + '.json')
    .then(function (response) {
      if (!response.ok) throw new Error('нет ответа');
      return response.json();
    })
    .then(function (previous) {
      if (!previous || typeof previous !== 'object') return null;

      // Снимки старой схемы могли тащить вложенный backups от прежнего
      // расположения: в новую историю его не кладём, иначе копии
      // вкладывались бы друг в друга и раздували узел.
      const snapshot = Object.assign({}, previous);
      delete snapshot.backups;

      return fetch(FIREBASE_BACKUPS_URL + '.json')
        .then(function (response) {
          if (!response.ok) throw new Error('нет ответа');
          return response.json();
        })
        .then(function (list) {
          const items = Array.isArray(list) ? list : [];
          items.unshift(snapshot);
          return fetch(FIREBASE_BACKUPS_URL + '.json', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items.slice(0, BACKUP_LIMIT)),
          });
        })
        .then(function () { return previous; }, function () { return previous; });
    })
    .catch(function () { return null; });
}

// Отложенная отправка: несколько правок подряд дают один PUT
export function scheduleSync() {
  // Правка взводит syncPending всегда (кроме записей при чтении): серверный
  // снимок застарел — данные правки ещё не дошли наверх. Флаг встаёт и тогда,
  // когда синк уже идёт: таймер в этом случае не создаётся, но правку
  // заберёт текущий обмен или следующая отправка. До первой сверки
  // отправлять нельзя: локальное состояние ещё не сверено, а PUT затирает
  // узел целиком — правка отправится после ответа.
  if (!normalizing) markSyncPending();
  if (syncing) return;
  if (!cloudReady) return;

  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(function () {
    syncTimer = null;
    syncToCloud();
  }, SYNC_DEBOUNCE_MS);
}

// Надпись под кнопками ручной синхронизации гаснет сама
export function showSyncStatus(message) {
  const status = document.getElementById('settings-sync-status');
  if (!status) return;
  status.textContent = message;
  if (syncStatusTimer) clearTimeout(syncStatusTimer);
  syncStatusTimer = setTimeout(function () {
    syncStatusTimer = null;
    status.textContent = '';
  }, SYNC_STATUS_MS);
}

/* ---------- Экспорт и импорт данных -------------------------------------- */

// Скачивание резервной копии через Blob. Дата в имени — локальная, тем же
// toISODate, что и в записях: UTC-вариант сдвигал бы имя на день назад.
export function exportData() {
  const blob = new Blob([JSON.stringify(buildBackup(), null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = 'youplanner-backup-' + toISODate(new Date()) + '.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Импорт выбранного файла. Пока разбор не удался или пользователь не подтвердил
// замену, текущие данные не трогаются.
export function importData(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function () { onBackupRead(String(reader.result)); };
  reader.onerror = function () { alert('Не удалось прочитать файл.'); };
  reader.readAsText(file);
}

export function onBackupRead(text) {
  const data = parseBackup(text);
  if (!data) {
    alert('Не удалось прочитать файл. Это резервная копия YouPlanner?');
    return;
  }

  if (!confirm('Импорт заменит все текущие данные. Продолжить?')) return;

  applyBackup(data);
}

/* ==========================================================================
   YouPlanner — логика интерфейса

   Скрипт не модуль и не IIFE: все имена объявляются в глобальной области
   видимости. Функции слоя данных только ВЫЗЫВАЮТСЯ, но никогда
   не переобъявляются.

   Ключевая архитектурная особенность: ячейки таблицы перерисовываются целиком
   (renderTable), поэтому обработчики событий навешиваются ОДИН РАЗ на
   #habits-table и #habit-list — делегирование. Иначе после перерисовки
   слушатели на ячейках терялись бы.
   ========================================================================== */

/* --- Состояние приложения ------------------------------------------------ */

export const appState = {
  habits: [],      // Habit[]
  weekStart: null, // Date — понедельник отображаемой недели
};

// Мобильная вёрстка: -1 не выбрана, 0 Пн–Чт, 1 Пт–Вс
export let mobileDayPage = -1;

// Режим главного экрана на телефоне: 'day' — карточки за сегодня,
// 'week' — привычная таблица недели. Выбор переживает перезапуск.
export let mainView = localStorage.getItem('youplanner.mainView') || 'day';

// Тип дня в разделе „Расписание“. На этом этапе не сохраняется между запусками —
// хранение добавится вместе с редактированием через Настройки.
export let scheduleType = 'weekday';

// Тип дня в редакторе расписания (schedule-edit): самостоятельная переменная,
// чтобы выбор в просмотре и в редакторе не перескакивал друг за другом.
export let scheduleEditType = 'weekday';

/* --- Константы ----------------------------------------------------------- */

/* --- Вспомогательные функции (не пересекаются с именами data.js) --------- */

// Привычка из текущего состояния по id
export function findHabit(habitId) {
  for (let i = 0; i < appState.habits.length; i++) {
    if (appState.habits[i].id === habitId) return appState.habits[i];
  }
  return null;
}

// Даты отображаемой недели: понедельник и шесть следующих дней
export function getWeekDates(weekStart) {
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(toISODate(addDays(weekStart, i)));
  return dates;
}

// Прогресс привычки за отображаемую неделю. Знаменатель всегда 7 дней,
// поэтому с каждым новым понедельником круг естественно обнуляется.
export function weekPercent(habit) {
  const weekStart = appState.weekStart;
  if (!weekStart) return 0;
  return calcProgress(habit, getWeekDates(weekStart));
}

// Прогресс привычки за месяц: с 1-го числа по сегодня включительно
export function monthPercent(habit) {
  const weekStart = appState.weekStart;
  if (!weekStart) return 0;
  const dates = getMonthDatesToToday(weekStart.getFullYear(), weekStart.getMonth());
  return calcProgress(habit, dates);
}

// Высота, на которую клавиатура перекрывает окно. В медиа-запросе телефона
// шторки стоят по bottom и поднимаются на эту величину: без неё клавиатура
// накрывает панель формы вместе с полем ввода.
export function syncSheetToKeyboard() {
  if (!window.visualViewport) return;
  const offset = Math.max(0,
    window.innerHeight - window.visualViewport.height
    - window.visualViewport.offsetTop);
  document.documentElement.style.setProperty('--keyboard-offset', offset + 'px');
}

/* --- Разметка (строки, чтобы собрать таблицу одним присвоением) ---------- */

// Опции выпадающего списка типов привычек
export function typeOptionsMarkup(current) {
  let html = '';
  for (let i = 0; i < HABIT_TYPES.length; i++) {
    const type = HABIT_TYPES[i];
    html += '<option value="' + escapeHtml(type.value) + '"' +
      (type.value === current ? ' selected' : '') + '>' + escapeHtml(type.label) + '</option>';
  }
  return html;
}

// Подпись типа привычки для экрана «Привычки»
export function habitTypeLabel(type) {
  for (let i = 0; i < HABIT_TYPES.length; i++) {
    if (HABIT_TYPES[i].value === type) return HABIT_TYPES[i].label;
  }
  return '';
}

// Опции выпадающего списка значений ячейки choice. У Спорта и Пресса свой
// список кодов и свои подписи (§3.1), у прочих привычек типа choice — общий.
export function choiceOptionsMarkup(current, habitId) {
  const isCoded = isChoiceLevelHabit(habitId);
  const codes = isCoded ? SPORT_VALUES : CHOICE_OPTIONS;

  let html = '<option value=""' + (current === '' ? ' selected' : '') + '>—</option>';
  for (let i = 0; i < codes.length; i++) {
    const option = codes[i];
    const label = isCoded ? SPORT_VALUE_LABELS[option] : option;
    html += '<option value="' + escapeHtml(option) + '"' +
      (option === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }
  return html;
}

// Класс границы поля отметки по уровню записи (§1.5). Уровня нет — класс
// не ставится, и поле остаётся с обычной рамкой --border.
export function levelClass(level) {
  if (level === LEVEL_ON_TIME) return ' is-on-time';
  if (level === LEVEL_LATE) return ' is-late';
  if (level === LEVEL_TWO_MIN) return ' is-two-min';
  return '';
}

// Маленькая кнопка вызова попапа уровня — только у Корана (§1.2)
export function levelButtonMarkup(habit, date) {
  const entry = getEntry(date, habit.id);
  const isSet = entry && entry.level ? ' is-set' : '';
  return '<button type="button" class="cell-level-btn' + isSet + '"' +
    ' data-habit-id="' + escapeHtml(habit.id) + '"' +
    ' data-date="' + escapeHtml(date) + '" aria-label="Как выполнено">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
    ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 9l6 6 6-6"></path></svg></button>';
}

// Разметка одной ячейки дня: <td class="cell" data-habit-id data-date>…</td>
export function cellMarkup(habit, date) {
  const entry = getEntry(date, habit.id);
  const value = entry ? entry.value : undefined;
  const dataAttrs = ' data-habit-id="' + escapeHtml(habit.id) + '"' +
    ' data-date="' + escapeHtml(date) + '"';
  let inner = '';

  if (habit.type === 'boolean') {
    // Чекбокс = true, кнопка «✗» = false, пусто = записи нет
    const checked = value === true ? ' checked' : '';
    const xActive = value === false ? ' is-active' : '';
    inner =
      '<input type="checkbox" class="cell-check"' + dataAttrs + checked +
      ' aria-label="Выполнено">' +
      '<button type="button" class="cell-x' + xActive + '"' + dataAttrs +
      ' aria-label="Не выполнено">✗</button>';
  } else if (habit.id === QAZA_HABIT_ID) {
    // Каза ведётся во вкладке «Каза-намазы», ячейка только показывает счётчик дня
    inner = qazaCellMarkup(date);
  } else if (habit.id === QURAN_HABIT_ID) {
    // Коран: инпут + кнопка уровня (как у обычной числовой привычки)
    const text = typeof value === 'number' ? String(value) : '';
    const withButton = hasLevelPopup(habit.id);
    inner = '<input type="number" class="cell-number' +
      levelClass(entry ? entry.level : null) + (withButton ? ' has-level-btn' : '') +
      '" min="0" step="1"' + dataAttrs +
      ' value="' + escapeHtml(text) + '" aria-label="Значение">';
    if (withButton) inner += levelButtonMarkup(habit, date);
  } else if (habit.type === 'number') {
    const text = typeof value === 'number' ? String(value) : '';
    // Класс нужен только мобильному медиа-запросу: там поле делит ширину
    // колонки с кнопкой попапа, иначе кнопка уезжает на вторую строку
    const withButton = hasLevelPopup(habit.id);
    inner = '<input type="number" class="cell-number' +
      levelClass(entry ? entry.level : null) + (withButton ? ' has-level-btn' : '') +
      '" min="0" step="1"' + dataAttrs +
      ' value="' + escapeHtml(text) + '" aria-label="Значение">';
    if (withButton) inner += levelButtonMarkup(habit, date);
  } else {
    const current = typeof value === 'string' ? value : '';
    inner = '<select class="cell-select' +
      levelClass(entry ? entry.level : null) + '"' + dataAttrs + ' aria-label="Значение">' +
      choiceOptionsMarkup(current, habit.id) + '</select>';
  }

  return '<td class="cell"' + dataAttrs + '>' + inner + '</td>';
}

// SVG-круг прогресса. percent — недельный процент (может быть больше 100),
// дуга при этом обрезается по 100%. monthPct — месячный процент, выводится
// второй строкой внутри круга.
export function circleMarkup(percent, habitId, monthPct) {
  const raw = Number(percent);
  const safe = isFinite(raw) ? raw : 0;
  const clamped = Math.min(Math.max(safe, 0), 100);
  const dashoffset = CIRCLE_LENGTH * (1 - clamped / 100);
  // Цвет ставим инлайновым стилем, чтобы он перебивал возможные правила CSS
  const strokeStyle = safe >= 100 ? 'stroke:var(--success)' : 'stroke:var(--accent)';
  const label = Math.round(safe) + '%';

  const monthRaw = Number(monthPct);
  const monthLabel = 'М: ' + Math.round(isFinite(monthRaw) ? monthRaw : 0) + '%';

  const idAttr = habitId === null || habitId === undefined
    ? '' : ' data-habit-id="' + escapeHtml(habitId) + '"';

  return '<svg class="progress-circle" viewBox="0 0 ' + CIRCLE_SIZE + ' ' + CIRCLE_SIZE + '"' +
    ' width="' + CIRCLE_SIZE + '" height="' + CIRCLE_SIZE + '"' +
    ' role="img" aria-label="Неделя ' + escapeHtml(label) +
    ', месяц ' + escapeHtml(monthLabel) + '"' + idAttr + '>' +
    '<circle class="progress-track" cx="' + CIRCLE_CENTER + '" cy="' + CIRCLE_CENTER + '"' +
    ' r="' + CIRCLE_RADIUS + '" fill="none" stroke="var(--border)" stroke-width="5"></circle>' +
    '<circle class="progress-arc" cx="' + CIRCLE_CENTER + '" cy="' + CIRCLE_CENTER + '"' +
    ' r="' + CIRCLE_RADIUS + '" fill="none" stroke-width="5" stroke-linecap="round"' +
    ' style="' + strokeStyle + '"' +
    ' stroke-dasharray="' + CIRCLE_LENGTH.toFixed(3) + '"' +
    ' stroke-dashoffset="' + dashoffset.toFixed(3) + '"' +
    ' transform="rotate(-90 ' + CIRCLE_CENTER + ' ' + CIRCLE_CENTER + ')"></circle>' +
    '<text x="' + CIRCLE_CENTER + '" y="27" class="progress-text" text-anchor="middle"' +
    ' dominant-baseline="central">' + escapeHtml(label) + '</text>' +
    '<text x="' + CIRCLE_CENTER + '" y="41" class="progress-month" text-anchor="middle"' +
    ' dominant-baseline="central">' + escapeHtml(monthLabel) + '</text>' +
    '</svg>';
}

/* --- Инициализация ------------------------------------------------------- */

// Что делать со списком привычек после первой сверки. Пустое хранилище само
// по себе не значит, что привычек нет: это «ещё не знаем». Дефолты пишутся
// только тогда, когда сервер ответил и подтвердил, что он пуст, — иначе
// пустая таблица честнее выдуманного списка (§13). Запись идёт под
// saveNormalized, поэтому syncPending она не взводит, а отправку забирает
// init: узел пуст, значит PUT и так уходит.
export function settleHabitsAfterSync(result) {
  const reachable = !!result && result.reachable === true;

  if (reachable && result.serverEmpty && !hasData(loadHabits())) {
    const defaults = DEFAULT_HABITS.map(function (h) { return defaultHabit(h.id); });
    saveNormalized(function () { saveHabits(defaults); });
    markMigration('press');
  }

  // Офлайн-первый запуск: сервер недоступен, локально привычек нет.
  // Сеем дефолты, чтобы таблица не была пустой.
  if (!reachable && !hasData(loadHabits())) {
    const offlineDefaults = DEFAULT_HABITS.map(function (h) { return defaultHabit(h.id); });
    saveNormalized(function () { saveHabits(offlineDefaults); });
    markMigration('press');
  }

  // Миграция ждёт конца сверки: до неё список ещё может приехать с сервера
  migratePressHabit();
}

export function init() {
  // Межвкладочная страховка: событие storage приходит только из других
  // вкладок, поэтому с write-through в текущей оно не конфликтует.
  window.addEventListener('storage', function (event) {
    if (event.key === null || event.key === STORAGE_KEYS.records) invalidateRecordsCache();
  });

  appState.habits = loadHabits();
  appState.weekStart = getWeekStart(new Date());

  // Начальные данные каза записываются при первом запуске, а не при открытии
  // вкладки: так состояние очереди существует до первого показа
  qazaState = loadQaza();

  renderHeader();
  renderMainView();
  updateFormFields();

  bindEvents();

  // Стартовый раздел ставим тем же переключателем, что и кнопки:
  // так главная вкладка сразу подсвечена, а таб-бар скрыт на ПК
  switchAppView('main');

  // Раз в минуту обновляются счётчик и окно намаза. Таймер один на приложение
  // и идёт всегда: вкладка может быть закрыта, а при её открытии экран всё
  // равно собирается заново. Старый таймер снимаем: повторный init не должен
  // оставлять второй интервал.
  if (prayerTimer) clearInterval(prayerTimer);
  prayerTimer = setInterval(prayerTick, 60000);

  // Пустой сервер заполняем своей копией, иначе забираем то, что там новее.
  // Только после этого разрешаем отправку: loadQaza() выше уже зовёт
  // saveQaza() → scheduleSync(), и если ответ сервера придёт позже задержки,
  // отправка уходила бы вперёд ответа и затирала чужой снимок (в том числе
  // привычек — пустой локальный список ложился на сервер вместо серверного).
  //
  // Сверка разрешает отправку при любом исходе, включая недоступный сервер:
  // приложение работает офлайн, и ждать сети, чтобы разрешить запись, значило
  // бы копить правки в syncPending без срока. Итог сверки берём через
  // Promise.resolve(), потому что fetch вызывается синхронно: его бросок
  // вылетел бы из syncFromCloud до возврата промиса, и .catch ниже его не
  // увидел бы. Отправка после неудачной сверки просто упадёт молча — это
  // штатный путь syncToCloud, а следующая правка отправит всё разом.
  Promise.resolve()
    .then(syncFromCloud)
    .catch(function () { return null; })
    .then(function (result) {
      // Дефолты и миграция — до cloudReady: запись под saveNormalized не
      // взводит syncPending, а отправку заберёт init ниже
      settleHabitsAfterSync(result);
      cloudReady = true;
      migrateDropTasks();
      // Накопленную правку забирает отправка, и приоритет локального на этом
      // исчерпан: оставленный флаг запирал бы применение серверных снимков
      // до конца сеанса.
      const pending = syncPending;
      clearSyncPending();
      if ((result && result.serverEmpty) || pending) syncToCloud();

      // Список привычек мог измениться только что — перерисовываем главную,
      // чтобы вместе с ним появилась или пропала пометка «не загружены»
      appState.habits = loadHabits();
      renderMainView();
    });
}

// Все обработчики навешиваются один раз. События внутри таблицы и списка
// привычек — делегированные, поэтому перерисовка не теряет слушатели.
export function bindEvents() {
  const table = document.getElementById('habits-table');
  if (table) {
    table.addEventListener('change', onTableChange);
    table.addEventListener('click', onTableClick);
  }

  const habitList = document.getElementById('habit-list');
  if (habitList) {
    habitList.addEventListener('click', onHabitListClick);
  }

  // Раздел «Настройки»: кнопка в шапке ПК и стрелка «Назад» внутри раздела
  const settingsButton = document.getElementById('settings-btn');
  if (settingsButton) {
    settingsButton.addEventListener('click', function () { switchAppView('settings'); });
  }

  const settingsBack = document.getElementById('settings-back');
  if (settingsBack) {
    settingsBack.addEventListener('click', function () { switchAppView('main'); });
  }

  // Вкладка «Молитвы»: кнопка в шапке каза, возврат в неё же
  const prayerButton = document.getElementById('prayer-btn');
  if (prayerButton) {
    prayerButton.addEventListener('click', function () { switchAppView('prayer'); });
  }

  const prayerBack = document.getElementById('prayer-back');
  if (prayerBack) {
    prayerBack.addEventListener('click', function () { switchAppView('qaza'); });
  }

  const prayerGeo = document.getElementById('prayer-geo');
  if (prayerGeo) prayerGeo.addEventListener('click', onPrayerGeo);

  const prayerSave = document.getElementById('prayer-save');
  if (prayerSave) prayerSave.addEventListener('click', onPrayerManualSave);

  const prayerShowAllButton = document.getElementById('prayer-show-all');
  if (prayerShowAllButton) prayerShowAllButton.addEventListener('click', onPrayerShowAll);

  // Экран настроек молитв: строка из Настроек, мазхаб и обновление координат
  const settingsPrayer = document.getElementById('settings-prayer');
  if (settingsPrayer) {
    settingsPrayer.addEventListener('click', function () { switchAppView('prayer-settings'); });
  }

  const prayerSettingsBack = document.getElementById('prayer-settings-back');
  if (prayerSettingsBack) {
    prayerSettingsBack.addEventListener('click', function () { switchAppView('settings'); });
  }

  const prayerMadhhab = document.getElementById('prayer-madhhab');
  if (prayerMadhhab) prayerMadhhab.addEventListener('change', onPrayerMadhhabChange);

  const prayerMethod = document.getElementById('prayer-method');
  if (prayerMethod) prayerMethod.addEventListener('change', onPrayerMethodChange);

  const prayerRefresh = document.getElementById('prayer-refresh');
  if (prayerRefresh) prayerRefresh.addEventListener('click', onPrayerRefresh);

  // Раздел «Статистика»: строка из Настроек, возврат в них же,
  // из категории каза — назад в хаб
  const settingsStats = document.getElementById('settings-stats');
  if (settingsStats) {
    settingsStats.addEventListener('click', function () { switchAppView('stats'); });
  }

  // Панель навигации статистики: кнопка в шапке, подложка и пункты списка.
  // Пункты — делегированием: экран живёт в data-stats-view, и обработчик
  // не переписывается, когда в панель добавляется строка
  const statsMenuBtn = document.getElementById('stats-menu-btn');
  if (statsMenuBtn) statsMenuBtn.addEventListener('click', openStatsMenu);

  const statsMenuBackdrop = document.getElementById('stats-menu-backdrop');
  if (statsMenuBackdrop) statsMenuBackdrop.addEventListener('click', closeStatsMenu);

  const statsMenu = document.getElementById('stats-menu');
  if (statsMenu) {
    statsMenu.addEventListener('click', function (event) {
      const item = event.target.closest('.stats-menu-item');
      if (!item) return;
      // У пунктов статистики экран лежит в data-stats-view, у «Цикла сна»
      // его нет: экран живёт вне раздела, и атрибут у него свой. Без этой
      // проверки switchAppView получил бы null и не открыл ничего
      if (item.hasAttribute('data-sleep-view')) {
        closeStatsMenu();
        switchAppView('sleep');
        return;
      }
      if (item.hasAttribute('data-stats-view')) {
        switchAppView(item.getAttribute('data-stats-view'));
      }
    });
  }

  // Стрелка аккордеона. Класс у неё свой, и делегирование по .stats-menu-item
  // её не ловит — обработчик отдельный. Раскрытие помечает панель классом
  // is-hub-open (по нему разворачивается иконка), а aria-expanded говорит
  // то же самое голосом
  const statsHubToggle = document.getElementById('stats-hub-toggle');
  const statsHubSub = document.getElementById('stats-hub-sub');
  if (statsHubToggle && statsHubSub && statsMenu) {
    statsHubToggle.addEventListener('click', function () {
      const willOpen = statsHubSub.hidden;
      statsHubSub.hidden = !willOpen;
      statsMenu.classList.toggle('is-hub-open', willOpen);
      statsHubToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  }

  // Строка «Цикл сна» в Настройках: на ПК это единственный вход в раздел,
  // на телефоне — второй, после пункта гамбургера
  const settingsSleep = document.getElementById('settings-sleep');
  if (settingsSleep) {
    settingsSleep.addEventListener('click', function () {
      switchAppView('sleep');
    });
  }

  // Экран «Цикл сна»: возврат туда, откуда вошли, и пересчёт при правке любого
  // поля. Слушаются оба события — колесо времени на телефоне присылает только change
  const sleepBack = document.getElementById('sleep-back');
  if (sleepBack) sleepBack.addEventListener('click', function () { switchAppView(sleepReturnView); });

  ['sleep-bed', 'sleep-fall', 'sleep-wake'].forEach(function (id) {
    const field = document.getElementById(id);
    if (!field) return;
    field.addEventListener('input', onSleepFieldChange);
    field.addEventListener('change', onSleepFieldChange);
  });

  // Галочка «встану по рекомендации» пересчитывает итог тем же обработчиком:
  // она меняет время для истории, а не только подсказку
  const sleepFollow = document.getElementById('sleep-follow-rec');
  if (sleepFollow) sleepFollow.addEventListener('change', onSleepFieldChange);

  // Галочка «встал по плану», поле фактического подъёма и галочка исключения
  // из статистики — все пересчитывают итог тем же обработчиком
  const sleepOnPlan = document.getElementById('sleep-on-plan');
  if (sleepOnPlan) sleepOnPlan.addEventListener('change', onSleepFieldChange);
  const sleepExcluded = document.getElementById('sleep-excluded');
  if (sleepExcluded) sleepExcluded.addEventListener('change', onSleepFieldChange);
  const sleepRealWake = document.getElementById('sleep-real-wake');
  if (sleepRealWake) {
    sleepRealWake.addEventListener('input', onSleepFieldChange);
    sleepRealWake.addEventListener('change', onSleepFieldChange);
  }

  // «Назад» из хаба ведёт туда, откуда в раздел вошли: на ПК это Настройки,
  // на телефоне — главная с гамбургером
  const statsBack = document.getElementById('stats-back');
  if (statsBack) statsBack.addEventListener('click', function () { switchAppView(statsReturnView); });

  const statsQazaBack = document.getElementById('stats-qaza-back');
  if (statsQazaBack) {
    statsQazaBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsRowQaza = document.getElementById('stats-row-qaza');
  if (statsRowQaza) {
    statsRowQaza.addEventListener('click', function () { switchAppView('stats-qaza'); });
  }

  const statsRowFast = document.getElementById('stats-row-fast');
  if (statsRowFast) {
    statsRowFast.addEventListener('click', function () { switchAppView('stats-fast'); });
  }

  const statsRowSleep = document.getElementById('stats-row-sleep');
  if (statsRowSleep) {
    statsRowSleep.addEventListener('click', function () { switchAppView('stats-sleep'); });
  }

  const statsFastBack = document.getElementById('stats-fast-back');
  if (statsFastBack) {
    statsFastBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsSleepBack = document.getElementById('stats-sleep-back');
  if (statsSleepBack) {
    statsSleepBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsRowHabits = document.getElementById('stats-row-habits');
  if (statsRowHabits) {
    statsRowHabits.addEventListener('click', function () { switchAppView('stats-habits'); });
  }

  const statsHabitsBack = document.getElementById('stats-habits-back');
  if (statsHabitsBack) {
    statsHabitsBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsHabitBack = document.getElementById('stats-habit-back');
  if (statsHabitBack) {
    statsHabitBack.addEventListener('click', function () { switchAppView('stats-habits'); });
  }

  // Строка списка привычек: id едет в data-habit-id, карточка читает его из
  // statsHabitId — так у выбора один источник, а не два. Слушатель один на
  // список: строк в нём столько же, сколько привычек у человека
  const statsHabitsList = document.getElementById('stats-habits-list');
  if (statsHabitsList) {
    statsHabitsList.addEventListener('click', function (event) {
      const row = event.target.closest('[data-habit-id]');
      if (!row) return;
      statsHabitId = row.getAttribute('data-habit-id');
      switchAppView('stats-habit');
    });
  }

  // Сегмент-контрол периодов. Категория берётся из id блока, а не из общей
  // переменной: у каждой категории свой период (§11y), поэтому выбор в каза
  // период привычек не трогает. Выбор запоминается на устройстве,
  // перерисовываются экраны только этой категории
  Object.keys(STATS_PERIOD_BOXES).forEach(function (id) {
    const box = document.getElementById(id);
    if (!box) return;
    const category = STATS_PERIOD_BOXES[id];
    box.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      if (!saveStatsPeriod(category, btn.getAttribute('data-period'))) return;
      renderStatsCategory(category);
    });
  });

  // Экран «Привычки» в настройках
  const settingsEdit = document.getElementById('settings-edit-habits');
  if (settingsEdit) {
    settingsEdit.addEventListener('click', function () { switchAppView('edit-habits'); });
  }

  const habitsEditBack = document.getElementById('habits-edit-back');
  if (habitsEditBack) {
    habitsEditBack.addEventListener('click', function () { switchAppView('settings'); });
  }

  const habitsEditAdd = document.getElementById('habits-edit-add');
  if (habitsEditAdd) habitsEditAdd.addEventListener('click', openModal);

  const habitsEditList = document.getElementById('habits-edit-list');
  if (habitsEditList) {
    habitsEditList.addEventListener('click', onHabitsEditClick);
    habitsEditList.addEventListener('change', onHabitsEditChange);
  }

  // Ручная синхронизация из настроек. Итог у неё тот же, что у первой:
  // пустой сервер засевает дефолты — иначе пустая таблица осталась бы и без
  // данных, и без пометки. Отправку ставит сама запись (§11t)
  const syncNow = document.getElementById('settings-sync-now');
  if (syncNow) {
    syncNow.addEventListener('click', function () {
      syncFromCloud().then(function (result) {
        settleHabitsAfterSync(result);
        appState.habits = loadHabits();
        renderMainView();
        showSyncStatus('Обновлено');
      });
    });
  }

  const syncPush = document.getElementById('settings-sync-push');
  if (syncPush) {
    syncPush.addEventListener('click', function () {
      syncToCloud().then(function () { showSyncStatus('Отправлено'); });
    });
  }

  // Экспорт и импорт данных
  const exportButton = document.getElementById('settings-export');
  if (exportButton) exportButton.addEventListener('click', exportData);

  const importButton = document.getElementById('settings-import');
  if (importButton) {
    importButton.addEventListener('click', function () {
      document.getElementById('settings-import-file').click();
    });
  }

  const importFile = document.getElementById('settings-import-file');
  if (importFile) {
    importFile.addEventListener('change', function () {
      importData(this.files && this.files[0]);
      // Значение сбрасывается сразу: иначе повторный выбор того же файла
      // не вызовет change — браузер считает файл уже выбранным
      this.value = '';
    });
  }

  const weekPrev = document.getElementById('week-prev');
  if (weekPrev) weekPrev.addEventListener('click', function () { changeWeek(-1); });

  const weekNext = document.getElementById('week-next');
  if (weekNext) weekNext.addEventListener('click', function () { changeWeek(1); });

  const weekToday = document.getElementById('week-today');
  if (weekToday) weekToday.addEventListener('click', goToday);

  const qazaButton = document.getElementById('qaza-btn');
  if (qazaButton) {
    qazaButton.addEventListener('click', function () { switchAppView('qaza'); });
  }

  const qazaBack = document.getElementById('qaza-back');
  if (qazaBack) {
    qazaBack.addEventListener('click', function () { switchAppView('main'); });
  }

  const scheduleBack = document.getElementById('schedule-back');
  if (scheduleBack) {
    scheduleBack.addEventListener('click', function () {
      switchAppView('main');
    });
  }

  // Нижний таб-бар: тот же переключатель разделов, что и у кнопок шапки
  const tabItems = document.querySelectorAll('#tab-bar .tab-item');
  for (let i = 0; i < tabItems.length; i++) {
    tabItems[i].addEventListener('click', function () {
      switchAppView(this.getAttribute('data-view'));
    });
  }

  const qazaUndoButton = document.getElementById('qaza-undo');
  if (qazaUndoButton) qazaUndoButton.addEventListener('click', onQazaUndo);

  const qazaPlanBox = document.getElementById('qaza-plan');
  if (qazaPlanBox) qazaPlanBox.addEventListener('click', onQazaDone);

  const qazaStartBox = document.getElementById('qaza-start');
  if (qazaStartBox) qazaStartBox.addEventListener('change', onQazaStartChange);

  const qazaAddBox = document.getElementById('qaza-add');
  if (qazaAddBox) qazaAddBox.addEventListener('change', onQazaAddPick);

  const qazaAddButton = document.getElementById('qaza-add-btn');
  if (qazaAddButton) qazaAddButton.addEventListener('click', onQazaAddSubmit);

  // Вкладка «Ураза»: кнопка в шапке каза, возврат в неё же и три кнопки
  // обычного экрана. Форма ввода — одна на все случаи, поэтому и
  // «Сохранить» у неё одно
  const fastButton = document.getElementById('fast-btn');
  if (fastButton) {
    fastButton.addEventListener('click', function () { switchAppView('fast'); });
  }

  const fastBack = document.getElementById('fast-back');
  if (fastBack) {
    fastBack.addEventListener('click', function () { switchAppView('qaza'); });
  }

  const fastInitSave = document.getElementById('fast-init-save');
  if (fastInitSave) fastInitSave.addEventListener('click', onFastInitSave);

  const fastInitCancel = document.getElementById('fast-init-cancel');
  if (fastInitCancel) fastInitCancel.addEventListener('click', onFastInitCancel);

  const fastDoneButton = document.getElementById('fast-done');
  if (fastDoneButton) fastDoneButton.addEventListener('click', onFastDone);

  const fastAddButton = document.getElementById('fast-add');
  if (fastAddButton) fastAddButton.addEventListener('click', onFastAdd);

  const fastEditButton = document.getElementById('fast-edit');
  if (fastEditButton) fastEditButton.addEventListener('click', onFastEdit);

  // Enter в поле — то же, что «Сохранить»: экран первый, и лишний тап
  // по кнопке на телефоне читается как помеха
  const fastInitValue = document.getElementById('fast-init-value');
  if (fastInitValue) {
    fastInitValue.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') onFastInitSave();
    });
  }

  // Вкладка «Расписание»: кнопка в шапке ПК и таб-бар (таб-бар — общим циклом выше)
  const scheduleButton = document.getElementById('schedule-btn');
  if (scheduleButton) {
    scheduleButton.addEventListener('click', function () {
      switchAppView('schedule');
    });
  }

  const scheduleSwitch = document.getElementById('schedule-switch');
  if (scheduleSwitch) {
    scheduleSwitch.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      const value = btn.getAttribute('data-schedule');
      if (SCHEDULE_TYPES.indexOf(value) === -1) return;
      scheduleType = value;
      renderScheduleView();
    });
  }

  // Клавиатура меняет visualViewport, а не resize окна
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncSheetToKeyboard);
    window.visualViewport.addEventListener('scroll', syncSheetToKeyboard);
  }

  // Поднимать поле ввода над клавиатурой при фокусе внутри шторок
  document.addEventListener('focusin', function(e) {
    const input = e.target;
    if (!input || !input.matches) return;
    const sheetPanel = input.closest('.sheet-panel');
    if (!sheetPanel) return;
    requestAnimationFrame(function() {
      input.scrollIntoView({ block: 'nearest' });
      sheetPanel.style.paddingBottom = '40px';
    });
  });

  document.addEventListener('focusout', function(e) {
    const input = e.target;
    if (!input || !input.matches) return;
    const sheetPanel = input.closest('.sheet-panel');
    if (!sheetPanel) return;
    sheetPanel.style.paddingBottom = '';
  });

  const levelOptions = document.querySelectorAll('#level-sheet .level-option');
  for (let i = 0; i < levelOptions.length; i++) {
    levelOptions[i].addEventListener('click', onLevelPick);
  }

  // Подложка и «Отмена» попапа уровня
  const levelClosers = document.querySelectorAll('[data-level-sheet-close]');
  for (let i = 0; i < levelClosers.length; i++) {
    levelClosers[i].addEventListener('click', closeLevelSheet);
  }

  // Кнопка закрытия и подложка помечены атрибутом data-modal-close
  const closers = document.querySelectorAll('[data-modal-close]');
  for (let i = 0; i < closers.length; i++) {
    closers[i].addEventListener('click', closeModal);
  }
  const modalClose = document.getElementById('modal-close');
  if (modalClose) modalClose.addEventListener('click', closeModal);

  // Уход со вкладки — повод не потерять неотправленную правку: если она есть
  // (syncTimer стоит), debounce снимаем и отправляем сразу — приложение могут
  // закрыть раньше, чем истекут его 1.5с. Без правки не делаем ничего: иначе
  // каждое переключение вкладки клало бы в узел бэкапов одинаковый снимок и
  // вытесняло настоящую историю. Возврат — повод проверить, нет ли свежих.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (!syncTimer) return;
      clearTimeout(syncTimer);
      syncTimer = null;
      syncToCloud();
      return;
    }
    syncFromCloud();
  });

  // Escape разбирает окна по слоям: сначала верхнее меню, потом то, что под
  // ним, и только затем саму форму. Иначе форма закрылась бы, оставив меню
  // висеть на экране.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    // Панель статистики — верхний слой и в цепочке проверяется первой:
    // она висит поверх таб-бара, и Escape обязан снять сначала её
    if (isStatsMenuOpen()) {
      closeStatsMenu();
      return;
    }

    const modal = document.getElementById('habit-modal');
    if (modal && !modal.hidden) closeModal();

    // Попап уровня открывается из таблицы, но снимается
    // тем же правилом: Escape гасит верхнюю шторку за раз
    const levelSheet = document.getElementById('level-sheet');
    if (levelSheet && !levelSheet.hidden) {
      closeLevelSheet();
      return;
    }

  });

  const form = document.getElementById('habit-form');
  if (form) form.addEventListener('submit', onFormSubmit);

  const formType = document.getElementById('form-type');
  if (formType) formType.addEventListener('change', updateFormFields);

  const formCancel = document.getElementById('form-cancel');
  if (formCancel) {
    formCancel.addEventListener('click', function () {
      if (form) form.reset();
      updateFormFields();
      setFormError('');
    });
  }

  // Переключатель «День / Неделя». Выбор запоминается на будущие запуски
  const switchBox = document.getElementById('main-view-switch');
  if (switchBox) {
    switchBox.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      mainView = btn.getAttribute('data-view');
      localStorage.setItem('youplanner.mainView', mainView);
      renderMainView();
    });
  }

  // Карточки дня: те же обработчики, что у таблицы
  const dayBox = document.getElementById('day-cards');
  if (dayBox) {
    dayBox.addEventListener('change', onTableChange);
    dayBox.addEventListener('click', onTableClick);
  }

  // Переключатель половин недели на телефоне
  const dayTabFirst = document.getElementById('day-tab-1');
  if (dayTabFirst) {
    dayTabFirst.addEventListener('click', function () {
      mobileDayPage = 0;
      renderTable();
    });
  }

  const dayTabSecond = document.getElementById('day-tab-2');
  if (dayTabSecond) {
    dayTabSecond.addEventListener('click', function () {
      mobileDayPage = 1;
      renderTable();
    });
  }

  // Смена ширины окна переводит таблицу в другой режим: набор дней разный.
  // В iOS Safari сворачивание адресной строки тоже шлёт resize, режим при этом
  // не меняется — перерисовываем только на настоящей смене режима.
  let lastIsMobile = isMobileView();
  window.addEventListener('resize', function () {
    const now = isMobileView();
    if (now !== lastIsMobile) {
      lastIsMobile = now;
      renderMainView();
      // Ширина сменилась — таб-бар появляется или исчезает вместе с режимом
      document.getElementById('tab-bar').hidden = !now;
    }
  });

  // Редактор расписания: вход из Настроек, выход стрелкой «Назад»
  const btnEditSchedule = document.getElementById('settings-edit-schedule');
  if (btnEditSchedule) {
    btnEditSchedule.addEventListener('click', function () {
      switchAppView('schedule-edit');
      renderScheduleEditView();
    });
  }

  const btnScheduleEditBack = document.getElementById('schedule-edit-back');
  if (btnScheduleEditBack) {
    btnScheduleEditBack.addEventListener('click', function () {
      switchAppView('settings');
    });
  }

  // Тип дня в редакторе: подсветку кнопки держим здесь, а не отдельной
  // marking-функцией — последний выбор не сохраняется между экранами
  const scheduleEditSwitch = document.getElementById('schedule-edit-switch');
  if (scheduleEditSwitch) {
    scheduleEditSwitch.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      scheduleEditType = btn.getAttribute('data-schedule-type');

      scheduleEditSwitch.querySelectorAll('.view-switch-btn').forEach(function(b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');

      renderScheduleEditView();
    });
  }

  const formScheduleAdd = document.getElementById('schedule-add-form');
  if (formScheduleAdd) formScheduleAdd.addEventListener('submit', onScheduleAddSubmit);

  const listScheduleEdit = document.getElementById('schedule-edit-list');
  if (listScheduleEdit) listScheduleEdit.addEventListener('click', onScheduleEditListClick);
}

/* --- Шапка и таблица ----------------------------------------------------- */

// Подпись недели: «Сентябрь 2026 · 7–13 сентября» либо
// «31 авг – 6 сент 2026», если неделя пересекает границу месяца.
export function renderHeader() {
  const label = document.getElementById('week-label');
  if (!label || !appState.weekStart) return;

  const weekStart = appState.weekStart;
  const weekEnd = addDays(weekStart, 6);
  const dayStart = weekStart.getDate();
  const dayEnd = weekEnd.getDate();
  const monthStart = weekStart.getMonth();
  const monthEnd = weekEnd.getMonth();
  const yearStart = weekStart.getFullYear();
  const yearEnd = weekEnd.getFullYear();

  let text;
  if (monthStart === monthEnd && yearStart === yearEnd) {
    text = MONTHS_NOMINATIVE[monthStart] + ' ' + yearStart +
      ' · ' + dayStart + '–' + dayEnd + ' ' + MONTHS_GENITIVE[monthStart];
  } else {
    text = dayStart + ' ' + MONTHS_SHORT[monthStart] + ' – ' +
      dayEnd + ' ' + MONTHS_SHORT[monthEnd] + ' ' + yearEnd;
  }

  label.textContent = text;
}

/* --- Мобильная вёрстка --------------------------------------------------- */

// Порог тот же, что у медиа-запроса в стилях: ширина узкого телефона
export function isMobileView() {
  return window.matchMedia('(max-width: 700px)').matches;
}

// Индексы дней недели (0 — понедельник), попадающие в текущий вид.
// На ПК это вся неделя, на телефоне — выбранная половина.
export function getVisibleDays() {
  if (!isMobileView()) return [0, 1, 2, 3, 4, 5, 6];
  return mobileDayPage === 1 ? [4, 5, 6] : [0, 1, 2, 3];
}

// Первый выбор половины: показываем ту, где сегодняшний день.
// Дальше выбор пользователя не перебиваем.
export function initMobileDayPage() {
  if (mobileDayPage !== -1) return;
  const d = new Date().getDay(); // 0 — воскресенье, 1–6 — понедельник…суббота
  mobileDayPage = (d >= 1 && d <= 4) ? 0 : 1;
}

// Переключатель половин виден только в мобильном режиме;
// активная кнопка показывает текущую половину
export function updateMobileTabs() {
  const box = document.getElementById('mobile-day-tabs');
  if (box) box.hidden = !isMobileView();

  const tab1 = document.getElementById('day-tab-1');
  const tab2 = document.getElementById('day-tab-2');
  if (tab1) tab1.classList.toggle('is-active', mobileDayPage === 0);
  if (tab2) tab2.classList.toggle('is-active', mobileDayPage === 1);
}

/* --- Режим «День» -------------------------------------------------------- */

// Карточки дня — мобильный режим: на ПК и в режиме «Неделя» его нет
export function isMainDayView() {
  return isMobileView() && mainView === 'day';
}

// Единая точка перерисовки главного экрана: выбирает между карточками дня
// и таблицей недели и приводит видимость блоков в соответствие режиму
export function renderMainView() {
  const switchBox = document.getElementById('main-view-switch');
  if (switchBox) {
    switchBox.hidden = !isMobileView();
    switchBox.querySelectorAll('.view-switch-btn').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === mainView);
    });
  }

  const dayBox = document.getElementById('day-cards');
  const tabs = document.getElementById('mobile-day-tabs');
  const weekNav = document.getElementById('week-nav');
  const table = document.getElementById('habits-table');

  // Пустая таблица при неотвеченной сверке — это «данные не загружены».
  // Пустая таблица после ответа сервера — «человек всё удалил», и молчит
  const note = document.getElementById('habits-note');
  if (note) note.hidden = !(cloudReady && !cloudReachable && appState.habits.length === 0);

  if (isMainDayView()) {
    if (dayBox) dayBox.hidden = false;
    if (tabs) tabs.hidden = true;
    if (weekNav) weekNav.hidden = true;
    if (table) table.hidden = true;
    renderDayCards();
  } else {
    if (dayBox) dayBox.hidden = true;
    if (tabs) tabs.hidden = !isMobileView();
    if (weekNav) weekNav.hidden = false;
    if (table) table.hidden = false;
    renderTable();
  }
}

// По карточке на привычку за сегодня. Контролы те же, что в ячейках таблицы,
// но крупнее — размеры заданы правилами .day-card .cell-* в медиа-запросе.
export function renderDayCards() {
  const box = document.getElementById('day-cards');
  if (!box) return;

  const today = toISODate(new Date());
  let html = '';

  for (let h = 0; h < appState.habits.length; h++) {
    const habit = appState.habits[h];
    let inner = '';

    if (habit.type === 'boolean') {
      const value = getRecord(today, habit.id);
      const checked = value === true ? ' checked' : '';
      const xActive = value === false ? ' is-active' : '';
      inner = '<div class="day-card-controls">' +
        '<input type="checkbox" class="cell-check" data-habit-id="' + escapeHtml(habit.id) +
        '" data-date="' + escapeHtml(today) + '"' + checked + ' aria-label="Выполнено">' +
        '<button type="button" class="cell-x' + xActive + '" data-habit-id="' +
        escapeHtml(habit.id) + '" data-date="' + escapeHtml(today) + '" aria-label="Не выполнено">✗</button>' +
        '</div>';
    } else if (habit.id === QAZA_HABIT_ID) {
      // Каза ведётся во вкладке, карточка только показывает счётчик дня
      inner = '<div class="day-card-controls">' + qazaCellMarkup(today) + '</div>';
    } else if (habit.type === 'number') {
      const entry = getEntry(today, habit.id);
      const value = entry ? entry.value : undefined;
      const text = typeof value === 'number' ? String(value) : '';
      inner = '<div class="day-card-controls">' +
        '<input type="number" class="cell-number' +
        levelClass(entry ? entry.level : null) + '" min="0" step="1" data-habit-id="' +
        escapeHtml(habit.id) + '" data-date="' + escapeHtml(today) + '" value="' + escapeHtml(text) +
        '" aria-label="Значение">' +
        (hasLevelPopup(habit.id) ? levelButtonMarkup(habit, today) : '') + '</div>';
    } else {
      const entry = getEntry(today, habit.id);
      const current = entry && typeof entry.value === 'string' ? entry.value : '';
      inner = '<div class="day-card-controls">' +
        '<select class="cell-select' + levelClass(entry ? entry.level : null) +
        '" data-habit-id="' + escapeHtml(habit.id) +
        '" data-date="' + escapeHtml(today) + '" aria-label="Значение">' +
        choiceOptionsMarkup(current, habit.id) + '</select></div>';
    }

    html += '<div class="day-card">' +
      '<div class="day-card-name">' + escapeHtml(habit.name) +
      (habit.unit ? '<span class="day-card-unit">(' + escapeHtml(habit.unit) + ')</span>' : '') +
      '</div>' + inner + '</div>';
  }

  box.innerHTML = html;
}

// Полная перерисовка шапки и тела таблицы.
// Разметка собирается строками и вставляется через DocumentFragment
// (<template>.content) — одно присвоение innerHTML на контейнер и одна
// вставка в живой DOM, чтобы уложиться в 50 мс.
export function renderTable() {
  const weekStart = appState.weekStart;
  if (!weekStart) return;

  initMobileDayPage();

  // Даты отображаемых дней недели: на ПК это вся неделя,
  // на телефоне — выбранная половина (Пн–Чт или Пт–Вс)
  const visibleDays = getVisibleDays();
  const dates = [];
  for (let i = 0; i < visibleDays.length; i++) {
    const day = addDays(weekStart, visibleDays[i]);
    dates.push(new Date(day.getFullYear(), day.getMonth(), day.getDate()));
  }

  let thead = '<tr><th class="habit-col">Привычка</th>';
  for (let i = 0; i < dates.length; i++) {
    thead += '<th class="day-col">' + pad2(dates[i].getDate()) + '.' +
      pad2(dates[i].getMonth() + 1) + '</th>';
  }
  thead += '<th class="progress-col">Прогресс</th></tr>';

  // В круге — прогресс за неделю, второй строкой — за месяц
  let tbody = '';
  for (let h = 0; h < appState.habits.length; h++) {
    const habit = appState.habits[h];
    tbody += '<tr class="habit-row" data-habit-id="' + escapeHtml(habit.id) + '">';
    tbody += '<td><span class="habit-name">' + escapeHtml(habit.name) + '</span>';
    if (habit.unit) {
      tbody += '<span class="habit-unit">(' + escapeHtml(habit.unit) + ')</span>';
    }
    tbody += '</td>';
    for (let i = 0; i < dates.length; i++) {
      tbody += cellMarkup(habit, toISODate(dates[i]));
    }
    tbody += '<td class="progress-cell">' +
      circleMarkup(weekPercent(habit), habit.id, monthPercent(habit)) + '</td>';
    tbody += '</tr>';
  }

  const headTemplate = document.createElement('template');
  headTemplate.innerHTML = thead;
  const bodyTemplate = document.createElement('template');
  bodyTemplate.innerHTML = tbody;

  const theadEl = document.getElementById('habits-thead');
  const tbodyEl = document.getElementById('habits-tbody');
  if (theadEl) theadEl.replaceChildren(headTemplate.content);
  if (tbodyEl) tbodyEl.replaceChildren(bodyTemplate.content);

  updateMobileTabs();
}

/* --- Делегированные обработчики таблицы ---------------------------------- */

// Контейнер ячейки: в таблице это <td class="cell">, в режиме «День» — блок
// управления карточки. Нужен, чтобы после изменения обновить оба контрола
// boolean-ячейки (галочку и «✗»).
export function cellContainer(target) {
  return target.closest('td.cell') || target.closest('.day-card-controls');
}

// data-habit-id и data-date в таблице стоят на <td>, а в карточке — на самом
// контроле, поэтому читаем их с контейнера, а при отсутствии — с цели события.
export function cellData(container, target, name) {
  return container.getAttribute(name) || target.getAttribute(name);
}

export function onTableChange(event) {
  const target = event.target;
  if (!target || !target.classList || typeof target.closest !== 'function') return;

  const cell = cellContainer(target);
  if (!cell) return;

  const habitId = cellData(cell, target, 'data-habit-id');
  const date = cellData(cell, target, 'data-date');
  const habit = findHabit(habitId);
  if (!habit || !date) return;

  const entry = getEntry(date, habitId);
  const current = entry ? entry.value : undefined;
  // Уровень «2 минуты» выбран человеком и правку значения переживает (§2.4) —
  // но только у Корана: там значение и уровень независимы. У Спорта уровень
  // выводится из самого ответа, и «отдых» после «2 минут» не должен остаться
  // голубым, поэтому там он всегда пересчитывается.
  const kept = habitId === QURAN_HABIT_ID && entry && entry.level === LEVEL_TWO_MIN
    ? LEVEL_TWO_MIN : undefined;

  // boolean: галочка = true, снятая галочка = удаление записи
  if (target.classList.contains('cell-check')) {
    const value = target.checked ? true : undefined;
    if (current === value) {
      syncBooleanCell(cell, current);
      return;
    }
    if (!onCellChange(habit, date, value)) {
      // Запись не удалась: возвращаем галочку и «✗» к прежнему значению,
      // а не к новому. Тост уже показал safeSetItem.
      syncBooleanCell(cell, current);
      return;
    }
    syncBooleanCell(cell, value);
    return;
  }

  // choice: пустая опция = удаление записи
  if (target.classList.contains('cell-select')) {
    const value = target.value === '' ? undefined : target.value;
    if (current === value) return;
    if (!onCellChange(habit, date, value, kept === undefined ? defaultLevel(habit, value) : kept)) {
      target.value = current === undefined ? '' : current;
      return;
    }
    syncLevelCell(cell, habitId, date);
    return;
  }

  // number: '' -> удаление, 0 — значимое значение, отрицательное/NaN -> удаление
  if (target.classList.contains('cell-number')) {
    let value;
    if (target.value === '') {
      value = undefined;
    } else {
      const parsed = Number(target.value);
      value = (isFinite(parsed) && parsed >= 0) ? parsed : undefined;
    }
    if (current === value) return;
    if (!onCellChange(habit, date, value, kept === undefined ? defaultLevel(habit, value) : kept)) {
      target.value = current === undefined ? '' : current;
      return;
    }
    syncLevelCell(cell, habitId, date);
  }
}

// Вид полей ячейки после отметки: класс границы по уровню и метка на кнопке
export function syncLevelCell(cell, habitId, date) {
  if (!cell || !isLevelHabit(habitId)) return;

  const entry = getEntry(date, habitId);
  const level = entry ? entry.level : null;

  const field = cell.querySelector('.cell-number') || cell.querySelector('.cell-select');
  if (field) {
    field.classList.remove('is-on-time', 'is-late', 'is-two-min');
    const cls = levelClass(level).trim();
    if (cls) field.classList.add(cls);
  }

  const button = cell.querySelector('.cell-level-btn');
  if (button) button.classList.toggle('is-set', !!level);
}

export function onTableClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  // Кнопка уровня открывает попап на привычке и дне своей ячейки (§1.2)
  const levelButton = target.closest('.cell-level-btn');
  if (levelButton) {
    const levelCell = cellContainer(levelButton);
    if (!levelCell) return;
    openLevelSheet(
      cellData(levelCell, levelButton, 'data-habit-id'),
      cellData(levelCell, levelButton, 'data-date')
    );
    return;
  }

  const button = target.closest('.cell-x');
  if (!button) return;

  const cell = cellContainer(button);
  if (!cell) return;

  const habitId = cellData(cell, button, 'data-habit-id');
  const date = cellData(cell, button, 'data-date');
  const habit = findHabit(habitId);
  if (!habit || !date) return;

  // Повторный клик по «✗» сбрасывает запись в «пусто»
  const current = getRecord(date, habitId);
  const value = current === false ? undefined : false;

  if (!onCellChange(habit, date, value)) return;
  syncBooleanCell(cell, value);
}

// Синхронизация вида boolean-ячейки после изменения
export function syncBooleanCell(cell, value) {
  if (!cell) return;
  const check = cell.querySelector('.cell-check');
  const cross = cell.querySelector('.cell-x');
  if (check) check.checked = value === true;
  if (cross) cross.classList.toggle('is-active', value === false);
}

/* --- Изменение значения ячейки ------------------------------------------- */

// Записывает значение и обновляет ТОЛЬКО круг своей строки — без renderTable().
// День отметки может уехать во вчерашний (§4): тогда без перерисовки не
// обойтись — отметка встанет в чужую колонку и останется незамеченной.
export function onCellChange(habit, date, value, level) {
  if (!habit) return false;

  const markDate = habitMarkDate(habit, date, new Date());
  if (!writeHabitEntry(habit, markDate, value, level)) return false;

  if (markDate !== date) {
    renderTable();
    renderDayCards();
    return true;
  }

  updateRowCircle(habit.id);
  return true;
}

// Перерисовка круга одной строки (полная перерисовка таблицы не нужна)
export function updateRowCircle(habitId) {
  let habit = findHabit(habitId);
  if (!habit) {
    appState.habits = loadHabits();
    habit = findHabit(habitId);
  }
  if (!habit || !appState.weekStart) return;

  const row = document.querySelector(
    '#habits-tbody tr.habit-row[data-habit-id="' + cssEscape(habitId) + '"]'
  );
  if (!row) return;

  const cell = row.querySelector('.progress-cell');
  if (!cell) return;

  cell.innerHTML = circleMarkup(weekPercent(habit), habit.id, monthPercent(habit));
}

/* --- Навигация по неделям ------------------------------------------------ */

export function changeWeek(delta) {
  appState.weekStart = addDays(appState.weekStart, delta * 7);
  renderHeader();
  renderTable();
}

export function goToday() {
  appState.weekStart = getWeekStart(new Date());
  renderHeader();
  renderTable();
}

export function renderScheduleView() {
  markScheduleType();

  const list = document.getElementById('schedule-list');
  if (!list) return;

  const scheduleData = loadSchedule();
  const items = scheduleData[scheduleType] || [];
  let html = '';
  for (let i = 0; i < items.length; i++) {
    html += '<li>' +
      '<span class="schedule-time">' + escapeHtml(items[i].time) + '</span>' +
      '<span class="schedule-text">' + escapeHtml(items[i].text) + '</span>' +
      '</li>';
  }
  list.innerHTML = html;
}

/* --- Редактор расписания (Настройки → Редактировать расписание) ------------ */

// Список + кнопка удаления на каждый пункт. Сортировка по времени даёт один
// порядок в DOM и в массиве: data-index кнопки указывает ровно на ту запись,
// которую видно. Изменение порядка переживает запись в хранилище — расписание
// дальше живёт отсортированным.
export function renderScheduleEditView() {
  const list = document.getElementById('schedule-edit-list');
  if (!list) return;

  const schedule = loadSchedule();
  const items = schedule[scheduleEditType] || [];

  items.sort((a, b) => a.time.localeCompare(b.time));

  let html = '';
  for (let i = 0; i < items.length; i++) {
    html += '<li style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border);">' +
      '<div><span class="schedule-time" style="font-weight: 600; margin-right: 12px; font-variant-numeric: tabular-nums;">' + escapeHtml(items[i].time) + '</span>' +
      '<span class="schedule-text">' + escapeHtml(items[i].text) + '</span></div>' +
      '<button type="button" class="btn btn-danger delete-schedule-item" data-index="' + i + '" aria-label="Удалить">✕</button>' +
      '</li>';
  }
  list.innerHTML = html;
}

// Форма «Добавить». saveSchedule решает судьбу отправки и перерисовки:
// запись не удалась — поля не чистим и экран не трогаем.
export function onScheduleAddSubmit(event) {
  event.preventDefault();
  const timeInput = document.getElementById('schedule-add-time');
  const textInput = document.getElementById('schedule-add-text');
  if (!timeInput || !textInput) return;

  const time = timeInput.value;
  const text = textInput.value.trim();
  if (!time || !text) return;

  const schedule = loadSchedule();
  if (!schedule[scheduleEditType]) schedule[scheduleEditType] = [];

  schedule[scheduleEditType].push({ time: time, text: text });

  if (!saveSchedule(schedule)) return;

  timeInput.value = '';
  textInput.value = '';
  renderScheduleEditView();
}

// Удаление пункта — делегировано на ul, поэтому перерисовки не теряют
// обработчик. Индекс согласован с DOM: render рисует уже отсортированный
// массив, поэтому и здесь сортируем до splice.
export function onScheduleEditListClick(event) {
  const btn = event.target.closest('.delete-schedule-item');
  if (!btn) return;

  const index = parseInt(btn.getAttribute('data-index'), 10);
  if (isNaN(index)) return;

  const schedule = loadSchedule();
  const items = schedule[scheduleEditType];
  if (!items || index < 0 || index >= items.length) return;

  items.sort((a, b) => a.time.localeCompare(b.time));
  items.splice(index, 1);

  if (!saveSchedule(schedule)) return;

  renderScheduleEditView();
}

/* --- Попап уровня выполнения (§1.3) --------------------------------------- */

// Привычка и день, для которых открыт попап. День здесь уже выправленный
// правилом полуночи (§4): попап пишет туда же, куда писала бы клетка.
export let levelSheetTarget = null;

// Текущее значение отметки — из него считается «Полная версия».
// Пустое поле значит, что выполнять нечего, и пункт гаснет (§2.3).
export function openLevelSheet(habitId, date) {
  const habit = findHabit(habitId);
  if (!habit || !date || !hasLevelPopup(habitId)) return;

  const entry = getEntry(date, habitId);
  const value = entry ? entry.value : undefined;
  const hasValue = typeof value === 'number';

  levelSheetTarget = {
    habitId: habitId,
    date: habitMarkDate(habit, date, new Date()),
    value: value,
  };

  const full = document.getElementById('level-option-full');
  if (full) {
    full.disabled = !hasValue;
    full.classList.toggle('is-active', !!entry && entry.level !== LEVEL_TWO_MIN);
  }

  const twoMin = document.getElementById('level-option-two-min');
  if (twoMin) twoMin.classList.toggle('is-active', !!entry && entry.level === LEVEL_TWO_MIN);

  const sheet = document.getElementById('level-sheet');
  if (!sheet) return;

  // Для Корана показываем только «Полная версия» и «2 минуты»,
  // остальные кнопки скрываем
  const options = sheet.querySelectorAll('.level-option');
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (habitId === QURAN_HABIT_ID) {
      const lvl = opt.getAttribute('data-level');
      opt.style.display = (lvl === 'full' || lvl === 'two-min') ? '' : 'none';
    } else {
      opt.style.display = '';
    }
  }

  sheet.hidden = false;
  syncSheetToKeyboard();
}

export function closeLevelSheet() {
  const sheet = document.getElementById('level-sheet');
  if (sheet) sheet.hidden = true;
  levelSheetTarget = null;
  document.documentElement.style.setProperty('--keyboard-offset', '0px');
}

// Выбор пункта попапа. «2 минуты» пишутся и уровнем, и значением, если
// значения ещё нет: у Корана это 0, у Спорта — сам код «2 минуты».
export function onLevelPick(event) {
  const option = event.target.closest('.level-option');
  if (!option || option.disabled || !levelSheetTarget) return;

  const habit = findHabit(levelSheetTarget.habitId);
  const date = levelSheetTarget.date;
  const value = levelSheetTarget.value;
  if (!habit) return;

  let level;
  if (option.getAttribute('data-level') === 'two-min') {
    level = LEVEL_TWO_MIN;
  } else {
    level = defaultLevel(habit, value);
  }

  // Числа ещё нет — «2 минуты» пишутся нулём страниц (§2.4).
  // «Полная версия» без числа недоступна, поэтому дальше пути нет.
  let written = value;
  if (written === undefined && level === LEVEL_TWO_MIN) written = 0;
  if (written === undefined) return;

  if (!writeHabitEntry(habit, date, written, level)) return;

  closeLevelSheet();
  syncLevelCells(habit.id, date);
  updateRowCircle(habit.id);
}

// Вид полей уровня после выбора в попапе: клетки таблицы и, если открыт режим
// «День», карточки. Так же поступает updateQazaCells: на телефоне таблица
// скрыта медиа-запросом, но остаётся в DOM, и обновления одной её мало.
export function syncLevelCells(habitId, date) {
  const cells = document.querySelectorAll(
    'td.cell[data-habit-id="' + cssEscape(habitId) + '"]');
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].getAttribute('data-date') === date) syncLevelCell(cells[i], habitId, date);
  }

  if (isMainDayView()) renderDayCards();
}

/* --- Вкладка «Каза-намазы» ----------------------------------------------- */

// Состояние очереди каза. Заполняется в init(), дальше меняется только вкладкой.
export let qazaState = null;

// Намаз, выбранный в блоке ручного добавления. Живёт только в интерфейсе
// и не сохраняется: это ещё не решение, а подготовка к нажатию «Добавить».
export let qazaAddPick = null;

// Показ и скрытие элемента по id
export function setHidden(id, hidden) {
  const element = document.getElementById(id);
  if (element) element.hidden = hidden;
}

/* --- Панель навигации статистики (заход 4) ------------------------------- */

// Панель открыта — на панели класс is-open: по нему едет transform,
// а visibility снимается без задержки. Подложка отдельным элементом
// и гасится атрибутом hidden.
export function openStatsMenu() {
  const menu = document.getElementById('stats-menu');
  const backdrop = document.getElementById('stats-menu-backdrop');
  if (!menu || !backdrop) return;
  menu.classList.add('is-open');
  backdrop.hidden = false;
}

export function closeStatsMenu() {
  const menu = document.getElementById('stats-menu');
  const backdrop = document.getElementById('stats-menu-backdrop');
  if (!menu || !backdrop) return;
  menu.classList.remove('is-open');
  // Аккордеон категорий возвращается в свёрнутый вид: следующее открытие
  // панели не должно показывать чужое состояние. Работает для всех способов
  // закрытия — Escape, тап по подложке, выбор пункта: все они идут сюда
  menu.classList.remove('is-hub-open');
  const sub = document.getElementById('stats-hub-sub');
  if (sub) sub.hidden = true;
  const toggle = document.getElementById('stats-hub-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  backdrop.hidden = true;
}

// Открыта ли панель. Спрашивает Escape: он разбирает шторки по слоям
export function isStatsMenuOpen() {
  const menu = document.getElementById('stats-menu');
  return !!menu && menu.classList.contains('is-open');
}

// Экраны раздела «Статистика»: у них общий вход и общий возврат «Назад»
export function isStatsView(name) {
  return name === 'stats' || name === 'stats-qaza' || name === 'stats-habits' ||
    name === 'stats-habit' || name === 'stats-fast' || name === 'stats-sleep';
}

// Куда вернёт «Назад» с экранов статистики. Входов два — строка в Настройках
// на ПК и гамбургер на телефоне, — и вернуть надо туда, откуда вошли.
// Значение снимается один раз, на входе в раздел: иначе переход между
// категориями переписывал бы его, и возврат уводил бы в прошлый экран
export let statsReturnView = 'settings';

// Куда вернёт «Назад» с экрана «Цикл сна». Входов два — строка в Настройках
// на ПК и пункт гамбургера на телефоне, — и вернуть надо туда, откуда вошли.
// Снимается один раз, на входе в экран, как у статистики
export let sleepReturnView = 'main';

// Текущий вид приложения. Нужен затем, чтобы отличить вход в статистику
// от перехода внутри неё
export let currentView = 'main';

// Переключение разделов. Единая точка входа для таб-бара на телефоне,
// кнопки «Каза-намазы» и «Назад» на ПК.
export function switchAppView(name) {
  const weekNav = document.getElementById('week-nav'); if (weekNav) weekNav.hidden = (name !== 'main');
  // Панель статистики принадлежит главной: любой переход её закрывает
  closeStatsMenu();
  // Попап уровня — тоже: программный переход (из консоли, теста или будущего
  // кода) без этого оставил бы его висеть поверх нового экрана
  closeLevelSheet();

  // Вход в раздел запоминает, откуда вошли, — туда «Назад» из хаба и вернёт
  if (isStatsView(name) && !isStatsView(currentView)) statsReturnView = currentView;

  // То же для «Цикла сна»: у экрана два входа — строка в Настройках и пункт
  // гамбургера, — и «Назад» должен вернуть в тот, откуда вошли
  if (name === 'sleep' && currentView !== 'sleep') sleepReturnView = currentView;

  document.getElementById('main').hidden = name !== 'main';
  document.getElementById('settings-view').hidden = name !== 'settings';
  document.getElementById('habits-edit-view').hidden = name !== 'edit-habits';
  document.getElementById('qaza-view').hidden = name !== 'qaza';
  document.getElementById('prayer-view').hidden = name !== 'prayer';
  document.getElementById('prayer-settings-view').hidden = name !== 'prayer-settings';
  document.getElementById('fast-view').hidden = name !== 'fast';
  document.getElementById('stats-view').hidden = name !== 'stats';
  document.getElementById('stats-qaza-view').hidden = name !== 'stats-qaza';
  document.getElementById('stats-habits-view').hidden = name !== 'stats-habits';
  document.getElementById('stats-habit-view').hidden = name !== 'stats-habit';
  document.getElementById('stats-fast-view').hidden = name !== 'stats-fast';
  document.getElementById('stats-sleep-view').hidden = name !== 'stats-sleep';
  document.getElementById('sleep-view').hidden = name !== 'sleep';
  document.getElementById('schedule-view').hidden = name !== 'schedule';
  document.getElementById('schedule-edit-view').hidden = name !== 'schedule-edit';
  document.getElementById('mobile-day-tabs').hidden = name !== 'main' || !isMobileView();
  document.getElementById('tab-bar').hidden = !isMobileView();
  document.getElementById('week-nav').hidden = name !== 'main';
  document.getElementById('qaza-btn').hidden = name !== 'main';
  document.getElementById('schedule-btn').hidden = name !== 'main';
  document.getElementById('settings-btn').hidden = name !== 'main';
  // Кнопка статистики открывает панель с экранами раздела: на других
  // экранах ей нечего делать
  document.getElementById('stats-menu-btn').hidden = name !== 'main';

  // Вложенные экраны подсвечивают вкладку, из которой открыты: «Привычки»,
  // настройки молитв, статистика и «Цикл сна» — «Настройки», «Молитвы»
  // и «Ураза» — «Каза». У сна вкладки нет своей: вход в него из гамбургера,
  // а он принадлежит главной, и подсвечивать там нечего
  const tabView = name === 'edit-habits' || name === 'prayer-settings' ||
    name === 'sleep' || name === 'stats' || name === 'stats-qaza' ||
    name === 'stats-habits' || name === 'stats-habit' ||
    name === 'stats-fast' || name === 'stats-sleep' ? 'settings'
    : name === 'prayer' || name === 'fast' ? 'qaza'
      : name;
  document.querySelectorAll('#tab-bar .tab-item').forEach(function (item) {
    item.classList.toggle('is-active', item.getAttribute('data-view') === tabView);
  });

  // Классы на body гасят шапку действий в каза, молитвах, уразе, настройках
  // и статистике. У статистики свой класс, а не view-settings: гасят они одно
  // и то же, но имя читается по экрану
  const isSettings = name === 'settings' || name === 'edit-habits' ||
    name === 'prayer-settings' || name === 'sleep';
  document.body.classList.toggle('view-qaza', name === 'qaza');
  document.body.classList.toggle('view-prayer', name === 'prayer');
  document.body.classList.toggle('view-fast', name === 'fast');
  document.body.classList.toggle('view-settings', isSettings);
  document.body.classList.toggle('view-stats', name === 'stats' || name === 'stats-qaza' ||
    name === 'stats-habits' || name === 'stats-habit' ||
    name === 'stats-fast' || name === 'stats-sleep');

  if (name === 'qaza') {
    if (!qazaState) qazaState = loadQaza();
    renderQazaView();
  }

  if (name === 'main') {
    renderMainView();
  }

  if (name === 'edit-habits') {
    appState.habits = loadHabits();
    renderHabitsEditList();
  }

  if (name === 'settings') {
    renderSettingsView();
  }

  if (name === 'stats') {
    renderStatsView();
  }

  if (name === 'stats-qaza') {
    renderStatsQazaView();
  }

  if (name === 'stats-habits') {
    // Вход в список обнуляет выбранную привычку: карточка открывается только
    // тапом по строке, а не остатком прошлого захода
    statsHabitId = null;
    renderStatsHabitsView();
  }

  if (name === 'stats-habit') {
    renderStatsHabitView();
  }

  if (name === 'stats-fast') {
    renderStatsFastView();
  }

  if (name === 'stats-sleep') {
    renderStatsSleepView();
  }

  if (name === 'sleep') {
    renderSleepView();
  }

  if (name === 'schedule') {
    renderScheduleView();
  }

  if (name === 'prayer') {
    // Список открывается свёрнутым: «Показать все» — разовый взгляд
    prayerShowAll = false;
    renderPrayerView();
  }

  if (name === 'prayer-settings') {
    renderPrayerSettings();
  }

  if (name === 'fast') {
    // Незакрытая форма не переживает уход с экрана: возвращаться к наполовину
    // заполненному полю незачем, а первый запуск снова покажет форму сам
    fastInitMode = null;
    renderFastView();
  }

  window.scrollTo(0, 0);
  currentView = name;

  // Обновить каплю-индикаторы всех переключателей через общий планировщик
  scheduleLiquidIndicators();
}

// Строка версии в Настройках
export function renderSettingsView() {
  const version = document.getElementById('settings-version');
  if (version) version.textContent = 'Версия: ' + APP_VERSION + ' · сборка ' + APP_BUILD;
}

/* ---------- Экран «Статистика» ------------------------------------------- */

// Выбранный период живёт на устройстве, а не в данных человека: как mainView,
// это отметка последнего просмотра, а не запись. Категория у каждой своя,
// поэтому общей переменной нет — её читает loadStatsPeriod(category)

// Перерисовка экранов одной категории. Скрытые трогать незачем: их нарисует
// вход на экран (switchAppView)
export function renderStatsCategory(category) {
  if (category === 'hub') {
    renderStatsView();
  } else if (category === 'qaza') {
    renderStatsQazaView();
  } else if (category === 'habits') {
    renderStatsHabitsView();
    renderStatsHabitView();
  } else if (category === 'fast') {
    renderStatsFastView();
  } else if (category === 'sleep') {
    renderStatsSleepView();
  }
}

// Строка цифр: подпись слева, значение справа — тем же .settings-row,
// что и список хаба. data-stat нужен проверкам, разметку не украшает.
export function statsSummaryMarkup(rows) {
  return rows.map(function (row) {
    return '<p class="settings-row" data-stat="' + escapeHtml(row[0]) + '">' +
      '<span>' + escapeHtml(row[1]) + '</span>' +
      '<span class="stats-row-value">' + escapeHtml(row[2]) + '</span></p>';
  }).join('');
}

// Столбики по дням: высота — значение дня. Строка SVG собирается вручную
// через innerHTML, как circleMarkup; библиотек нет (§4). Подпись — второй
// параметр: у каза и у привычек она своя, а рисование одно и то же.
export function statsChartMarkup(values, label) {
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > max) max = values[i];
  }
  if (max <= 0) return '';

  // 94, а не 100: самый высокий столбик не должен упираться в верх графика
  let bars = '';
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0) continue;
    // Минимум 2 единицы: день с одним каза иначе был бы не виден
    const height = Math.max(2, Math.round(values[i] / max * 94));
    bars += '<rect x="' + i + '" y="' + (100 - height) + '" width="0.7" height="' +
      height + '"></rect>';
  }

  return '<svg viewBox="0 0 ' + values.length + ' 100" preserveAspectRatio="none" ' +
    'role="img" aria-label="' + escapeHtml(label || 'Каза по дням') + '">' + bars + '</svg>';
}

export function markScheduleType() {
  const box = document.getElementById('schedule-switch');
  if (!box) return;
  box.querySelectorAll('.view-switch-btn').forEach(function (btn) {
    btn.classList.toggle('is-active',
      btn.getAttribute('data-schedule') === scheduleType);
  });
}

// Подсветка выбранного периода. Период читается для категории этого блока:
// у каждой свой. Разметка кнопок статична, поэтому пересобирать её не нужно —
// как у переключателя «День / Неделя»
export function markStatsPeriod(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const period = loadStatsPeriod(STATS_PERIOD_BOXES[boxId]);
  box.querySelectorAll('.view-switch-btn').forEach(function (btn) {
    btn.classList.toggle('is-active', btn.getAttribute('data-period') === period);
  });
}

export function setStatsValue(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}

// Хаб: четыре строки. Цифры считаются по хранилищу, а не по appState:
// раздел открывается из Настроек, где состояние таблицы могло устареть.
export function renderStatsView() {
  markStatsPeriod('stats-period');

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('hub'), today);

  if (!qazaState) qazaState = loadQaza();
  setStatsValue('#stats-list [data-stat="qaza"] .stats-row-value',
    qazaTotalRemaining(qazaState));

  // Сон — средняя длительность записи за период хаба. Дни берутся уже
  // собранные: период у строки тот же, что у остальных цифр. Записи
  // excluded пропускаются целиком, значение дня — realSleepMin ?? sleepMin
  const sleep = loadSleep();
  let sleepValue = '—';
  if (sleep && sleep.history.length > 0) {
    const dayIndex = {};
    for (let i = 0; i < dates.length; i++) dayIndex[dates[i]] = i;

    let sum = 0;
    let count = 0;
    for (let i = 0; i < sleep.history.length; i++) {
      const entry = sleep.history[i];
      if (entry.excluded === true) continue;
      if (dayIndex[entry.date] === undefined) continue;
      sum += entry.realSleepMin ?? entry.sleepMin;
      count++;
    }
    if (count > 0) sleepValue = sleepFormatDuration(Math.round(sum / count));
  }
  setStatsValue('#stats-list [data-stat="sleep"] .stats-row-value', sleepValue);

  const fast = loadFast();
  setStatsValue('#stats-list [data-stat="fast"] .stats-row-value',
    fast ? fast.remaining : '—');

  const average = habitsAveragePercent(loadHabits(), dates);
  setStatsValue('#stats-list [data-stat="habits"] .stats-row-value',
    average === null ? '—' : Math.round(average) + '%');
}

export function renderStatsQazaView() {
  markStatsPeriod('stats-qaza-period');

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('qaza'), today);
  const records = loadRecords();

  // Источник за день зависит от журнала (§5). Журнала нет — как было: поле h6
  // в записях дня, единственный свидетель каза за день. Журнал заведён — за
  // дни до since всё ещё h6, а с since и позже считает журнал: стек очереди
  // живёт только за сегодня, журнал же по датам не чистится
  const log = loadQazaLog();
  const logDone = qazaLogDoneByDay(log);

  let done = 0;
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    const count = log && dates[i] >= log.since
      ? (logDone[dates[i]] || 0)
      : qazaDoneOn(records, dates[i]);
    values.push(count);
    done += count;
  }

  if (!qazaState) qazaState = loadQaza();
  const average = done / dates.length;

  const summary = document.getElementById('stats-qaza-summary');
  if (summary) {
    summary.innerHTML = statsSummaryMarkup([
      ['done', 'Выполнено за период', String(done)],
      ['average', 'Средний темп в день', average.toFixed(1).replace('.', ',')],
      ['streak', 'Текущая серия, дней', String(qazaStreak(records, today))],
      ['total', 'Общий остаток', String(qazaTotalRemaining(qazaState))],
    ]);
  }

  const chart = document.getElementById('stats-qaza-chart');
  if (chart) chart.innerHTML = statsChartMarkup(values);
}

// Категория «Ураза». Источник — растущая история счётчика (§5): интерфейс
// уразы её только пишет, читает раздел статистики. Счётчика нет — ни цифр,
// ни графика: собрать их не из чего
export function renderStatsFastView() {
  markStatsPeriod('stats-fast-period');

  const summary = document.getElementById('stats-fast-summary');
  const chart = document.getElementById('stats-fast-chart');
  const note = document.getElementById('stats-fast-empty-note');
  if (!summary || !chart || !note) return;

  const fast = loadFast();
  if (!fast) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'Счётчик не заведён';
    note.hidden = false;
    return;
  }

  summary.hidden = false;

  const dates = statsPeriodDates(loadStatsPeriod('fast'), new Date());
  const dayIndex = {};
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    dayIndex[dates[i]] = i;
    values.push(0);
  }

  let done = 0;
  let added = 0;
  let since = null;

  for (let i = 0; i < fast.history.length; i++) {
    const event = fast.history[i];
    // Начало истории — по всей истории, а не по периоду: «с какого дня
    // копится» не должно меняться от выбранного окна
    if (since === null || event.date < since) since = event.date;

    const day = dayIndex[event.date];
    if (day === undefined) continue;
    if (event.source === FAST_SOURCE_DONE) {
      done += event.count;
      values[day] += event.count;
    } else if (event.source === FAST_SOURCE_ADD) {
      added += event.count;
    }
  }

  summary.innerHTML = statsSummaryMarkup([
    ['remaining', 'Остаток', String(fast.remaining)],
    ['done', 'Возмещено за период', String(done)],
    ['added', 'Добавлено за период', String(added)],
    ['since', 'История копится с', since === null ? '—' : since],
  ]);

  // Истории мало — вместо графика строка текста: три столбика на всю ширину
  // читались бы как «данных достаточно», хотя это ещё начало
  if (fast.history.length < FAST_HISTORY_MIN) {
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'История копится с ' + (since === null ? '—' : since) +
      '. Данных пока мало для графика';
    note.hidden = false;
  } else {
    chart.hidden = false;
    chart.innerHTML = statsChartMarkup(values, 'Возмещено по дням');
    note.hidden = true;
  }
}

// Категория «Сон». Источник — история раздела «Цикл сна» (§11ab): форма её
// только пишет, читает раздел статистики. Пустых состояний два, и это разные
// вещи: истории нет вовсе — показывать нечего, истории нет за выбранное окно
// — данные есть, но не здесь. Средние отбоя и подъёма считает
// sleepAverageMinutes: у времени суток своя арифметика, и обычное среднее
// на ней врёт. Средний подъём — по полю actualWake, а не wake: в историю
// идёт то, что вышло на самом деле, а wake — цель
export function renderStatsSleepView() {
  markStatsPeriod('stats-sleep-period');

  const sleep = loadSleep();
  const summary = document.getElementById('stats-sleep-summary');
  const chart = document.getElementById('stats-sleep-chart');
  const note = document.getElementById('stats-sleep-empty-note');
  if (!summary || !chart || !note) return;

  if (!sleep || sleep.history.length === 0) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'Истории сна нет';
    note.hidden = false;
    return;
  }

  const dates = statsPeriodDates(loadStatsPeriod('sleep'), new Date());
  const dayIndex = {};
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    dayIndex[dates[i]] = i;
    values.push(0);
  }

  // Записи периода. Одна запись на день — держит sleepHistoryEntry, — но
  // сумма на день, а не присваивание: вторая запись о том же дне сложилась бы
  // в значение дня, а не затёрла первую. Записи excluded пропускаются целиком:
  // человек сказал «не считать этот день», и он не должен попасть ни в средние,
  // ни в график, ни в счётчик
  const inPeriod = [];
  for (let i = 0; i < sleep.history.length; i++) {
    const entry = sleep.history[i];
    if (entry.excluded === true) continue;
    const day = dayIndex[entry.date];
    if (day === undefined) continue;
    inPeriod.push(entry);
    values[day] += entry.realSleepMin ?? entry.sleepMin;
  }

  if (inPeriod.length === 0) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'За выбранный период записей нет';
    note.hidden = false;
    return;
  }

  summary.hidden = false;

  // Оба конца ночи — время суток, и history их уже проверила при чтении:
  // каждое значение здесь число, а не null. Средний подъём — по факту
  // (realWake), если он задан, иначе по actualWake. Средняя длительность —
  // по realSleepMin, если он задан, иначе по sleepMin
  const bedMinutes = inPeriod.map(function (e) { return sleepTimeMinutes(e.bed); });
  const wakeMinutes = inPeriod.map(function (e) {
    return sleepTimeMinutes(e.realWake ?? e.actualWake);
  });

  let durationSum = 0;
  for (let i = 0; i < inPeriod.length; i++) {
    durationSum += inPeriod[i].realSleepMin ?? inPeriod[i].sleepMin;
  }
  const averageDuration = Math.round(durationSum / inPeriod.length);

  const averageBed = sleepAverageMinutes(bedMinutes);
  const averageWake = sleepAverageMinutes(wakeMinutes);

  summary.innerHTML = statsSummaryMarkup([
    ['bed',     'Средний отбой',        averageBed === null ? '—' : sleepTimeLabel(averageBed)],
    ['wake',    'Средний подъём',       averageWake === null ? '—' : sleepTimeLabel(averageWake)],
    ['average', 'Средняя длительность', sleepFormatDuration(averageDuration)],
    ['count',   'Записей за период',    String(inPeriod.length)],
  ]);

  chart.hidden = false;
  chart.innerHTML = statsChartMarkup(values, 'Длительность сна по дням');
  note.hidden = true;
}

/* ---------- Статистика: привычки ----------------------------------------- */

// Выбранная привычка. Живёт только в интерфейсе: список обнуляет её при входе,
// строка списка ставит своё значение перед показом карточки
export let statsHabitId = null;

// Календарь-сетка: колонка — неделя (понедельник сверху), строка — день недели.
// Клетки одинаковые и заданы в пикселях, поэтому ширина сетки растёт вместе
// с числом недель, а не подгоняется под экран: на телефоне её прокручивает
// контейнер. Новых переменных палитры нет — цвета берёт §9
export function statsHabitGridMarkup(habit, dates) {
  if (!dates || dates.length === 0) return '';

  const CELL = 10;
  const GAP = 2;
  const STEP = CELL + GAP;

  // Сдвиг первого дня от понедельника: 0 — понедельник, 6 — воскресенье
  const offset = (parseISODate(dates[0]).getDay() + 6) % 7;
  const weeks = Math.ceil((offset + dates.length) / 7);

  let cells = '';
  for (let i = 0; i < dates.length; i++) {
    const slot = offset + i;
    cells += '<rect class="stats-grid-day' +
      (habitMarked(habit, dates[i]) ? ' is-on' : '') +
      '" x="' + Math.floor(slot / 7) * STEP + '" y="' + slot % 7 * STEP +
      '" width="' + CELL + '" height="' + CELL + '" rx="2"></rect>';
  }

  return '<svg width="' + (weeks * STEP - GAP) + '" height="' + (7 * STEP - GAP) +
    '" role="img" aria-label="Отметки по дням">' + cells + '</svg>';
}

// Список привычек. Процент за период — calcProgress, и это же делает «0%»
// при полном отсутствии записей: пустой день даёт ноль, ветка «—» не нужна
export function renderStatsHabitsView() {
  markStatsPeriod('stats-habits-period');

  const list = document.getElementById('stats-habits-list');
  if (!list) return;

  const dates = statsPeriodDates(loadStatsPeriod('habits'), new Date());
  const habits = loadHabits();

  // Строка — кнопка, как строка хаба: <div> выпал бы из таб-навигации
  let markup = '';
  for (let i = 0; i < habits.length; i++) {
    const habit = habits[i];
    markup += '<li><button type="button" class="settings-row" data-habit-id="' +
      escapeHtml(habit.id) + '"><span>' + escapeHtml(habit.name) + '</span>' +
      '<span class="stats-row-value">' + escapeHtml(Math.round(calcProgress(habit, dates))) +
      '%</span></button></li>';
  }
  list.innerHTML = markup;
}

// Карточка одной привычки. Без выбранного id рисовать нечего: экран
// открывается только тапом по строке списка
export function renderStatsHabitView() {
  if (statsHabitId === null) return;

  markStatsPeriod('stats-habit-period');

  // Список читается из хранилища, как в хабе: раздел открывают из Настроек,
  // где состояние таблицы могло устареть
  const habits = loadHabits();
  let habit = null;
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === statsHabitId) habit = habits[i];
  }
  if (!habit) return;

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('habits'), today);

  const title = document.getElementById('stats-habit-title');
  if (title) title.textContent = habit.name;

  const summary = document.getElementById('stats-habit-summary');
  if (summary) {
    summary.innerHTML = statsSummaryMarkup([
      ['average', 'Средний процент за период', Math.round(calcProgress(habit, dates)) + '%'],
      ['streak', 'Текущая серия, дней', String(habitCurrentStreak(habit, today))],
      ['best', 'Лучшая серия за период, дней', String(habitBestStreak(habit, dates))],
      ['marks', 'Всего отметок за период', String(habitMarkedDays(habit, dates).length)],
    ]);
  }

  const values = [];
  for (let i = 0; i < dates.length; i++) values.push(calcProgress(habit, [dates[i]]));

  const chart = document.getElementById('stats-habit-chart');
  if (chart) chart.innerHTML = statsChartMarkup(values, 'Отметки по дням');

  const grid = document.getElementById('stats-habit-grid');
  if (grid) {
    grid.innerHTML = statsHabitGridMarkup(habit, dates);
    // Свежие отметки лежат справа: без этого «Всё время» открывалось бы
    // на неделях пустоты, а сегодняшний край оставался за кадром
    grid.scrollLeft = grid.scrollWidth;
  }
}

/* ---------- Экран «Молитвы» ---------------------------------------------- */

// Раскрыт ли полный список. Живёт только в интерфейсе и сбрасывается при
// входе на вкладку: «Показать все» — разовый взгляд, а не настройка.
export let prayerShowAll = false;
// Сутки, на которые нарисован экран. Смена значения — сигнал пересобрать
// день целиком, а не только счётчик.
export let prayerRenderedDay = null;
export let prayerTimer = null;

// Намаз, окно которого идёт сейчас. Восход окна не имеет — он не намаз,
// а граница утреннего.
export function prayerCurrent(times, nowMin) {
  for (let i = 0; i < PRAYER_WINDOWS.length; i++) {
    const from = times[PRAYER_WINDOWS[i][0]];
    const endKey = PRAYER_WINDOWS[i][1];
    const to = endKey ? times[endKey] : 1440;
    if (from === null || from === undefined) continue;
    if (to === null || to === undefined) continue;
    if (nowMin >= from && nowMin < to) return PRAYER_WINDOWS[i][0];
  }
  return null;
}

// Ближайшее событие: сперва сегодняшние, потом завтрашний Фаджр. Минуты
// завтрашних идут со сдвигом на сутки — так разница до них берётся вычитанием,
// а не отдельной веткой.
export function prayerNext(times, tomorrow, nowMin) {
  for (let i = 0; i < PRAYER_ORDER.length; i++) {
    const min = times[PRAYER_ORDER[i]];
    if (min === null || min === undefined) continue;
    if (min > nowMin) return { key: PRAYER_ORDER[i], min: min, tomorrow: false };
  }

  const fajr = tomorrow ? tomorrow.fajr : null;
  if (fajr === null || fajr === undefined) return null;
  return { key: 'fajr', min: fajr + 1440, tomorrow: true };
}

// Событие после следующего — вторая строка свёрнутого списка
export function prayerAfter(times, tomorrow, next) {
  if (!next) return null;

  if (next.tomorrow) {
    const sunrise = tomorrow ? tomorrow.sunrise : null;
    if (sunrise === null || sunrise === undefined) return null;
    return { key: 'sunrise', min: sunrise + 1440, tomorrow: true };
  }

  const key = PRAYER_ORDER[PRAYER_ORDER.indexOf(next.key) + 1];
  if (!key || times[key] === null || times[key] === undefined) return null;
  return { key: key, min: times[key], tomorrow: false };
}

// Всё, что нужно экрану: времена сегодня и завтра, текущий намаз, следующий
// и строки свёрнутого списка. Завтрашние времена нужны не для красоты:
// после Иши следующее событие наступает уже завтра, и круг обязан его показать.
export function prayerViewState() {
  const saved = loadPrayer();
  if (!saved) return null;

  const now = new Date();
  const times = prayerTimes(prayerDateISO(now), saved.lat, saved.lng,
    saved.madhhab, saved.method);
  if (!times) return null;

  const tomorrow = prayerTimes(
    prayerDateISO(new Date(now.getTime() + 86400000)),
    saved.lat, saved.lng, saved.madhhab, saved.method) || {};

  const nowMin = prayerMinutes(now);
  const current = prayerCurrent(times, nowMin);
  const next = prayerNext(times, tomorrow, nowMin);
  const after = prayerAfter(times, tomorrow, next);

  // Идёт окно намаза — показываем текущий и следующий; окна нет (например,
  // между Восходом и Зухром) — следующий и после следующего.
  const shown = [];
  if (current) {
    shown.push({ key: current, min: times[current], tomorrow: false });
    if (next) shown.push(next);
  } else {
    if (next) shown.push(next);
    if (after) shown.push(after);
  }

  return { times: times, now: nowMin, current: current, next: next, shown: shown };
}

// Минуты → «ЧЧ:ММ». Завтрашние минуты приходят со сдвигом на сутки.
export function prayerClock(minutes) {
  if (minutes === null || minutes === undefined || !isFinite(minutes)) return '--:--';
  const total = Math.round(minutes) % 1440;
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}

// Счётчик до начала намаза
export function prayerCountdown(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) return 'через ' + hours + ' ч ' + mins + ' мин';
  if (hours) return 'через ' + hours + ' ч';
  return 'через ' + mins + ' мин';
}

// Строки списка: свёрнуто — две, развёрнуто — все шесть по порядку
export function prayerRows(view) {
  if (!prayerShowAll) return view.shown;

  const rows = [];
  PRAYER_ORDER.forEach(function (key) {
    const min = view.times[key];
    if (min === null || min === undefined) return;
    rows.push({ key: key, min: min, tomorrow: false });
  });
  return rows;
}

export function renderPrayerList(view) {
  const list = document.getElementById('prayer-list');
  if (!list) return;

  list.innerHTML = prayerRows(view).map(function (entry) {
    const classes = ['prayer-row'];
    if (entry.key === 'sunrise') classes.push('is-sunrise');

    const isCurrent = view.current === entry.key && !entry.tomorrow;
    if (isCurrent) classes.push('is-current');

    // Счётчик стоит у следующего намаза и только у него: у текущего он
    // читался бы как «до конца намаза», а это неправда
    const isNext = !!view.next && view.next.key === entry.key &&
      view.next.tomorrow === entry.tomorrow && !isCurrent;
    const countdown = isNext
      ? '<span class="prayer-countdown">' +
        escapeHtml(prayerCountdown(view.next.min - view.now)) + '</span>'
      : '';

    return '<div class="' + classes.join(' ') + '" data-prayer="' +
      escapeHtml(entry.key) + '">' +
      '<span class="prayer-row-name">' + escapeHtml(PRAYER_LABELS[entry.key]) + '</span>' +
      '<span class="prayer-row-right">' + countdown +
      '<span class="prayer-row-time">' + escapeHtml(prayerClock(entry.min)) +
      '</span></span></div>';
  }).join('');
}

// Кольцо показывает долю пути от прошлого события до следующего: по ней
// видно, много ли осталось, не заводя второй шкалы.
export function renderPrayerRing(view) {
  const ring = document.getElementById('prayer-ring-progress');
  if (!ring) return;

  const length = 2 * Math.PI * 88;
  ring.setAttribute('stroke-dasharray', String(length));

  if (!view.next) {
    ring.setAttribute('stroke-dashoffset', String(length));
    return;
  }

  let from = 0;
  PRAYER_ORDER.forEach(function (key) {
    const min = view.times[key];
    if (min !== null && min !== undefined && min <= view.now) {
      from = Math.max(from, min);
    }
  });

  const span = view.next.min - from;
  const done = span > 0 ? Math.min(1, Math.max(0, (view.now - from) / span)) : 0;
  ring.setAttribute('stroke-dashoffset', String(length * (1 - done)));
}

export function renderPrayerTimes() {
  const view = prayerViewState();
  if (!view) return;

  const name = document.getElementById('prayer-next-name');
  const time = document.getElementById('prayer-next-time');
  if (name) name.textContent = view.next ? PRAYER_LABELS[view.next.key] : '';
  if (time) time.textContent = view.next ? prayerClock(view.next.min) : '--:--';
  setHidden('prayer-next-hint', !(view.next && view.next.tomorrow));

  renderPrayerRing(view);
  renderPrayerList(view);

  const showAll = document.getElementById('prayer-show-all');
  if (showAll) showAll.textContent = prayerShowAll ? 'Свернуть' : 'Показать все';
}

// Пока координат нет, вместо времён показывается приветственный экран
export function renderPrayerView() {
  const saved = loadPrayer();
  setHidden('prayer-welcome', !!saved);
  setHidden('prayer-times', !saved);

  prayerRenderedDay = prayerDateISO(new Date());
  if (!saved) return;

  renderPrayerTimes();
}

export function renderPrayerSettings() {
  const saved = loadPrayer();

  const coords = document.getElementById('prayer-coords');
  if (coords) {
    coords.textContent = saved
      ? 'Широта ' + saved.lat + ' · Долгота ' + saved.lng
      : 'Координат нет — времена намазов не считаются.';
  }

  renderPrayerMadhhab(saved ? saved.madhhab : 'shafi');
  renderPrayerMethod(saved ? saved.method : PRAYER_METHOD_DEFAULT);
}

export function renderPrayerMethod(method) {
  const box = document.getElementById('prayer-method');
  if (!box) return;

  box.innerHTML = PRAYER_METHODS.map(function (key) {
    const active = key === method;
    return '<label class="prayer-method-option' + (active ? ' is-active' : '') + '">' +
      '<input type="radio" class="prayer-method-radio" name="prayer-method" value="' +
      escapeHtml(key) + '"' + (active ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(PRAYER_METHOD_LABELS[key]) + '</span></label>';
  }).join('');
}

export function markPrayerMethod(method) {
  document.querySelectorAll('#prayer-method .prayer-method-option')
    .forEach(function (option) {
      const input = option.querySelector('input');
      option.classList.toggle('is-active', !!input && input.value === method);
    });
}

export function renderPrayerMadhhab(madhhab) {
  const box = document.getElementById('prayer-madhhab');
  if (!box) return;

  box.innerHTML = PRAYER_MADHHABS.map(function (key) {
    const active = key === madhhab;
    return '<label class="prayer-madhhab-option' + (active ? ' is-active' : '') + '">' +
      '<input type="radio" class="prayer-madhhab-radio" name="prayer-madhhab" value="' +
      escapeHtml(key) + '"' + (active ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(PRAYER_MADHHAB_LABELS[key]) + '</span></label>';
  }).join('');
}

// Подсветка выбранной пилюли без пересборки разметки: пересборка внутри
// события change уносит элемент, по которому только что нажали
export function markPrayerMadhhab(madhhab) {
  document.querySelectorAll('#prayer-madhhab .prayer-madhhab-option')
    .forEach(function (option) {
      const input = option.querySelector('input');
      option.classList.toggle('is-active', !!input && input.value === madhhab);
    });
}

// Раз в минуту: счётчик до следующего намаза и смена суток. В полночь
// пересобирается весь день — времена-то у него свои.
export function prayerTick() {
  if (prayerDateISO(new Date()) !== prayerRenderedDay) {
    renderPrayerView();
    return;
  }
  renderPrayerTimes();
}

// После смены координат или мазхаба перерисовываются оба экрана: они читают
// один и тот же ключ
export function afterPrayerChange() {
  renderPrayerView();
  renderPrayerSettings();
}

// Разбор координаты. Запятая вместо точки — обычная опечатка мобильной
// клавиатуры, поэтому принимается наравне с точкой.
export function prayerParseCoord(value, limit) {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = raw.trim().replace(',', '.');
  if (!text) return null;

  const num = Number(text);
  if (!isFinite(num) || num < -limit || num > limit) return null;
  return prayerRound(num);
}

// Геолокация — единственный способ, который может отказать не по вине
// пользователя, поэтому отказ объясняется словами, а не молчанием.
// Экран без своей строки для пояснений (настройки) говорит тостом.
export function requestPrayerLocation(noteId, onDone) {
  const note = noteId ? document.getElementById(noteId) : null;
  const say = function (message) {
    if (note) { note.textContent = message; return; }
    if (message) showToast(message);
  };

  if (!navigator.geolocation) {
    say('Геолокация недоступна. Введите координаты вручную.');
    return;
  }

  say('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(function (position) {
    say('');
    onDone(prayerRound(position.coords.latitude),
      prayerRound(position.coords.longitude));
  }, function () {
    say('Не удалось определить местоположение. Введите координаты вручную.');
  }, { timeout: 10000, maximumAge: 600000 });
}

// Сохраняет координаты, не трогая выбранные мазхаб и метод расчёта.
// Возвращает boolean результата записи: перерисовка — забота вызывающих.
export function applyPrayerCoords(lat, lng) {
  const saved = loadPrayer();
  // savePrayer при невалидных координатах возвращает undefined — приводим
  // результат к строгому boolean, как у успешной/неуспешной записи.
  return savePrayer({
    lat: lat,
    lng: lng,
    madhhab: saved ? saved.madhhab : 'shafi',
    method: saved ? saved.method : PRAYER_METHOD_DEFAULT,
  }) === true;
}

export function onPrayerGeo() {
  requestPrayerLocation('prayer-welcome-note', function (lat, lng) {
    if (!applyPrayerCoords(lat, lng)) return;
    afterPrayerChange();
  });
}

export function onPrayerRefresh() {
  requestPrayerLocation(null, function (lat, lng) {
    if (!applyPrayerCoords(lat, lng)) return;
    afterPrayerChange();
    showToast('Координаты обновлены');
  });
}

export function onPrayerManualSave() {
  const latEl = document.getElementById('prayer-lat');
  const lngEl = document.getElementById('prayer-lng');
  const note = document.getElementById('prayer-welcome-note');

  // Широта — тот же порог, что у prayerTimes (89.8). Иначе ввод
  // 89.9 принимался бы полем и молча отбрасывался savePrayer
  // (§11aa, B4).
  const lat = prayerParseCoord(latEl ? latEl.value : '', 89.8);
  const lng = prayerParseCoord(lngEl ? lngEl.value : '', 180);

  if (lat === null || lng === null) {
    if (note) note.textContent = 'Широта — число от −89.8 до 89.8, долгота — от −180 до 180.';
    return;
  }

  if (note) note.textContent = '';
  if (!applyPrayerCoords(lat, lng)) return;
  afterPrayerChange();
}

export function onPrayerMadhhabChange(event) {
  const value = event.target && event.target.value;
  if (!PRAYER_SHADOW[value]) return;

  const saved = loadPrayer();
  if (!saved) return;
  if (!savePrayer({ lat: saved.lat, lng: saved.lng, madhhab: value, method: saved.method })) return;

  // Настройки не пересобираются целиком — только подсветка: экран молитв
  // мог быть открыт, и он перерисовывается под новый мазхаб
  markPrayerMadhhab(value);
  renderPrayerView();
}

export function onPrayerMethodChange(event) {
  const value = event.target && event.target.value;
  if (PRAYER_METHODS.indexOf(value) < 0) return;

  const saved = loadPrayer();
  if (!saved) return;
  if (!savePrayer({ lat: saved.lat, lng: saved.lng, madhhab: saved.madhhab, method: value })) return;

  markPrayerMethod(value);
  renderPrayerView();
}

export function onPrayerShowAll() {
  prayerShowAll = !prayerShowAll;
  renderPrayerTimes();
}

export function renderQazaView() {
  if (!qazaState) return;

  const total = qazaTotalRemaining(qazaState);

  const summary = document.getElementById('qaza-summary');
  if (summary) {
    summary.textContent = 'Осталось всего: ' + total +
      ' · Цель: ' + QAZA_DAILY_GOAL + ' намаза в день';
  }

  // Когда очередь исчерпана, выбирать стартовый намаз не из чего
  setHidden('qaza-start-block', total === 0);

  renderQazaRemaining();
  renderQazaStart();
  renderQazaPlan();
  renderQazaAdd();
}

// Выбор намаза для ручного добавления: пять радио в виде пилюль, как в блоке
// «Откуда продолжаем?». По умолчанию не выбрано ничего — программа не берётся
// угадывать, какой именно намаз человек забыл.
export function renderQazaAdd() {
  const box = document.getElementById('qaza-add');
  const button = document.getElementById('qaza-add-btn');

  // Подтверждать нечего, пока намаз не выбран
  if (button) button.disabled = qazaAddPick === null;
  if (!box) return;

  let html = '';
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const isPicked = i === qazaAddPick;

    html += '<label class="qaza-add-option' + (isPicked ? ' is-picked' : '') + '">' +
      '<input type="radio" class="qaza-add-radio" name="qaza-add" value="' + i + '"' +
      (isPicked ? ' checked' : '') + '>' +
      '<span class="qaza-add-name">' + escapeHtml(NAMAZ_LABELS[NAMAZ_ORDER[i]]) + '</span>' +
      (isPicked ? '<span class="qaza-add-mark">выбран</span>' : '') +
      '</label>';
  }

  box.innerHTML = html;
}

// Выбор намаза в блоке добавления: только подсветка, состояние очереди не трогается.
// Обработчик делегирован на #qaza-add, потому что список перерисовывается.
export function onQazaAddPick(event) {
  const target = event && event.target;
  if (!target || !target.classList || !target.classList.contains('qaza-add-radio')) return;

  const index = parseInt(target.value, 10);
  if (!Number.isInteger(index) || index < 0 || index >= NAMAZ_ORDER.length) return;

  qazaAddPick = index;
  renderQazaAdd();
  restoreQazaRadioFocus('qaza-add', 'qaza-add-radio');
}

// Подтверждение добавления: остаток выбранного намаза растёт на единицу,
// счётчик дня и курсор очереди остаются на месте.
export function onQazaAddSubmit() {
  if (qazaAddPick === null) return;

  // Ручное добавление тоже идёт в день каза: ночью до Фаджра это вчера (§5)
  if (!addMissedQaza(qazaState, NAMAZ_ORDER[qazaAddPick], kazaDayFor(new Date()))) return;

  // После добавления выбор сбрасывается: повторное нажатие не должно
  // записать тот же намаз второй раз
  qazaAddPick = null;
  afterQazaChange();
}

// Выбор стартового намаза: пять радио. Текущий помечен рамкой и словом «сейчас»,
// чтобы выбор не передавался только цветом.
export function renderQazaStart() {
  const box = document.getElementById('qaza-start');
  if (!box) return;

  let html = '';
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const isCursor = i === qazaState.cursor;

    html += '<label class="qaza-start-option' + (isCursor ? ' is-cursor' : '') + '">' +
      '<input type="radio" class="qaza-start-radio" name="qaza-start" value="' + i + '"' +
      (isCursor ? ' checked' : '') + '>' +
      '<span class="qaza-start-name">' + escapeHtml(NAMAZ_LABELS[NAMAZ_ORDER[i]]) + '</span>' +
      (isCursor ? '<span class="qaza-start-mark">сейчас</span>' : '') +
      '</label>';
  }

  box.innerHTML = html;
}

// Смена стартового намаза: курсор переставляется и план пересчитывается.
// Обработчик делегирован на #qaza-start, потому что список перерисовывается.
export function onQazaStartChange(event) {
  const target = event && event.target;
  if (!target || !target.classList || !target.classList.contains('qaza-start-radio')) return;

  const index = parseInt(target.value, 10);
  if (!Number.isInteger(index) || index < 0 || index >= NAMAZ_ORDER.length) return;

  qazaState.cursor = index;

  // Курсор обязан указывать на намаз с остатком > 0
  normalizeQazaCursor(qazaState);

  if (!saveQaza(qazaState)) return;
  renderQazaView();
  restoreQazaRadioFocus('qaza-start', 'qaza-start-radio');
}

// Перерисовка списка радио уносит фокус вместе со старыми узлами, и обход
// стрелками обрывается. Возвращаем фокус на выбранный вариант.
// На мышиный клик это не влияет: :focus-visible тогда не срабатывает.
export function restoreQazaRadioFocus(boxId, radioClass) {
  const box = document.getElementById(boxId);
  if (!box) return;

  const checked = box.querySelector('.' + radioClass + ':checked');
  if (checked) checked.focus({ preventScroll: true });
}

// Список пяти намазов с остатками. Текущий помечен рамкой и словом «сейчас»,
// чтобы информация не передавалась только цветом.
export function renderQazaRemaining() {
  const box = document.getElementById('qaza-remaining');
  if (!box) return;

  let html = '';
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const key = NAMAZ_ORDER[i];
    const isCursor = i === qazaState.cursor;
    const isEmpty = qazaState.remaining[key] === 0;

    html += '<div class="qaza-row' + (isCursor ? ' is-cursor' : '') +
      (isEmpty ? ' is-empty' : '') + '">' +
      '<span class="qaza-row-name">' + escapeHtml(NAMAZ_LABELS[key]) + '</span>' +
      (isCursor ? '<span class="qaza-row-mark">сейчас</span>' : '') +
      '<span class="qaza-count">' + escapeHtml(qazaState.remaining[key]) + '</span>' +
      '</div>';
  }

  box.innerHTML = html;
}

// План на сегодня. Кнопка «Выполнено» есть только у первого пункта:
// очередь строго последовательная, перепрыгнуть её нельзя.
export function renderQazaPlan() {
  const box = document.getElementById('qaza-plan');
  const note = document.getElementById('qaza-note');
  const undo = document.getElementById('qaza-undo');
  const startLabel = document.getElementById('qaza-plan-start');
  if (!box) return;

  // День каза, а не календарный: запись, зачтённая ночью во вчера, отменяется
  // оттуда же, куда легла (§7)
  const today = kazaDayFor(new Date());
  const plan = getQazaPlan(qazaState);

  if (undo) {
    const last = qazaState.history[qazaState.history.length - 1];
    undo.disabled = !last || last.date !== today;
  }

  if (plan.length === 0) {
    box.innerHTML = '';
    if (startLabel) {
      startLabel.hidden = true;
      startLabel.textContent = '';
    }
    if (note) {
      note.hidden = false;
      note.textContent = 'Все каза выполнены. Остатков не осталось.';
    }
    return;
  }

  if (note) {
    note.hidden = true;
    note.textContent = '';
  }

  // Всегда видно, откуда программа отсчитывает план
  if (startLabel) {
    startLabel.hidden = false;
    startLabel.textContent = 'Начать с: ' + NAMAZ_LABELS[NAMAZ_ORDER[qazaState.cursor]];
  }

  let html = '';
  for (let i = 0; i < plan.length; i++) {
    const key = NAMAZ_ORDER[plan[i]];
    const isCurrent = i === 0;

    html += '<div class="qaza-plan-item' + (isCurrent ? ' is-current' : '') + '">' +
      '<span class="qaza-plan-name">' + escapeHtml(NAMAZ_LABELS[key]) + '</span>' +
      (isCurrent
        ? '<button type="button" id="qaza-done" class="btn btn-primary">Выполнено</button>'
        : '<span class="qaza-plan-next">дальше</span>') +
      '</div>';
  }

  box.innerHTML = html;
}

// Нажатие «Выполнено». Обработчик делегирован на #qaza-plan, потому что
// содержимое плана перерисовывается целиком.
// День берётся не календарный, а день каза (§5): ночью до Фаджра выполнение
// уходит во вчерашний день, и об этом говорит тост — иначе отметка в таблице
// встала бы не туда, где её ищут (§6).
export function onQazaDone(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== 'function') return;
  if (!target.closest('#qaza-done')) return;

  const day = kazaDayFor(new Date());
  if (!markQazaDone(qazaState, day)) return;
  afterQazaChange();

  if (day !== toISODate(new Date())) showToast('Каза зачтена во вчерашний день');
}

// Отмена работает с тем днём, к которому отнесена верхняя запись (§7):
// запись, зачтённая вчера, снимается там же, где и легла.
export function onQazaUndo() {
  if (!undoQazaDone(qazaState, kazaDayFor(new Date()))) return;
  afterQazaChange();
}

// Общая часть после изменения очереди: перерисовать вкладку, ячейки каза
// и прогресс-круг строки h6 в таблице
export function afterQazaChange() {
  renderQazaView();
  updateQazaCells();
  updateRowCircle(QAZA_HABIT_ID);
}

// Разметка ячейки каза: число выполненных за день либо прочерк
export function qazaCellMarkup(date) {
  const value = getRecord(date, QAZA_HABIT_ID);
  const isEmpty = typeof value !== 'number';
  return '<span class="cell-qaza' + (isEmpty ? ' is-empty' : '') + '">' +
    escapeHtml(isEmpty ? '—' : String(value)) + '</span>';
}

// Обновление ячеек каза во всех днях отображаемой недели
export function updateQazaCells() {
  const cells = document.querySelectorAll(
    '#habits-tbody td.cell[data-habit-id="' + cssEscape(QAZA_HABIT_ID) + '"]'
  );
  for (let i = 0; i < cells.length; i++) {
    const date = cells[i].getAttribute('data-date');
    if (!date) continue;
    cells[i].innerHTML = qazaCellMarkup(date);
  }

  // В режиме «День» таблица скрыта — обновляем ещё и карточки
  if (isMainDayView()) renderDayCards();
}

/* --- Вкладка «Ураза» ----------------------------------------------------- */

// Форма открыта кнопкой обычного экрана: 'add' или 'edit'. Первый запуск
// сюда не пишется — он выводится из отсутствия ключа. Иначе «ключ стёрли»
// и «форму ещё не закрыли» стали бы одним состоянием.
export let fastInitMode = null;

// Экран раздела: форма ввода или обычный экран. Признак первого запуска —
// только loadFast() === null. Остаток 0 — существующий счётчик, и экран
// у него обычный: возмещать нечего, но добавлять и править есть что.
export function renderFastView() {
  const fast = loadFast();
  const mode = fastInitMode || (fast === null ? 'start' : null);

  setHidden('fast-init', mode === null);
  setHidden('fast-main', mode !== null || fast === null);

  if (mode !== null) {
    // Заголовок и «Отмена» зависят от случая: на первом запуске обычного
    // экрана ещё нет, и отменять нечего
    const title = document.querySelector('#fast-init .qaza-subtitle');
    if (title) {
      title.textContent = mode === 'add' ? 'Сколько дней добавить?'
        : mode === 'edit' ? 'Сколько дней осталось?'
          : 'Сколько дней нужно возместить?';
    }
    setHidden('fast-init-cancel', mode === 'start');

    // Сообщение об ошибке снимается при каждом открытии формы заново
    const note = document.getElementById('fast-init-note');
    if (note) note.textContent = '';
    return;
  }

  const label = document.getElementById('fast-remaining');
  if (label) label.textContent = fastRemainingLabel(fast.remaining);

  // При нулевом остатке «Возместить» гаснет: возмещённых постов не бывает
  // больше, чем дней к возмещению
  const done = document.getElementById('fast-done');
  if (done) done.disabled = fast.remaining <= 0;
}

// Открыть форму кнопкой обычного экрана
export function openFastForm(mode) {
  fastInitMode = mode;

  const field = document.getElementById('fast-init-value');
  if (field) field.value = '';
  renderFastView();
  if (field) field.focus();
}

export function onFastAdd() {
  openFastForm('add');
}

export function onFastEdit() {
  openFastForm('edit');
}

export function onFastInitCancel() {
  fastInitMode = null;
  renderFastView();
}

// «Возместить 1 день». Кнопка при нулевом остатке погашена, но обработчик
// проверяет остаток сам: погашенная кнопка — подсказка, а не защита,
// и остаток не должен уйти в минус нажатием из консоли или скрипта.
export function onFastDone() {
  const fast = loadFast();
  if (!fast || fast.remaining <= 0) return;

  if (!markFastDone(fast)) return;
  renderFastView();
}

// «Сохранить» формы. Один обработчик на три случая: режим решает, что делать
// с введённым числом. Неверный ввод оставляет форму открытой — исправлять
// его здесь же, а не в обычном экране.
export function onFastInitSave() {
  const field = document.getElementById('fast-init-value');
  const note = document.getElementById('fast-init-note');
  const fast = loadFast();

  const mode = fastInitMode || (fast === null ? 'start' : null);
  if (mode === null) return;

  // Первый запуск и «Изменить счётчик» задают остаток целиком (≥ 0),
  // «Добавить уразу» — только прибавку (> 0, ноль не принимается)
  const value = parseFastInput(field ? field.value : '', mode === 'add' ? 'add' : 'counter');
  if (value === null) {
    if (note) {
      note.textContent = mode === 'add'
        ? 'Введите целое число больше нуля, не больше ' + FAST_MAX_INPUT + '.'
        : 'Введите целое число от 0 до ' + FAST_MAX_INPUT + '.';
    }
    return;
  }

  if (mode === 'add') {
    if (!addFast(fast, value)) return;
  } else {
    // Первого ключа ещё нет — заводим его здесь же
    if (!setFast(fast || { version: FAST_VERSION, remaining: 0, history: [] }, value)) return;
  }

  if (note) note.textContent = '';
  if (field) field.value = '';

  fastInitMode = null;
  renderFastView();
}

/* --- Раздел «Цикл сна» --------------------------------------------------- */

// Значение поля экрана. Поля читаются как есть: набор, который видит человек
export function sleepFieldValue(id) {
  const field = document.getElementById(id);
  return field ? field.value : '';
}

// Состояние галочки «встану по рекомендации». Снятая галочка и отсутствие
// элемента — одно и то же: без экрана решения нет, и по умолчанию идёт цель
export function sleepFollowRec() {
  const box = document.getElementById('sleep-follow-rec');
  return !!box && box.checked === true;
}

// Синхронизация поля фактического подъёма: видимость и подсказка. Вызывается
// из renderSleepView и onSleepFieldChange. Галочка «встал по плану» отмечена —
// поле скрыто, подсказка очищена. Галочка снята, поле пустое — подсказка
// «Введите время, во сколько встали». Галочка снята, поле заполнено, но
// время не разбирается — подсказка «Введите время в формате ЧЧ:ММ».
// Иначе — подсказка очищена
export function syncRealWakeField() {
  const onPlanBox = document.getElementById('sleep-on-plan');
  const field = document.getElementById('sleep-real-wake-field');
  const note = document.getElementById('sleep-real-wake-note');
  const input = document.getElementById('sleep-real-wake');
  if (!onPlanBox || !field || !note || !input) return;

  if (onPlanBox.checked) {
    field.hidden = true;
    note.textContent = '';
    return;
  }

  field.hidden = false;
  if (!input.value) {
    note.textContent = 'Введите время, во сколько встали';
  } else if (sleepTimeMinutes(input.value) === null) {
    note.textContent = 'Введите время в формате ЧЧ:ММ';
  } else {
    note.textContent = '';
  }
}

// Решение по текущим полям: что уйдёт в историю и сколько это минут. Одно
// место, где из трёх полей и галочки собирается ответ; им пользуются и
// отрисовка, и запись, поэтому разойтись они не могут. Пустое или неверное
// любое из полей — null
export function sleepDecision() {
  const bed = sleepFieldValue('sleep-bed');
  const wake = sleepFieldValue('sleep-wake');
  const fall = sleepFallMinutes(sleepFieldValue('sleep-fall'));
  if (fall === null) return null;

  const followRec = sleepFollowRec();
  const actualWake = actualWakeTime(bed, fall, wake, followRec);
  if (actualWake === null) return null;

  const sleepMin = sleepDurationMinutes(bed, fall, actualWake);
  if (sleepMin === null) return null;

  // Фактический подъём: галочка «встал по плану» снята — поле времени
  // обязательно, иначе запись в хранилище не идёт
  const onPlanBox = document.getElementById('sleep-on-plan');
  const realWakeField = document.getElementById('sleep-real-wake');
  const onPlan = !!onPlanBox && onPlanBox.checked;
  let realWake = null;
  let ready = true;
  if (!onPlan) {
    const realWakeValue = realWakeField ? realWakeField.value : '';
    if (realWakeValue) {
      const parsed = sleepTimeMinutes(realWakeValue);
      if (parsed !== null) {
        realWake = realWakeValue;
      } else {
        ready = false;
      }
    } else {
      ready = false;
    }
  }

  const realSleepMin = realWake !== null
    ? sleepDurationMinutes(bed, fall, realWake)
    : null;

  const excludedBox = document.getElementById('sleep-excluded');
  const excluded = !!excludedBox && excludedBox.checked === true;

  return {
    bed: bed,
    fall: fall,
    wake: wake,
    followRec: followRec,
    actualWake: actualWake,
    sleepMin: sleepMin,
    realWake: realWake,
    realSleepMin: realSleepMin,
    excluded: excluded,
    ready: ready,
  };
}

// Вход на экран: три поля и галочка заполняются сохранённым, затем считается
// итог. Записи нет — поля остаются пустыми, галочка снята, и итог тоже пуст.
// Галочка ставится сравнением actualWake с wake: отдельного поля у неё нет,
// а «встаю по рекомендации» — это ровно случай, когда времена разошлись.
// Совпадение (будильник ровно на конце цикла) галочку не вернёт, но разницы
// там нет: оба режима дают одно и то же время
export function renderSleepView() {
  const sleep = loadSleep();
  const follow = document.getElementById('sleep-follow-rec');
  if (follow) follow.checked = !!sleep && sleep.actualWake !== sleep.wake;
  if (sleep) {
    const bed = document.getElementById('sleep-bed');
    const fall = document.getElementById('sleep-fall');
    const wake = document.getElementById('sleep-wake');
    if (bed) bed.value = sleep.bed;
    if (fall) fall.value = String(sleep.fall);
    if (wake) wake.value = sleep.wake;
  } else {
    const onPlan = document.getElementById('sleep-on-plan');
    if (onPlan) onPlan.checked = true;
    const realWake = document.getElementById('sleep-real-wake');
    if (realWake) realWake.value = '';
    const excluded = document.getElementById('sleep-excluded');
    if (excluded) excluded.checked = false;
  }
  if (sleep) {
    const onPlan = document.getElementById('sleep-on-plan');
    if (onPlan) onPlan.checked = sleep.realWake === null;
    const realWake = document.getElementById('sleep-real-wake');
    if (realWake) realWake.value = sleep.realWake || '';
    const excluded = document.getElementById('sleep-excluded');
    if (excluded) excluded.checked = sleep.excluded === true;
  }
  syncRealWakeField();
  renderSleepResult();
}

// Итог по трём полям и галочке. Пустое или неверное любое из полей —
// результата нет вовсе: половина расчёта хуже, чем его отсутствие
export function renderSleepResult() {
  const box = document.getElementById('sleep-result');
  if (!box) return;

  const decision = sleepDecision();
  const result = decision === null
    ? null
    : sleepCycleTimes(decision.bed, decision.fall, decision.wake);

  if (!decision || !result) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = sleepResultMarkup(decision, result);
}

// Разметка итога: крупный будильник, время для истории, длительность сна,
// пояснение, список циклов и полоска. Крупным у пары вариантов идёт первый —
// тот, что раньше: подсвечены в списке оба, а решает человек. Время для
// истории считается от галочки и с крупным может не совпасть: там ближайший
// конец цикла, здесь — то, что человек выбрал
export function sleepResultMarkup(decision, result) {
  const pick = result.recommended[0];
  const parts = [];

  parts.push('<p class="sleep-alarm">Будильник: ' + escapeHtml(pick.time) + '</p>');
  let actualText;
  if (decision.realWake) {
    actualText = 'В историю: ' + decision.realWake + ' (по факту)';
  } else if (decision.followRec) {
    actualText = 'В историю: ' + decision.actualWake + ' (по рекомендации)';
  } else if (decision.ready === true) {
    actualText = 'В историю: ' + decision.actualWake + ' (по цели)';
  } else {
    actualText = 'В историю: —';
  }
  parts.push('<p class="sleep-actual">' + escapeHtml(actualText) + '</p>');
  parts.push('<p class="sleep-duration">Сон: ' +
    escapeHtml(sleepFormatDuration(decision.realSleepMin ?? decision.sleepMin)) + '</p>');

  let detail = sleepCycleLabel(pick.cycles) + ', ' + sleepFormatDuration(pick.sleepMinutes);
  if (result.recommended.length === 2) {
    detail += ' · встать раньше — ' + result.recommended[0].time +
      ', встать позже — ' + result.recommended[1].time;
  }
  parts.push('<p class="sleep-detail">' + escapeHtml(detail) + '</p>');

  parts.push('<div class="sleep-cycles">');
  for (let i = 0; i < result.cycles.length; i++) {
    const cycle = result.cycles[i];
    const recommended = result.recommended.indexOf(cycle) !== -1;
    parts.push('<p' + (recommended ? ' class="is-recommended"' : '') + '>' +
      escapeHtml(sleepCycleLabel(cycle.cycles) + ' — ' + cycle.time) + '</p>');
  }
  parts.push('</div>');

  parts.push(sleepBarMarkup(decision.bed, decision.fall, decision.wake, result.cycles));
  return parts.join('');
}

// Полоска: по горизонтали — от отхода до конца последнего цикла. Засечки
// нарисованы узкими прямоугольниками, а не линиями: viewBox растягивается
// по ширине карточки неравномерно (preserveAspectRatio="none"), и толщина
// штриха у линии поехала бы вместе с растяжением. Метка подъёма — акцентная
// и заметно шире засечки; за последним циклом она прижимается к краю
export function sleepBarMarkup(bed, fall, wake, cycles) {
  const anchors = sleepAnchors(bed, fall, wake);
  if (!anchors || !cycles.length) return '';

  const span = anchors.asleepMinutes + cycles[cycles.length - 1].sleepMinutes -
    anchors.bedMinutes;
  if (span <= 0) return '';

  function at(minutes) {
    const percent = ((minutes - anchors.bedMinutes) / span) * 100;
    return Math.max(0, Math.min(100, percent));
  }

  const parts = [];
  parts.push('<div class="sleep-bar">');
  parts.push('<svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">');
  parts.push('<rect class="sleep-bar-track" x="0" y="17" width="100" height="6"></rect>');
  for (let i = 0; i < cycles.length; i++) {
    const tick = (at(anchors.asleepMinutes + cycles[i].sleepMinutes) - 0.3).toFixed(2);
    parts.push('<rect class="sleep-bar-tick" x="' + tick +
      '" y="11" width="0.6" height="18"></rect>');
  }
  const mark = (at(anchors.wakeMinutes) - 0.5).toFixed(2);
  parts.push('<rect class="sleep-bar-wake" x="' + mark +
    '" y="5" width="1" height="30"></rect>');
  parts.push('</svg>');
  parts.push('</div>');
  return parts.join('');
}

// Правка любого поля или галочки: сначала пересчёт, потом запись. Галочка
// идёт сюда же — она меняет то же решение, а формы на экране нет, отправлять
// нечего. Сохраняется то, что в полях сейчас, — неполный набор saveSleep
// отбросит сам. Слушаются оба события полей: колесо времени на телефоне
// присылает только change
export function onSleepFieldChange() {
  syncRealWakeField();
  const decision = sleepDecision();
  if (!decision || !decision.ready) return;

  if (!saveSleep({
    bed: decision.bed,
    fall: decision.fall,
    wake: decision.wake,
    actualWake: decision.actualWake,
    sleepMin: decision.sleepMin,
    realWake: decision.realWake,
    realSleepMin: decision.realSleepMin,
    excluded: decision.excluded,
  })) {
    renderSleepView();
    syncRealWakeField();
    return;
  }

  renderSleepResult();
}

/* --- Модальное окно ------------------------------------------------------ */

export function openModal() {
  appState.habits = loadHabits();
  renderHabitList();
  const modal = document.getElementById('habit-modal');
  if (modal) modal.hidden = false;
}

export function closeModal() {
  const modal = document.getElementById('habit-modal');
  if (modal) modal.hidden = true;
  setFormError('');
  // После добавления привычки список на экране «Привычки» устарел
  renderHabitsEditList();
}

// Список привычек в модалке. События делегированы на #habit-list.
export function renderHabitList() {
  const list = document.getElementById('habit-list');
  if (!list) return;

  let html = '';
  for (let i = 0; i < appState.habits.length; i++) {
    const habit = appState.habits[i];
    // У каза тип задаётся вкладкой «Каза-намазы» и заблокирован всегда;
    // у остальных — только если по привычке уже есть записи
    const isQaza = habit.id === QAZA_HABIT_ID;
    const locked = isQaza || hasRecords(habit.id);
    const lockedTitle = isQaza
      ? 'Тип каза задаётся вкладкой «Каза-намазы»'
      : 'Тип нельзя изменить: по привычке уже есть записи';
    const lockedAttr = locked
      ? ' disabled title="' + escapeHtml(lockedTitle) + '"'
      : '';
    const goalValue = habit.goal === null || habit.goal === undefined
      ? '' : String(habit.goal);

    html += '<li data-habit-id="' + escapeHtml(habit.id) + '">' +
      '<input type="text" class="habit-edit-name" value="' + escapeHtml(habit.name) +
      '" aria-label="Название">' +
      '<select class="habit-type"' + lockedAttr + ' aria-label="Тип">' +
      typeOptionsMarkup(habit.type) + '</select>' +
      '<input type="text" class="habit-edit-unit" value="' + escapeHtml(habit.unit || '') +
      '" placeholder="Ед." aria-label="Единица измерения">' +
      '<input type="number" class="habit-edit-goal" min="1" step="1" value="' +
      escapeHtml(goalValue) + '" placeholder="Цель" aria-label="Цель">' +
      // Время — только у привычек с уровнями: оно задаёт окно «вовремя»
      (isLevelHabit(habit.id)
        ? '<input type="time" class="habit-edit-time" value="' +
          escapeHtml(habit.time || '') + '" aria-label="Время">'
        : '') +
      '<button type="button" class="btn btn-secondary habit-save">Сохранить</button>' +
      // У каза кнопки удаления нет: удалив привычку, синхронизацию не восстановить
      (isQaza ? '' : '<button type="button" class="btn btn-danger habit-delete">Удалить</button>') +
      '</li>';
  }

  list.innerHTML = html;
}

// Делегированный обработчик кнопок «Сохранить» и «Удалить» в списке
export function onHabitListClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  const item = target.closest('li[data-habit-id]');
  if (!item) return;

  const habitId = item.getAttribute('data-habit-id');
  const habit = findHabit(habitId);
  if (!habit) return;

  if (target.closest('.habit-delete')) {
    if (!window.confirm('Удалить привычку «' + habit.name + '» и все её записи?')) return;
    if (!removeHabit(habitId)) return;
    appState.habits = loadHabits();
    setFormError('');
    renderHabitList();
    renderMainView();
    return;
  }

  if (target.closest('.habit-save')) {
    const data = readHabitItem(item);
    const result = validateHabitForm(data, habitId);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    const patch = { name: data.name.trim(), unit: data.unit, goal: data.goal };
    // Время есть только у привычек с уровнями: поле пустое — время не задано
    if (isLevelHabit(habitId)) patch.time = data.time;
    // Тип меняем только у привычки без записей
    if (!hasRecords(habitId)) patch.type = data.type;

    if (!updateHabit(habitId, patch)) return;
    appState.habits = loadHabits();
    setFormError('');
    renderHabitList();
    renderMainView();
  }
}

/* --- Экран «Привычки» (настройки, телефон) ------------------------------- */

// Строки-аккордеоны: поля раскрываются тапом по заголовку
export function renderHabitsEditList() {
  const list = document.getElementById('habits-edit-list');
  if (!list) return;

  let html = '';
  for (let i = 0; i < appState.habits.length; i++) {
    const habit = appState.habits[i];
    const isQaza = habit.id === QAZA_HABIT_ID;
    const locked = isQaza || hasRecords(habit.id);
    const lockedTitle = isQaza
      ? 'Тип каза задаётся вкладкой «Каза-намазы»'
      : 'Тип нельзя изменить: по привычке уже есть записи';
    const lockedAttr = locked
      ? ' disabled title="' + escapeHtml(lockedTitle) + '"'
      : '';
    const isNumber = habit.type === 'number';
    const numberHidden = isNumber ? '' : ' hidden';
    const goalValue = habit.goal === null || habit.goal === undefined
      ? '' : String(habit.goal);

    html += '<li class="habit-row-edit" data-habit-id="' + escapeHtml(habit.id) + '">' +
      '<button type="button" class="habit-row-head">' +
        '<span class="habit-row-name">' + escapeHtml(habit.name) + '</span>' +
        '<span class="habit-row-type">' + escapeHtml(habitTypeLabel(habit.type)) + '</span>' +
        '<span class="habit-row-chevron">›</span>' +
      '</button>' +
      '<div class="habit-row-body">' +
        '<label><span>Название</span>' +
          '<input type="text" class="edit-name" value="' + escapeHtml(habit.name) + '">' +
        '</label>' +
        '<label><span>Тип</span>' +
          '<select class="edit-type"' + lockedAttr + '>' +
          typeOptionsMarkup(habit.type) + '</select>' +
        '</label>' +
        '<label class="edit-number-field"' + numberHidden + '><span>Единица измерения</span>' +
          '<input type="text" class="edit-unit" value="' + escapeHtml(habit.unit || '') +
          '" placeholder="Ед.">' +
        '</label>' +
        '<label class="edit-number-field"' + numberHidden + '><span>Цель</span>' +
          '<input type="number" class="edit-goal" min="1" step="1" value="' +
          escapeHtml(goalValue) + '" placeholder="Цель">' +
        '</label>' +
        // Время — только у привычек с уровнями: оно задаёт окно «вовремя»
        (isLevelHabit(habit.id)
          ? '<label class="edit-time-field"><span>Время</span>' +
            '<input type="time" class="edit-time" value="' +
            escapeHtml(habit.time || '') + '">' +
            '</label>'
          : '') +
        '<p class="form-error" role="alert"></p>' +
        '<div class="habit-row-actions">' +
          '<button type="button" class="btn btn-primary edit-save">Сохранить</button>' +
          // У каза удаления нет: удалив привычку, синхронизацию не восстановить
          (isQaza ? '' : '<button type="button" class="btn btn-danger edit-delete">Удалить</button>') +
        '</div>' +
      '</div>' +
      '</li>';
  }

  list.innerHTML = html;
}

// Ошибка показывается внутри раскрытой строки — форма модалки здесь не видна
export function setRowError(item, message) {
  const error = item.querySelector('.form-error');
  if (error) error.textContent = message || '';
}

// Делегированный обработчик экрана «Привычки»
export function onHabitsEditClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  if (target.closest('.habit-row-head')) {
    const row = target.closest('.habit-row-edit');
    if (!row) return;
    const wasOpen = row.classList.contains('is-open');
    // Открыта не более одной строки: раскрытие закрывает соседей
    const siblings = row.parentNode.children;
    for (let i = 0; i < siblings.length; i++) {
      siblings[i].classList.remove('is-open');
    }
    if (!wasOpen) row.classList.add('is-open');
    return;
  }

  const item = target.closest('li[data-habit-id]');
  if (!item) return;

  const habitId = item.getAttribute('data-habit-id');
  const habit = findHabit(habitId);
  if (!habit) return;

  if (target.closest('.edit-delete')) {
    if (!window.confirm('Удалить привычку «' + habit.name + '» и все её записи?')) return;
    if (!removeHabit(habitId)) return;
    appState.habits = loadHabits();
    renderHabitsEditList();
    renderMainView();
    return;
  }

  if (target.closest('.edit-save')) {
    const data = readHabitItem(item, EDIT_ROW_SELECTORS);
    const result = validateHabitForm(data, habitId);
    if (!result.ok) {
      setRowError(item, result.error);
      return;
    }
    const patch = { name: data.name.trim(), unit: data.unit, goal: data.goal };
    // Время есть только у привычек с уровнями: поле пустое — время не задано
    if (isLevelHabit(habitId)) patch.time = data.time;
    // Тип меняем только у привычки без записей
    if (!hasRecords(habitId)) patch.type = data.type;

    if (!updateHabit(habitId, patch)) return;
    appState.habits = loadHabits();
    renderHabitsEditList();
    renderMainView();
  }
}

// Поля «Единица» и «Цель» нужны только числовому типу
export function onHabitsEditChange(event) {
  const field = event.target;
  if (!field || !field.classList || !field.classList.contains('edit-type')) return;

  const item = field.closest('li[data-habit-id]');
  if (!item) return;

  const isNumber = field.value === 'number';
  const fields = item.querySelectorAll('.edit-number-field');
  for (let i = 0; i < fields.length; i++) {
    fields[i].hidden = !isNumber;
  }
}

// Селекторы строки экрана «Привычки» — имена классов отличаются от модалки
export const EDIT_ROW_SELECTORS = {
  name: '.edit-name',
  type: '.edit-type',
  unit: '.edit-unit',
  goal: '.edit-goal',
  time: '.edit-time',
};

// Данные одной строки списка привычек.
// cls переопределяет селекторы: в модалке и на экране «Привычки» они разные.
export function readHabitItem(item, cls) {
  const sel = cls || {};
  const nameField = item.querySelector(sel.name || '.habit-edit-name');
  const typeField = item.querySelector(sel.type || '.habit-type');
  const unitField = item.querySelector(sel.unit || '.habit-edit-unit');
  const goalField = item.querySelector(sel.goal || '.habit-edit-goal');
  const timeField = item.querySelector(sel.time || '.habit-edit-time');

  const type = typeField ? typeField.value : 'boolean';
  const unit = unitField ? unitField.value.trim() : '';
  const goalText = goalField ? goalField.value.trim() : '';
  // Пустое поле времени — это null, а не пустая строка: так «времени нет»
  // и «время затёрли» читаются одинаково
  const timeText = timeField ? timeField.value.trim() : '';

  return {
    name: nameField ? nameField.value : '',
    type: type,
    unit: type === 'number' ? unit : '',
    goal: type === 'number' ? Number(goalText) : null,
    time: timeText === '' ? null : timeText,
  };
}

/* --- Форма добавления привычки ------------------------------------------- */

export function setFormError(message) {
  const error = document.getElementById('form-error');
  if (error) error.textContent = message || '';
}

// Поля unit и goal имеют смысл только для числового типа
export function updateFormFields() {
  const typeField = document.getElementById('form-type');
  const unitField = document.getElementById('form-unit');
  const goalField = document.getElementById('form-goal');
  const isNumber = !!typeField && typeField.value === 'number';
  if (unitField) unitField.hidden = !isNumber;
  if (goalField) goalField.hidden = !isNumber;
}

export function onFormSubmit(event) {
  event.preventDefault();

  const nameField = document.getElementById('form-name');
  const typeField = document.getElementById('form-type');
  const unitField = document.getElementById('form-unit');
  const goalField = document.getElementById('form-goal');

  const type = typeField ? typeField.value : 'boolean';
  const data = {
    name: nameField ? nameField.value : '',
    type: type,
    unit: unitField ? unitField.value.trim() : '',
    goal: type === 'number' && goalField ? Number(goalField.value.trim()) : null,
  };

  const result = validateHabitForm(data);
  if (!result.ok) {
    setFormError(result.error);
    return;
  }

  const created = addHabit({
    name: data.name.trim(),
    type: data.type,
    unit: data.type === 'number' ? data.unit : '',
    goal: data.goal,
  });
  if (!created) return;

  appState.habits = loadHabits();
  setFormError('');

  const form = document.getElementById('habit-form');
  if (form) form.reset();
  updateFormFields();

  renderHabitList();
  renderMainView();
}

// validateHabitForm(data, excludeId) -> { ok: true } | { ok: false, error }
// excludeId позволяет не считать саму привычку дубликатом при редактировании.
export function validateHabitForm(data, excludeId) {
  const skipId = excludeId !== undefined && excludeId !== null
    ? excludeId
    : (data && data.excludeId !== undefined ? data.excludeId : null);

  const name = (data && data.name ? String(data.name) : '').trim();
  if (name === '') {
    return { ok: false, error: 'Введите название привычки' };
  }

  const habits = loadHabits();
  const lowerName = name.toLowerCase();
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === skipId) continue;
    if (String(habits[i].name).trim().toLowerCase() === lowerName) {
      return { ok: false, error: 'Привычка с названием «' + name + '» уже существует' };
    }
  }

  if (data && data.type === 'number') {
    const goal = data.goal;
    const isInteger = typeof goal === 'number' && isFinite(goal) &&
      Math.floor(goal) === goal && goal > 0;
    if (!isInteger) {
      return { ok: false, error: 'Цель должна быть целым числом больше 0' };
    }
    if (!(data.unit ? String(data.unit) : '').trim()) {
      return { ok: false, error: 'Укажите единицу измерения для числовой привычки' };
    }
  }

  return { ok: true };
}

/* --- Проводка слоёв через шину событий -------------------------------------
   Единственное место, где слои слышат друг друга: данные эмитят правку,
   синхронизация — применённый снимок, хранилище — ошибку записи. Прямых
   вызовов между слоями нет, поэтому при переходе на ES-модули (Фаза 3.2)
   граф импортов останется однонаправленным. */

bus.on('data:changed', scheduleSync);
bus.on('data:replaced', function () {
  appState.habits = loadHabits();
  qazaState = loadQaza();
  renderMainView();
  renderQazaView();
  renderPrayerView();
  renderFastView();
});
bus.on('sync:applied', function () {
  renderMainView();
  renderQazaView();
  renderPrayerView();
  renderFastView();
  const sw = document.getElementById('schedule-view');
  if (sw && !sw.hidden) renderScheduleView();
});
bus.on('storage:error', function () {
  showToast('Не удалось сохранить: хранилище переполнено');
});

document.addEventListener('DOMContentLoaded', init);

// Регистрация service worker для офлайн-работы.
// По file:// регистрация невозможна — ошибку молча глотаем, страница работает как обычно.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}

// --- Liquid Glass: плавающая капсула для таб-бара и всех переключателей ---
export const LIQUID_SWITCH_SELECTORS = [
  '#tab-bar',
  '#main-view-switch',
  '#schedule-switch',
  '#schedule-edit-switch',
  '#stats-period',
  '#stats-qaza-period',
  '#stats-habits-period',
  '#stats-habit-period',
  '#stats-fast-period',
  '#stats-sleep-period'
];

window.moveIndicator = function (container) {
  if (!container || container.hidden) return;

  const indicator = container.querySelector(':scope > .glass-indicator');
  const button = container.querySelector(':scope > button.is-active');

  if (!indicator || !button) return;
  if (button.offsetWidth <= 0 || button.offsetHeight <= 0) return;

  const containerRect = container.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();

  if (containerRect.width <= 0 || containerRect.height <= 0) return;

  if (container.id === 'tab-bar') {
    const maxPillWidth = 60;
    const pillWidth = Math.max(0, Math.min(maxPillWidth, buttonRect.width - 12));

    const relativeLeft =
      (buttonRect.left - containerRect.left) +
      (buttonRect.width - pillWidth) / 2;

    const maxLeft = Math.max(0, containerRect.width - pillWidth);
    const clampedLeft = Math.max(0, Math.min(relativeLeft, maxLeft));

    indicator.style.width = pillWidth + 'px';
    indicator.style.height = '36px';
    indicator.style.top = '14px';
    indicator.style.transform =
      'translate3d(' + clampedLeft + 'px, 0, 0)';
  } else {
    const rawLeft = buttonRect.left - containerRect.left;
    const maxWidth = Math.max(0, containerRect.width - Math.max(0, rawLeft));
    const buttonWidth = Math.max(0, Math.min(buttonRect.width, maxWidth));

    indicator.style.width = buttonWidth + 'px';
    indicator.style.height = 'calc(100% - 8px)';
    indicator.style.top = '4px';
    indicator.style.transform =
      'translate3d(' + Math.max(0, rawLeft) + 'px, 0, 0)';
  }
};

export function getLiquidSwitchContainers() {
  return LIQUID_SWITCH_SELECTORS
    .map(function (selector) {
      return document.querySelector(selector);
    })
    .filter(Boolean);
}

export function moveAllIndicators() {
  getLiquidSwitchContainers().forEach(function (container) {
    window.moveIndicator(container);
  });
}

export let liquidIndicatorFrame = 0;

export function scheduleLiquidIndicators() {
  if (liquidIndicatorFrame) {
    cancelAnimationFrame(liquidIndicatorFrame);
  }

  liquidIndicatorFrame = requestAnimationFrame(function () {
    liquidIndicatorFrame = 0;
    moveAllIndicators();
  });
}

document.addEventListener('click', function (event) {
  const button = event.target.closest(
    LIQUID_SWITCH_SELECTORS.join(', ') + ' > button'
  );

  if (!button) return;

  requestAnimationFrame(function () {
    requestAnimationFrame(scheduleLiquidIndicators);
  });
});

// Наблюдатель следит за class/hidden; style не наблюдаем, чтобы собственные
// изменения индикатора не зацикливали пересчёт.
export const liquidObserver = new MutationObserver(function () {
  scheduleLiquidIndicators();
});

export function observeLiquidSwitches() {
  getLiquidSwitchContainers().forEach(function (container) {
    liquidObserver.observe(container, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden']
    });
  });
}

export let liquidResizeObserver = null;

export function observeLiquidSwitchSizes() {
  if (!('ResizeObserver' in window)) return;

  if (liquidResizeObserver) {
    liquidResizeObserver.disconnect();
  }

  liquidResizeObserver = new ResizeObserver(function () {
    scheduleLiquidIndicators();
  });

  getLiquidSwitchContainers().forEach(function (container) {
    liquidResizeObserver.observe(container);
  });
}

export function updateTabCalendarDate() {
  const dateElement = document.getElementById('tab-calendar-date');
  if (!dateElement) return;

  dateElement.textContent = String(new Date().getDate());
}

document.addEventListener('DOMContentLoaded', function () {
  updateTabCalendarDate();
  observeLiquidSwitches();
  observeLiquidSwitchSizes();
  scheduleLiquidIndicators();
});

window.addEventListener('resize', scheduleLiquidIndicators);

window.addEventListener('orientationchange', function () {
  scheduleLiquidIndicators();
});
  