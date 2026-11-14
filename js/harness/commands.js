/* Контракт команд Harness (ТЗ F6.3): чистые builder'ы params, отображение
   текста ленты и надёжная отправка (pending-made ДО сетевого PUT).

   Контракт (согласован с BR-воркером, _ci/contract/contract.json):
     обычная задача  → run_task.params =
       { actions: [{ actionId: 'act-1', tool: 'model_task',
                     params: { text, settings } }] }
     проверочный     → run_task.params =
       { actions: [{ actionId: 'act-1', tool: 'guarded_append_line',
                     params: { text: 'Проверка контура Harness' } }] }

   params.task как отправляемое УДАЛЕНО; legacy-чтение (старые записи
   ленты с params.task) остаётся — только отображение, не переисполнение.
   Envelope и digest строит ТОЛЬКО makeCommand в firebase.js; actionId
   фиксирован ('act-1', как в fixtures) и стабилен при повторе того же
   commandId: повтор использует сохранённый made целиком, ничего не
   перестраивает.

   Отправка (createTaskSender):
   * pending-made (commandId/path/payload) сохраняется в память + хранилище
     ДО сетевого PUT; отказ хранения блокирует начало отправки;
   * потерянный ответ PUT разрешается readCommand ТОГО ЖЕ path/digest;
   * неизвестный исход — made сохранён, карточка «Исход отправки неизвестен»,
     единственный ID не удаляется;
   * повтор — только явным действием, до expiresAt, тем же commandId. */

// Текст fixture контракта (contract.json fixtures['проверочный']).
export const VERIFICATION_TEXT = 'Проверка контура Harness';
// Метка проверочного режима в интерфейсе — не ответ модели (F6.3.A.3).
export const VERIFICATION_LABEL = 'Проверка контура — запись строки';
export const UNKNOWN_OUTCOME_TEXT = 'Исход отправки неизвестен';

const ACTION_ID = 'act-1';

// Обычная задача: model_task с текстом и снимком настроек (формат F6.2.5).
export function buildModelTaskParams({ text, settings }) {
  return {
    actions: [{
      actionId: ACTION_ID,
      tool: 'model_task',
      params: {
        text: String(text),
        settings: JSON.parse(JSON.stringify(settings)),
      },
    }],
  };
}

// Проверочный режим: ровно fixture контракта (digest 5a6b4653…).
export function buildVerificationParams() {
  return {
    actions: [{
      actionId: ACTION_ID,
      tool: 'guarded_append_line',
      params: { text: VERIFICATION_TEXT },
    }],
  };
}

// Глубокая копия снимка настроек ДО первого await создания команды:
// изменение active после нажатия «Отправить» не меняет payload/digest.
export function freezeSettingsSnapshot(settings) {
  if (!settings || typeof settings !== 'object') return null;
  return JSON.parse(JSON.stringify(settings));
}

// Текст карточки ленты по params команды (F6.3.10): model_task — текст
// задачи; проверочный — метка режима; legacy params.task — только
// отображение старых записей, не переисполнение.
export function textFromCommandParams(params, type) {
  if (params && Array.isArray(params.actions) && params.actions.length) {
    const action = params.actions[0];
    if (action && action.tool === 'model_task' && action.params &&
        typeof action.params.text === 'string') {
      return action.params.text;
    }
    if (action && action.tool === 'guarded_append_line' && action.params) {
      return VERIFICATION_LABEL;
    }
  }
  if (params && typeof params.task === 'string') return params.task;
  return String(type || '');
}

/* --- pending-made по owner/device --------------------------------------------------- */

const PENDING_KEY_PREFIX = 'harness.pendingCommand';

function validMade(made) {
  return Boolean(made && typeof made === 'object' &&
    made.commandId && made.path && made.payload &&
    made.payload.digest && Number.isFinite(made.payload.expiresAt));
}

