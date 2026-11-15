/* Контракт access-v1 (ТЗ Раздел 7, A7.2/A7.3/A7.4.8/A7.9.1). Чистый модуль
   БЕЗ DOM и БЕЗ сети: строгая валидация policy/status, контроллер политики
   с ВНЕДРЯЕМЫМ транспортом и билдер access для команд. Компаньоны:
   firebase.js (транспорт REST) и access-view.js (DOM). Index.js обратно
   не импортируется.

   Пути (CONTRACT-0.5 §10):
     bridge/access_policy/{ownerUid}/{deviceId} — пишет ТОЛЬКО владелец;
     bridge/access_status/{ownerUid}/{deviceId} — пишет ТОЛЬКО устройство.

   Правила (A7.2):
   * policy: schemaVersion=1, version 1..9007199254740991 (целое, не bool),
     requestId [A-Za-z0-9_-]{1,128}, mode safe|medium|unrestricted,
     requestedBy=владелец, requestedAt — плейсхолдер {".sv":"timestamp"}.
     confirmation обязателен ТОЛЬКО в unrestricted (kind
     unrestricted_windows_v1, requestId совпадает, confirmedBy=владелец);
     в safe/medium поле запрещено. Неизвестные поля запрещены; поле route
     от клиента запрещено (маршрут вычисляет агент по mode).
   * status: state applying|applied|blocked|error; reason из фиксированного
     списка; до первого применения appliedVersion=0/appliedRequestId=""/
     effectiveMode="safe" — локальный запрет, НЕ автономное разрешение.
   * Свежесть (A7.9.1): status.updatedAt и presence.heartbeatAt не старше
     30 с от serverNow; agentSessionId в presence совпадает с status.
     Только совпавшая свежая сессия + state=applied дают access для задачи.
   * CAS (A7.2.5/A7.3.4): Apply — один условный PUT; 412 → перечитать,
     показать конфликт, НЕ повторять повышение автоматически; timeout →
     сверка прежнего requestId, без слепой новой версии; submitting-флаг
     ставится синхронно до первого await; двойной тап не создаёт вторую
     версию; unrestricted — только после отдельного confirm-шага, которое
     не переживает смену версии и не хранится между сессиями. */

// isPlainObject — общий предикат из js/core/struct.js (аудит YP-08); импорт
// снимает верхнеуровневый дубликат (в песочнице load-app модули склеиваются
// в один Script — верхнеуровневые имена уникальны в графе модулей).
import { isPlainObject } from '../core/struct.js';

const ACCESS_MAX_VERSION = 9007199254740991;
const ACCESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACCESS_TIMESTAMP_PLACEHOLDER = { '.sv': 'timestamp' };

export const ACCESS_MODES = ['safe', 'medium', 'unrestricted'];
const ACCESS_STATES = ['applying', 'applied', 'blocked', 'error'];
const ACCESS_REASONS = [
  'ok', 'policy_missing', 'policy_invalid', 'policy_changed',
  'cloud_unreachable', 'docker_unavailable', 'image_missing',
  'stop_unconfirmed', 'journal_unavailable', 'unsupported_contract',
];
const ACCESS_DOCKER_STATES = ['unknown', 'ready', 'unavailable', 'image_missing'];
const ACCESS_CONFIRM_KIND = 'unrestricted_windows_v1';

// Единый источник подписей режимов (load-app склеивает модули в один
// Script — top-level имена обязаны быть уникальны во всём графе; access-view
// импортирует, дубликат объявления ломал ВЕСЬ гейт 544 тестами).
export const ACCESS_MODE_LABELS = { safe: 'Safe', medium: 'Medium', unrestricted: 'Unrestricted' };


// Конечное целое число, НЕ bool и НЕ строка (A7.9.2).
function accessIsInt(value) {
  return typeof value === 'number' && Number.isFinite(value) &&
    Number.isInteger(value);
}

function accessIsTimestamp(value) {
  return accessIsInt(value) && value >= 0;
}

// Строго {".sv":"timestamp"} — единственный допустимый плейсхолдер.
function accessIsPlaceholder(value) {
  return isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    value['.sv'] === 'timestamp';
}

