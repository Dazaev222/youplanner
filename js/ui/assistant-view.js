// Вкладка «ИИ-Ассистент»: чат с ходом к api.neuraldeep.ru.
//
// Ключ хранится в localStorage устройства (youplanner.api_key) и сознательно
// не входит в STORAGE_KEYS из js/data/storage.js: тот реестр — разделы данных
// для синхронизации и файла копии, а ключ так жизни не должен получать.
// В коде ключа нет — его вводит пользователь в модалке.
//
// История диалога живёт рядом (youplanner.assistant_history): массив
// {role, content}, хвост из 50 сообщений. В запрос уходит системный промпт
// со снимком данных трекера и последние 20 реплик.

import { showToast } from '../core/dom.js';

// Ключ = доступ ассистента к neuraldeep.ru. Имя ключа — часть каркаса:
// следующему заходу менять его нельзя без миграции.
export const ASSISTANT_API_KEY = 'youplanner.api_key';
const ASSISTANT_MODEL_KEY = 'youplanner.assistant_model';
export const ASSISTANT_HISTORY_KEY = 'youplanner.assistant_history';
// OpenAI-совместимый эндпоинт neuraldeep.ru. Список моделей — каталог
// NeuralDeep (llms.txt); модель выбирается в модалке настроек и хранится
// на устройстве (ASSISTANT_MODEL_KEY). Первая в списке — дефолт: она же
// единственная базовая «все тарифы · в РФ».
const ASSISTANT_API_URL = 'https://api.neuraldeep.ru/v1/chat/completions';
export const ASSISTANT_MODELS = [
  { id: 'qwen3.6-35b-a3b', label: 'Qwen 3.6 — базовая (все тарифы)' },
  { id: 'qwen3.8-27b', label: 'Qwen 3.8 — Starter/Pro, зрение' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B — Starter/Pro, вне РФ' },
];
const ASSISTANT_DEFAULT_MODEL = ASSISTANT_MODELS[0].id;
// 60 секунд: длинные ответы reasoning-моделей (qwen/gpt-oss думают вслух)
// не успевали в 30, и запрос рвался по таймауту на «Нет связи»
const REQUEST_TIMEOUT_MS = 60000;
const HISTORY_KEEP = 50;   // сколько реплик хранить на устройстве
const HISTORY_SEND = 20;   // сколько последних реплик уходит в запрос
// Потолок снимка данных трекера в системном промпте. 15 000 символов —
// разумный максимум: «Сводка недели» с богатой историей раньше упиралась
// в меньший лимит, а вместе с PDF-текстом и историей остаётся запас
// до контекста API (256k токенов у qwen)
const CONTEXT_MAX_CHARS = 15000;

export function readAssistantApiKey() {
  try {
    return localStorage.getItem(ASSISTANT_API_KEY);
  } catch (e) {
    return null;
  }
}

// Выбранная модель. Сохранённая вне списка (устаревший кэш после правки
// каталога) откатывается на дефолт — запрос с чужим именем модели даёт 404.
export function readAssistantModel() {
  try {
    const saved = localStorage.getItem(ASSISTANT_MODEL_KEY);
    if (saved && ASSISTANT_MODELS.some(function (m) { return m.id === saved; })) {
      return saved;
    }
  } catch (e) {
    // хранилище недоступно — работает дефолт
  }
  return ASSISTANT_DEFAULT_MODEL;
}

export function onAssistantModelChange() {
  const select = document.getElementById('assistant-model-select');
  if (!select) return;
  const value = readAssistantModel();
  const wanted = select.value;
  if (!ASSISTANT_MODELS.some(function (m) { return m.id === wanted; })) {
    select.value = value;   // чужое значение селекта не сохраняем
    return;
  }
  try {
    localStorage.setItem(ASSISTANT_MODEL_KEY, wanted);
  } catch (e) {
    // модель — расходник: пережить недоступное хранилище можно
  }
  if (wanted !== value) showToast('Модель: ' + wanted);
}

function readHistory() {
  try {
    const raw = localStorage.getItem(ASSISTANT_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string' && m.content.length > 0;
    });
  } catch (e) {
    return [];
  }
}

function pushHistory(role, content) {
  const history = readHistory();
  history.push({ role: role, content: content });
  const tail = history.slice(-HISTORY_KEEP);
  try {
    localStorage.setItem(ASSISTANT_HISTORY_KEY, JSON.stringify(tail));
  } catch (e) {
    // История — расходник: переполнение хранилища не ломает чат
  }
}