export function createPendingCommandStore({ storage, ownerUid, deviceId }) {
  const key = PENDING_KEY_PREFIX + '.' + String(ownerUid) + '.' + String(deviceId);
  let memory = null;

  return {
    key: () => key,
    // Сохранение ДО сетевого PUT. false — хранилище отказало: отправку
    // начинать нельзя (потерянный ID не восстановить).
    save(made) {
      if (!validMade(made)) return false;
      memory = made;
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(made));
        return true;
      } catch (e) {
        return false;
      }
    },
    load() {
      if (memory && validMade(memory)) return memory;
      memory = null;
      if (!storage) return null;
      let raw = null;
      try {
        raw = storage.getItem(key);
      } catch (e) {
        return null;
      }
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (validMade(parsed)) {
          memory = parsed;
          return memory;
        }
      } catch (e) { /* битая запись = нет записи */ }
      return null;
    },
    clear() {
      memory = null;
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch (e) { /* ignore */ }
    },
  };
}

/* --- Отправка с надёжным исходом ------------------------------------------------------- */

// Достоверное отсутствие записи: readCommand вернулся без ошибки сети,
// но данных нет — команда гарантированно не записана.
function reliablyAbsent(check) {
  return Boolean(check) && check.ok === false &&
    check.error === undefined && !check.data;
}

export function createTaskSender({
  makeCommand, sendCommand, readCommand, pending, now = () => Date.now(),
}) {
  if (typeof makeCommand !== 'function' || typeof sendCommand !== 'function' ||
      typeof readCommand !== 'function' || !pending) {
    throw new Error('createTaskSender: нужны makeCommand/sendCommand/readCommand/pending');
  }

  // Совпадение digest подтверждает, что на сервере лежит ровно наша команда.
  function digestMatches(data, made) {
    return Boolean(data && data.digest && made.payload.digest &&
      data.digest === made.payload.digest);
  }

  async function send({ ownerUid, deviceId, type = 'run_task', params, serverTime, onMade }) {
    const made = await makeCommand({
      ownerUid, deviceId, type, params, serverTime,
    });
    // Pending ДО сети: отказ хранения — отправка не начинается (F6.3.11).
    if (!pending.save(made)) {
      const err = new Error(
        'Не удалось сохранить запись отправки на этом устройстве — отправка не начата');
      err.code = 'pending';
      throw err;
    }
    if (typeof onMade === 'function') onMade(made);
    try {
      await sendCommand(made);
      pending.clear();
      return { ok: true, commandId: made.commandId, made };
    } catch (err) {
      let check = null;
      try {
        check = await readCommand(made.path);
      } catch (e2) {
        check = { ok: false, error: e2 };
      }
      if (check && check.ok && digestMatches(check.data, made)) {
        // Потерянный ответ: запись подтверждена чтением того же commandId.
        pending.clear();
        return { ok: true, reconciled: true, commandId: made.commandId, made };
      }
      if (reliablyAbsent(check)) {
        // Достоверно нет записи: честный отказ, draft остаётся; pending
        // сохранён для явного повтора того же ID.
        return { ok: false, reason: 'failed', error: err, commandId: made.commandId, made };
      }
      // Неизвестный исход: ID не удаляется, карточка unknown, pending живёт.
      return {
        ok: false, outcomeUnknown: true, error: err,
        commandId: made.commandId, made,
      };
    }
  }

  // Явный повтор владельца: сначала readCommand того же path/digest.
  async function retry() {
    const made = pending.load();
    if (!made) return { ok: false, reason: 'empty' };
    if (now() >= made.payload.expiresAt) {
      // Срок допуска истёк: тот же ID повторить нельзя, новый не создаём.
      return { ok: false, reason: 'expired', commandId: made.commandId };
    }
    let check = null;
    try {
      check = await readCommand(made.path);
    } catch (e) {
      check = { ok: false, error: e };
    }
    if (check && check.ok && digestMatches(check.data, made)) {
      pending.clear();
      return { ok: true, reconciled: true, commandId: made.commandId };
    }
    if (reliablyAbsent(check)) {
      // Записи достоверно нет — повтор ТОГО ЖЕ made (тот же commandId/digest).
      try {
        await sendCommand(made);
        pending.clear();
        return { ok: true, resent: true, commandId: made.commandId };
      } catch (err) {
        return {
          ok: false, outcomeUnknown: true, error: err,
          commandId: made.commandId,
        };
      }
    }
    return { ok: false, outcomeUnknown: true, commandId: made.commandId };
  }

  return { send, retry };
}