function accessIsOwnerTime(value) {
  return accessIsTimestamp(value) || accessIsPlaceholder(value);
}

function accessIsIdString(value) {
  return typeof value === 'string' && value.length >= 1 &&
    value.length <= 128 && ACCESS_ID_PATTERN.test(value);
}

// Эхо requestId политики в status: пусто до первой записи либо тот же
// алфавит [A-Za-z0-9_-]{1,128}.
function accessIsRequestIdEcho(value) {
  return value === '' || accessIsIdString(value);
}

// Строгий объект: только перечисленные ключи (неизвестные поля запрещены).
function accessRejectUnknown(raw, allowedKeys) {
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) return false;
  }
  return true;
}

function fail(reason) {
  return { ok: false, reason };
}

/* --- Валидация policy ---------------------------------------------------------------- */

export function validateAccessPolicy(raw) {
  if (!isPlainObject(raw)) return fail('schema');
  if (!accessRejectUnknown(raw, ['schemaVersion', 'version', 'requestId', 'mode',
    'requestedBy', 'requestedAt', 'confirmation'])) return fail('unknown');
  if (raw.schemaVersion !== 1 || !accessIsInt(raw.schemaVersion)) return fail('schema');
  if (!accessIsInt(raw.version) || raw.version < 1 || raw.version > ACCESS_MAX_VERSION) {
    return fail('version');
  }
  if (!accessIsIdString(raw.requestId)) return fail('requestId');
  if (!ACCESS_MODES.includes(raw.mode)) return fail('mode');
  if (typeof raw.requestedBy !== 'string' || !raw.requestedBy ||
      raw.requestedBy.length > 128) return fail('requestedBy');
  if (!accessIsOwnerTime(raw.requestedAt)) return fail('requestedAt');
  if (raw.mode === 'unrestricted') {
    const confirmation = raw.confirmation;
    if (!isPlainObject(confirmation)) return fail('confirmation');
    if (!accessRejectUnknown(confirmation, ['kind', 'requestId', 'confirmedBy',
      'confirmedAt'])) return fail('unknown');
    if (confirmation.kind !== ACCESS_CONFIRM_KIND) return fail('confirmation');
    if (confirmation.requestId !== raw.requestId) return fail('confirmation');
    if (confirmation.confirmedBy !== raw.requestedBy) return fail('confirmation');
    if (!accessIsOwnerTime(confirmation.confirmedAt)) return fail('confirmation');
  } else if ('confirmation' in raw) {
    return fail('confirmation');   // confirmation в safe/medium запрещён
  }
  return { ok: true, policy: raw };
}

/* --- Валидация status ---------------------------------------------------------------- */

export function validateAccessStatus(raw) {
  if (!isPlainObject(raw)) return fail('schema');
  if (!accessRejectUnknown(raw, ['schemaVersion', 'observedVersion',
    'observedRequestId', 'appliedVersion', 'appliedRequestId',
    'effectiveMode', 'state', 'reason', 'agentSessionId', 'updatedAt',
    'docker'])) return fail('unknown');
  if (raw.schemaVersion !== 1 || !accessIsInt(raw.schemaVersion)) return fail('schema');
  if (!accessIsInt(raw.observedVersion) || raw.observedVersion < 0) {
    return fail('observedVersion');
  }
  // RequestId эхом повторяет политику: '' до первой записи либо тот же
  // алфавит [A-Za-z0-9_-] (A7.2).
  if (!accessIsRequestIdEcho(raw.observedRequestId)) return fail('observedRequestId');
  if (!accessIsInt(raw.appliedVersion) || raw.appliedVersion < 0 ||
      raw.appliedVersion > raw.observedVersion) return fail('appliedVersion');
  if (!accessIsRequestIdEcho(raw.appliedRequestId)) return fail('appliedRequestId');
  if (!ACCESS_MODES.includes(raw.effectiveMode)) return fail('effectiveMode');
  if (!ACCESS_STATES.includes(raw.state)) return fail('state');
  if (!ACCESS_REASONS.includes(raw.reason)) return fail('reason');
  if (!accessIsIdString(raw.agentSessionId)) return fail('agentSessionId');
  if (!accessIsTimestamp(raw.updatedAt)) return fail('updatedAt');
  const docker = raw.docker;
  if (!isPlainObject(docker)) return fail('docker');
  if (!accessRejectUnknown(docker, ['state', 'checkedAt'])) return fail('unknown');
  if (!ACCESS_DOCKER_STATES.includes(docker.state)) return fail('docker');
  if (!accessIsTimestamp(docker.checkedAt)) return fail('docker');
  return { ok: true, status: raw };
}

