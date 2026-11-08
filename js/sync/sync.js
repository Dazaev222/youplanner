import { bus } from '../core/bus.js';
import { loadArchive } from '../data/archive.js';
import { loadFast } from '../data/fast.js';
import { DEFAULT_HABITS, defaultHabit, loadHabits, loadTombstones, pruneResolvedTombstones, saveHabits } from '../data/habits.js';
import { markMigration, migratePressHabit } from '../data/migrations.js';
import { loadPrayer } from '../data/prayer.js';
import { loadQaza, loadQazaLog } from '../data/qaza.js';
import { loadRecords } from '../data/records.js';
import { loadSchedule } from '../data/schedule.js';
import { loadSleep } from '../data/sleep.js';
import {
  STORAGE_KEYS, loadPlannerEnvelope,
  savePlannerEnvelope, sectionWrittenTs,
} from '../data/storage.js';
import { MATRIX_STORAGE_KEY, plannerOwnerUid } from '../data/matrix.js';
import { safeSetItem } from '../core/storage.js';
import { timeoutGuard } from '../core/dom.js';
// Ядро sync-слоя: константы Firebase, флаги состояния и валидаторы снимка
// (слито из data/sync.js, sync/state.js и sync/validators.js, этап Y2)
import { BACKUP_LIMIT, BACKUP_MIN_INTERVAL_MS, FIREBASE_BACKUPS_URL, FIREBASE_PLANNER_URL, FIREBASE_URL, SYNC_DEBOUNCE_MS, SYNC_TS_KEY, clearSyncPending, hasData, markSyncPending, normalizing, saveNormalized, setSyncing, syncPending, syncTs, syncing } from './core.js';
import { normalizePlannerV1 } from './merge.js';
import { refreshAuthToken, getAuthToken, hasSessionRefreshToken } from '../data/firebase-auth.js';
// Движки применения (АДР 2026-11-08): путь снимка и путь гонки вынесены
// из этого файла; здесь — транспорт, гейты новизны и состояние обменов.
import { applyCloudData, planPlannerApply } from './apply-engine.js';
import { applyMergedFromCloud } from './merge-engine.js';
// Публичный API сохраняется: planPlannerApply импортирует data/backup.js,
// applyCloudData достают тесты и песочницы.
export { applyCloudData, planPlannerApply };
export let syncTimer = null;
// Сетевой таймаут обменов. Без него зависшее соединение (сеть отдаёт TCP,
// но не отвечает) держит syncExchange открытым вечно: правки встают в
// очередь и не уезжают, пока страница не перезагружена. Сам гард — общий
// для сети проекта (Safari < 15.4 без AbortSignal.timeout и песочницы без
// Abort API учтены там): js/core/dom.js, timeoutGuard.
const SYNC_TIMEOUT_MS = 20000;
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
// владельца, офлайн, пауза после неудачи) — запрос идёт без заголовка, и
// опубликованные правила ответят отказом: приложение продолжит работать на
// локальных данных, а наружу уйдёт sync:denied, чтобы человек увидел причину.
// getAuthToken() не бросает и при неудаче не выходит в сеть до конца своей
// 5-минутной паузы, так что вызов здесь дешёвый.
//
// Токен ходит легаси-параметром ?auth=<idToken> в URL. Возврат с Bearer
// (эпик-3, «аудит секретов»): живая проверка 2026-11-07 показала, что RTDB
// REST отвечает 401 «Unauthorized request.» на Authorization: Bearer с
// Firebase ID-токеном при ЛЮБОЙ его свежести (валидный токен подтверждался
// успешным securetoken-обменом), а принимает ID-токен только параметром
// ?auth= — заголовок Bearer он резервирует для OAuth2 access-токенов.
// Компромисс осознанный: ?auth= оседает в логах серверов, компенсация —
// App Check (список «Предложено»).
//
// Ответ 401 «токен просрочен» (INVALID_ID_TOKEN и родня) — не отказ правил,
// а протухший id-токен: часы устройства врут или страница спала дольше часа.
// Такой ответ лечится здесь же: refreshAuthToken() меняет refresh-токен
// на свежую пару, и ИСХОДНЫЙ запрос повторяется один раз с новым токеном.
// «Permission denied» (правила не пускают) и повторный 401 после refresh
// обновлением не лечатся — это уже честный sync:denied.
function authedFetch(url, options, token) {
  const guard = timeoutGuard(SYNC_TIMEOUT_MS);
  let requestUrl = url;
  if (token) {
    requestUrl = url + (url.indexOf('?') === -1 ? '?' : '&') +
      'auth=' + encodeURIComponent(token);
  }
  return fetch(requestUrl, Object.assign({}, options, { signal: guard.signal }))
    .finally(guard.cancel);
}