// --- Снимок данных трекера для системного промпта ---------------------------
// Каждый раздел читается независимо и с защитой: битый/чужой JSON не должен
// ронять чат. Объекты режутся до разумного размера — промпт не резиновый.

function readSection(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function compact(value, max) {
  try {
    const text = JSON.stringify(value);
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  } catch (e) {
    return '';
  }
}

function lastDays(records, days) {
  if (!records || typeof records !== 'object') return [];
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
    if (records[iso]) out.push(iso + ': ' + compact(records[iso], 400));
  }
  return out;
}

function buildContext() {
  const parts = [];

  const habits = readSection('youplanner.habits');
  if (Array.isArray(habits) && habits.length) {
    parts.push('Привычки: ' + compact(habits.map(function (h) {
      return h && h.name ? h.name + ' (' + (h.type || '?') + (h.goal ? ', цель ' + h.goal : '') + ')' : '';
    }).filter(Boolean), 1200));
  }

  const records = readSection('youplanner.records');
  if (records) {
    const days = lastDays(records, 14);
    if (days.length) parts.push('Записи за 14 дней:\n' + days.join('\n'));
  }

  const qaza = readSection('youplanner.qaza');
  if (qaza) parts.push('Очередь каза-намазов: ' + compact(qaza, 500));
  const qazaLog = readSection('youplanner.qaza.log');
  if (Array.isArray(qazaLog)) {
    parts.push('Журнал выполнений каза: всего ' + qazaLog.length
      + ', последние: ' + compact(qazaLog.slice(-5), 400));
  }
  const fast = readSection('youplanner.qaza.fast');
  if (fast !== null) parts.push('Счётчик уразы: ' + compact(fast, 300));
  const sleep = readSection('youplanner.sleep');
  if (sleep) parts.push('Цикл сна (последние записи): ' + compact(sleep, 800));
  const schedule = readSection('youplanner.schedule');
  if (schedule) parts.push('Расписание дня: ' + compact(schedule, 800));
  const prayer = readSection('youplanner.prayer');
  if (prayer) parts.push('Настройки молитв: ' + compact(prayer, 300));

  return parts.join('\n').slice(0, CONTEXT_MAX_CHARS);
}

function buildMessages() {
  const context = buildContext();
  let system = 'Ты — ИИ-ассистент трекера привычек YouPlanner. Отвечай кратко '
    + 'и по-русски, опираясь на данные пользователя. Если данных нет — так и скажи.\n'
    + (context ? 'Данные пользователя:\n' + context : 'Данных пока нет.');
  // PDF прикрепляется к каждому запросу, пока файл не сброшен: модель отвечает
  // по документу, а история диалога остаётся лёгкой — текст в неё не пишется.
  if (pdfContext) {
    system = 'Вот текст из PDF-файла «' + pdfContext.name + '» (' + pdfContext.pages
      + ' стр.):\n' + pdfContext.text
      + '\n\nОтветь на вопрос пользователя, опираясь на этот текст. '
      + 'Если ответа в тексте нет — так и скажи.\n\n' + system;
  }
  return [{ role: 'system', content: system }].concat(
    readHistory().slice(-HISTORY_SEND)
  );
}

// --- Ход к API ---------------------------------------------------------------
// Успех — строка ответа, любая ошибка — отвергнутый промис с готовым текстом
// для пузыря чата. 401/403 помечены в тексте, чтобы поднять модалку ключа.

// --- PDF-контекст ------------------------------------------------------------
// Текст из PDF живёт в переменной модуля: не в localStorage (переполнение
// хранилища и лишний вес кэша ни к чему), перезагрузка страницы его сбрасывает.
// Прикрепляется к каждому запросу, пока файл не сброшен; в историю диалога
// не попадает — только в системный промпт.
const PDF_MAX_PAGES = 30;        // страницы читаются последовательно, до лимита
const PDF_MAX_CHARS = 50000;     // ~15–20k токенов: не упирается в контекст API
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';

let pdfContext = null;   // { name, pages, text } | null
let pdfParsing = false;
let pdfWorkerUrl = '';   // blob-URL воркера pdf.js, создаётся при первом PDF