/* --- Свежесть (A7.9.1) ----------------------------------------------------------------- */

function accessIsFreshTime(atMs, now, freshMs) {
  return accessIsInt(atMs) && atMs > 0 && now - atMs >= 0 && now - atMs <= freshMs;
}

// presence видели, но heartbeat просрочен/битый — «ПК не на связи».
// Отсутствие presence вообще — информации нет, это не «не на связи».
export function accessIsPresenceStale(presence, now, freshMs) {
  if (!isPlainObject(presence)) return false;
  return !accessIsFreshTime(presence.heartbeatAt, now, freshMs);
}

// Свежий совпавший ack: state=applied, observed==applied (версия+requestId),
// updatedAt свежий, сессия presence совпадает, и (если известна политика)
// ack ссылается на неё же. Старый ack после рестарта не подтверждение.
export function accessIsFreshAck(status, presence, policy, now, freshMs) {
  if (!isPlainObject(status) || status.state !== 'applied') return false;
  if (status.appliedVersion !== status.observedVersion ||
      status.appliedRequestId !== status.observedRequestId) return false;
  if (!accessIsFreshTime(status.updatedAt, now, freshMs)) return false;
  if (!isPlainObject(presence)) return false;
  if (presence.agentSessionId !== status.agentSessionId) return false;
  if (!accessIsFreshTime(presence.heartbeatAt, now, freshMs)) return false;
  if (isPlainObject(policy) &&
      (status.appliedVersion !== policy.version ||
       status.appliedRequestId !== policy.requestId)) return false;
  return true;
}

/* --- Честный статус для UI (A7.3.6/A7.3.7) ---------------------------------------------- */

const ACCESS_REASON_WORDS = {
  policy_missing: 'политика отсутствует',
  policy_invalid: 'политика не прошла проверку',
  policy_changed: 'политика изменилась',
  cloud_unreachable: 'нет связи с облаком',
  docker_unavailable: 'Docker недоступен',
  image_missing: 'образ Docker отсутствует',
  stop_unconfirmed: 'остановка не подтверждена',
  journal_unavailable: 'журнал недоступен',
};

// Docker-примечание к «активен» (A7.3.6): applied НЕ означает готовность
// Docker; для safe/medium запуск Python блокируется отдельно.
function accessDockerSuffix(status, mode) {
  if (mode === 'unrestricted' || !isPlainObject(status) ||
      !isPlainObject(status.docker)) return '';
  if (status.docker.state === 'unavailable') {
    return '; запуск Python недоступен: Docker не отвечает';
  }
  if (status.docker.state === 'image_missing') {
    return '; запуск Python недоступен: образ Docker отсутствует';
  }
  return '';
}

/* input: { policy, status, presence, phase, submittedMode, unknownOutcome }.
   opts: { serverNow(), freshMs } */
