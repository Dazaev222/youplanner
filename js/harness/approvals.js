/* Контроллер подтверждений Harness (ТЗ U5.6, P2.4; сценарии U5.9.1).

   Очередь pending по server createdAt → approvalId, ОДИН dialog
   «Запрос i из N · осталось M:SS», состояния представления (loading/pending/
   submitting/approved/rejected/consumed/expired/cancelled/offline/
   auth-expired/error) — они НЕ расширяют серверную схему approvals_v2.

   Все данные и действия приходят через deps: read/decide — функции
   firebase-адаптера, serverNow — оценка серверного времени, timers —
   подменяемые часы (тесты идут на фейке, не на сети). DOM-элементы
   тоже аргументы: модуль не ищет ничего в document сам.

   Правила безопасности (гл. 0.5/U5.6):
   * решение — условная запись только из pending, с версией записи (etag):
     перед записью контроллер читает запись заново и проверяет привязку/срок;
   * двойной тап гасится синхронным флагом ДО первого await;
   * 412/timeout → перечитать ТОТ ЖЕ approvalId и показать победителя;
   * таймер считается от serverNow(), не декрементом;
   * collapse не пишет rejected/approved;
   * destroy чистит таймер и закрывает dialog.
   Тексты — textContent, innerHTML не используется (см. тесты). */

const REQUIRED_FIELDS = ['approvalId', 'commandId', 'actionId', 'attemptId',
  'deviceId', 'tool', 'params', 'digest', 'expiresAt'];

// Канонические тексты состояний (U5.6.3–U5.6.5). Ни одно не называется
// «Выполнено» — это слово оставлено итоговому execution/result.
export const APPROVAL_STATE_TEXT = {
  submitting: 'Сохраняем решение…',
  approved: 'Разрешено · ожидает выполнения',
  consumed: 'Разрешение использовано · ожидаем результат',
  rejected: 'Отклонено',
  cancelled: 'Запрос отменён',
  expired: 'Срок подтверждения истёк',
  offline: 'Нет связи — подтвердить нельзя',
  'auth-expired': 'Войдите снова',
  loading: 'Загружаем запрос…',
  reconciling: 'Проверяем запись на сервере…',
  error: 'Не удалось связаться: исход решения неизвестен. Кнопки отключены до сверки.',
};

const INCOMPLETE_TEXT =
  'У запроса неполные данные (нет существенных полей) — подтверждение заблокировано.';
const NO_MODAL_TEXT =
  'Подтверждения недоступны в этом браузере. Откройте YouPlanner в современном браузере.';

// M:SS из миллисекунд. Оставшееся время — ceil: недостающая секунда честно
// показывается как «0:01», а не «0:00» до реального нуля.
function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes + ':' + String(seconds).padStart(2, '0');
}

