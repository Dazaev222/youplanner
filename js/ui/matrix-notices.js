/* Локальные уведомления Матрицы (ТЗ Б5 «Доставка»).

   Единственный экран, который напоминает о напоминании, — сам интерфейс
   приложения: push, Notification API и сеть здесь не используются. Контроллер
   из js/core/matrix-reminders.js решает КОГДА, этот модуль решает КАК выглядит
   и как живёт очередь.

   Почему отдельный модуль, а не правка #toast: toast — одна строка на весь
   экран, и он же показывает отказ хранилища. Наложить напоминание поверх
   «Не удалось сохранить…» означало бы стереть предупреждение о потере данных,
   поэтому у очереди свой контейнер и свой живой регион.

   Текст уходит через textContent: заголовок задачи пользовательский, и из него
   нельзя собирать разметку (то же правило, что у js/ui/matrix-view.js). */

export const MATRIX_NOTICE_MAX = 4;

const NOTICE_STACK_ID = 'matrix-reminder-stack';

function noticeDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function noticeTime(value) {
  const date = noticeDate(value);
  if (!date) return '';
  return date.toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function createNoticeCenter(options) {
  const opts = options || {};
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : function () {};
  // id → узел. Порядок вставки = порядок обхода Map, поэтому «самый старый»
  // всегда первый, и переполнение очереди снимает именно его.
  const live = new Map();
  let stack = null;

  function ensureStack() {
    if (stack) return stack;
    if (!doc || !doc.body) return null;
    stack = doc.getElementById(NOTICE_STACK_ID);
    if (!stack) {
      stack = doc.createElement('div');
      stack.id = NOTICE_STACK_ID;
      stack.className = 'matrix-reminder-stack';
      stack.setAttribute('role', 'region');
      stack.setAttribute('aria-label', 'Напоминания Матрицы');
      // polite, а не assertive: уведомление не имеет права перебивать то, что
      // человек читает в этот момент.
      stack.setAttribute('aria-live', 'polite');
      doc.body.appendChild(stack);
    }
    return stack;
  }

  function dismiss(id) {
    const node = live.get(id);
    if (!node) return false;
    live.delete(id);
    if (node.remove) node.remove();
    return true;
  }

  function button(className, label) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    return btn;
  }

  function show(item) {
    if (!doc || !doc.body || !item || !item.id) return false;
    if (live.has(item.id)) return false;
    const host = ensureStack();
    if (!host) return false;

    const notice = doc.createElement('div');
    notice.className = 'matrix-reminder-notice';

    const title = doc.createElement('p');
    title.className = 'matrix-reminder-notice-title';
    title.textContent = String(item.title || 'Задача');
    const time = doc.createElement('p');
    time.className = 'matrix-reminder-notice-time';
    time.textContent = noticeTime(item.at);
    const actions = doc.createElement('div');
    actions.className = 'matrix-reminder-notice-actions';
    const open = button('matrix-reminder-notice-open', 'Открыть');
    open.addEventListener('click', () => {
      // «Открыть» снимает карточку: человек ушёл смотреть задачу, держать
      // напоминание над экраном больше незачем.
      dismiss(item.id);
      onOpen(item);
    });
    const close = button('matrix-reminder-notice-close', 'Закрыть');
    close.addEventListener('click', () => dismiss(item.id));
    actions.append(open, close);

    notice.appendChild(title);
    notice.appendChild(time);
    notice.appendChild(actions);
    host.appendChild(notice);
    live.set(item.id, notice);

    while (live.size > MATRIX_NOTICE_MAX) {
      const oldest = live.keys().next().value;
      dismiss(oldest);
    }
    return true;
  }

  function clear() {
    for (const id of Array.from(live.keys())) dismiss(id);
  }

  return {
    show: show,
    dismiss: dismiss,
    clear: clear,
    count: function () { return live.size; },
    node: function () { return stack; },
  };
}