export function describeAccessStatus(input, opts) {
  const options = opts || {};
  const now = typeof options.serverNow === 'function' ? options.serverNow() : 0;
  const freshMs = Number.isFinite(options.freshMs) ? options.freshMs : 30000;
  const policy = input && isPlainObject(input.policy) ? input.policy : null;
  const status = input && isPlainObject(input.status) ? input.status : null;
  const presence = input && input.presence;
  const phase = input ? input.phase : 'draft';
  const submittedMode = input ? input.submittedMode : null;

  // 1. Исход повышения неизвестен — самый честный статус.
  if (input && input.unknownOutcome) {
    return { kind: 'unknown-outcome', mode: submittedMode,
      text: 'Исход изменения неизвестен' };
  }
  // 2. Идёт запись/применение.
  if (phase === 'submitting') {
    return { kind: 'submitting', mode: submittedMode, text: 'Применяется' };
  }
  // 3. Heartbeat видели и он просрочен — состояние применения неизвестно.
  if (accessIsPresenceStale(presence, now, freshMs)) {
    return { kind: 'offline', mode: null,
      text: 'ПК не на связи; состояние применения неизвестно' };
  }
  // 4. Свежий совпавший ack — единственный источник «активен».
  if (status && accessIsFreshAck(status, presence, policy, now, freshMs)) {
    const mode = status.effectiveMode;
    return { kind: 'active', mode,
      text: ACCESS_MODE_LABELS[mode] + ' активен' + accessDockerSuffix(status, mode) };
  }
  // 5. Свежий status в промежуточных состояниях.
  if (status && accessIsFreshTime(status.updatedAt, now, freshMs)) {
    if (status.state === 'applying') {
      return { kind: 'applying', mode: status.effectiveMode, text: 'Применяется' };
    }
    if (status.state === 'blocked' || status.state === 'error') {
      if (status.reason === 'unsupported_contract') {
        return { kind: 'unsupported', mode: null,
          text: 'Нужно обновление приложения' };
      }
      const words = ACCESS_REASON_WORDS[status.reason] || status.reason;
      return { kind: status.state, mode: status.effectiveMode,
        text: 'Применение не завершено: ' + words };
    }
  }
  // 6. Запись политики подтверждена, ack ещё не пришёл.
  if (submittedMode && ACCESS_MODES.includes(submittedMode)) {
    return { kind: 'waiting', mode: submittedMode,
      text: 'Выбран ' + ACCESS_MODE_LABELS[submittedMode] + ' — ожидаем ПК' };
  }
  // 7. Политика есть, состояния применения неизвестно.
  if (policy) {
    return { kind: 'waiting-unknown', mode: policy.mode,
      text: 'Политика задана: ' + ACCESS_MODE_LABELS[policy.mode] +
        '; состояние применения неизвестно' };
  }
  // 8. Политики нет: доступ не настроен, Safe выбирается вручную (A7.3.7).
  return { kind: 'not-configured', mode: null,
    text: 'Доступ не настроен', suggestSafe: true };
}

/* --- Контроллер --------------------------------------------------------------------------- */