export function assistantPdfState() {
  return { name: pdfContext && pdfContext.name, parsing: pdfParsing };
}

export function onAssistantPdfPick() {
  const fileInput = document.getElementById('assistant-pdf-input');
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) return;
  if (pdfParsing) return;   // параллельный разбор не запускаем
  parsePdf(file);
  fileInput.value = '';     // повторный выбор того же файла снова срабатывает
}

function setPdfIndicator(text) {
  const el = document.getElementById('assistant-pdf-indicator');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function resetPdfContext() {
  pdfContext = null;
  setPdfIndicator('');
}// Ранний выход при переполнении: страница читается целиком, но в буфер
// попадает только остаток лимита — память не копит лишнее.
// Счётчик charsUsed считает СИМВОЛЫ: раньше лимит сравнивался с числом
// страниц (buffer.length), никогда не срабатывал, и текст мог уехать в
// запрос далеко за лимитом.
function appendPageText(buffer, pageText, charsUsed) {
  const room = PDF_MAX_CHARS - charsUsed.value;
  if (room <= 0) return false;
  const piece = pageText.length > room ? pageText.slice(0, room) : pageText;
  buffer.push(piece);
  charsUsed.value += piece.length;
  return charsUsed.value < PDF_MAX_CHARS;
}

async function parsePdf(file) {
  pdfParsing = true;
  setPdfIndicator('Читаю ' + file.name + '…');
  try {
    // Динамический import: pdf.js нужен только при выборе файла, старт
    // PWA и офлайн-режим он не утяжеляет.
    const pdfjs = await import(PDFJS_BASE + 'pdf.min.mjs');
    // Воркер с CDN-URL не стартует: cross-origin Worker запрещён, и pdf.js
    // молча висит на getDocument. Код воркера оборачивается в blob URL —
    // он same-origin, и разбор страниц идёт вне UI-потока как положено.
    if (!pdfWorkerUrl) {
      const resp = await fetch(PDFJS_BASE + 'pdf.worker.min.mjs');
      if (!resp.ok) throw new Error('не удалось загрузить pdf.js воркер');
      const code = await resp.text();
      pdfWorkerUrl = URL.createObjectURL(
        new Blob([code], { type: 'text/javascript' }));
    }
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const data = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: data }).promise;
    const buffer = [];
    const charsUsed = { value: 0 };
    let pages = 0;
    for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(function (item) { return item.str; })
        .join(' ').replace(/\s+/g, ' ').trim();
      pages = i;
      if (!appendPageText(buffer, pageText, charsUsed)) {
        page.cleanup();
        break;
      }
      page.cleanup();   // освобождает ресурсы страницы сразу: Safari на
                        // iPhone не держит в памяти весь документ
    }
    const text = buffer.join('\n').trim();
    // Диагностика «читает только обложку»: видно, сколько страниц в файле
    // и сколько реально прочитано и вошло в лимит. До destroy(): у убитого
    // документа numPages уже не прочитать
    console.log('[assistant] PDF ' + file.name + ': страниц в файле ' + doc.numPages
      + ', прочитано ' + pages + ', символов ' + text.length);
    const truncated = pages < doc.numPages || text.length >= PDF_MAX_CHARS;
    await doc.destroy();
    if (!text) {
      resetPdfContext();
      showToast('В PDF не найдено текста — возможно, это сканы');
      return;
    }
    pdfContext = {
      name: file.name,
      pages: pages,
      text: truncated ? text.replace(/\s+\S*$/, '') + ' …[текст обрезан]' : text,
    };
    setPdfIndicator('✕ ' + pdfContext.name + ' · ' + pages + ' стр. — нажмите, чтобы убрать');
    showToast('PDF прочитан: ' + pages + ' стр.');
  } catch (e) {
    console.error('[assistant] разбор PDF не удался:', e);
    resetPdfContext();
    showToast('Не удалось прочитать PDF: ' + (e && e.message ? e.message : 'ошибка'));
  } finally {
    pdfParsing = false;
  }
}

export function onAssistantPdfClear() {
  if (pdfParsing) return;
  if (pdfContext) {
    resetPdfContext();
    showToast('Текст PDF убран из чата');
  }
}

