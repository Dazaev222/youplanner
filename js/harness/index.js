/* Композиция Harness-маршрута (ТЗ U5.8): жизненный цикл Auth/device,
   подключение firebase-адаптера, чата и контроллера approvals, защита от
   устаревших ответов (generation), полная отписка на выходе.

   Импорты направлены только внутрь (index → модули); app.js импортирует
   mountHarness отсюда — циклов нет. Top-level код не трогает DOM: модуль
   безопасно загружается и в тестовой песочнице, mountHarness зовётся при
   входе на маршрут (ROUTE_RENDER в app.js).

   Публичный веб-конфиг Firebase проекта Bridge — источник:
   BR/служебное/get_web_config.py → BR/miniapp/firebase-config.js.
   Значения публичные по дизайну Firebase (apiKey — идентификатор
   приложения, доступ закрывают Rules RTDB и Auth). */

import { createApprovalController } from './approvals.js';
import { createChat, statusFor, FEEDBACK_LOADING_NOTE } from './chat.js';
import {
  createHarnessFirebase,
  HARNESS_DEVICE_HEARTBEAT_MS,
  HARNESS_DEVICE_STALE_MS,
} from './firebase.js';
import { mountHarnessViewport } from './viewport.js';

// Публичный веб-конфиг RTDB Bridge (см. шапку файла).
const BRIDGE_WEB_CONFIG = {
  apiKey: 'AIzaSyB_AynV8tFqanugavpWfiRDcE8bBiKlOHo',
  authDomain: 'telegram-claude-tunnel.firebaseapp.com',
  databaseURL: 'https://telegram-claude-tunnel-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'telegram-claude-tunnel',
  storageBucket: 'telegram-claude-tunnel.firebasestorage.app',
  messagingSenderId: '869669207915',
  appId: '1:869669207915:web:70d14e8f6264451e77162e',
};

// Разрешённые ПК владельца. Расширение списка — по мере регистрации
// устройств (set_roles.py создаёт аккаунты устройств с deviceId).
const KNOWN_DEVICES = [
  { deviceId: 'pc-main-01', label: 'Домашний ПК' },
];

const HARNESS_STORAGE_KEYS = {
  device: 'harness.deviceId',
  ownerUid: 'harness.ownerUid',
  draftPrefix: 'harness.draft.',
};

// Пороги presence по умолчанию (U5.7): при отсутствии согласованного порога
// с BR — heartbeat 15с / устаревание 45с. Значения экспортированы из
// firebase.js и зафиксированы в отчёте.

function readStorage(storage, key, fallback) {
  try {
    return storage.getItem(key) || fallback;
  } catch (e) {
    return fallback;
  }
}