// Протух ли токен по этому ответу. Тело читается СКЛОНА текстом (не json()):
// RTDB REST пишет 401 и JSON'ом ({"error": "строка"}), и текстом — прокси и
// нестандартные обёртки вообще отвечают без JSON, и прежняя попытка
// probe.json() кидала на них исключение, ответ навсегда оставался «обычным
// отказом», и лечение токеном не запускалось (баг владельца 2026-11-07).
// Разбор: JSON с полем error — сверяем сообщение со списком протухших;
// нечитаемое/не-JSON непустое тело — кандидат на протухший токен (отказ
// правил «Permission denied» ходит строго JSON'ом и сюда не попадает);
// пустое тело — обычный отказ. В песочницах без Response.clone тело
// читается напрямую — тела не-ok ответов вызывающие всё равно не читают.
async function isExpiredTokenResponse(response) {
  if (!response || response.status !== 401) return false;
  let raw = '';
  try {
    const probe = typeof response.clone === 'function' ? response.clone() : response;
    raw = await probe.text();
  } catch (e) {
    return false;
  }
  if (!raw) return false;
  let message = raw;
  try {
    const body = JSON.parse(raw);
    const error = body && body.error;
    if (error === undefined || error === null) return false;
    message = typeof error === 'string' ? error : (error && error.message) || '';
  } catch (e) {
    return true; // не-JSON непустое тело — кандидат на протухший токен
  }
  return /INVALID_ID_TOKEN|TOKEN_EXPIRED|EXPIRED|INVALID_AUTH_TOKEN/i.test(message);
}

// Книга отказов по правам — только на ПОСЛЕДНЕМ ответе запроса: если 401
// вылечился обновлением токена и повтор удался, наружу не уходит ни
// sync:denied, ни deniedStatus.
//
// 401/403 — это не «нет связи», а «нас сюда не пускают»: правила базы
// привязаны к auth.uid владельца, и устройство без входа (или с потерянной
// сессией) получит отказ всегда. Без сигнала снаружи это выглядело бы
// вечной сетевой ошибкой, поэтому событие ставится здесь, в единственной
// обёртке: его видят и GET, и PUT, и бэкапы. 5xx сюда не входит — совет
// «проверьте вход» при сбое сервера значил бы соврать.
function noteDenied(response) {
  if (response.status === 401 || response.status === 403) {
    deniedStatus = response.status;
    bus.emit('sync:denied', { status: response.status });
  } else if (response.ok) {
    deniedStatus = 0;
  }
}

