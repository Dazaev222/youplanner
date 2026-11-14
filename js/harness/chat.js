/* Лента и composer Harness-чата (ТЗ U5.7, U5.8).

   Ответственность модуля: DOM ленты и поля ввода, безопасный вывод
   (только textContent), статусы по источнику, черновики по устройству,
   якорь прокрутки (80px), пагинация по 50 сообщений, рост textarea.

   Модуль НЕ обращается к RTDB и не пишет approvals: данные и действия
   приходят аргументами (deps.onSend / deps.draftStore / deps.deviceId),
   элементы ленты — deps/elements. Тесты подставляют заглушки вместо DOM.

   История команд Harness отдельна от истории обычного ИИ-чата (U5.1.1):
   элементы создаются с классами harness-message, к assistant-chat модуль
   не прикасается. innerHTML не используется (см. tests/harness-layout). */

// Порог «владелец у низа ленты»: если до нового сообщения он был не дальше
// 80px от конца — прокручиваем к концу, иначе сохраняем позицию и показываем
// плашку «Новые сообщения» (U5.7).
const NEAR_BOTTOM_PX = 80;
// Начальная страница и шаг дозагрузки старых записей (U5.7).
const PAGE_SIZE = 50;
// Верхняя граница DOM-ленты: старые записи выгружаются из DOM, полная
// история живёт в модели (не держим неограниченную историю в DOM).
const DOM_LIMIT = 200;
// Рост textarea: ~5 строк при 16px/1.4 + отступы, дальше — своя прокрутка.
const INPUT_MIN_HEIGHT = 44;
const INPUT_MAX_HEIGHT = 126;

export const FEEDBACK_EMPTY_NOTE = 'Задач пока нет. Напишите задачу для ПК';
export const FEEDBACK_LOADING_NOTE = 'Загружаем задачи…';

// Статус задания по источнику (U5.7). item — модель карточки:
// { phase } | { command, execution, result }. Порядок честный:
// «Отправляется» → «Записано в облако» → «Принято ПК» → «Выполняется» → итог.
export function statusFor(item) {
  if (!item) return { text: 'Отправляется', kind: 'info' };
  if (item.phase === 'sending') return { text: 'Отправляется', kind: 'info' };
  if (!item.command) return { text: 'Отправляется', kind: 'info' };
  const execution = item.execution || null;
  if (!execution) return { text: 'Записано в облако', kind: 'info' };
  if (execution.waitingApproval && execution.state !== 'succeeded' &&
      execution.state !== 'failed') {
    return { text: 'Ожидает подтверждения', kind: 'attention' };
  }
  switch (execution.state) {
    case 'queued':
    case 'claimed':
      return { text: 'Принято ПК', kind: 'info' };
    case 'running':
      return { text: 'Выполняется', kind: 'info' };
    case 'succeeded': {
      const summary = execution.summary || (item.result && item.result.summary) || '';
      return { text: summary ? 'Готово: ' + summary : 'Готово', kind: 'ok' };
    }
    case 'failed':
      return {
        text: 'Не удалось: ' + (execution.errorMessage || 'подробности у результата'),
        kind: 'error',
      };
    case 'cancelled':
      return { text: 'Отменено', kind: 'attention' };
    case 'expired':
      return { text: 'Срок команды истёк', kind: 'error' };
    case 'outcome_unknown':
      // Без ложного успеха и без кнопки авто-повтора (гл. 0.5, U5.7).
      return {
        text: 'Возможно, действие уже выполнено. Автоматического повтора не будет',
        kind: 'error',
      };
    default:
      return { text: 'Статус неизвестен', kind: 'error' };
  }
}

