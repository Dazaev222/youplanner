import { bus } from '../core/bus.js';
import { ARCHIVE_KEY, loadArchive } from '../data/archive.js';
import { FAST_KEY, FAST_VERSION, loadFast, validFastHistory } from '../data/fast.js';
import { getAuthToken } from '../data/firebase-auth.js';
import { DEFAULT_HABITS, defaultHabit, loadHabits, loadTombstones, pruneResolvedTombstones, saveHabits } from '../data/habits.js';
import { markMigration, migratePressHabit } from '../data/migrations.js';
import { PRAYER_KEY, loadPrayer } from '../data/prayer.js';
import { QAZA_LOG_KEY, QAZA_LOG_VERSION, QAZA_STORAGE_KEY, loadQaza, loadQazaLog, validQazaLogEntries } from '../data/qaza.js';
import { invalidateRecordsCache, loadRecords } from '../data/records.js';
import { loadSchedule } from '../data/schedule.js';
import { SLEEP_KEY, loadSleep, validSleepHistory } from '../data/sleep.js';
import { STORAGE_KEYS } from '../data/storage.js';
import { rollbackStagedKeys } from '../core/storage.js';
import { BACKUP_LIMIT, FIREBASE_BACKUPS_URL, FIREBASE_URL, SYNC_DEBOUNCE_MS, SYNC_TS_KEY } from '../data/sync.js';
import { clearSyncPending, markSyncPending, normalizing, saveNormalized, syncPending, syncTs } from './state.js';
import { mergeCloudIntoLocal, mergeTombstonesById } from './merge.js';
import { hasData, validCloudArchive, validCloudFast, validCloudHabits, validCloudPrayer, validCloudQaza, validCloudQazaLog, validCloudRecords, validCloudSchedule, validCloudSleep, validCloudTombstones } from './validators.js';
export let syncTimer = null;
// Сетевой таймаут обменов. Без него зависшее соединение (сеть отдаёт TCP,
// но не отвечает) держит syncExchange открытым вечно: правки встают в
// очередь и не уезжают, пока страница не перезагружена. Ручной контроллер,
// а не AbortSignal.timeout: тот появился в Safari только в 15.4, и вызов
// на старых iPhone кидал TypeError (см. js/ui/assistant-view.js).
const SYNC_TIMEOUT_MS = 20000;
// Таймаут обмена. В fallback-ветке (Safari < 15.4) таймер создаётся вручную,
// поэтому возвращается пара «сигнал + отмена»: без clearTimeout короткий
// успешный обмен оставлял бы за собой живой таймер до 20 с.
function syncGuard() {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS), cancel: function () {} };
  }
  // Песочницы без Abort API (юнит-тесты, старые движки) ходят без сигнала:
  // отсутствие таймаута лучше падения каждого обмена
  if (typeof AbortController === 'undefined') {
    return { signal: undefined, cancel: function () {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, SYNC_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cancel: function () { clearTimeout(timer); },
  };
}
// fetch с таймаутом: таймер снимается, как только запрос завершился любым
// исходом (успех, ошибка, прерывание). Сам таймаут по-прежнему прерывает
// зависший запрос.
//
// Токен анонимной аутентификации добывается здесь, в единственной обёртке:
// правило базы auth != null (database.rules.json) закрывает все пять узлов
// сразу, и вызывающим про аутентификацию знать не нужно. Токена нет (нет
// ключа, офлайн, пауза после неудачи) — запрос идёт как раньше: до публикации
// правил база публична, это рабочий режим. getAuthToken() не бросает и при
// неудаче не выходит в сеть до конца своей 5-минутной паузы, так что вызов
// здесь дешёвый.
async function fetchWithTimeout(url, options) {
  const token = await getAuthToken();
  let fullUrl = url;
  if (token) {
    fullUrl = url + (url.indexOf('?') === -1 ? '?' : '&') +
      'auth=' + encodeURIComponent(token);
  }
  const guard = syncGuard();
  const request = Object.assign({}, options, { signal: guard.signal });
  return fetch(fullUrl, request).finally(guard.cancel);
}
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
// Применяет данные с сервера. Пишем прямо в localStorage: saveHabits/saveQaza
// поставили бы отправку и вернули бы на сервер только что полученное.
// Пустой раздел на сервере не затирает непустой локальный: это след неполного
// снимка, а не осознанное удаление — иначе чужая пустая копия съест записи.
//
// Применение устроено «всё или ничего» (аудит 2026-10-31): раньше каждый
// прошедший проверку раздел писался сразу, и QuotaExceededError посреди
// применения оставлял половину разделов — данные пользователя смешивались
// с серверными, а UI рисовал половину. Теперь три фазы:
//   1) валидация всех разделов и сбор stage — пар «ключ, готовая строка» —
//      без единой записи в хранилище;
//   2) снимок предыдущего состояния каждого ключа stage;
//   3) запись; первая ошибка — откат уже записанных ключей (rollbackStagedKeys).
// Предсказать квоту localStorage заранее нельзя: navigator.storage.estimate
// считает совсем другое (кэш и диски, а не лимит ключей), у строк своя цена
// в UTF-16 — поэтому гарантией целостности служит откат фаз 2–3, а не
// предсказание места.
// Результат: true — снимок применён целиком; false — хранилище отвергло
// запись и применение откачено (потребитель обязан считать снимок
// неприменённым); применять было нечего — undefined, как раньше.
export function applyCloudData(data, ts) {
  syncing = true;
  // Снимок считается принятым, если хотя бы один раздел прошёл проверку
  // и был применён. Только тогда двигаем SYNC_TS_KEY: отметка времени
  // на отброшенных данных заставила бы считать сервер свежее, чем он есть.
  // Флаг живёт на уровне функции, а не внутри try: эмит в конце читает его
  // уже за пределами try-блока.
  let cloudApplied = false;
  try {
    // Снимок локального берём под флагом: loadQaza при первом прогоне пишет
    // дефолты и иначе поставил бы отправку
    const local = {
      habits: loadHabits(),
      records: loadRecords(),
      qaza: loadQaza(true),
      prayer: loadPrayer() || {},
      fast: loadFast() || null,
      qazaLog: loadQazaLog() || null,
      sleep: loadSleep() || null,
      schedule: loadSchedule(),
      tombstones: loadTombstones(),
    };

    // ── Фаза 1: валидация всех разделов, сбор stage без записей ──
    // Условия применения каждого раздела — ровно прежние: битый раздел
    // по-прежнему отвергается целиком (в stage не попадает и не пишется
    // вовсе), но остальные разделы снимка из-за него не отбрасываются.
    // Ключей на удаление в stage нет: прежняя семантика никогда не стирает
    // разделы снимком, и выдумывать удаление здесь нельзя.
    const stage = [];
    if (validCloudHabits(data.habits) && (hasData(data.habits) || !hasData(local.habits))) {
      stage.push({ key: STORAGE_KEYS.habits, value: JSON.stringify(data.habits) });
    }
    if (validCloudRecords(data.records) &&
        (hasData(data.records) || !hasData(local.records))) {
      stage.push({ key: STORAGE_KEYS.records, value: JSON.stringify(data.records) });
    }
    // Раздел каза не применяется, пока есть неотправленная правка:
    // серверной копии она ещё не видела, и снимок затёр бы её молча.
    if (!syncPending && validCloudQaza(data.qaza) &&
        (hasData(data.qaza) || !hasData(local.qaza))) {
      stage.push({ key: QAZA_STORAGE_KEY, value: JSON.stringify(data.qaza) });
    }
    // Координаты — один раздел целиком. Пустой объект с сервера
    // не затирает заданные координаты: это след неполного снимка.
    if (validCloudPrayer(data.prayer) &&
        (hasData(data.prayer) || !hasData(local.prayer))) {
      stage.push({ key: PRAYER_KEY, value: JSON.stringify(data.prayer) });
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
      stage.push({ key: FAST_KEY, value: JSON.stringify({
        version: FAST_VERSION,
        remaining: data.fast.remaining,
        history: validFastHistory(data.fast.history),
      }) });
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
      stage.push({ key: QAZA_LOG_KEY, value: JSON.stringify({
        version: QAZA_LOG_VERSION,
        since: data.qazaLog.since,
        entries: validQazaLogEntries(data.qazaLog.entries),
      }) });
    }
    // Запись о сне — отдельный раздел, один целиком, как счётчик уразы.
    // Пустой объект с сервера не затирает заведённую запись: он приходит
    // следом неполного снимка, а не осознанным удалением (§5)
    if (validCloudSleep(data.sleep) &&
        (hasData(data.sleep) || !hasData(local.sleep))) {
      stage.push({ key: SLEEP_KEY, value: JSON.stringify(Object.assign({}, data.sleep, {
        history: validSleepHistory(data.sleep.history),
      })) });
    }
    // Расписание заменяется целиком, как запись о сне. Дефолтов здесь нет:
    // loadSchedule подставляет их сама, поэтому раздел с сервера, прошедший
    // проверку, применяется всегда — пустым он быть не может. Перерисовка
    // открытого экрана расписания — у подписчика sync:applied, вместе
    // с остальными экранами (§11v)
    if (validCloudSchedule(data.schedule)) {
      stage.push({ key: STORAGE_KEYS.schedule, value: JSON.stringify(data.schedule) });
    }
    // Архив — месячные сводки историй (js/data/archive.js). Раздел заменяет
    // локальный целиком: сводки производные, месяцы пересчитываются заново
    // при каждой архивации. Раздела в снимке нет — локальный архив не
    // трогается: снимок старой версии не должен обнулять то, чего не знает.
    if (validCloudArchive(data.archive)) {
      stage.push({ key: ARCHIVE_KEY, value: JSON.stringify(data.archive) });
    }
    // Надгробия удалённых привычек (B.3): раздел необязателен — старые
    // снимки без него применяются как раньше. Заменять локальные надгробия
    // серверными нельзя: ещё не отправленная метка удаления исчезла бы,
    // и привычка воскресла бы при следующем слиянии. Поэтому — слияние
    // по max(ts) (mergeTombstonesById), аддитивное в обе стороны.
    const cloudTombstones = validCloudTombstones(data.tombstones);
    if (cloudTombstones && hasData(cloudTombstones)) {
      stage.push({
        key: STORAGE_KEYS.tombstones,
        value: JSON.stringify(mergeTombstonesById(local.tombstones, cloudTombstones)),
      });
    }

    // Нечего применять: прежний код с cloudApplied=false не писал метку
    // и не эмитил — выходим с тем же наблюдаемым результатом (undefined)
    if (stage.length === 0) return;

    // Метка времени — последний элемент stage: она движется только вместе
    // с целым снимком (бывшее `if (cloudApplied)`), а сбой её записи откатывает
    // снимок целиком — метка на наполовину применённых данных заставила бы
    // считать их серверными и больше не принимать свежий снимок.
    stage.push({ key: SYNC_TS_KEY, value: String(ts) });

    // ── Фаза 2: снимок предыдущего состояния каждого ключа stage ──
    // Журнал — он же протокол отката: written отмечает уже записанные
    // ключи (только они подлежат откату), had — существовал ли ключ до
    // записи (стирать или восстанавливать).
    const appliedLog = [];
    for (let i = 0; i < stage.length; i++) {
      const previous = localStorage.getItem(stage[i].key);
      appliedLog.push({
        key: stage[i].key,
        value: stage[i].value,
        previous: previous,
        had: previous !== null,
        written: false,
      });
    }

    // ── Фаза 3: применение; первая ошибка — откат всего записанного ──
    for (let i = 0; i < appliedLog.length; i++) {
      try {
        localStorage.setItem(appliedLog[i].key, appliedLog[i].value);
      } catch (e) {
        // QuotaExceededError или любая другая ошибка записи: применённое
        // до сбоя откатывается целиком (см. rollbackStagedKeys)
        rollbackStagedKeys(appliedLog, 'applyCloudData');
        // Практика сообщения о квоте в проекте одна: safeSetItem эмитит
        // storage:error, тост показывает подписчик в app.js. Метка не
        // двигается и sync:applied не эмится: хранилище осталось ровно
        // в прежнем состоянии
        bus.emit('storage:error');
        return false;
      }
      appliedLog[i].written = true;
      // Кэш записей сбрасывается сразу после записи раздела, как раньше:
      // при последующем откате кэш просто перечитает прежнюю строку
      if (appliedLog[i].key === STORAGE_KEYS.records) invalidateRecordsCache();
    }

    cloudApplied = true;
  } finally {
    syncing = false;
  }

  // Обновление appState и перерисовку делает подписчик sync:applied:
  // слой синхронизации не знает ни состояния интерфейса, ни рендеров.
  // Эмит только при реально применённых данных: отвергнутый снимок ничего
  // не менял, и шторм перерисовок (таблица, каза, молитвы, ураза) был бы
  // чистым расходом — при сверах «ничего нового» частых.
  if (cloudApplied) bus.emit('sync:applied');
  // Дошли сюда — все ключи записаны, отката не было
  return true;
}
// Чей снимок применяем. Чистое правило без чтения глобального состояния:
// серверный снимок должен быть строго новее и не спорить с правкой, которой
// сервер ещё не видел (pending). Ранние возвраты вместо вложенных условий.
export function serverSnapshotWins(serverTs, localTs, pending) {
  const server = Number(serverTs) || 0;
  const local = Number(localTs) || 0;

  if (!server) return false;          // метки нет — не новее
  if (server <= local) return false;
  if (pending) return false;          // правка ещё не ушла наверх
  return true;
}

// Уступает ли локальное состояние серверному снимку. Правило одно на все
// сверки: снимок должен быть новее и не спорить с правкой, которой сервер
// ещё не видел. Второе условие закрывает гонку первых секунд: правка, сделанная
// во время незавершённой сверки, уходит наверх (init после сверки зовёт
// syncToCloud), а пришедший снимок её уже не трогает — иначе правка пропала бы,
// не дойдя до сервера. Другое устройство получит её при следующей сверке.
export function cloudSnapshotWins(serverTs) {
  return serverSnapshotWins(serverTs, syncTs(), syncPending);
}
// Снимок отвергнут, но привычек у нас нет вовсе — значит правка, которой
// сервер ещё не видел, привычек не касалась: править было нечего. Берём
// серверный список, иначе пустой уехал бы наверх и стёр серверный.
function adoptServerHabitsIfLocalEmpty(data) {
  if (!Array.isArray(data.habits) || !hasData(data.habits)) return;
  if (hasData(loadHabits())) return;
  localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(data.habits));
  // Привычки вернулись в список — их надгробия (если чудом остались)
  // больше не нужны: висящая метка блокировала бы привоз этой привычки
  // на других устройствах
  pruneResolvedTombstones();
  // Список только что сменился, а DOM остался прежним: обновление
  // состояния и перерисовку делает подписчик sync:applied (§11v)
  bus.emit('sync:applied');
}
// Забирает данные с сервера. Промис разрешается true, если на сервере пусто —
// тогда init отправляет наверх локальную копию.
// Ошибки сети глотаем: приложение работает на локальных данных.
export async function syncFromCloud() {
  try {
    const response = await fetchWithTimeout(FIREBASE_URL + '.json');
    if (!response.ok) throw new Error('нет ответа');
    const data = await response.json();

    cloudReachable = true;
    if (!data || typeof data !== 'object') {
      return { reachable: true, serverEmpty: true };
    }

    const serverTs = Number(data.updatedAt) || 0;
    if (!cloudSnapshotWins(serverTs)) {
      adoptServerHabitsIfLocalEmpty(data);
      return { reachable: true, serverEmpty: false };
    }

    // false у applyCloudData — строго «хранилище отвергло запись, применение
    // откачено»: снимок не применён, метка не двигалась, но сервер отвечал.
    // Минимальная реакция — та же, что у сетевой ошибки ниже: пометить
    // сервер недоступным, обмен фактического результата не дал (защита
    // серверных привычек в syncBody остаётся честной). reachable в ответе
    // остаётся true: сервер реально отвечал, а reachable:false заставил бы
    // settleHabitsAfterSync сеять офлайн-дефолты поверх рабочих данных.
    if (applyCloudData(data, serverTs) === false) {
      cloudReachable = false;
    } else {
      // Снимок применён: привычки, вернувшиеся в списке, надгробий не
      // заслужили — иначе метки уезжали бы наверх при каждой отправке
      // и блокировали привоз этой привычки на других устройствах
      pruneResolvedTombstones();
    }
    return { reachable: true, serverEmpty: false };
  } catch (e) {
    cloudReachable = false;
    return { reachable: false, serverEmpty: false };
  }
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
  async function run() {
    try {
      return await syncToCloudNow();
    } finally {
      syncExchange = null;
      if (syncQueued) {
        syncQueued = false;
        syncToCloud();
      }
    }
  }
  syncExchange = run();
  return syncExchange;
}
// Отправляет локальные данные наверх. Ключ времени пишется ПОСЛЕ успешного
// PUT: если отправка не дошла, локальная копия и в реальности не новее
// серверной, и завышенный таймстамп помешал бы принять следующий снимок.
export async function syncToCloudNow() {
  const ts = Date.now();

  // Сначала копия, потом запись: сбой копирования данные всё равно отправит.
  // Заодно оттуда берётся предыдущий узел — он нужен телу запроса.
  let previous = null;
  try {
    previous = await backupCloudSnapshot();
  } catch (e) {
    previous = null;
  }

  // Гонка бэкапов двух устройств (аудит 2026-10-31): PUT затирает узел
  // целиком, и правки, которые другое устройство записало после нашей
  // последней сверки, гибли бы молча. Пока серверный снимок новее последней
  // сверки, он сливается с локальным состоянием и слияние применяется себе:
  // наверх уходит объединение, а не перезапись (js/sync/merge.js). Равные
  // метки — снимок уже виден локально, слияние не нужно.
  const cloudTs = previous ? Number(previous.updatedAt) || 0 : 0;
  if (previous && cloudTs > syncTs()) {
    applyMergedFromCloud(previous);
  }

  // Вторая гонка того же обмена (B.2): между первым GET и PUT устройство B
  // может отправить свой снимок — PUT без повторной сверки стёр бы правки B
  // безвозвратно. Поэтому непосредственно перед PUT — ещё один GET; снимок
  // изменился (метка updatedAt или байты JSON) — слияние повторяется со
  // свежим снимком, и наверх уезжает уже объединение с чужой правкой.
  // Однократного повтора достаточно: обмен инициируется кнопкой или
  // дебаунсом 1,5 с, окно гонки — миллисекунды, а каждый лишний круг —
  // лишняя секунда задержки и лишний шанс новой гонки.
  let fresh = null;
  try {
    fresh = await fetchCloudNode();
  } catch (e) {
    // Повторное чтение не удалось: PUT уходит как раньше, по первому снимку —
    // это прежнее поведение обмена, слияние выше уже защитило от старой гонки
    fresh = null;
  }
  if (fresh && snapshotDiffers(fresh, previous)) {
    const freshTs = Number(fresh.updatedAt) || 0;
    if (freshTs > syncTs()) {
      applyMergedFromCloud(fresh);
    }
    // Тело PUT строится по последнему виденному снимку: запасной путь
    // «серверные привычки при пустом локальном списке» должен видеть
    // свежий сервер, а не тот, что был двумя запросами назад
    previous = fresh;
  }

  try {
    const response = await fetchWithTimeout(FIREBASE_URL + '.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: syncBody(ts, previous),
    });
    if (response.ok) {
      localStorage.setItem(SYNC_TS_KEY, String(ts));
      if (!syncTimer) clearSyncPending();
    }
    return response;
  } catch (e) {
    // Сеть отвалилась на PUT: до следующего успешного ответа сервер
    // считается недоступным, иначе cloudReachable залипает в true
    // и syncBody перестаёт беречь серверные привычки при пустом локальном списке.
    cloudReachable = false;
  }
}
// Отличаются ли два снимка сервера. Метка updatedAt — быстрый путь: чужой PUT
// всегда пишет свою метку. Совпадение меток (два устройства уложились в одну
// миллисекунду) проверяется побайтово: содержимое могло разойтись при равной
// метке, а лишнее слияние дешевле потерянной правки.
function snapshotDiffers(a, b) {
  const aTs = Number(a && a.updatedAt) || 0;
  const bTs = Number(b && b.updatedAt) || 0;
  if (aTs !== bTs) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}
