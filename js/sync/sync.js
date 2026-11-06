import { bus } from '../core/bus.js';
import { ARCHIVE_KEY, loadArchive } from '../data/archive.js';
import { FAST_KEY, FAST_VERSION, loadFast, validFastHistory } from '../data/fast.js';
import { DEFAULT_HABITS, defaultHabit, loadHabits, loadTombstones, pruneResolvedTombstones, saveHabits } from '../data/habits.js';
import { markMigration, migratePressHabit } from '../data/migrations.js';
import { PRAYER_KEY, loadPrayer } from '../data/prayer.js';
import { QAZA_LOG_KEY, QAZA_LOG_VERSION, QAZA_STORAGE_KEY, loadQaza, loadQazaLog, validQazaLogEntries } from '../data/qaza.js';
import { invalidateRecordsCache, loadRecords } from '../data/records.js';
import { loadSchedule } from '../data/schedule.js';
import { SLEEP_KEY, loadSleep, validSleepHistory } from '../data/sleep.js';
import {
  SECTION_WRITE_TS_KEY, STORAGE_KEYS, loadPlannerEnvelope, loadSectionWriteTs,
  savePlannerEnvelope, plannerObserveVersions, sectionWriteTsJson, sectionWrittenTs,
} from '../data/storage.js';
import {
  MATRIX_STORAGE_KEY, materializePlannerTasks, plannerLoadOrBuildEnvelope, plannerOwnerUid,
} from '../data/matrix.js';
import { rollbackStagedKeys, safeSetItem } from '../core/storage.js';
// Ядро sync-слоя: константы Firebase, флаги состояния и валидаторы снимка
// (слито из data/sync.js, sync/state.js и sync/validators.js, этап Y2)
import { BACKUP_LIMIT, FIREBASE_BACKUPS_URL, FIREBASE_PLANNER_URL, FIREBASE_URL, SYNC_DEBOUNCE_MS, SYNC_TS_KEY, clearSyncPending, hasData, markSyncPending, normalizing, saveNormalized, syncPending, syncTs, validCloudArchive, validCloudFast, validCloudHabits, validCloudPrayer, validCloudQaza, validCloudQazaLog, validCloudRecords, validCloudSchedule, validCloudSleep, validCloudTombstones } from './core.js';
import {
  mergeCloudIntoLocal, mergeTombstonesById, mergePlannerV1, normalizePlannerV1,
  plannerCanonicalJson, sectionEnvelopeWins, unwrapSection,
} from './merge.js';
import { getAuthToken } from '../data/firebase-auth.js';
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
// Последний отказ по правам: 0 — его не было, иначе 401 или 403. Ставится в
// fetchWithTimeout и снимается любым успешным ответом, чтобы «доступ
// запрещён» не висел после первого же удачного обмена. Нужен наружу (js/app.js)
// вот зачем: при пине правил на auth.uid отказ и «нет сети» — разные diagnosis,
// а путаница стоит владельцу вечера, проведённого в поисках соединения.
export let deniedStatus = 0;
// fetch с таймаутом: таймер снимается, как только запрос завершился любым
// исходом (успех, ошибка, прерывание). Сам таймаут по-прежнему прерывает
// зависший запрос.
//
// Токен аутентификации (js/data/firebase-auth.js) добывается здесь, в
// единственной обёртке: правила базы закрывают все узлы сразу, и вызывающим
// про аутентификацию знать не нужно. Токена нет (нет ключа, нет входа
// владельца, офлайн, пауза после неудачи) — запрос идёт без ?auth=, и
// опубликованные правила ответят отказом: приложение продолжит работать на
// локальных данных, а наружу уйдёт sync:denied, чтобы человек увидел причину.
// getAuthToken() не бросает и при неудаче не выходит в сеть до конца своей
// 5-минутной паузы, так что вызов здесь дешёвый.
async function fetchWithTimeout(url, options) {
  const token = await getAuthToken();
  let fullUrl = url;
  if (token) {
    fullUrl = url + (url.indexOf('?') === -1 ? '?' : '&') +
      'auth=' + encodeURIComponent(token);
  }
  const guard = syncGuard();
  const request = Object.assign({}, options, { signal: guard.signal });
  return fetch(fullUrl, request).then(function (response) {
    // 401/403 — это не «нет связи», а «нас сюда не пускают»: правила базы
    // привязаны к auth.uid владельца, и устройство без входа (или с потерянной
    // сессией) получит отказ всегда. Без сигнала снаружи это выглядело бы
    // вечной сетевой ошибкой, поэтому событие ставится здесь, в единственной
    // обёртке: его видят и GET, и PUT, и бэкапы. 5xx сюда не входит — совет
    // «проверьте вход» при сбое сервера значил бы соврать.
    if (response.status === 401 || response.status === 403) {
      deniedStatus = response.status;
      bus.emit('sync:denied', { status: response.status });
    } else if (response.ok) {
      deniedStatus = 0;
    }
    return response;
  }).finally(guard.cancel);
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
// plannerV1: подготовка применения чужого узла (без записей). Снимок
// merge-ится с envelope (замена целиком — ни одна сторона не теряет
// независимые поля; delete-wins проверяет mergePlannerV1), результат
// материализуется в список Матрицы. Отказы:
//   * узла нет / он пуст — ничего не меняем: отсутствие plannerV1 у
//     старого клиента ≠ удаление (ТЗ §1.4.1);
//   * schemaVersion неизвестен или мусор — локальное состояние целое,
//     уходит только диагностика без содержимого (ТЗ §1.3);
//   * envelope привязан к другому подтверждённому владельцу — блок в обе
//     стороны, межустройственное смешивание решает владелец (ТЗ §1.4.4).
// Возвращает пару значений для stage (envelope + список) или null.
export function planPlannerApply(cloudRaw) {
  if (cloudRaw === undefined || cloudRaw === null) return null;
  const normalized = normalizePlannerV1(cloudRaw);
  if (!normalized.ok) {
    bus.emit('planner:rejected', { unsupported: normalized.unsupported === true });
    return null;
  }
  const incoming = normalized.snapshot;
  if (!hasData(incoming.entries) && !hasData(incoming.settings) && !hasData(incoming.tombstones)) {
    return null;
  }
  const env = plannerLoadOrBuildEnvelope();
  if (env.ownerUid) {
    const uid = plannerOwnerUid();
    if (uid && uid !== env.ownerUid) return null;
  }
  const merged = mergePlannerV1(env.snapshot, incoming);
  if (plannerCanonicalJson(merged) === plannerCanonicalJson(env.snapshot)) return null;
  env.snapshot = merged;
  plannerObserveVersions(env, merged);
  const tasks = materializePlannerTasks(merged);
  return {
    envValue: JSON.stringify(env),
    tasksValue: JSON.stringify(tasks),
  };
}

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
    // Локальные метки записи цельных разделов (P1-3): с ними снимок сравнивает
    // каждый конверт, а не только общую метку снимка
    const sectionWrites = loadSectionWriteTs();
    // Метки применённых конвертов — одной записью в конце stage (см. ниже)
    const writeTsUpdates = {};

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
    //
    // P1-3: цельные разделы ходят в конвертах {v, ts} — ts это часы
    // отправителя на момент записи раздела. Общий гейт новизны
    // (cloudSnapshotWins) решает по метке ВСЕГО снимка: снимок, опубликованный
    // позже, переписывал бы раздел, записанный на этом устройстве позже чужой
    // правки. Поэтому у цельных разделов своё сравнение: конверт применяется,
    // только если его метка записи строго новее локальной (sectionWrittenTs);
    // при равенстве побеждает локальная версия — детерминированно, обе стороны
    // выберут одно и то же. Раздел без конверта (старый клиент) — ts=0:
    // конверт побеждает его при первом же обмене, а он сам не затирает свежий
    // конверт. Оба без конвертов — прежнее правило: снимок уже прошёл общий
    // гейт (третий аргумент sectionEnvelopeWins).
    const cloudQaza = unwrapSection(data.qaza);
    if (!syncPending && validCloudQaza(cloudQaza.v) &&
        (hasData(cloudQaza.v) || !hasData(local.qaza)) &&
        sectionEnvelopeWins(cloudQaza.ts, sectionWrites.qaza, true)) {
      stage.push({ key: QAZA_STORAGE_KEY, value: JSON.stringify(cloudQaza.v) });
      if (cloudQaza.ts > 0) writeTsUpdates.qaza = cloudQaza.ts;
    }
    // Координаты — один раздел целиком, в конверте {v, ts} (правило выше).
    // Пустой объект с сервера не затирает заданные координаты: это след
    // неполного снимка.
    const cloudPrayer = unwrapSection(data.prayer);
    if (validCloudPrayer(cloudPrayer.v) &&
        (hasData(cloudPrayer.v) || !hasData(local.prayer)) &&
        sectionEnvelopeWins(cloudPrayer.ts, sectionWrites.prayer, true)) {
      stage.push({ key: PRAYER_KEY, value: JSON.stringify(cloudPrayer.v) });
      if (cloudPrayer.ts > 0) writeTsUpdates.prayer = cloudPrayer.ts;
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
    // Конверт {v, ts} — как у каза и координат (P1-3, см. выше)
    const cloudFast = unwrapSection(data.fast);
    if (validCloudFast(cloudFast.v) &&
        (hasData(cloudFast.v) || !hasData(local.fast)) &&
        sectionEnvelopeWins(cloudFast.ts, sectionWrites.fast, true)) {
      stage.push({ key: FAST_KEY, value: JSON.stringify({
        version: FAST_VERSION,
        remaining: cloudFast.v.remaining,
        history: validFastHistory(cloudFast.v.history),
      }) });
      if (cloudFast.ts > 0) writeTsUpdates.fast = cloudFast.ts;
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
    // проверку, применяется всегда — пустым он быть не может. Конверт {v, ts}
    // — как у каза (P1-3, см. выше). Перерисовка открытого экрана расписания —
    // у подписчика sync:applied, вместе с остальными экранами (§11v)
    const cloudSchedule = unwrapSection(data.schedule);
    if (validCloudSchedule(cloudSchedule.v) &&
        sectionEnvelopeWins(cloudSchedule.ts, sectionWrites.schedule, true)) {
      stage.push({ key: STORAGE_KEYS.schedule, value: JSON.stringify(cloudSchedule.v) });
      if (cloudSchedule.ts > 0) writeTsUpdates.schedule = cloudSchedule.ts;
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
    // plannerV1 (ТЗ §1.4.1–2): аддитивный узел планирования. Слияние с
    // envelope и материализация списка — двумя ключами одного stage:
    // откат фазы 3 возвращает и envelope, и список побайтно
    const plannerStage = planPlannerApply(data.plannerV1);
    if (plannerStage) {
      stage.push({ key: STORAGE_KEYS.plannerEnvelope, value: plannerStage.envValue });
      stage.push({ key: MATRIX_STORAGE_KEY, value: plannerStage.tasksValue });
    }

    // Нечего применять: прежний код с cloudApplied=false не писал метку
    // и не эмитил — выходим с тем же наблюдаемым результатом (undefined)
    if (stage.length === 0) return;

    // Метки записи применённых конвертов — в той же атомарной порции: откат
    // снимка обязан откатить и карту, иначе следующее сравнение считало бы
    // раздел применённым по метке, которой в хранилище нет (или наоборот).
    // Перед меткой времени: та остаётся последним элементом stage.
    const writeTsJson = sectionWriteTsJson(writeTsUpdates);
    if (writeTsJson) stage.push({ key: SECTION_WRITE_TS_KEY, value: writeTsJson });

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
    // X-Firebase-ETag и на чтениях при сверке: метка позволяет следующему
    // обмену идти условно, а не вслепую
    const response = await fetchWithTimeout(FIREBASE_URL + '.json', {
      headers: { 'X-Firebase-ETag': 'true' },
    });
    if (!response.ok) throw new Error('нет ответа');
    lastCloudEtag = readResponseEtag(response);
    const data = await response.json();

    cloudReachable = true;
    if (!data || typeof data !== 'object') {
      return { reachable: true, serverEmpty: true };
    }

    // Состояние планировщика применяется из выделенного корня независимо от
    // «новизны» корневого снимка: порядок planner-правок разрешают
    // Lamport-версии, а не метка updatedAt (ТЗ §1.4.1). Если выделенный узел
    // пуст (узнаём из этого же GET — без него вслепую не мигрировать), а в
    // корневом снимке лежит legacy-plannerV1 — переносим его в безопасное
    // место (migratePlannerFromRoot). Ошибка сети на planner-GET не роняет
    // сверку: локальное состояние целое, повтор — при следующей сверке.
    try {
      const plannerNode = await fetchPlannerNode();
      if (plannerNode) applyPlannerNodeFromCloud(plannerNode);
      else await migratePlannerFromRoot(data);
    } catch (e) { /* выделенный узел недоступен — повтор при следующей сверке */ }

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

  // Состояние планировщика публикуется в выделенный узел ДО корневого PUT:
  // это единственная копия Матрицы, которой старомодный клиент не владеет,
  // и её выгрузка не должна зависеть от успеха корневого обмена. Публикуется
  // только устройство, у которого есть planner-содержимое или не
  // подтверждённые операции: без этого обмен не платит лишним GET. Свежий
  // GET узла перед публикацией — та же дисциплина B.2, что у корня: чужие
  // правки сливаются до записи, ETag становится If-Match условной записи.
  // GET не удался — публикация переносится: без свежего ETag PUT был бы
  // безусловным и мог бы затереть невиденные правки другого устройства;
  // операции остаются в outbox до следующего обмена.
  if (plannerPublishNode(loadPlannerEnvelope(), plannerOwnerUid())) {
    let plannerKnown = false;
    try {
      const plannerNode = await fetchPlannerNode();
      plannerKnown = true;
      if (plannerNode) applyPlannerNodeFromCloud(plannerNode);
    } catch (e) {
      plannerKnown = false;
    }
    if (plannerKnown) await publishPlannerSnapshot();
  }

  // Кольцо условной записи (ТЗ §1.4.2): PUT с If-Match по последнему
  // прочитанному ETag. 412 — серверный снимок изменился: перечитать,
  // слить (applyMergedFromCloud трогает и соседние разделы, и legacy-узел
  // plannerV1 корневого снимка), пересобрать тело и повторить. Максимум
  // PLANNER_CAS_ATTEMPTS попыток за цикл; дальше outbox честно ждёт
  // следующего цикла — глушение 412 безусловным PUT означало бы затирание
  // чужой правки.
  try {
    let response = null;
    for (let attempt = 0; attempt < PLANNER_CAS_ATTEMPTS; attempt++) {
      const putHeaders = { 'Content-Type': 'application/json' };
      if (lastCloudEtag) putHeaders['If-Match'] = lastCloudEtag;
      response = await fetchWithTimeout(FIREBASE_URL + '.json', {
        method: 'PUT',
        headers: putHeaders,
        body: syncBody(ts, previous),
      });
      if (response.status !== 412 || attempt === PLANNER_CAS_ATTEMPTS - 1) break;
      let refetch = null;
      try {
        refetch = await fetchCloudNode();
      } catch (e) {
        refetch = null;
      }
      if (!refetch) break;
      applyMergedFromCloud(refetch);
      previous = refetch;
      // тело следующего PUT строится уже по слитому состоянию (syncBody
      // перечитывает envelope и разделы из хранилища); операции
      // неподтверждённой попытки остаются в outbox до удачного CAS
    }
    if (response && response.ok) {
      // Метка времени — та же safe-запись, что и весь проект: сырой setItem
      // внутри этого try бросок квоты превращал бы успешный PUT в мнимый
      // сетевой сбой (catch ниже считает сетью любой бросок).
      safeSetItem(SYNC_TS_KEY, String(ts));
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
//
// plannerV1 в теле НЕТ: состояние планировщика уезжает отдельным PUT в
// выделенный соседний корень (FIREBASE_PLANNER_URL, publishPlannerSnapshot).
// Причина — клиент на кэше ниже v43 не знает ключа plannerV1, и его корневой
// PUT стирал узел с сервера; соседний корень корневой PUT не заменяет
// (та же дисциплина, что у FIREBASE_BACKUPS_URL). Корневой снимок, который
// ещё несёт legacy-plannerV1, теряет его с этого PUT — не потеря: миграция
// (migratePlannerFromRoot) уже скопировала снимок в выделенный узел.
const PLANNER_CAS_ATTEMPTS = 5;

function plannerPublishNode(env, uid) {
  if (!env) return null;
  if (!uid) return null;
  if (env.ownerUid && env.ownerUid !== uid) return null;
  const snapshot = env.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const hasContent = hasData(snapshot.entries) || hasData(snapshot.settings) ||
    hasData(snapshot.tombstones);
  if (!hasContent && !(Array.isArray(env.outbox) && env.outbox.length > 0)) return null;
  return snapshot;
}

// Конверт цельного раздела для снимка: {v, ts} с меткой записи раздела
// (sectionWrittenTs) — либо раздел как есть, если метки нет. Раздел, не
// записанный новой версией приложения (данные до внедрения конвертов), и
// отсутствующий раздел (null) конверта не получают: выдумывать им время
// публикации нельзя — публикация омолаживала бы раздел на каждом PUT'е, и
// сравнение конвертов сводилось бы к гонке публикаций, а не записей.
function publishSectionEnvelope(section, payload) {
  if (!payload) return payload;
  const ts = sectionWrittenTs(section);
  if (!ts) return payload;
  return { v: payload, ts: ts };
}

function syncBody(ts, previous) {
  syncing = true;
  try {
    let habits = loadHabits();
    if (!cloudReachable && !hasData(habits) && previous && hasData(previous.habits)) {
      habits = previous.habits;
    }
    const body = {
      habits: habits,
      records: loadRecords(),
      // Цельные разделы — в конвертах {v, ts} (P1-3): приёмник сравнивает
      // метки записи разделов и не затирает свежую локальную правку старым
      // снимком. Для старых клиентов форма раздела меняется: их валидаторы
      // отвергнут объект {v, ts} целиком — их данные от этого не портятся,
      // но обновления этих разделов от новой версии они не получат (принятый
      // аудитом компромисс: «новый формат побеждает при первом же обмене»).
      qaza: publishSectionEnvelope('qaza', loadQaza()),
      prayer: publishSectionEnvelope('prayer', loadPrayer() || {}),
      // Счётчика нет — наверх уходит null. Ноль счётчиком быть не перестаёт:
      // объект с remaining: 0 остаётся объектом и уезжает как есть.
      fast: publishSectionEnvelope('fast', loadFast() || null),
      // Журнала нет — наверх уходит null. Пустой журнал (entries: [])
      // остаётся объектом и уезжает как есть.
      qazaLog: loadQazaLog() || null,
      // Записи о сне нет — наверх уходит null. Пустого объекта здесь быть
      // не может: loadSleep() возвращает либо полную запись, либо null.
      sleep: loadSleep() || null,
      schedule: publishSectionEnvelope('schedule', loadSchedule()),
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
    };
    return JSON.stringify(body);
  } finally {
    syncing = false;
  }
}

// Подтверждение публикации plannerV1: операции уходят из outbox ТОЛЬКО
// после успешного CAS. Падение между CAS и ack безопасно: повтор отправит
// те же opId/версии, merge идемпотентен.
function ackPlannerPublish(info) {
  if (!info || !Array.isArray(info.publishedOpIds)) return;
  const env = loadPlannerEnvelope();
  if (!env) return;
  const published = {};
  for (let i = 0; i < info.publishedOpIds.length; i++) published[info.publishedOpIds[i]] = true;
  let changed = false;
  const kept = [];
  for (let i = 0; i < env.outbox.length; i++) {
    if (published[env.outbox[i].opId]) { changed = true; continue; }
    kept.push(env.outbox[i]);
  }
  if (info.ownerUid && !env.ownerUid) {
    env.ownerUid = info.ownerUid;
    changed = true;
  }
  if (!changed) return;
  env.outbox = kept;
  // сбой записи envelope не отменяет успех CAS: операции останутся в outbox
  // и будут подтверждены в следующем цикле той же идемпотентной доставкой
  savePlannerEnvelope(env);
}

// ── plannerV1 в выделенном корне (FIREBASE_PLANNER_URL) ─────────────────────
// Состояние планировщика живёт соседним корнем, а не ребёнком рабочего узла:
// клиент на кэше ниже v43 ключа plannerV1 не знает, и его корневой PUT стирал
// узел с сервера (status.md, заходит 2026-11-05). Соседний корень корневой
// PUT не заменяет (та же дисциплина, что у узла бэкапов), поэтому данные
// переживают любой его PUT. Правила узла — запись только владельцу.

// ETag выделенного узла. Отдельно от lastCloudEtag: это два независимых
// узла с независимыми версиями, и If-Match от корня на planner-узле всегда
// дал бы 412.
let lastPlannerEtag = null;

// Чтение выделенного узла. Возвращает снимок или null, если узел пуст;
// при ошибке сети бросает — вызывающий решает, публиковать ли вслепую.
async function fetchPlannerNode() {
  const response = await fetchWithTimeout(FIREBASE_PLANNER_URL + '.json', {
    headers: { 'X-Firebase-ETag': 'true' },
  });
  if (!response.ok) throw new Error('нет ответа');
  lastPlannerEtag = readResponseEtag(response);
  const node = await response.json();
  if (!node || typeof node !== 'object') return null;
  return node;
}

// Чужой снимок выделенного узла → локальный envelope и список Матрицы.
// Слияние то же, что у корневого снимка (planPlannerApply), но вокруг нет
// общего stage трёх фаз, поэтому запись немедленная и с откатом в духе
// saveTasks (js/data/matrix.js): сначала envelope, потом список; список не
// лег — envelope возвращается к прежним байтам.
function applyPlannerNodeFromCloud(cloudRaw) {
  const planned = planPlannerApply(cloudRaw);
  if (!planned) return false;
  let rawBefore = null;
  try {
    rawBefore = localStorage.getItem(STORAGE_KEYS.plannerEnvelope);
  } catch (e) {
    rawBefore = null;
  }
  if (!safeSetItem(STORAGE_KEYS.plannerEnvelope, planned.envValue)) return false;
  if (!safeSetItem(MATRIX_STORAGE_KEY, planned.tasksValue)) {
    if (rawBefore === null) {
      try { localStorage.removeItem(STORAGE_KEYS.plannerEnvelope); } catch (e) { /* уже пусто */ }
    } else {
      safeSetItem(STORAGE_KEYS.plannerEnvelope, rawBefore);
    }
    bus.emit('storage:error');
    return false;
  }
  // Список Матрицы изменился: перерисовку делает подписчик sync:applied (§11v)
  bus.emit('sync:applied');
  return true;
}

// Публикация снимка в выделенный узел своим CAS-контуром: If-Match по ETag
// узла, 412 — перечитать, слить, пересобрать снимок из обновлённого envelope
// и повторить; максимум PLANNER_CAS_ATTEMPTS за цикл. Операции outbox
// подтверждаются только после успешного PUT (ackPlannerPublish) — тот же
// контракт, что был у plannerV1 внутри корневого PUT. Сеть/отказ — outbox
// сохраняется и доезжает следующим обменом.
async function publishPlannerSnapshot() {
  let info = null;
  try {
    let response = null;
    for (let attempt = 0; attempt < PLANNER_CAS_ATTEMPTS; attempt++) {
      const env = loadPlannerEnvelope();
      const uid = plannerOwnerUid();
      const snapshot = plannerPublishNode(env, uid);
      if (!snapshot) return null;
      info = {
        publishedOpIds: (env.outbox || []).map(function (o) { return o.opId; }),
        ownerUid: uid,
      };
      const putHeaders = { 'Content-Type': 'application/json' };
      if (lastPlannerEtag) putHeaders['If-Match'] = lastPlannerEtag;
      response = await fetchWithTimeout(FIREBASE_PLANNER_URL + '.json', {
        method: 'PUT',
        headers: putHeaders,
        body: JSON.stringify(snapshot),
      });
      if (response.status !== 412 || attempt === PLANNER_CAS_ATTEMPTS - 1) break;
      // 412: узел изменился под нами. Повторное чтение отличает «узел стал
      // пуст» (легальный ответ — повторяем PUT уже с новым ETag) от «сети
      // нет» (повторный PUT был бы безусловным слепым — переносим на
      // следующий обмен, как и при первой неудаче чтения).
      let refetch = null;
      let refetchOk = false;
      try {
        refetch = await fetchPlannerNode();
        refetchOk = true;
      } catch (e) {
        refetchOk = false;
      }
      if (!refetchOk) break;
      if (refetch) applyPlannerNodeFromCloud(refetch);
      // снимок следующей попытки перечитывается из envelope в начале цикла
    }
    if (response && response.ok) ackPlannerPublish(info);
    return response;
  } catch (e) {
    return null;
  }
}

// Миграция при первой загрузке: снимок plannerV1, лежащий в корневом узле
// (туда писали клиенты до выноса на соседний корень), переносится в
// выделенный узел. Вызывается только когда выделенный узел ТОЧНО пуст —
// сверка только что прочитала его, — поэтому перезаписать чужие данные
// миграция не может. Повторяемая: непустой выделенный узел и мусор вместо
// снимка — no-op; не вышло скопировать — повтор при следующей сверке.
async function migratePlannerFromRoot(rootSnapshot) {
  const legacy = rootSnapshot && typeof rootSnapshot === 'object'
    ? rootSnapshot.plannerV1
    : null;
  if (!legacy) return false;
  const normalized = normalizePlannerV1(legacy);
  if (!normalized.ok) return false;
  const snapshot = normalized.snapshot;
  if (!hasData(snapshot.entries) && !hasData(snapshot.settings) &&
      !hasData(snapshot.tombstones)) return false;
  const putHeaders = { 'Content-Type': 'application/json' };
  // If-Match по только что прочитанному пустому узлу: если другое устройство
  // мигрировало одновременно с нами, сервер ответит 412 — и правильно, его
  // копия уже там, повторная не нужна.
  if (lastPlannerEtag) putHeaders['If-Match'] = lastPlannerEtag;
  try {
    const response = await fetchWithTimeout(FIREBASE_PLANNER_URL + '.json', {
      method: 'PUT',
      headers: putHeaders,
      body: JSON.stringify(snapshot),
    });
    // 401/403 (правила узла ещё не опубликованы владельцем) и другие не-ok —
    // копия не состоялась: помечаем неудачей, чтобы следующая сверка
    // повторила перенос вместо того, чтобы считать его свершившимся
    if (!response.ok) return false;
  } catch (e) {
    return false;
  }
  // Данные в безопасном месте: сливаются и в локальный envelope, чтобы
  // устройство, чей корневой снимок не свежее, всё равно увидело Матрицу
  applyPlannerNodeFromCloud(snapshot);
  return true;
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
  // Метки записи цельных разделов: слияние сравнивает по ним конверты
  // (P1-3), а победившая метка переносится в карту тем же stage ниже
  const sectionWrites = loadSectionWriteTs();
  const merged = mergeCloudIntoLocal(local, previous, {
    pending: syncPending,
    localTs: syncTs(),
    sectionWrites: sectionWrites,
  });
  // plannerV1 сливается независимо от «ок новее» соседних разделов:
  // CRDT-состояние разрешают Lamport-версии, а не метка снимка; старый
  // узел plannerV1 всё равно не может «воскресить» локальные tombstones
  const plannerStage = planPlannerApply(previous.plannerV1);
  if (!merged && !plannerStage) return;

  const stage = [];
  if (merged) {
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
  }
  if (plannerStage) {
    stage.push({ key: STORAGE_KEYS.plannerEnvelope, value: plannerStage.envValue });
    stage.push({ key: MATRIX_STORAGE_KEY, value: plannerStage.tasksValue });
  }
  if (stage.length === 0) return;

  // Победивший в слиянии конверт переносит свою метку в локальную карту тем
  // же stage: раздел поменял содержимое — значит, выиграла облачная сторона
  // (цельные разделы сливаются целиком), и следующее сравнение должно идти
  // от её метки записи. Откат фазы записи возвращает и карту. Только четыре
  // конвертных раздела: у коллекций (habits, records…) меток записи нет.
  const ENVELOPE_SECTIONS = ['qaza', 'prayer', 'fast', 'schedule'];
  const writeTsUpdates = {};
  for (let i = 0; i < stage.length; i++) {
    const section = stage[i].section;
    if (ENVELOPE_SECTIONS.indexOf(section) === -1) continue;
    const incoming = unwrapSection(previous[section]);
    if (incoming.ts > 0) writeTsUpdates[section] = incoming.ts;
  }
  const writeTsJson = sectionWriteTsJson(writeTsUpdates);
  if (writeTsJson) stage.push({ key: SECTION_WRITE_TS_KEY, value: writeTsJson });

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
//
// ETag: GET запрашивает метку заголовком X-Firebase-ETag (ТЗ §1.4.2).
// Последняя прочитанная метка хранится в lastCloudEtag и надевается на PUT
// как If-Match: «второй GET без CAS» гонку не закрывает — между чтением и
// записью любой обмен двигает серверный снимок, и только условная запись
// замечает это отказом 412. Сервер без ETag (старый заглушечный транспорт,
// тесты) — If-Match не шлётся, PUT остаётся безусловным, как раньше.
let lastCloudEtag = null;

function readResponseEtag(response) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return null;
  const value = response.headers.get('etag');
  return typeof value === 'string' && value !== '' ? value : null;
}

async function fetchCloudNode() {
  const response = await fetchWithTimeout(FIREBASE_URL + '.json', {
    headers: { 'X-Firebase-ETag': 'true' },
  });
  if (!response.ok) throw new Error('нет ответа');
  lastCloudEtag = readResponseEtag(response);
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