export function createChat({ elements, deps }) {
  const el = elements;
  const io = deps || {};

  const makeNode = io.makeElement ||
    (typeof document !== 'undefined' && document.createElement
      ? (tag) => document.createElement(tag)
      // Тестовая среда без DOM: узел с минимальным деревом-контрактом.
      : () => ({
        children: [],
        appendChild(node) { this.children.push(node); return node; },
        removeChild(node) {
          const i = this.children.indexOf(node);
          if (i !== -1) this.children.splice(i, 1);
          return node;
        },
      }));

  const state = {
    messages: [],      // полная модель ленты
    windowStart: 0,    // индекс первого сообщения в DOM
    sending: false,    // синхронный флаг анти-дубля до первого await
  };

  /* --- Черновики (по устройству) ---------------------------------------------- */

  function saveDraft() {
    if (!io.draftStore || !io.deviceId) return;
    try {
      io.draftStore.set(io.deviceId, el.input.value);
    } catch (e) {
      // Отказ хранилища не блокирует ввод: черновик живёт в поле до ухода.
      showFeedback('Черновик не сохранён: хранилище недоступно', true);
    }
  }

  function restoreDraft() {
    if (!io.draftStore || !io.deviceId) return;
    try {
      const saved = io.draftStore.get(io.deviceId);
      if (saved && !el.input.value) el.input.value = saved;
    } catch (e) {
      // хранилище недоступно — поле просто пустое
    }
  }

  /* --- Обратная связь ---------------------------------------------------------- */

  function showFeedback(text, isError) {
    el.feedback.textContent = text;
    el.feedback.hidden = !text;
    if (isError && io.announce) io.announce(text);
  }

  /* --- Отправка ------------------------------------------------------------------ */

  // Возвращает true, если отправка начата. Пустое/пробельное не отправляется
  // (U5.7). Ошибка отправки сохраняет текст и показывает адресную причину.
  function trySend() {
    if (state.sending) return false;
    const text = String(el.input.value || '').trim();
    if (!text) return false;
    state.sending = true;
    el.send.disabled = true;
    let flight;
    try {
      flight = Promise.resolve(io.onSend(text));
    } catch (e) {
      flight = Promise.reject(e);
    }
    return flight.then(function () {
      state.sending = false;
      el.send.disabled = false;
      el.input.value = '';
      autosize();
      saveDraft();
      showFeedback('', false);
    }, function (err) {
      state.sending = false;
      el.send.disabled = false;
      // Черновик сохраняется до подтверждённой записи: текст остаётся.
      showFeedback('Не удалось отправить задачу: ' +
        ((err && err.message) ? err.message : 'нет связи'), true);
      autosize();
    });
  }

  // Клавиатура композера (U5.7): Ctrl/Cmd+Enter отправляет, plain Enter
  // всегда оставляет строку, IME-композиция не отправляет.
  function onKeydown(event) {
    if (!event) return false;
    if (event.isComposing) return false;
    const sendKey = event.key === 'Enter' && (event.ctrlKey || event.metaKey);
    if (!sendKey) return false;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    // trySend возвращает промис, если отправка начата, и false — если нет.
    // Обработчик отвечает булевым «отправка начата»: промис уже несёт свою
    // обработку ошибок и не бросает.
    return trySend() !== false;
  }

  /* --- Рост textarea ---------------------------------------------------------------- */

  function autosize() {
    const height = Math.min(Math.max(Number(el.input.scrollHeight) || 0,
      INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT);
    el.input.style.height = height + 'px';
    el.input.style.overflowY =
      Number(el.input.scrollHeight) > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }

  /* --- Прокрутка и лента ------------------------------------------------------------ */

  function isNearBottom() {
    const scroller = el.scroller;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    return gap <= NEAR_BOTTOM_PX;
  }

  function buildMessageNode(message) {
    const li = makeNode('li');
    li.className = 'harness-message harness-message--' +
      (message.role === 'owner' ? 'owner' : 'agent');
    li.textContent = String(message.text || '');
    const time = makeNode('time');
    time.textContent = message.at
      ? new Date(message.at).toISOString().replace('T', ' ').slice(0, 16)
      : '';
    const status = makeNode('span');
    status.className = 'harness-message-status';
    if (message.status) status.textContent = String(message.status);
    li.appendChild(time);
    li.appendChild(status);
    return li;
  }

  function trimDom() {
    while (el.list.children.length > DOM_LIMIT) {
      el.list.removeChild(el.list.children[0]);
      state.windowStart += 1;
    }
  }

  // Одно новое сообщение: якорь решает — прокрутить или показать плашку.
  function appendMessage(message) {
    const wasNear = isNearBottom();
    state.messages.push(message);
    const node = buildMessageNode(message);
    el.list.appendChild(node);
    trimDom();
    if (wasNear) {
      el.scroller.scrollTop = el.scroller.scrollHeight;
      el.newMessages.hidden = true;
    } else {
      el.newMessages.hidden = false;
    }
    if (io.announce && message.role === 'agent') {
      io.announce('Новый ответ ПК-агента');
    }
    return node;
  }

  // Пагинация: полная модель → окно DOM. Начальная страница — последние 50.
  function renderWindow() {
    while (el.list.children.length) {
      el.list.removeChild(el.list.children[el.list.children.length - 1]);
    }
    for (let i = state.windowStart; i < state.messages.length; i++) {
      el.list.appendChild(buildMessageNode(state.messages[i]));
    }
  }

  function setMessages(items) {
    state.messages = Array.isArray(items) ? items.slice() : [];
    state.windowStart = Math.max(0, state.messages.length - PAGE_SIZE);
    renderWindow();
    el.scroller.scrollTop = el.scroller.scrollHeight;
    el.newMessages.hidden = true;
    showFeedback(state.messages.length ? '' : FEEDBACK_EMPTY_NOTE, false);
  }

  function loadOlder() {
    if (state.windowStart === 0) return;
    state.windowStart = Math.max(0, state.windowStart - PAGE_SIZE);
    // Якорь прокрутки: сохраняем видимое положение (высотный дельта в живом
    // DOM компенсирует вставку; в тестовой заглушке позиция не меняется).
    const previousTop = el.scroller.scrollTop;
    renderWindow();
    el.scroller.scrollTop = previousTop;
  }

  restoreDraft();
  autosize();

  return {
    trySend,
    onKeydown,
    autosize,
    saveDraft,
    isNearBottom,
    appendMessage,
    setMessages,
    loadOlder,
    messages() {
      return state.messages;
    },
    windowStart() {
      return state.windowStart;
    },
    isSending() {
      return state.sending;
    },
  };
}