function friendlyError(status) {  if (status === 401 || status === 403) {
    return 'Ключ не принят сервисом (ошибка ' + status
      + '). Проверьте ключ через шестерёнку в шапке.';
  }
  if (status === 429) {
    return 'Сервис отвечает «слишком много запросов» (429). Попробуйте через минуту.';
  }
  if (status >= 500) {
    return 'Сервис нейросети сейчас недоступен (ошибка ' + status + '). Попробуйте позже.';
  }
  return 'Сервис вернул неожиданный ответ (ошибка ' + status + ').';
}

// AbortSignal.timeout появился в Safari только в 15.4: на старых iPhone
// его вызов кидал TypeError, и каждый запрос мгновенно падал в «Нет связи».
// Ручной контроллер работает везде, поэтому подстраховываем им.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(function () { controller.abort(); }, ms);
  return controller.signal;
}

async function requestAssistantReply() {
  let response;
  try {
    response = await fetch(ASSISTANT_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + readAssistantApiKey(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: readAssistantModel(),
        messages: buildMessages(),
      }),
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // Реальная причина — в консоль: TypeError (сеть/CORS/старый API),
    // TimeoutError/AbortError (30 с без ответа) видны только так.
    console.error('[assistant] запрос не дошёл:', e && e.name + ': ' + e.message, e);
    throw new Error(e && e.name === 'TimeoutError'
      ? 'Сервис не ответил за 30 секунд. Попробуйте ещё раз.'
      : 'Нет связи с сервисом нейросети. Подробности — в консоли браузера (F12).');
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch (e) {
      // тело ошибки не прочиталось — статус уже показан ниже
    }
    console.error('[assistant] HTTP ' + response.status, ASSISTANT_API_URL, detail);
    throw new Error(friendlyError(response.status));
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error('Сервис вернул ответ не в формате JSON. Попробуйте позже.');
  }

  const reply = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error('Сервис ответил пустым сообщением. Попробуйте переформулировать вопрос.');
  }
  return reply.trim();
}

// --- Отрисовка ---------------------------------------------------------------

export function renderAssistantView() {
  const hint = document.getElementById('assistant-hint');
  const hasKey = Boolean(readAssistantApiKey());
  if (hint) {
    hint.textContent = hasKey
      ? 'Ключ сохранён на устройстве. Ассистент отвечает по данным трекера.'
      : 'Ключ не задан: введите его, чтобы задавать вопросы.';
  }
  if (hasKey) {
    closeAssistantKeyModal();
  } else {
    openAssistantKeyModal();
  }
  renderHistory();
}

// Приветствие пустого чата: без истории лента — не «белая дыра», а стартовая
// реплика ассистента. В localStorage не пишется и в запросы не попадает.
const ASSISTANT_WELCOME = 'Привет! Я ассистент YouPlanner — отвечаю по данным вашего трекера. Спросите что-нибудь или выберите быструю команду ниже.';

function renderHistory() {
  const chat = document.getElementById('assistant-chat');
  if (!chat) return;
  chat.textContent = '';
  const history = readHistory();
  if (!history.length) {
    appendMessage('bot', ASSISTANT_WELCOME);
    return;
  }
  for (let i = 0; i < history.length; i++) {
    appendMessage(history[i].role === 'user' ? 'user' : 'bot', history[i].content);
  }
}

export function openAssistantKeyModal() {
  const modal = document.getElementById('assistant-key-modal');
  const input = document.getElementById('assistant-key-input');
  const error = document.getElementById('assistant-key-error');
  const select = document.getElementById('assistant-model-select');
  if (!modal) return;
  if (error) error.textContent = '';
  if (input) {
    input.value = readAssistantApiKey() || '';
  }
  if (select) {
    if (!select.options.length) {
      // варианты ставятся один раз: каталог моделей в коде, не в разметке
      for (const m of ASSISTANT_MODELS) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        select.appendChild(opt);
      }
    }
    select.value = readAssistantModel();
  }
  modal.hidden = false;
  if (input) input.focus();
}

export function closeAssistantKeyModal() {
  const modal = document.getElementById('assistant-key-modal');
  if (modal) modal.hidden = true;
}

// Escape закрывает модалку ключа — как нативные alert iOS. Состояние читается
// в момент нажатия, поэтому один обработчик на document живёт вечно.
export function onAssistantKeyKeydown(event) {
  if (event.key !== 'Escape') return;
  const modal = document.getElementById('assistant-key-modal');
  if (modal && !modal.hidden) closeAssistantKeyModal();
}