async function fetchWithTimeout(url, options) {
  const token = await getAuthToken();
  const response = await authedFetch(url, options, token);

  // 401 лечится токеном в двух случаях. (а) Ходили С токеном, и тело говорит
  // «протух» — классика. (б) Ходили БЕЗ токена: getAuthToken() вернул null
  // из паузы после разового сбоя добычи (запрос уехал без ?auth=, сервер
  // ответил 401), а refresh-токен в хранилище жив — владелец при этом
  // авторизован, и молча отказываться от лечения нельзя (баг владельца
  // 2026-11-07: настройки показывают email/UID, синк ловит 401). Обмен при
  // успехе снимает паузу сам (exchangeRefreshToken: authPausedUntil = 0).
  // Повтор оплачивается только новым токеном: refresh не удался (мёртвый
  // refresh-токен, нет сети) — наружу уходит первый ответ как есть, а при
  // 4xx-отказе обмена firebase-auth сам разлогинит и сообщит событием.
  // Ровно один повтор: ответ повтора дальше не проверяется — иначе упорный
  // 401 зациклил бы refresh.
  const recoverable = response.status === 401 &&
    (token ? await isExpiredTokenResponse(response) : hasSessionRefreshToken());
  if (recoverable) {
    const freshToken = await refreshAuthToken();
    if (freshToken) {
      const retried = await authedFetch(url, options, freshToken);
      noteDenied(retried);
      return retried;
    }
  }
  noteDenied(response);
  return response;
}
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
// Снимок отвергнут, но привычек у нас нет вовсе — берём серверный список,
// иначе пустой уехал бы наверх и стёр серверный. Исключение — привычки под
// надгробиями: пустой список при живых метках значит «здесь их удалили, а
// отправка ещё не ушла», и адопция отменила бы удаление молча, а
// pruneResolvedTombstones стёр бы его след — следующая отправка опубликовала
// бы «воскрешённый» список навсегда. То же правило, что у слияния
// (mergeHabitsById): привычка с настоящим надгробием не привозится.
function adoptServerHabitsIfLocalEmpty(data) {
  if (!Array.isArray(data.habits) || !hasData(data.habits)) return;
  if (hasData(loadHabits())) return;
  const tombstones = loadTombstones();
  const habits = data.habits.filter(function (h) {
    // Мусорная метка (не число) не блокирует: блокирует только настоящая —
    // как в mergeHabitsById
    const ts = h && h.id != null ? tombstones[h.id] : undefined;
    return !(typeof ts === 'number' && Number.isFinite(ts));
  });
  if (!hasData(habits)) return;
  localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(habits));
  // Привычки вернулись в список — их надгробия (если чудом остались)
  // больше не нужны: висящая метка блокировала бы привоз этой привычки
  // на других устройствах. Надгробия непривезённых — след ещё не виденных
  // сервером удалений — остаются.
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
  // Заодно оттуда берётся предыдущий узел — он нужен телу запроса. Копия
  // троттлится (Г2): в пропущенные обмены приходит null — пред-PUT слияния
  // не будет, гонку с чужой записью закрывает 412-ветка условной записи.
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

  // Вторая гонка того же обмена (B.2): между первым GET (внутри
  // backupCloudSnapshot) и PUT устройство B может отправить свой снимок.
  // Раньше непосредственно перед PUT делали ещё один GET со слиянием
  // («контрольный GET»), но гонку он не закрывал — между его чтением и
  // записью оставалось своё окно (см. комментарий у fetchCloudNode: «второй
  // GET без CAS» гонку не закрывает). Гонку закрывает условная запись: PUT
  // ниже несёт If-Match по lastCloudEtag первого GET, чужая запись между GET
  // и PUT отвечает 412, и цикл перечитывает сервер, сливает его (слияние
  // в ветке 412 — осознанно: сливать нужно только реально изменившийся
  // сервер) и повторяет PUT уже объединением. Контрольный GET убран (Г1):
  // обмен экономит сетевой круг, а защита сверяется сервером, а не на глаз
  // клиента.

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
      // X-Firebase-ETag у PUT: RTDB возвращает ETag в ответе только на
      // запросах с этим заголовком — он нужен для обновления lastCloudEtag
      // после успеха (ниже)
      const putHeaders = { 'Content-Type': 'application/json', 'X-Firebase-ETag': 'true' };
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
      // lastCloudEtag обновляется и от успешного PUT: сервер отвечает меткой
      // записанного значения. Без метки в ответе (заглушечный транспорт,
      // тесты) остаётся метка от GET — её достаточно, сервер не менялся.
      // Актуальная метка спасает следующий обмен от лишнего 412, если его
      // первый GET не удался и PUT пойдёт по последней известной метке.
      const putEtag = readResponseEtag(response);
      if (putEtag) lastCloudEtag = putEtag;
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
  setSyncing(true);
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
    setSyncing(false);
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
// Обычное чтение узла данных без копии в бэкапы. Возвращает объект снимка
// или null, если узел пуст; при ошибке сети бросает — вызывающий решает,
// критична ли ему ошибка (backupCloudSnapshot глотает, цикл 412 в
// syncToCloudNow при отказе перечитывания выходит без повторного PUT).
// Токен и таймаут — в общей обёртке fetchWithTimeout.
//
// ETag: GET запрашивает метку заголовком X-Firebase-ETag (ТЗ §1.4.2).
// Последняя прочитанная метка хранится в lastCloudEtag и надевается на PUT
// как If-Match: «второй GET без CAS» гонку не закрывает — между чтением и
// записью любой обмен двигает серверный снимок, и только условная запись
// замечает это отказом 412. Сервер без ETag (старый заглушечный транспорт,
// тесты) — If-Match не шлётся, PUT остаётся безусловным, как раньше.
let lastCloudEtag = null;
// Момент последней успешной копии в узел бэкапов (Г2), null — копии в этой
// сессии ещё не было. Переменная модульная, не в хранилище: после загрузки
// страницы свежая копия снимается сразу, а не ждёт конца интервала.
let lastBackupAt = null;

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
// не отменяет, и узел всё равно нужен вызывающему. Троттлинг (Г2): чаще
// раза за BACKUP_MIN_INTERVAL_MS возвращается null сразу, без запросов.
// Чтения последовательны: сначала снимок данных, затем список бэкапов и
// запись копии (GET+GET → PUT), каждый запрос ждёт предыдущего. Снимок
// нужен и копии, и вызывающему, поэтому он идёт первым.
export async function backupCloudSnapshot() {
  // Гейт стоит внутри, а не у вызова в syncToCloudNow: через эту функцию
  // идут все обмены — стартовая синхронизация, ручная кнопка, flushPendingSync
  // — и правило троттлинга для всех одно.
  if (lastBackupAt !== null && Date.now() - lastBackupAt < BACKUP_MIN_INTERVAL_MS) {
    return null;
  }
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
      const copyResponse = await fetchWithTimeout(FIREBASE_BACKUPS_URL + '.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items.slice(0, BACKUP_LIMIT)),
      });
      // Метка троттлинга — только после успешного PUT списка: сорвавшаяся
      // копия не глушит следующие попытки, следующая отправка повторит.
      if (copyResponse && copyResponse.ok) lastBackupAt = Date.now();
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