export function createApprovalController({ elements, deps }) {
  const el = elements;
  const io = deps;

  const state = {
    items: new Map(),      // approvalId -> item (последние данные сервера)
    queue: [],             // pending-идентификаторы по (createdAt, approvalId)
    currentId: null,
    etag: null,            // версия записи открытого запроса (для If-Match)
    connection: 'online',  // 'online' | 'offline' | 'auth-expired'
    stale: false,          // данные после reconnect требуют свежего чтения
    submitting: false,     // синхронный флаг: ставится ДО первого await
    reconciling: false,
    errorFlag: false,      // сверка не удалась: исход решения неизвестен
    manuallyCollapsed: new Set(),
    expiryRecheckDone: new Set(),
    lastAnnouncedView: null,   // диктор озвучивает только смену состояния
    destroyed: false,
    timerId: null,
  };

  const modalSupported = typeof el.dialog.showModal === 'function';

  /* --- Очередь -------------------------------------------------------------- */

  function isPending(item) {
    return !item.decision && !item.consumedAt && !item.cancelledAt;
  }

  function sortQueue() {
    state.queue = [...state.items.values()]
      .filter((item) => isPending(item))
      .sort((a, b) => (a.createdAt - b.createdAt) ||
        String(a.approvalId).localeCompare(String(b.approvalId)))
      .map((item) => item.approvalId);
  }

  function isComplete(item) {
    if (!item || typeof item !== 'object') return false;
    for (const field of REQUIRED_FIELDS) {
      if (item[field] === undefined || item[field] === null) return false;
    }
    // Неизвестная схема не исполняется (CONTRACT-0.5 §3.3).
    if (item.schemaVersion !== 1) return false;
    if (typeof item.params !== 'object') return false;
    if (typeof item.expiresAt !== 'number') return false;
    return true;
  }

  function currentItem() {
    return state.currentId ? state.items.get(state.currentId) : null;
  }

  function queueSize() {
    return state.queue.length;
  }

  /* --- Состояние представления ------------------------------------------------ */

  function serverOutcome(item) {
    if (!item) return null;
    if (item.cancelledAt) return 'cancelled';
    if (item.decision === 'approved' && item.consumedAt) return 'consumed';
    if (item.decision === 'approved') return 'approved';
    if (item.decision === 'rejected') return 'rejected';
    return null;
  }

  function computeViewState() {
    if (state.destroyed) return 'loading';
    const item = currentItem();
    if (!item || !isComplete(item)) return 'error';
    const outcome = serverOutcome(item);
    if (outcome) return outcome;
    if (state.submitting) return 'submitting';
    if (state.reconciling) return 'reconciling';
    if (state.errorFlag) return 'error';
    if (state.stale) return 'loading';
    if (state.connection === 'offline') return 'offline';
    if (state.connection === 'auth-expired') return 'auth-expired';
    if (typeof item.expiresAt === 'number' && item.expiresAt <= io.serverNow()) {
      return 'expired';
    }
    return 'pending';
  }

  /* --- Отрисовка --------------------------------------------------------------- */

  function render() {
    const item = currentItem();
    const view = computeViewState();
    const index = state.currentId ? state.queue.indexOf(state.currentId) : -1;

    renderCounter(item, view, index);
    renderBody(item, view);
    renderState(item, view);
    renderButtons(view);
    // Открытие dialog — только явные переходы (applySnapshot/open/showNext):
    // render не переоткрывает свернутый вручную запрос (U5.6.2).
    armTimer(item, view);
  }

  function renderCounter(item, view, index) {
    if (!item || index === -1) {
      el.counter.textContent = '';
      return;
    }
    let counter = 'Запрос ' + (index + 1) + ' из ' +
      Math.max(state.queue.length, index + 1);
    if (view === 'pending' || view === 'submitting' ||
        view === 'offline' || view === 'auth-expired' || view === 'reconciling') {
      counter += ' · осталось ' + formatRemaining(item.expiresAt - io.serverNow());
    } else if (view === 'expired') {
      counter += ' · осталось 0:00';
    }
    el.counter.textContent = counter;
  }

  function renderBody(item, view) {
    if (!item || view === 'loading') {
      el.summary.textContent = '';
      el.facts.textContent = '';
      el.arguments.textContent = '';
      return;
    }
    el.summary.textContent = 'Действие «' + item.tool + '» на устройстве ' +
      item.deviceId + ' требует вашего подтверждения.';
    // Точные привязки: tool/устройство/команда/действие/попытка/срок.
    // textContent без innerHTML: параметры выводятся как есть (U5.6.1).
    el.facts.textContent = [
      'Инструмент: ' + item.tool,
      'Устройство: ' + item.deviceId,
      'Команда: ' + item.commandId,
      'Действие: ' + item.actionId,
      'Попытка: ' + item.attemptId,
      'Срок: ' + new Date(item.expiresAt).toISOString().replace('T', ' ')
        .slice(0, 19) + ' UTC',
    ].join('\n');
    // Канонические параметры конкретного вызова — целиком, с переносами.
    let paramsText = '';
    try {
      paramsText = JSON.stringify(item.params, null, 2);
    } catch (e) {
      paramsText = String(item.params);
    }
    el.arguments.textContent = paramsText;
  }

  function renderState(item, view) {
    // Ошибка и истёкший срок — красным (и словами, не только цветом, U5.3).
    const stateClass = 'harness-approval-state' +
      (view === 'error' || view === 'expired' ? ' is-error' : '');
    if (el.stateLine.classList && typeof el.stateLine.classList.toggle === 'function') {
      el.stateLine.classList.toggle('is-error',
        view === 'error' || view === 'expired');
    } else {
      el.stateLine.className = stateClass;
    }
    if (view === 'error' && item && !isComplete(item)) {
      el.stateLine.textContent = INCOMPLETE_TEXT;
      return;
    }
    if (view === 'error') {
      el.stateLine.textContent = APPROVAL_STATE_TEXT.error;
      return;
    }
    if (view === 'pending' && !modalSupported) {
      el.stateLine.textContent = NO_MODAL_TEXT;
      return;
    }
    el.stateLine.textContent = APPROVAL_STATE_TEXT[view] || '';
    // Диктор озвучивает СМЕНУ состояния, не каждый тик таймера (U5.7:
    // без ежесекундного отсчёта).
    if (io.announce && item && APPROVAL_STATE_TEXT[view] &&
        state.lastAnnouncedView !== view) {
      state.lastAnnouncedView = view;
      io.announce(APPROVAL_STATE_TEXT[view]);
    }
  }

  // Решения видны в рабочих состояниях (пусть и заблокированные), у итоговых
  // скрываются: владелец видит исход, а не кнопки прошлого вопроса.
  function renderButtons(view) {
    const show = view === 'pending' || view === 'submitting' ||
      view === 'offline' || view === 'auth-expired' ||
      view === 'reconciling' || view === 'loading' || view === 'error';
    el.approveBtn.hidden = !show;
    el.rejectBtn.hidden = !show;
    const locked = view !== 'pending';
    el.approveBtn.disabled = locked;
    el.rejectBtn.disabled = locked;
    el.collapseBtn.hidden = state.destroyed;
  }

  function openDialog() {
    if (state.destroyed) return;
    if (!modalSupported) {
      // Немодального fallback нет (U5.5.1): без showModal подтверждения
      // недоступны — диалог не открываем, объясняем словами.
      return;
    }
    // Перед открытием — blur активного ввода без потери черновика (F6.1.9);
    // фокус в textarea автоматически не возвращается.
    if (typeof io.beforeOpen === 'function') io.beforeOpen();
    if (!el.dialog.open) el.dialog.showModal();
    // Фокус на заголовок, не на «Разрешить» (U5.5.5).
    if (el.title && typeof el.title.focus === 'function') el.title.focus();
  }

  /* --- Таймер (от серверного времени, не декремент) ----------------------------- */

  function armTimer(item, view) {
    if (state.timerId) {
      io.timers.clearTimeout(state.timerId);
      state.timerId = null;
    }
    if (state.destroyed || !item) return;
    const pendingish = view === 'pending' || view === 'submitting' ||
      view === 'offline' || view === 'auth-expired' || view === 'reconciling';
    if (!pendingish) return;
    state.timerId = io.timers.setTimeout(tick, 1000);
  }

  function tick() {
    state.timerId = null;
    if (state.destroyed) return;
    const item = currentItem();
    if (!item || !isPending(item)) return;
    if (typeof item.expiresAt !== 'number') return;
    if (item.expiresAt <= io.serverNow()) {
      // Ноль: немедленно отключить решения, показать истёкший срок и
      // перечитать сервер. Право переводить запрос в expired — у сервера
      // (Rules/CAS/устройство); здесь только честное представление, поэтому
      // перечитка тихая: флаг reconciling не гасит надпись «истёк».
      if (!state.expiryRecheckDone.has(item.approvalId)) {
        state.expiryRecheckDone.add(item.approvalId);
        recheckCurrent(true).catch(() => null);
      }
      render();
      return;
    }
    render();
  }

  /* --- Чтение/сверка ------------------------------------------------------------ */

  // silent — не махать reconciling (перечитка при истечении срока): вид
  // остаётся «expired», данные обноваются в фоне.
  async function recheckCurrent(silent) {
    if (state.destroyed) return;
    const item = currentItem();
    if (!item) return;
    if (!silent) {
      state.reconciling = true;
      render();
    }
    try {
      const result = await io.read(item.approvalId);
      if (state.destroyed) return;
      if (result && result.ok && result.data) {
        applyItem(result.data, result.etag);
      } else if (!silent) {
        state.reconciling = false;
        state.errorFlag = true;
        render();
      } else {
        render();
      }
    } catch (e) {
      if (state.destroyed) return;
      if (!silent) {
        state.reconciling = false;
        state.errorFlag = true;
      }
      render();
    }
  }

  function applyItem(item, etag) {
    if (!item || !item.approvalId) return;
    state.items.set(item.approvalId, item);
    if (state.currentId === item.approvalId) {
      state.etag = etag || state.etag;
    }
    sortQueue();
    state.reconciling = false;
    render();
  }

  // Свежая версия записи перед условной записью решения: read того же ID,
  // затем повторная проверка, что запись всё ещё pending (U5.6.4; свежесть —
  // как в B5: решение записывается только по проверенному состоянию).
  async function ensureVersion(item) {
    if (state.etag) return true;
    try {
      const result = await io.read(item.approvalId);
      if (state.destroyed) return false;
      if (result && result.ok && result.data) {
        state.items.set(item.approvalId, result.data);
        state.etag = result.etag || null;
        const fresh = state.items.get(item.approvalId);
        if (state.currentId === item.approvalId && isPending(fresh) &&
            isComplete(fresh) && state.connection === 'online') {
          return true;
        }
        return false;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /* --- Публичный контракт --------------------------------------------------------- */

  return {
    // Свежий snapshot approvals_v2 (список записей узла). Порядок очереди —
    // server createdAt, затем approvalId; открытый ID не подменяется.
    applySnapshot(items) {
      if (state.destroyed) return;
      const list = Array.isArray(items) ? items : [];
      for (const item of list) {
        if (item && item.approvalId) state.items.set(item.approvalId, item);
      }
      sortQueue();
      state.stale = false;
      state.errorFlag = false;
      state.reconciling = false;
      if (io.onQueueChanged) io.onQueueChanged(state.queue.length);

      let newlySelected = false;
      if (!state.currentId) {
        if (state.queue.length) {
          state.currentId = state.queue[0];
          state.etag = null;
          newlySelected = true;
        } else if (state.items.size) {
          // Нет ни одного pending: показываем итог самой свежей записи,
          // чтобы решение владельца честно завершалось исходом (U5.6.2).
          const latest = [...state.items.values()].sort((a, b) =>
            (b.createdAt || 0) - (a.createdAt || 0))[0];
          state.currentId = latest.approvalId;
          state.etag = null;
        }
      }

      // Первый новый запрос открывается сам только на видимом экране;
      // свернутый вручную ID не открывается на каждом snapshot (U5.6.2).
      // Диалог открывается только при явном выборе НОВОГО запроса.
      if (!el.dialog.open && state.queue.length && io.isVisible && io.isVisible()) {
        const openable = state.queue.find((id) => {
          if (state.manuallyCollapsed.has(id)) return false;
          const it = state.items.get(id);
          return it && isComplete(it);
        });
        if (openable && openable !== state.currentId) {
          state.currentId = openable;
          state.etag = null;
          newlySelected = true;
        }
      }
      if (newlySelected && !el.dialog.open) openDialog();
      render();
    },

    // Состояние соединения: offline / auth-expired / online. Разблокировка
    // после reconnect — только через свежий applySnapshot (U5.6.7).
    setConnection(mode) {
      state.connection = mode;
      if (mode === 'online') {
        // Данные, полученные до разрыва, не считаются свежими.
        state.stale = true;
      }
      render();
    },

    currentId() {
      return state.currentId;
    },

    queueSize() {
      return queueSize();
    },

    viewState() {
      return computeViewState();
    },

    // Решение владельца. Возвращает промис, который разрешается ПОСЛЕ полной
    // сверки (включая перечитку при 412/timeout), чтобы тесты могли ждать итог.
    async decide(kind) {
      if (state.destroyed) return;
      // Синхронный флаг двойного тапа: ставится ДО первого await (U5.6.4).
      if (state.submitting) return;
      let item = currentItem();
      if (!item || computeViewState() !== 'pending') return;   // офлайн/итог — отказ

      state.submitting = true;
      render();

      // Свежая версия + повторная проверка привязки прямо перед записью.
      const ready = await ensureVersion(item);
      if (state.destroyed) return;
      if (!ready) {
        state.submitting = false;
        state.errorFlag = true;
        render();
        return;
      }
      item = currentItem();
      if (!item || !isPending(item)) {
        // Пока мы читали, запись решила другая вкладка/сервер: показываем
        // актуальные данные, свою запись не отправляем.
        state.submitting = false;
        render();
        return;
      }

      let outcome = null;
      try {
        await io.decide({
          approvalId: item.approvalId,
          etag: state.etag,
          decision: kind === 'approved' ? 'approved' : 'rejected',
          decidedAt: io.serverNow(),
        });
        // Успех: перечитываем ту же запись — сервер авторитетен, локальный
        // optimistic approve не выдаётся за состоявшееся разрешение.
        outcome = 'ok';
      } catch (err) {
        const code = err && (err.code || (err.status === 412 ? 'conflict' : null));
        if (code === 'conflict' || code === 'timeout') {
          // 412/потерянный ответ: исход неизвестен — сначала read того же
          // approvalId, кнопки остаются выключенными до сверки. Флаг
          // submitting снимается: дальше показывается состояние сверки.
          state.submitting = false;
          state.reconciling = true;
          render();
          try {
            const result = await io.read(item.approvalId);
            if (state.destroyed) return;
            if (result && result.ok && result.data) {
              applyItem(result.data, result.etag);
            } else {
              state.reconciling = false;
              state.errorFlag = true;
              render();
            }
          } catch (e) {
            if (state.destroyed) return;
            state.reconciling = false;
            state.errorFlag = true;
            render();
          }
        } else {
          // Обычный отказ (нет сети, права): решение не записано, можно
          // повторить вручную. Никаких авто-повторов (U5.6.7).
          state.submitting = false;
          render();
          if (io.announce && err && err.message) io.announce(String(err.message));
        }
        return;
      } finally {
        if (state.destroyed) return;
        state.submitting = false;
        if (outcome === 'ok') await recheckCurrent(false);
      }
    },

    // Переход к следующему запросу после показа итога текущего (U5.6.2).
    // При пустой очереди — закрытие диалога.
    showNextAfterOutcome() {
      if (state.destroyed) return;
      const next = state.queue.find((id) => id !== state.currentId);
      if (next) {
        state.currentId = next;
        state.etag = null;
        render();
      } else {
        el.dialog.close();
        state.currentId = null;
        render();
      }
    },

    // Свернуть без решения: только представление, никаких записей (U5.5.6,
    // U5.6.3). Отправленное решение продолжает сверку — цикл decide живёт
    // независимо от dialog.
    collapse() {
      if (state.destroyed) return;
      if (state.currentId) state.manuallyCollapsed.add(state.currentId);
      el.dialog.close();
    },

    // Открыть из плашки очереди: вручную свернутый ID разрешено открыть снова.
    open() {
      if (state.destroyed || !modalSupported) return;
      if (!state.currentId && state.queue.length) {
        state.currentId = state.queue[0];
        state.etag = null;
      }
      if (state.currentId) {
        render();
        openDialog();
      }
    },

    isOpen() {
      return Boolean(el.dialog.open);
    },

    destroy() {
      state.destroyed = true;
      if (state.timerId) {
        io.timers.clearTimeout(state.timerId);
        state.timerId = null;
      }
      state.items.clear();
      state.queue = [];
      state.currentId = null;
      state.etag = null;
      state.submitting = false;
      state.reconciling = false;
      el.dialog.close();
      if (el.dialog.open) el.dialog.open = false;
      if (io.onQueueChanged) io.onQueueChanged(0);
    },
  };
}