// Тело PUT. Привычки берём локальные — кроме одного случая: сверка ни разу
// не дошла до сервера, а список у нас пуст. Пустой список здесь значит
// «не загрузили», а не «привычек нет», и PUT стёр бы серверные привычки,
// которых мы просто не видели. Тогда отправляем серверные (§13).
function syncBody(ts, previous) {
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
      // Архив — сводки старше года (js/data/archive.js): второе устройство
      // получает суммы срезанной детализации вместе со снимком.
      archive: loadArchive() || null,
      // Надгробия удалённых привычек (js/data/habits.js): след удаления,
      // из-за которого аддитивное слияние не воскресит привычку. Пустой
      // объект уезжает как есть — раздел необязательный, получатель пустоту
      // просто пропустит.
      tombstones: loadTombstones(),
      // Метки свежести по разделам для слияния (js/sync/merge.js): PUT пишет
      // все разделы разом, поэтому все метки равны времени отправки. Раздел
      // чужого снимка применяется, только если его метка строго новее нашей
      // последней сверки; в снимках до введения меток роль играет updatedAt.
      // Метка tombstones при слиянии не участвует (max(ts) безусловно), но
      // стоит в общем ряду, чтобы карта разделов оставалась полной.
      sectionTs: {
        habits: ts,
        records: ts,
        qaza: ts,
        prayer: ts,
        fast: ts,
        qazaLog: ts,
        sleep: ts,
        schedule: ts,
        tombstones: ts,
      },
      updatedAt: ts,
    });
  } finally {
    syncing = false;
  }
}
// Ключ хранилища для раздела слияния. null — раздел без своего ключа
// (таких в слитом снимке быть не должно).
function mergeSectionKey(section) {
  switch (section) {
    case 'habits': return STORAGE_KEYS.habits;
    case 'records': return STORAGE_KEYS.records;
    case 'qaza': return QAZA_STORAGE_KEY;
    case 'prayer': return PRAYER_KEY;
    case 'fast': return FAST_KEY;
    case 'qazaLog': return QAZA_LOG_KEY;
    case 'sleep': return SLEEP_KEY;
    case 'schedule': return STORAGE_KEYS.schedule;
    case 'archive': return ARCHIVE_KEY;
    case 'tombstones': return STORAGE_KEYS.tombstones;
  }
  return null;
}
// Слияние облачного снимка с локальным состоянием и запись изменившихся
// разделов (гонка двух устройств, см. syncToCloudNow). Те же три фазы, что
// у applyCloudData: сбор stage без записей, снимок прежнего состояния,
// запись с откатом. Разделы, которые слияние не меняло, не пишутся вовсе:
// sync:applied и перерисовка — только на реальные изменения. Пишем прямо
// в хранилище: saveX поставили бы отправку на каждый раздел, а здесь вся
// порция уезжает текущим PUT.
function applyMergedFromCloud(previous) {
  const local = {
    habits: loadHabits(),
    records: loadRecords(),
    qaza: loadQaza(true),
    prayer: loadPrayer() || {},
    fast: loadFast() || null,
    qazaLog: loadQazaLog() || null,
    sleep: loadSleep() || null,
    schedule: loadSchedule(),
    archive: loadArchive(),
    tombstones: loadTombstones(),
  };
  const merged = mergeCloudIntoLocal(local, previous, {
    pending: syncPending,
    localTs: syncTs(),
  });
  if (!merged) return;

  const stage = [];
  const sections = Object.keys(merged);
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const key = mergeSectionKey(section);
    if (!key) continue;
    const before = local[section] === undefined ? null : local[section];
    const after = merged[section] === undefined ? null : merged[section];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    stage.push({ key: key, value: JSON.stringify(after), section: section });
  }
  if (stage.length === 0) return;

  const appliedLog = [];
  for (let i = 0; i < stage.length; i++) {
    const previousValue = localStorage.getItem(stage[i].key);
    appliedLog.push({
      key: stage[i].key,
      previous: previousValue,
      had: previousValue !== null,
      written: false,
    });
  }
  for (let i = 0; i < stage.length; i++) {
    try {
      localStorage.setItem(stage[i].key, stage[i].value);
    } catch (e) {
      rollbackStagedKeys(appliedLog, 'applyMergedFromCloud');
      bus.emit('storage:error');
      return;
    }
    appliedLog[i].written = true;
    if (stage[i].section === 'records') invalidateRecordsCache();
  }
  // Слитый список мог вернуть удалённые привычки (чужая правка победила
  // надгробие): их метки снимаются, иначе уехали бы наверх при этом же PUT
  pruneResolvedTombstones();
  // Слияние уже в хранилище: подписчик sync:applied перечитает состояние,
  // запустит архивацию (снимок мог принести старую детализацию) и перерисует
  // видимый экран
  bus.emit('sync:applied');
}
// Обычное чтение узла данных без копии в бэкапы. Возвращает объект снимка
// или null, если узел пуст; при ошибке сети бросает — вызывающий решает,
// критична ли ему ошибка (backupCloudSnapshot глотает, повторный GET перед
// PUT в syncToCloudNow переводит обмен в прежний односнимочный режим).
// Токен и таймаут — в общей обёртке fetchWithTimeout.
async function fetchCloudNode() {
  const response = await fetchWithTimeout(FIREBASE_URL + '.json');
  if (!response.ok) throw new Error('нет ответа');
  const previous = await response.json();
  if (!previous || typeof previous !== 'object') return null;
  return previous;
}
// Кладёт в отдельный узел бэкапов копию того, что сейчас лежит на сервере:
// запись затирает чужой снимок, и без копии его не вернуть. Свежая версия
// сверху, всего не больше BACKUP_LIMIT — самая старая уходит. Пустой узел
// копировать нечего. Узел бэкапов — соседний корень (FIREBASE_BACKUPS_URL),
// а не ребёнок данных: иначе PUT основного узла стирал бы копии (см. выше).
// Возвращает предыдущий узел: не вышло записать копию — отправку это
// не отменяет, и узел всё равно нужен вызывающему.
// Два чтения — снимок данных и список бэкапов — независимы и ходят
// параллельно: раньше они были последовательными, и каждое сохранение
// платило тремя сетевыми кругами вместо двух (GET+GET → PUT).
export async function backupCloudSnapshot() {
  try {
    const previous = await fetchCloudNode();
    if (!previous) return null;

    // Снимки старой схемы могли тащить вложенный backups от прежнего
    // расположения: в новую историю его не кладём, иначе копии
    // вкладывались бы друг в друга и раздували узел.
    const snapshot = Object.assign({}, previous);
    delete snapshot.backups;

    // Копия — best-effort: её сбой отправку не отменяет, но previous
    // всё равно нужен вызывающему.
    try {
      const backupsResponse = await fetchWithTimeout(FIREBASE_BACKUPS_URL + '.json');
      if (!backupsResponse.ok) throw new Error('нет ответа');
      const list = await backupsResponse.json();
      const items = Array.isArray(list) ? list : [];
      items.unshift(snapshot);
      await fetchWithTimeout(FIREBASE_BACKUPS_URL + '.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items.slice(0, BACKUP_LIMIT)),
      });
    } catch (e) {
      // не вышло записать копию — данные всё равно отправит syncToCloudNow
    }
    return previous;
  } catch (e) {
    return null;
  }
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

// Взводится init'ом после первой сверки: до этого отправка запрещена,
// а переприсваивать импортированный let из app.js нельзя — поэтому доступ.
export function markCloudReady() {
  cloudReady = true;
}

// Уход со вкладки с несделанной отложенной правкой: debounce снимается
// и отправка уходит сразу — приложение могут закрыть раньше таймера.
export function flushPendingSync() {
  if (!syncTimer) return;
  clearTimeout(syncTimer);
  syncTimer = null;
  syncToCloud();
}