// Сохранение ключа: пустая строка ключом не считается — это «ключа нет»,
// как и у уразы, где ноль и отсутствие счётчика различаются сознательно.
export function onAssistantKeySave() {
  const input = document.getElementById('assistant-key-input');
  const error = document.getElementById('assistant-key-error');
  const value = input ? input.value.trim() : '';
  if (!value) {
    if (error) error.textContent = 'Введите ключ или закройте окно кнопкой «Отмена».';
    return;
  }
  try {
    localStorage.setItem(ASSISTANT_API_KEY, value);
  } catch (e) {
    if (error) error.textContent = 'Браузер не дал сохранить ключ: память недоступна.';
    return;
  }
  closeAssistantKeyModal();
  renderAssistantView();
  showToast('Ключ сохранён на устройстве');
}

export function onAssistantKeyCancel() {
  closeAssistantKeyModal();
}

// Очистка истории: действие необратимое, поэтому с подтверждением.
export function onAssistantClear() {
  if (!readHistory().length) {
    showToast('История и так пуста');
    return;
  }
  if (!confirm('Очистить историю диалога с ассистентом?')) return;
  try {
    localStorage.removeItem(ASSISTANT_HISTORY_KEY);
  } catch (e) {
    // не критично: пустая история дорисуется при следующем входе
  }
  renderHistory();
  showToast('История очищена');
}

// Пузырь в ленте. Текст кладётся через textContent: реплики пользователя и
// ответы модели не должны превращаться в разметку (защита от XSS).
function appendMessage(kind, text) {
  const chat = document.getElementById('assistant-chat');
  if (!chat) return null;
  const msg = document.createElement('div');
  msg.className = 'assistant-msg assistant-msg-' + kind;
  msg.textContent = text;
  chat.appendChild(msg);
  msg.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return msg;
}

function appendUserMessage(text) {
  return appendMessage('user', text);
}

// Точка входа и для формы, и для чипов: у чипа текст сообщения лежит
// в data-chip, у формы — в поле ввода.
// Пока идёт запрос к API, новый не отпускается: кнопки гасятся (анти-спам,
// иначе быстрые повторные вопросы ловили 429), а Enter игнорится флагом.
let assistantBusy = false;

function setAssistantBusy(busy) {
  assistantBusy = busy;
  const input = document.getElementById('assistant-input');
  const send = document.getElementById('assistant-send');
  const pdfBtn = document.getElementById('assistant-pdf-btn');
  if (input) input.disabled = busy;
  if (send) send.disabled = busy;
  if (pdfBtn) pdfBtn.classList.toggle('is-disabled', busy);
}

export function onAssistantSubmit(text) {
  const message = String(text || '').trim();
  if (!message || assistantBusy) return;
  appendUserMessage(message);
  pushHistory('user', message);
  if (!readAssistantApiKey()) {
    openAssistantKeyModal();
    return;
  }
  runAssistantReply();
}

async function runAssistantReply() {
  const typing = appendMessage('bot', 'Печатает…');
  if (typing) typing.classList.add('is-typing');
  setAssistantBusy(true);
  let reply = null;
  let error = null;
  try {
    reply = await requestAssistantReply();
  } catch (e) {
    // Ошибка не пишется в историю: это не реплика ассистента
    error = e;
  } finally {
    // finally: индикатор гасится при любом исходе — успех, 401, 500,
    // таймаут или неожиданное исключение. Раньше подвисал «Печатает…»,
    // если сбой случался между catch и снятием класса
    if (typing) {
      typing.classList.remove('is-typing');
      if (error) {
        typing.classList.add('is-error');
        typing.textContent = error.message;
      } else {
        typing.textContent = reply;
      }
    }
    setAssistantBusy(false);
  }
  if (error) {
    if (String(error.message).indexOf('Ключ не принят') === 0) {
      openAssistantKeyModal();
    }
    return;
  }
  pushHistory('assistant', reply);
}

// Обработчик формы: гасит перезагрузку и чистит поле.
export function onAssistantFormSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('assistant-input');
  if (!input) return;
  onAssistantSubmit(input.value);
  input.value = '';
}

// Чипы делегированы по контейнеру: текст команды — в data-chip.
export function onAssistantChipClick(event) {
  const chip = event.target.closest('.assistant-chip');
  if (!chip) return;
  onAssistantSubmit(chip.getAttribute('data-chip'));
}