// Транспорт (внедряется; в index.js — firebase.js, в тестах — фейк):
//   readPolicy({ownerUid, deviceId})  → {ok, data, etag} | throws
//   writePolicy({ownerUid, deviceId, expectedEtag, policy}) → {ok, etag} | throws
//   readStatus({ownerUid, deviceId})  → {ok, data} | throws
// Ошибки транспорта — с кодом: 'conflict' (412), 'timeout'/'network', 'auth'.
export function createAccessController({
  transport, ownerUid, deviceId, serverNow, makeRequestId, freshMs,
}) {
  if (!transport || typeof transport.readPolicy !== 'function' ||
      typeof transport.writePolicy !== 'function') {
    throw new Error('createAccessController: нужен transport (readPolicy/writePolicy/readStatus)');
  }
  const owner = String(ownerUid || '');
  const device = String(deviceId || '');
  const fresh = Number.isFinite(freshMs) ? freshMs : 30000;
  const now = typeof serverNow === 'function' ? serverNow : (() => Date.now());
  const newRequestId = typeof makeRequestId === 'function'
    ? makeRequestId
    : () => ('pol-' + Date.now().toString(36) + '-' +
        Math.random().toString(36).slice(2, 8));

  const state = {
    phase: 'draft',            // draft → submitting → ok|conflict|error
    draftMode: null,           // выбор radio; черновик, не запись
    confirmationOpen: false,
    confirmationChecked: false,
    confirmBaseVersion: null,  // версия, показанная владельцу при открытии
    policy: null,              // последняя валидная политика (или null)
    policyEtag: null,
    status: null,              // последняя валидная access_status
    presence: null,
    submittedMode: null,       // режим последней успешной записи
    unknownOutcome: false,     // timeout: исход не доказан ни в какую сторону
    pendingRequestId: null,    // requestId невыясненной записи
    lastError: null,
  };

  // Claim текущей записи: ставится СИНХРОННО до первого await — двойной тап
  // и второй контроллер-поток не создают вторую версию (A7.3.5).
  let submissionClaimed = false;

  const listeners = new Set();
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (e) { /* слушатель не роняет контроллер */ }
    }
  }

  function snapshotInput() {
    return {
      policy: state.policy,
      status: state.status,
      presence: state.presence,
      phase: state.phase,
      submittedMode: state.submittedMode,
      unknownOutcome: state.unknownOutcome,
      confirmationOpen: state.confirmationOpen,
    };
  }

  function observePolicy(raw) {
    if (raw === null || raw === undefined) {
      state.policy = null;
      state.policyEtag = null;
      notify();
      return;
    }
    const result = validateAccessPolicy(raw);
    if (!result.ok) {
      // Битая политика не затирает показанную: честный признак для UI.
      state.lastError = 'policy_invalid';
      notify();
      return;
    }
    const previous = state.policy;
    state.policy = result.policy;
    state.lastError = null;
    // Подтверждение не переживает смену версии (A7.3.4).
    if (state.confirmationOpen && previous &&
        previous.version !== result.policy.version) {
      resetConfirmation();
    }
    notify();
  }

  function observeStatus(raw) {
    if (raw === null || raw === undefined) {
      state.status = null;
      notify();
      return;
    }
    const result = validateAccessStatus(raw);
    if (!result.ok) {
      state.lastError = 'status_invalid';
      notify();
      return;
    }
    state.status = result.status;
    state.lastError = null;
    notify();
  }

  function observePresence(raw) {
    state.presence = isPlainObject(raw) ? raw : null;
    notify();
  }

  async function readPolicy() {
    const result = await transport.readPolicy({ ownerUid: owner, deviceId: device });
    if (result && result.ok) {
      state.policyEtag = result.etag || null;
      observePolicy(result.data);
    }
    return result;
  }

  async function readStatus() {
    if (typeof transport.readStatus !== 'function') return { ok: false };
    const result = await transport.readStatus({ ownerUid: owner, deviceId: device });
    if (result && result.ok) observeStatus(result.data);
    return result;
  }

  // Чтение обоих узлов: mount, возврат из фона (A7.9.1). Только чтение —
  // никогда не записывать safe поверх существующего unrestricted.
  async function refresh() {
    const policyResult = await readPolicy();
    let statusResult = { ok: false };
    try {
      statusResult = await readStatus();
    } catch (e) { /* статус может быть недоступен отдельно */ }
    notify();
    return { ok: policyResult.ok && statusResult.ok,
      policy: state.policy, status: state.status };
  }

  // Новая политика поверх текущей: версия = база + 1 (или 1 при отсутствии),
  // новый requestId, requestedAt плейсхолдером — сервер проставит время.
  function buildNextPolicy({ base, mode }) {
    const requestId = newRequestId();
    const policy = {
      schemaVersion: 1,
      version: (base && accessIsInt(base.version) ? base.version : 0) + 1,
      requestId,
      mode,
      requestedBy: owner,
      requestedAt: { '.sv': 'timestamp' },
    };
    if (mode === 'unrestricted') {
      policy.confirmation = {
        kind: ACCESS_CONFIRM_KIND,
        requestId,
        confirmedBy: owner,
        confirmedAt: { '.sv': 'timestamp' },
      };
    }
    const check = validateAccessPolicy(policy);
    if (!check.ok) {
      const err = new Error('построенная политика не прошла валидацию: ' + check.reason);
      err.code = 'invalid-policy';
      throw err;
    }
    return policy;
  }

  // Единственная точка записи: один CAS PUT; конфликт/таймаут разрешаются
  // по правилам A7.3.4/A7.3.5, без автоматического повторного повышения.
  async function putPolicy(policy) {
    try {
      const result = await transport.writePolicy({
        ownerUid: owner, deviceId: device,
        expectedEtag: state.policyEtag, policy,
      });
      if (result && result.ok) {
        // Запись принята сервером: она и есть актуальная политика (свежий
        // ack придёт подпиской/чтением; etag обновлён для следующего CAS).
        state.policy = policy;
        state.policyEtag = result.etag || null;
      }
      return { ok: true, etag: result && result.etag };
    } catch (err) {
      const code = err && err.code;
      if (code === 'conflict') {
        // 412: перечитать и показать конфликт; повторяет владелец вручную.
        try {
          await readPolicy();
        } catch (e) { /* конфликт всё равно показан */ }
        state.phase = 'conflict';
        notify();
        return { ok: false, reason: 'conflict', error: err };
      }
      if (code === 'timeout' || code === 'network') {
        // Исход неизвестен: одна сверка того же requestId, не новая версия.
        state.phase = 'error';
        state.unknownOutcome = true;
        state.pendingRequestId = policy.requestId;
        notify();
        const resolved = await resolveUnknownOutcome();
        if (resolved.ok) return { ok: true, reconciled: true };
        return { ok: false, reason: 'unknown-outcome', error: err };
      }
      state.phase = 'error';
      state.lastError = code || 'error';
      notify();
      return { ok: false, reason: 'error', error: err };
    }
  }

  async function resolveUnknownOutcome() {
    if (!state.pendingRequestId) return { ok: false };
    let read = null;
    try {
      read = await readPolicy();
    } catch (e) {
      return { ok: false, reason: 'unreadable' };
    }
    if (read && read.ok && isPlainObject(state.policy) &&
        state.policy.requestId === state.pendingRequestId) {
      // Запись дошла: исход признан, новая версия не создаётся.
      state.unknownOutcome = false;
      state.pendingRequestId = null;
      if (!state.submittedMode && isPlainObject(state.policy)) {
        state.submittedMode = state.policy.mode;
      }
      state.phase = 'ok';
      notify();
      return { ok: true, reconciled: true };
    }
    return { ok: false, reason: 'unconfirmed' };
  }

  function setDraft(mode) {
    if (mode !== null && !ACCESS_MODES.includes(mode)) return;
    // Смена черновика закрывает незавершённое подтверждение (A7.3.4).
    if (state.draftMode !== mode) resetConfirmation();
    state.draftMode = mode;
    notify();
  }

  function resetConfirmation() {
    state.confirmationOpen = false;
    state.confirmationChecked = false;
    state.confirmBaseVersion = null;
    notify();
  }

  function setConfirmationChecked(value) {
    state.confirmationChecked = Boolean(value);
    notify();
  }

  // Синхронный флаг ДО первого await (A7.3.5): двойной тап не создаёт
  // вторую версию. Вызывается view-ом в обработчике клика.
  function beginSubmit() {
    state.phase = 'submitting';
    notify();
  }

  function isBusy() {
    return state.phase === 'submitting';
  }

  // Apply из radio: safe/medium — один CAS PUT; unrestricted — ТОЛЬКО
  // открывает шаг подтверждения и ничего не пишет (A7.3.4).
  async function applyDraft() {
    if (submissionClaimed) return { ok: false, reason: 'busy' };
    const mode = state.draftMode;
    if (!mode) return { ok: false, reason: 'no-draft' };
    if (mode === 'unrestricted') {
      state.confirmationOpen = true;
      state.confirmBaseVersion = state.policy ? state.policy.version : 0;
      notify();
      return { ok: false, reason: 'confirm-required' };
    }
    submissionClaimed = true;   // синхронно ДО первого await
    state.phase = 'submitting';
    notify();
    try {
      // База для версии: последняя известная политика; если её ещё не
      // читали — одно чтение перед записью (CAS требует актуальный etag).
      if (!isPlainObject(state.policy)) {
        try {
          await readPolicy();
        } catch (e) {
          state.phase = 'error';
          state.lastError = (e && e.code) || 'network';
          notify();
          return { ok: false, reason: 'read-failed', error: e };
        }
      }
      const policy = buildNextPolicy({ base: state.policy, mode });
      const result = await putPolicy(policy);
      if (result.ok) {
        state.phase = 'ok';
        state.submittedMode = mode;
        state.unknownOutcome = false;
        state.pendingRequestId = null;
        notify();
      }
      return result;
    } finally {
      submissionClaimed = false;
    }
  }

  // confirm-submit с установленным checkbox (A7.3.4): confirmation формируется
  // от ЗАНОВО сверенной версии; изменилась — сброс подтверждения.
  async function confirmUnrestricted() {
    if (submissionClaimed) return { ok: false, reason: 'busy' };
    if (!state.confirmationOpen) return { ok: false, reason: 'no-confirm' };
    if (!state.confirmationChecked) return { ok: false, reason: 'confirm-required' };
    submissionClaimed = true;   // синхронно ДО первого await
    state.phase = 'submitting';
    notify();
    try {
      // Свежая сверка базы перед CAS (не та, что в памяти с открытия блока).
      let serverPolicy = state.policy;
      try {
        const read = await readPolicy();
        if (read && read.ok) serverPolicy = state.policy;
      } catch (e) {
        state.phase = 'error';
        state.lastError = (e && e.code) || 'network';
        notify();
        return { ok: false, reason: 'read-failed', error: e };
      }
      const baseVersion = state.confirmBaseVersion;
      if ((serverPolicy ? serverPolicy.version : 0) !== baseVersion) {
        state.phase = 'draft';
        resetConfirmation();
        return { ok: false, reason: 'version-changed' };
      }
      const policy = buildNextPolicy({ base: serverPolicy, mode: 'unrestricted' });
      const result = await putPolicy(policy);
      if (result.ok) {
        state.phase = 'ok';
        state.submittedMode = 'unrestricted';
        resetConfirmation();
        state.unknownOutcome = false;
        state.pendingRequestId = null;
        notify();
      }
      return result;
    } finally {
      submissionClaimed = false;
    }
  }

  // Билдер access для команд (A7.4.8): только свежий совпавший ack даёт
  // access; иначе запрет отправки с причиной.
  function buildCommandAccess() {
    const status = state.status;
    if (!isPlainObject(status)) return { ok: false, reason: 'no-status' };
    if (status.state !== 'applied') return { ok: false, reason: 'not-applied' };
    if (status.appliedVersion !== status.observedVersion ||
        status.appliedRequestId !== status.observedRequestId) {
      return { ok: false, reason: 'version-mismatch' };
    }
    if (!accessIsFreshTime(status.updatedAt, now(), fresh)) {
      return { ok: false, reason: 'stale-status' };
    }
    const presence = state.presence;
    if (!isPlainObject(presence) || !accessIsFreshTime(presence.heartbeatAt, now(), fresh)) {
      return { ok: false, reason: 'stale-presence' };
    }
    if (presence.agentSessionId !== status.agentSessionId) {
      return { ok: false, reason: 'session-mismatch' };
    }
    if (isPlainObject(state.policy) &&
        (status.appliedVersion !== state.policy.version ||
         status.appliedRequestId !== state.policy.requestId)) {
      return { ok: false, reason: 'policy-mismatch' };
    }
    return {
      ok: true,
      access: {
        policyVersion: status.appliedVersion,
        policyRequestId: status.appliedRequestId,
      },
    };
  }

  return {
    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
    },
    state() {
      return {
        phase: state.phase,
        draftMode: state.draftMode,
        confirmationOpen: state.confirmationOpen,
        confirmationChecked: state.confirmationChecked,
        confirmBaseVersion: state.confirmBaseVersion,
        policy: state.policy,
        etag: state.policyEtag,
        status: state.status,
        presence: state.presence,
        submittedMode: state.submittedMode,
        unknownOutcome: state.unknownOutcome,
        lastError: state.lastError,
        describeInput: snapshotInput,
        isBusy,
      };
    },
    observePolicy,
    observeStatus,
    observePresence,
    refresh,
    setDraft,
    beginSubmit,
    isBusy,
    applyDraft,
    confirmUnrestricted,
    setConfirmationChecked,
    resetConfirmation,
    resolveUnknownOutcome,
    buildCommandAccess,
  };
}