function writeStorage(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

export function mountHarness({ onBack } = {}) {
  /* --- Элементы ------------------------------------------------------------- */

  const view = document.getElementById('harness-view');
  if (!view) return { unmount() {} };

  const el = {
    view,
    presence: document.getElementById('harness-presence'),
    scroller: document.getElementById('harness-messages'),
    // Лента — ol с классом (U5.2), не с id: берём селектором внутри экрана
    list: view.querySelector('.harness-message-list'),
    announcer: document.getElementById('harness-announcer'),
    newMessages: document.getElementById('harness-new-messages'),
    pendingChip: document.getElementById('harness-pending'),
    feedback: document.getElementById('harness-feedback'),
    form: document.getElementById('harness-form'),
    input: document.getElementById('harness-input'),
    send: document.getElementById('harness-send'),
    dialog: document.getElementById('harness-approval'),
    dialogTitle: document.getElementById('harness-approval-title'),
    dialogSummary: document.getElementById('harness-approval-summary'),
  };
  if (el.dialog) {
    el.counter = el.dialog.querySelector('.harness-approval-counter');
    el.facts = el.dialog.querySelector('.harness-approval-facts');
    el.arguments = el.dialog.querySelector('.harness-approval-arguments');
    el.stateLine = el.dialog.querySelector('.harness-approval-state');
    el.approveBtn = el.dialog.querySelector('.harness-approve');
    el.rejectBtn = el.dialog.querySelector('.harness-reject');
    el.collapseBtn = el.dialog.querySelector('.harness-collapse');
  }
  const backButton = view.querySelector('.harness-head .harness-icon-btn[aria-label="Назад"]');
  const menuButton = view.querySelector('.harness-head .harness-icon-btn[aria-label="Меню ПК"]');

  const storage = (typeof localStorage !== 'undefined') ? localStorage : null;

  /* --- Состояние маршрута ------------------------------------------------------ */

  let destroyed = false;
  let generation = 0;           // защита от устаревших async-ответов
  let adapter = null;
  let deviceMenu = null;        // открытый пункт меню устройств
  let presenceTimer = 0;
  let layoutFrame = 0;
  let settingsOpen = false;     // подэкран «Настройки модели» (F6.2.8)
  let chat = null;
  let approvals = null;
  let viewport = null;
  const unsubscribes = [];
  // Модель ленты: команды по commandId, статусы по execution/result.
  const feed = { commands: new Map(), executions: new Map(), results: new Map() };
  const statusNodes = new Map();   // commandId → узел статуса в карточке

  function announce(text) {
    if (!destroyed && el.announcer) el.announcer.textContent = String(text || '');
  }

  /* --- Чат ---------------------------------------------------------------------- */

  chat = createChat({
    elements: {
      list: el.list,
      scroller: el.scroller,
      input: el.input,
      send: el.send,
      newMessages: el.newMessages,
      feedback: el.feedback,
      announcer: el.announcer,
    },
    deps: {
      deviceId: readStorage(storage, HARNESS_STORAGE_KEYS.device, KNOWN_DEVICES[0].deviceId),
      draftStore: {
        get(deviceId) {
          return readStorage(storage, HARNESS_STORAGE_KEYS.draftPrefix + deviceId, '');
        },
        set(deviceId, value) {
          writeStorage(storage, HARNESS_STORAGE_KEYS.draftPrefix + deviceId, value);
        },
      },
      onSend: (text) => sendTask(text),
      announce,
    },
  });

  // Начальное состояние ленты — loading (U5.7): до первого snapshot узла
  // команд поле обратной связи показывает «Загружаем задачи…».
  if (el.feedback) {
    el.feedback.textContent = FEEDBACK_LOADING_NOTE;
    el.feedback.hidden = false;
  }

  /* --- Подтверждения ---------------------------------------------------------------- */

  approvals = createApprovalController({
    elements: {
      dialog: el.dialog,
      title: el.dialogTitle,
      counter: el.counter,
      summary: el.dialogSummary,
      facts: el.facts,
      arguments: el.arguments,
      stateLine: el.stateLine,
      approveBtn: el.approveBtn,
      rejectBtn: el.rejectBtn,
      collapseBtn: el.collapseBtn,
    },
    deps: {
      // Чтение/решение всегда через актуальные сессию и токен; ошибка
      // нормализуется адаптером. stale-ответы отсекаются generation-гвардом.
      read: async (approvalId) => {
        const gen = generation;
        await adapter.getAccessToken();
        if (destroyed || gen !== generation) return { ok: false };
        try {
          const result = await adapter.readApproval({
            ownerUid: ownerUid(), approvalId,
          });
          return (gen === generation && !destroyed)
            ? result
            : { ok: false };
        } catch (err) {
          if (gen !== generation || destroyed) return { ok: false };
          if (err && err.code === 'auth') {
            approvals.setConnection('auth-expired');
          } else if (err && err.code === 'network') {
            approvals.setConnection('offline');
          }
          return { ok: false, error: err ? err.message : 'ошибка' };
        }
      },
      decide: async (args) => {
        const gen = generation;
        await adapter.getAccessToken();
        if (destroyed || gen !== generation) {
          const err = new Error('сессия сменилась');
          err.code = 'timeout';
          throw err;
        }
        await adapter.decideApproval({
          ownerUid: ownerUid(),
          approvalId: args.approvalId,
          decision: args.decision,
          etag: args.etag,
          serverTime: adapter.serverNow(),
        });
        if (gen !== generation || destroyed) {
          const err = new Error('сессия сменилась');
          err.code = 'timeout';
          throw err;
        }
        return { ok: true };
      },
      serverNow: () => (adapter ? adapter.serverNow() : Date.now()),
      timers: { setTimeout, clearTimeout },
      // Открытие dialog: сначала blur ввода (черновик остаётся в поле),
      // фокус в textarea автоматически не возвращается (F6.1.9).
      beforeOpen: () => {
        const active = document.activeElement;
        if (active && typeof active.blur === 'function' &&
            active !== document.body && !destroyed) {
          active.blur();
        }
      },
      isVisible: () => !destroyed && !view.hidden &&
        document.visibilityState !== 'hidden' && !settingsOpen,
      onQueueChanged: (count) => {
        if (!el.pendingChip) return;
        el.pendingChip.hidden = count === 0;
        el.pendingChip.textContent = 'Ожидают подтверждения: ' + count;
      },
      announce,
    },
  });

  /* --- Сессия --------------------------------------------------------------------------- */

  function ownerUid() {
    if (!adapter) return '';
    const account = adapter.getAccount();
    const stored = readStorage(storage, HARNESS_STORAGE_KEYS.ownerUid, '');
    return stored || (account ? account.uid : '');
  }

  function currentDeviceId() {
    const known = KNOWN_DEVICES.some((d) => d.deviceId === storedDevice);
    return known ? storedDevice : KNOWN_DEVICES[0].deviceId;
  }

  let storedDevice = readStorage(storage, HARNESS_STORAGE_KEYS.device, KNOWN_DEVICES[0].deviceId);

  function clearSubscriptions() {
    while (unsubscribes.length) {
      const off = unsubscribes.pop();
      try {
        off();
      } catch (e) { /* отписка не должна ронять выход */ }
    }
  }

  function setPresence(text) {
    if (el.presence) el.presence.textContent = text;
  }

  let lastPresence = null;

  // Presence не равен подключению телефона: статус только по свежему
  // heartbeat агента (U5.7). Нет достоверного времени — «Состояние ПК неизвестно».
  function renderPresence(snapshot) {
    lastPresence = snapshot;
    const label = KNOWN_DEVICES.find((d) => d.deviceId === currentDeviceId());
    const name = label ? label.label : currentDeviceId();
    const data = snapshot && typeof snapshot === 'object' ? snapshot : null;
    const heartbeatAt = data ? Number(data.heartbeatAt) : 0;
    if (!data || !Number.isFinite(heartbeatAt) || heartbeatAt <= 0) {
      setPresence(name + ' · Состояние ПК неизвестно');
      return;
    }
    const age = adapter.serverNow() - heartbeatAt;
    const fresh = age >= 0 && age <= HARNESS_DEVICE_STALE_MS;
    if (fresh) {
      setPresence(name + ' · На связи');
    } else {
      const when = new Date(heartbeatAt).toISOString().replace('T', ' ').slice(0, 16);
      setPresence(name + ' · Нет связи · был ' + when + ' UTC');
    }
    // У отсутствующего устройства отправка выключена и выбор ПК подсвечен
    // (U5.7). Пока heartbeat неизвестен, поле не блокируем: команда всё
    // равно встанет в очередь с честным статусом «Записано в облако».
    if (el.input && el.send && adapter.getAccount()) {
      const locked = !fresh;
      el.input.disabled = locked;
      el.send.disabled = locked || chat.isSending();
    }
  }

  function subscribeAll() {
    clearSubscriptions();
    const gen = generation;
    const uid = ownerUid();
    const deviceId = currentDeviceId();

    // Узкие подписки только своего среза (U5.8). Каждая проверяет generation:
    // ответ прошлой сессии не должен трогать интерфейс.
    const bind = (spec, handler) => {
      try {
        unsubscribes.push(adapter.subscribe(spec, (data) => {
          if (destroyed || gen !== generation) return;
          handler(data || {});
        }, () => {
          if (destroyed || gen !== generation) return;
          // Разрыв SSE: RTDB переподключается сам; статус соединения честный.
        }));
      } catch (e) {
        announce('Подписка недоступна: ' + (e && e.message ? e.message : 'ошибка'));
      }
    };

    bind({ kind: 'commands', ownerUid: uid, deviceId }, (data) => {
      feed.commands = new Map(Object.entries(data));
      renderFeed();
    });
    bind({ kind: 'executions', ownerUid: uid, deviceId }, (data) => {
      feed.executions = new Map(Object.entries(data));
      renderFeed();
    });
    bind({ kind: 'results', ownerUid: uid, deviceId }, (data) => {
      feed.results = new Map(Object.entries(data));
      renderFeed();
    });
    bind({ kind: 'approvals', ownerUid: uid }, (data) => {
      const items = Object.values(data).filter((item) => item && item.approvalId);
      approvals.applySnapshot(items);
    });
    bind({ kind: 'presence', ownerUid: uid, deviceId }, renderPresence);

    presenceTimer = setInterval(function () {
      if (destroyed || gen !== generation) return;
      // Пересчёт «осталось» и presence по серверному времени.
      renderPresence(lastPresence);
    }, HARNESS_DEVICE_HEARTBEAT_MS);
  }

  /* --- Лента ---------------------------------------------------------------------------- */

  function feedMessages() {
    const commands = [...feed.commands.values()]
      .filter((cmd) => cmd && cmd.commandId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return commands.map((cmd) => {
      const execution = feed.executions.get(cmd.commandId) || null;
      const result = feed.results.get(cmd.commandId) || null;
      const status = statusFor({ command: true, execution, result });
      const text = cmd.params && cmd.params.task ? String(cmd.params.task) : cmd.type;
      return {
        id: cmd.commandId,
        role: 'owner',
        text,
        at: cmd.createdAt,
        status: status.text,
      };
    });
  }

  function renderFeed() {
    const messages = feedMessages();
    // Гвард «ничего не изменилось»: presence/executions приходят часто,
    // и перерисовывать окно ленты из-за статуса «осталось» не нужно.
    const current = chat.messages();
    const same = current.length === messages.length && current.every((msg, i) =>
      msg.id === messages[i].id && msg.status === messages[i].status);
    if (!same) {
      chat.setMessages(messages);
      statusNodes.clear();
    }
  }

  /* --- Отправка задачи (P2.3) --------------------------------------------------------------- */

  async function sendTask(text) {
    if (destroyed) throw new Error('экран закрыт');
    if (!adapter.getAccount()) {
      const err = new Error('нужен вход владельца');
      err.code = 'auth';
      throw err;
    }
    const gen = generation;
    await adapter.getAccessToken();
    if (destroyed || gen !== generation) throw new Error('сессия сменилась');
    // commandId создаётся ДО отправки и сохраняется: потеря ответа
    // разрешается чтением этого ID, не созданием нового (P2.3).
    const made = await adapter.makeCommand({
      ownerUid: ownerUid(),
      deviceId: currentDeviceId(),
      type: 'run_task',
      params: { task: String(text) },
      serverTime: adapter.serverNow(),
    });
    feed.commands.set(made.commandId, made.payload);
    chat.appendMessage({
      id: made.commandId,
      role: 'owner',
      text: String(text),
      at: made.payload.createdAt,
      status: 'Отправляется',
    });
    try {
      await adapter.sendCommand(made);
      if (destroyed || gen !== generation) return { ok: true, commandId: made.commandId };
      // «Записано в облако»: статус показываем сразу, уточнит подписка.
      const card = feed.commands.get(made.commandId);
      if (card) card.writtenToCloud = true;
      renderFeed();
      return { ok: true, commandId: made.commandId };
    } catch (err) {
      if (destroyed || gen !== generation) throw err;
      // Потерянный ответ: сверка чтением ТОГО ЖЕ commandId со сравнением
      // digest; новый ID не создаём (P2.3). ID с другим payload — конфликт.
      let reconciled = null;
      try {
        const check = await adapter.readCommand(made.path);
        if (check && check.ok && check.data &&
            check.data.digest === made.payload.digest) {
          reconciled = check.data;
        }
      } catch (e2) { /* сверка не удалась — исход остаётся неизвестным */ }
      if (reconciled && !destroyed && gen === generation) {
        feed.commands.set(made.commandId, reconciled);
        renderFeed();
        return { ok: true, commandId: made.commandId, reconciled: true };
      }
      // Адресная ошибка: текст задачи остаётся черновиком (chat.trySend).
      feed.commands.delete(made.commandId);
      throw err;
    }
  }

  /* --- Панель входа (auth-expired) ------------------------------------------------------------ */

  let authBox = null;

  function removeAuthPanel() {
    if (authBox && authBox.parentNode) authBox.parentNode.removeChild(authBox);
    authBox = null;
  }

  function renderAuthPanel(message) {
    removeAuthPanel();
    if (destroyed || !el.list) return;
    const box = document.createElement('div');
    box.className = 'harness-auth';

    const title = document.createElement('p');
    title.textContent = message ||
      'Подтверждения и команды доступны после входа владельца в Firebase проекта Bridge.';

    const email = document.createElement('input');
    email.type = 'email';
    email.id = 'harness-auth-email';
    email.placeholder = 'Email владельца';
    email.autocomplete = 'username';

    const password = document.createElement('input');
    password.type = 'password';
    password.id = 'harness-auth-password';
    password.placeholder = 'Пароль';
    password.autocomplete = 'current-password';

    const error = document.createElement('p');
    error.id = 'harness-auth-error';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Войти';

    button.addEventListener('click', async function () {
      const gen = generation;
      error.textContent = '';
      button.disabled = true;
      try {
        const account = await adapter.signIn(email.value, password.value);
        writeStorage(storage, HARNESS_STORAGE_KEYS.ownerUid, account.uid);
        if (destroyed || gen !== generation) return;
        removeAuthPanel();
        approvals.setConnection('online');
        startSession();
      } catch (err) {
        if (gen !== generation || destroyed) return;
        // Пароль и токены в текст ошибки не попадают (redact адаптера).
        error.textContent = (err && err.message) ? err.message : 'Вход не удался';
        button.disabled = false;
      }
    });

    box.appendChild(title);
    box.appendChild(email);
    box.appendChild(password);
    box.appendChild(error);
    box.appendChild(button);
    el.list.appendChild(box);
    authBox = box;
  }

  /* --- Меню устройств ------------------------------------------------------------------------- */

  function closeDeviceMenu() {
    if (deviceMenu && deviceMenu.parentNode) {
      deviceMenu.parentNode.removeChild(deviceMenu);
    }
    deviceMenu = null;
    if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
  }

  function openDeviceMenu() {
    if (destroyed || deviceMenu || !menuButton) return;
    const menu = document.createElement('div');
    menu.className = 'harness-device-menu';
    const rect = menuButton.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.right =
      Math.max(8, document.documentElement.clientWidth - rect.right) + 'px';

    for (const device of KNOWN_DEVICES) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'harness-device-item';
      const selected = device.deviceId === currentDeviceId();
      item.textContent = device.label + (selected ? ' · выбран' : '');
      const presence = document.createElement('span');
      presence.className = 'harness-device-presence';
      presence.textContent = (lastPresence &&
        Number(lastPresence.heartbeatAt) > 0 &&
        adapter.serverNow() - Number(lastPresence.heartbeatAt) <= HARNESS_DEVICE_STALE_MS)
        ? 'На связи'
        : 'Состояние ПК неизвестно';
      item.appendChild(presence);
      item.addEventListener('click', function () {
        storedDevice = device.deviceId;
        writeStorage(storage, HARNESS_STORAGE_KEYS.device, device.deviceId);
        closeDeviceMenu();
        startSession();   // смена ПК: свежие подписки и свежее чтение
      });
      menu.appendChild(item);
    }

    view.appendChild(menu);
    deviceMenu = menu;
    menuButton.setAttribute('aria-expanded', 'true');
  }

  /* --- Геометрия dialog (U5.5.3, F6.1.9) ---------------------------------------------------------- */

  function layoutDialog() {
    layoutFrame = 0;
    if (destroyed || !el.dialog || !el.dialog.open) return;
    const inputRow = el.form ? el.form.querySelector('.harness-input-row') : null;
    if (!inputRow) return;
    const rowRect = inputRow.getBoundingClientRect();
    if (!rowRect || rowRect.width <= 0) return;
    const doc = document.documentElement;
    const clientWidth = doc.clientWidth;
    const clientHeight = doc.clientHeight;
    const bottomEdge = rowRect.top - 8;   // нижний край карточки: верх поля − 8px
    // Одна система layout-координат: видимый верх — vv.offsetTop, DOMRect поля
    // в тех же client-координатах; offsetTop второй раз не прибавляется.
    const vv = window.visualViewport;
    const visibleTop = (vv && Number.isFinite(Number(vv.offsetTop)))
      ? Number(vv.offsetTop) : 0;
    // Без константного минимума высоты (старый Math.max с 120 убран):
    // max-height ограничена реальным доступным местом; нехватка места не
    // выталкивает кнопки — карточка сжимается и прокручивается.
    const availableHeight = Math.max(0, bottomEdge - (visibleTop + 8));
    // Ширина = min(ширина колонки чата − 32px, 560px), центр колонки.
    const columnWidth = Math.min(clientWidth, 760);
    const width = Math.min(columnWidth - 32, 560);
    const columnLeft = Math.max(0, (clientWidth - columnWidth) / 2);
    const left = columnLeft + (columnWidth - width) / 2;
    el.dialog.style.left = Math.round(left) + 'px';
    el.dialog.style.width = Math.round(width) + 'px';
    el.dialog.style.maxHeight = Math.round(availableHeight) + 'px';
    el.dialog.style.top = 'auto';
    el.dialog.style.bottom =
      Math.max(0, Math.round(clientHeight - bottomEdge)) + 'px';
    el.dialog.style.margin = '0';
  }

  function scheduleDialogLayout() {
    if (layoutFrame || destroyed) return;
    layoutFrame = requestAnimationFrame(function () {
      layoutFrame = 0;
      layoutDialog();
    });
  }

  /* --- Проводка событий ------------------------------------------------------------------------- */

  const listeners = [];

  function bind(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }

  bind(el.form, 'submit', function (event) {
    event.preventDefault();
    chat.trySend();
  });
  bind(el.input, 'input', function () {
    chat.autosize();
    chat.saveDraft();
    scheduleDialogLayout();   // высота dock изменилась — пересчёт привязки
  });

  bind(el.newMessages, 'click', function () {
    el.newMessages.hidden = true;
    el.scroller.scrollTop = el.scroller.scrollHeight;
  });
  bind(el.pendingChip, 'click', function () {
    approvals.open();
    scheduleDialogLayout();
  });
  bind(backButton, 'click', function () {
    if (typeof onBack === 'function') onBack();
  });
  bind(menuButton, 'click', function () {
    if (deviceMenu) closeDeviceMenu();
    else openDeviceMenu();
  });

  // Решения: кнопки контроллера напрямую, dialog cancel/Escape и тап по
  // backdrop — только сворачивание представления, без записей (U5.5.6).
  bind(el.approveBtn, 'click', function () { approvals.decide('approved'); });
  bind(el.rejectBtn, 'click', function () { approvals.decide('rejected'); });
  bind(el.collapseBtn, 'click', function () {
    approvals.collapse();
  });
  bind(el.dialog, 'cancel', function (event) {
    // Escape/native cancel: закрыть вид, НЕ записав rejected/approved.
    event.preventDefault();
    approvals.collapse();
  });
  bind(el.dialog, 'click', function (event) {
    // Backdrop определяем по координатам за границами карточки: клики по
    // пустому месту внутри диалога отказом не считаются (U5.5.6).
    if (event.target === el.dialog) {
      approvals.collapse();
    }
  });
  bind(el.dialog, 'close', function () {
    scheduleDialogLayout();
    // Возврат фокуса на плашку очереди, если она видна (U5.5.5); в поле
    // ввода фокус не возвращается принудительно.
    if (el.pendingChip && !el.pendingChip.hidden &&
        typeof el.pendingChip.focus === 'function') {
      el.pendingChip.focus();
    }
  });

  // Viewport: клавиатура/поворот — единый владелец геометрии (F6.1) пишет
  // переменные на #app и зовёт onLayout; позиция диалога пересчитывается
  // после обновлённой геометрии, вторым viewport-компенсатором не заводится.
  bind(window, 'resize', scheduleDialogLayout);
  bind(window, 'orientationchange', scheduleDialogLayout);

  // Возврат из фона и reconnect: свежее чтение approvals и повторная
  // проверка дедлайна до разблокировки (U5.6.7).
  bind(document, 'visibilitychange', async function () {
    if (destroyed || document.visibilityState !== 'visible') return;
    const gen = generation;
    await refreshSession();
    if (gen !== generation || destroyed) return;
    await refreshApprovals();
  });
  bind(window, 'online', function () {
    refreshSession();
  });
  bind(window, 'offline', function () {
    approvals.setConnection('offline');
  });

  /* --- Жизненный цикл сессии ---------------------------------------------------------------------- */

  async function refreshSession() {
    if (destroyed) return;
    if (!adapter.getAccount()) {
      approvals.setConnection('auth-expired');
      setPresence('Состояние ПК неизвестно');
      return;
    }
    const gen = generation;
    await adapter.getAccessToken();
    if (destroyed || gen !== generation) return;
    approvals.setConnection('online');
  }

  async function refreshApprovals() {
    if (destroyed || !adapter.getAccount()) return;
    const gen = generation;
    await adapter.getAccessToken();
    if (destroyed || gen !== generation) return;
    try {
      // Полный узел approvals_v2 владельца: свежий snapshot для контроллера.
      const token = await adapter.getAccessToken();
      if (!token || gen !== generation || destroyed) return;
      const url = BRIDGE_WEB_CONFIG.databaseURL.replace(/\/+$/, '') +
        '/bridge/approvals_v2/' + encodeURIComponent(ownerUid()) + '.json?auth=' +
        encodeURIComponent(token);
      const response = await adapter.fetch(url, { method: 'GET' });
      if (!response.ok || gen !== generation || destroyed) return;
      const data = await response.json();
      const items = Object.values(data || {})
        .filter((item) => item && item.approvalId);
      approvals.applySnapshot(items);
    } catch (e) {
      // Ошибка свежего чтения: контроллер остаётся заблокированным.
    }
  }

  function startSession() {
    if (destroyed) return;
    generation += 1;                 // ответы прошлой сессии выбрасываются
    clearSubscriptions();
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = 0;
    }
    removeAuthPanel();
    if (!adapter.getAccount()) {
      approvals.setConnection('auth-expired');
      renderPresence(null);
      renderAuthPanel('');
      if (el.pendingChip) el.pendingChip.hidden = true;
      return;
    }
    approvals.setConnection('online');
    subscribeAll();
    renderPresence(lastPresence);
    refreshApprovals();
  }

  /* --- Старт --------------------------------------------------------------------------------------- */

  adapter = createHarnessFirebase({ config: BRIDGE_WEB_CONFIG, storage });
  startSession();
  // Единый владелец геометрии iOS (F6.1): монтируется один раз на маршрут,
  // destroy на unmount; Dialog получает onLayout после обновления геометрии.
  viewport = mountHarnessViewport({
    app: document.getElementById('app'),
    root: view,
    onLayout: scheduleDialogLayout,
  });

  return {
    unmount() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      clearSubscriptions();
      if (presenceTimer) {
        clearInterval(presenceTimer);
        presenceTimer = 0;
      }
      if (layoutFrame) {
        cancelAnimationFrame(layoutFrame);
        layoutFrame = 0;
      }
      for (const [target, type, handler, options] of listeners) {
        try {
          target.removeEventListener(type, handler, options);
        } catch (e) { /* снятие слушателя не должно ронять выход */ }
      }
      listeners.length = 0;
      closeDeviceMenu();
      removeAuthPanel();
      if (viewport) {
        viewport.destroy();
        viewport = null;
      }
      approvals.destroy();
      statusNodes.clear();
      feed.commands.clear();
      feed.executions.clear();
      feed.results.clear();
      if (el.pendingChip) el.pendingChip.hidden = true;
      if (el.presence) el.presence.textContent = 'Проверяем связь с ПК…';
      announce('');
    },
  };
}
