// Вкладка «ИИ-Ассистент»: чат с ходом к api.neuraldeep.ru.
//
// С этапа D.5 файл — оркестратор экрана: состояние (ключ/модель/история),
// рендер ленты, модалка ключа и обработчики. Подсистемы вынесены в модули:
// js/ui/assistant-pdf.js — чтение PDF и умная нарезка,
// js/ui/assistant-vision.js — фото в чате,
// js/ui/assistant-api.js — HTTP-клиент (fetch с таймаутом).
// Публичная поверхность файла не менялась: app.js и тесты импортируют отсюда.
//
// Ключ хранится в localStorage устройства (youplanner.api_key) и сознательно
// не входит в STORAGE_KEYS из js/data/storage.js: тот реестр — разделы данных
// для синхронизации и файла копии, а ключ так жизни не должен получать.
// В коде ключа нет — его вводит пользователь в модалке.
//
// История диалога живёт рядом (youplanner.assistant_history): массив
// {role, content}, хвост из 50 сообщений. В запрос уходит системный промпт
// со снимком данных трекера и последние 20 реплик.

import { showErrorToast, showToast } from '../core/dom.js';
import { FAST_KEY } from '../data/fast.js';
import { PRAYER_KEY } from '../data/prayer.js';
import { QAZA_LOG_KEY, QAZA_STORAGE_KEY } from '../data/qaza.js';
import { SLEEP_KEY } from '../data/sleep.js';
import { STORAGE_KEYS } from '../data/storage.js';
import { postAssistantChat } from './assistant-api.js';
import {
  PDF_MAX_CHARS,
  getPdfContext,
  isPdfParsing,
  parsePdf,
  resetPdfContext,
  selectPdfChunks,
} from './assistant-pdf.js';
import {
  assistantWithVisionAttachments,
  clearImageContext,
  compressChatImages,
  getImageContext,
  isImageCompressing,
  updateImageIndicator,
} from './assistant-vision.js';

// Ключ = доступ ассистента к neuraldeep.ru. Имя ключа — часть каркаса:
// следующему заходу менять его нельзя без миграции.
export const ASSISTANT_API_KEY = 'youplanner.api_key';
const ASSISTANT_MODEL_KEY = 'youplanner.assistant_model';
export const ASSISTANT_HISTORY_KEY = 'youplanner.assistant_history';
// Каталог моделей NeuralDeep: модель выбирается в модалке настроек и хранится
// на устройстве (ASSISTANT_MODEL_KEY). Первая в списке — дефолт: она же
// единственная базовая «все тарифы · в РФ».
export const ASSISTANT_MODELS = [
  { id: 'qwen3.6-35b-a3b', label: 'Qwen 3.6 — базовая (все тарифы)', vision: true },
  { id: 'qwen3.8-27b', label: 'Qwen 3.8 — Starter/Pro, зрение', vision: true },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B — Starter/Pro, вне РФ' },
];
const ASSISTANT_DEFAULT_MODEL = ASSISTANT_MODELS[0].id;
const HISTORY_KEEP = 50;   // сколько реплик хранить на устройстве
const HISTORY_SEND = 20;   // сколько последних реплик уходит в запрос
// Потолок снимка данных трекера в системном промпте. 20 000 символов:
// «Сводка недели» с богатой историей раньше упиралась в меньший лимит,
// а вместе с PDF-текстом и историей остаётся запас до контекста API
// (256k токенов у qwen)
const CONTEXT_MAX_CHARS = 20000;

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

// Принимает ли модель изображения. Чистая функция: проверяется тестами.
// Правило из баг-репорта iPhone (2026-10-31): всё семейство qwen — со зрением.
// Каталог сверяется первым: явный флаг сильнее; модели вне каталога (кэш с
// устройства после правки списка — например qwen3.6f.p) распознаются
// по префиксу семейства.
export function assistantModelSupportsVision(modelId) {
  for (let i = 0; i < ASSISTANT_MODELS.length; i++) {
    if (ASSISTANT_MODELS[i].id === modelId) {
      return ASSISTANT_MODELS[i].vision === true;
    }
  }
  return typeof modelId === 'string'
    && modelId.slice(0, 4).toLowerCase() === 'qwen';
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

// Разделы снимка берутся поимённо из реестров ключей (STORAGE_KEYS и
// константы доменных модулей): строки те же, но расхождение с доменом
// теперь поймает компилятор/тесты, а не пользователь.
function buildContext() {
  const parts = [];

  const habits = readSection(STORAGE_KEYS.habits);
  if (Array.isArray(habits) && habits.length) {
    parts.push('Привычки: ' + compact(habits.map(function (h) {
      return h && h.name ? h.name + ' (' + (h.type || '?') + (h.goal ? ', цель ' + h.goal : '') + ')' : '';
    }).filter(Boolean), 1200));
  }

  const records = readSection(STORAGE_KEYS.records);
  if (records) {
    const days = lastDays(records, 14);
    if (days.length) parts.push('Записи за 14 дней:\n' + days.join('\n'));
  }

  const qaza = readSection(QAZA_STORAGE_KEY);
  if (qaza) parts.push('Очередь каза-намазов: ' + compact(qaza, 500));
  const qazaLog = readSection(QAZA_LOG_KEY);
  if (Array.isArray(qazaLog)) {
    parts.push('Журнал выполнений каза: всего ' + qazaLog.length
      + ', последние: ' + compact(qazaLog.slice(-5), 400));
  }
  const fast = readSection(FAST_KEY);
  if (fast !== null) parts.push('Счётчик уразы: ' + compact(fast, 300));
  const sleep = readSection(SLEEP_KEY);
  if (sleep) parts.push('Цикл сна (последние записи): ' + compact(sleep, 800));
  const schedule = readSection(STORAGE_KEYS.schedule);
  if (schedule) parts.push('Расписание дня: ' + compact(schedule, 800));
  const prayer = readSection(PRAYER_KEY);
  if (prayer) parts.push('Настройки молитв: ' + compact(prayer, 300));

  return parts.join('\n').slice(0, CONTEXT_MAX_CHARS);
}

// Последний вопрос пользователя из истории: по нему ищутся фрагменты PDF.
// В истории его нет (старт чата) — пустая строка, отбор уходит в фолбэк:
// равномерная выборка по всей книге.
function lastUserQuestion() {
  const history = readHistory();
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return history[i].content;
  }
  return '';
}

function buildMessages() {
  const context = buildContext();
  let system = 'Ты — ИИ-ассистент трекера привычек YouPlanner. Отвечай кратко '
    + 'и по-русски, опираясь на данные пользователя. Если данных нет — так и скажи.\n'
    + (context ? 'Данные пользователя:\n' + context : 'Данных пока нет.');
  // PDF прикрепляется к каждому запросу, пока файл не сброшен: модель отвечает
  // по документу, а история диалога остаётся лёгкой — текст в неё не пишется.
  // Длинный документ уходит фрагментами, отобранными по последнему вопросу:
  // весь текст не влезает в бюджет запроса, а нужное место модель видит.
  const pdf = getPdfContext();
  if (pdf) {
    if (pdf.chunks) {
      const selected = selectPdfChunks(lastUserQuestion(), pdf.chunks, PDF_MAX_CHARS);
      system = 'Вот фрагменты длинного документа «' + pdf.name + '» ('
        + pdf.pages + ' стр.), отобранные по вопросу пользователя:\n' + selected
        + '\n\nОтветь на вопрос пользователя, опираясь на эти фрагменты. '
        + 'Если ответа в них нет — так и скажи, не выдумывай.\n\n' + system;
    } else {
      system = 'Вот текст из PDF-файла «' + pdf.name + '» (' + pdf.pages
        + ' стр.):\n' + pdf.text
        + '\n\nОтветь на вопрос пользователя, опираясь на этот текст. '
        + 'Если ответа в тексте нет — так и скажи.\n\n' + system;
    }
  }
  // Фото прикрепляются по семантике PDF: к каждому запросу, пока не убраны
  // вручную (уточняющие вопросы видят то же фото). История остаётся текстовой.
  const images = getImageContext();
  if (images && images.length) {
    system = 'Пользователь приложил к вопросу фото ('
      + images.length + ' шт.): рассмотрите их и опирайтесь на них в ответе.\n\n' + system;
  }
  return withVisionAttachments(
    [{ role: 'system', content: system }].concat(readHistory().slice(-HISTORY_SEND)),
    images
  );
}

// Реэкспорт чистой vision-функции под прежним именем: публичная поверхность
// assistant-view.js не меняется (tests/assistant-vision.test.mjs импортирует
// отсюда), реализация живёт в js/ui/assistant-vision.js.
export function withVisionAttachments(messages, images) {
  return assistantWithVisionAttachments(messages, images);
}

// Снимок выбранных файлов в обычный массив. Обязателен ДО сброса input.value:
// присвоение пустой строки опустошает список выбранных файлов (спека HTML,
// files — SameObject), и живой FileList в руках обработчика становился
// пустым — камера «молчала» на любом устройстве (баг-репорт iPhone,
// 2026-10-31: «нажимаю Готово — ничего не происходит»). Чистая функция:
// проверяется тестами на массивоподобном объекте.
export function snapshotPickedFiles(fileList) {
  if (!fileList) return [];
  return Array.prototype.slice.call(fileList);
}

export function onAssistantImagePick() {
  const input = document.getElementById('assistant-image-input');
  const picked = snapshotPickedFiles(input && input.files);
  // Сброс значения — как у PDF: иначе повторный выбор того же файла не
  // стреляет change, и камера кажется сломанной
  if (input) input.value = '';
  if (!picked.length) {
    console.warn('[vision] change пришёл, но файлов в input нет — ' +
      'выбор прерван до начала');
    return;
  }
  const names = picked.map(function (f) { return f.name; }).join(', ');
  console.log('[vision] выбрано файлов: ' + picked.length + ' (' + names + ')'
    + '; модель: ' + readAssistantModel()
    + ', зрение: ' + assistantModelSupportsVision(readAssistantModel()));
  if (isImageCompressing()) {
    console.warn('[vision] предыдущее сжатие ещё идёт — выбор пропущен');
    return;
  }
  compressChatImages(picked, updateAssistantControls);
}

export function onAssistantImageClear() {
  if (isImageCompressing()) return;
  if (clearImageContext()) {
    showToast('Фото убраны из чата');
  }
}

export function onAssistantPdfPick() {
  const fileInput = document.getElementById('assistant-pdf-input');
  const file = fileInput && fileInput.files && fileInput.files[0];
  // Сброс значения — в любом пути, включая «занят»: иначе повторный выбор того
  // же файла не стреляет change, и скрепка кажется сломанной
  if (fileInput) fileInput.value = '';
  if (!file) return;
  if (isPdfParsing()) return;   // параллельный разбор не запускаем
  parsePdf(file, updateAssistantControls);
}

export function onAssistantPdfClear() {
  if (isPdfParsing()) return;
  if (getPdfContext()) {
    resetPdfContext();
    showToast('Текст PDF убран из чата');
  }
}

// --- Ход к API ---------------------------------------------------------------
// Тонкая обёртка сохраняет прежнее имя и нулевую сигнатуру: payload
// ({model, messages}) собирается из состояния ассистента, ключ читается
// с устройства, сам HTTP ход — в js/ui/assistant-api.js (postAssistantChat).
async function requestAssistantReply() {
  return postAssistantChat(
    { model: readAssistantModel(), messages: buildMessages() },
    readAssistantApiKey()
  );
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
  bindViewportDockFix();
  // Чип фото живёт пока прикреплены снимки: переменная модуля переживает
  // уход с вкладки и обратно
  updateImageIndicator();
  renderHistory();
}

// --- Клавиатура iOS: док над системной панелью навигации --------------------
// iPhone (баг-репорт 2026-10-31): iOS при открытии клавиатуры НЕ уменьшает
// layout viewport — клавиатура вместе с системной панелью (стрелки вверх/
// вниз, галочка) просто наезжает на нижнюю часть экрана и перекрывает док.
// window.visualViewport даёт видимую область: перекрытие низа — это
// innerHeight минус высота и смещение визуального вьюпорта. На эту величину
// поднимается весь экран ассистента (margin-bottom в flex-колонке #app):
// лента и док остаются видимы, шапка не сдвигается. При закрытой клавиатуре
// перекрытие нулевое — инлайн-стиль снимается, safe-area CSS возвращается.
//
// Тот же overlap ведёт класс body.keyboard-open для CSS (mobile.css): он
// прячет плавающий таб-бар и снимает запас под него (84px + safe-area),
// иначе док зависает над клавиатурой с пустой дырой. Порог с гистерезисом:
// «шум» вьюпорта (сворачивание панели Safari и т.п.) даёт перекрытие до
// ~100px, самая низкая программная клавиатура (iPhone в landscape) — от
// ~200px. На Android класс сам не включается: там окно при клавиатуре
// сжимается целиком, innerHeight догоняет visualViewport и overlap
// остаётся около нуля.
let viewportBound = false;
const KEYBOARD_OPEN_AT = 120;    // перекрытие, с которого клавиатура считается открытой
const KEYBOARD_CLOSE_BELOW = 60; // ниже — закрытой (гистерезис от дребезга)
function bindViewportDockFix() {
  if (viewportBound) return;
  const viewport = window.visualViewport;
  if (!viewport) return;   // старые браузеры без API — живут как раньше
  viewportBound = true;
  let lastOverlap = -1;
  let keyboardOpen = false;
  const apply = function () {
    const overlap = Math.round(Math.max(0,
      window.innerHeight - viewport.height - viewport.offsetTop));
    if (overlap === lastOverlap) return;
    lastOverlap = overlap;
    // Состояние клавиатуры — факт вьюпорта, а не экрана ассистента: класс
    // ставится на body безотносительно наличия #assistant-view, CSS от него
    // нейтрален (правила только для телефона и внутри view-экранов)
    if (!keyboardOpen && overlap >= KEYBOARD_OPEN_AT) {
      keyboardOpen = true;
      document.body.classList.add('keyboard-open');
    } else if (keyboardOpen && overlap < KEYBOARD_CLOSE_BELOW) {
      keyboardOpen = false;
      document.body.classList.remove('keyboard-open');
    }
    const view = document.getElementById('assistant-view');
    if (!view) return;
    view.style.marginBottom = overlap > 0 ? overlap + 'px' : '';
  };
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
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
    reattachTyping(chat);
    return;
  }
  for (let i = 0; i < history.length; i++) {
    appendMessage(history[i].role === 'user' ? 'user' : 'bot', history[i].content, true);
  }
  reattachTyping(chat);
  // Одна прокрутка в конец вместо плавной на каждый пузырь
  chat.scrollTop = chat.scrollHeight;
}

// Живой узел «Печатает…» между перерисовками ленты. Перерисовка (textContent
// = '') отрывает его: ответ запроса в полёте записался бы в отсоединённый
// узел и остался бы невидимым, а экран выглядел бы зависшим — assistantBusy
// держит кнопку погашенной до завершения запроса.
let typingNode = null;

// Перерисовка при busy: typing-узел перепрыгивает на свежую ленту — ссылка
// в runAssistantReply остаётся боевой, ответ допишется в видимый пузырь.
// Приветствие не ломается: оно рисуется как обычно, typing возвращается
// последним — индикатор и обязан быть нижним пузырём.
function reattachTyping(chat) {
  if (!assistantBusy || !typingNode) return;
  chat.appendChild(typingNode);
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

// Escape для модалки ключа обрабатывает общий послойный обработчик в app.js:
// у всех окон один жест «верхнее — первым», а не два независимых обработчика,
// закрывавших две модалки одним нажатием.

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
  // Инвалидация in-flight: ответ запроса, начатого до очистки, в историю
  // уже не пишется (см. assistantGeneration в runAssistantReply). Сам пузырь
  // в текущей сессии остаётся — перерисовка ниже вернёт typing-узел в ленту.
  assistantGeneration += 1;
  renderHistory();
  showToast('История очищена');
}

// Пузырь в ленте. Текст кладётся через textContent: реплики пользователя и
// ответы модели не должны превращаться в разметку (защита от XSS).
function appendMessage(kind, text, silent) {
  const chat = document.getElementById('assistant-chat');
  if (!chat) return null;
  const msg = document.createElement('div');
  msg.className = 'assistant-msg assistant-msg-' + kind;
  msg.textContent = text;
  chat.appendChild(msg);
  // silent=true: перерисовка истории скроллит ленту один раз в конце,
  // а не дёргает плавный скролл на каждом из десятков пузырей
  if (!silent) msg.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return msg;
}

function appendUserMessage(text, images) {
  const chat = document.getElementById('assistant-chat');
  if (!chat) return null;
  const msg = document.createElement('div');
  msg.className = 'assistant-msg assistant-msg-user';
  // Фото — уменьшенные копии прикреплённых файлов: dataUrl уже сжат до
  // ≤1568 px по длинной стороне, отдельного ресайза не нужно. Текст —
  // текстовым узлом: реплики пользователя не должны превращаться в разметку.
  if (images && images.length) {
    for (let i = 0; i < images.length; i++) {
      const photo = document.createElement('img');
      photo.className = 'assistant-msg-photo';
      photo.src = images[i].dataUrl;
      photo.alt = 'Прикреплённое фото: ' + images[i].name;
      msg.appendChild(photo);
    }
  }
  msg.appendChild(document.createTextNode(text));
  chat.appendChild(msg);
  msg.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return msg;
}

// Точка входа и для формы, и для чипов: у чипа текст сообщения лежит
// в data-chip, у формы — в поле ввода.
// Пока идёт запрос к API, новый не отпускается: кнопки гасятся (анти-спам,
// иначе быстрые повторные вопросы ловили 429), а Enter игнорится флагом.
let assistantBusy = false;

// Поколение сессии чата. «Очистить историю» сдвигает его: запрос, начатый
// до очистки, при завершении показывается в текущей ленте (typing-узел),
// но в историю не пишется — иначе «очищенная» история получила бы
// запоздавшую реплику этого запроса.
let assistantGeneration = 0;

// Один источник правды для состояния кнопок. Гасит отправку и скрепку и на
// время запроса, и на время разбора PDF: раньше вопрос, отправленный пока
// большой PDF ещё читался, уходил в API вообще без текста файла — модель
// честно отвечала «в отрывке нет содержания». Ввод текста при разборе PDF
// остаётся доступным: печатать можно, отправится после.
function updateAssistantControls() {
  const input = document.getElementById('assistant-input');
  const send = document.getElementById('assistant-send');
  const pdfBtn = document.getElementById('assistant-pdf-btn');
  const imageBtn = document.getElementById('assistant-image-btn');
  const blocked = assistantBusy || isPdfParsing() || isImageCompressing();
  if (input) input.disabled = assistantBusy;
  if (send) send.disabled = blocked;
  if (pdfBtn) pdfBtn.classList.toggle('is-disabled', blocked);
  if (imageBtn) imageBtn.classList.toggle('is-disabled', blocked);
}

function setAssistantBusy(busy) {
  assistantBusy = busy;
  updateAssistantControls();
}

// false — отправка не состоялась (занято/читается PDF/сжимается фото/нет
// ключа), поле не чистится
export function onAssistantSubmit(text) {
  const message = String(text || '').trim();
  if (!message) return false;
  if (isPdfParsing()) {
    showErrorToast('PDF ещё читается — повторите отправку через пару секунд');
    return false;
  }
  if (isImageCompressing()) {
    showErrorToast('Фото ещё сжимается — повторите отправку через секунду');
    return false;
  }
  if (assistantBusy) return false;
  // Ключ проверяется ДО приёма реплики: без него запрос всё равно не уйдёт,
  // а вопрос, осевший в истории, пришлось бы повторять после ввода ключа
  if (!readAssistantApiKey()) {
    showErrorToast('Сначала сохраните API-ключ — окно уже открыто');
    openAssistantKeyModal();
    return false;
  }
  const attached = getImageContext();
  const images = attached ? attached.slice() : [];
  // Фото при модели без зрения не отправляются вовсе: API ответил бы
  // непонятной ошибкой. Модалка модели уже открыта — переключение рядом.
  if (images.length && !assistantModelSupportsVision(readAssistantModel())) {
    console.warn('[vision] отправка отсечена: модель без зрения — '
      + readAssistantModel());
    showErrorToast('Текущая модель не принимает изображения — переключитесь '
      + 'на Qwen (шестерёнка в шапке)');
    openAssistantKeyModal();
    return false;
  }
  const names = images.map(function (img) { return img.name; }).join(', ');
  appendUserMessage(message, images);
  // В историю — только текст: маркер [фото: …] оставляет диалог читаемым
  // и на следующих репликах напоминает модели про приложенные снимки
  pushHistory('user', names ? message + '\n[фото: ' + names + ']' : message);
  runAssistantReply();
  return true;
}

async function runAssistantReply() {
  typingNode = appendMessage('bot', 'Печатает…');
  if (typingNode) typingNode.classList.add('is-typing');
  setAssistantBusy(true);
  let reply = null;
  let error = null;
  // Поколение на старте запроса: очистка истории посреди полёта сдвинет
  // счётчик, и разница будет видна ниже
  const generation = assistantGeneration;
  try {
    reply = await requestAssistantReply();
  } catch (e) {
    // Ошибка не пишется в историю: это не реплика ассистента
    error = e;
  } finally {
    // finally: индикатор гасится при любом исходе — успех, 401, 500,
    // таймаут или неожиданное исключение. Раньше подвисал «Печатает…»,
    // если сбой случался между catch и снятием класса
    const typing = typingNode;
    typingNode = null;
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
  // Пузырь уже показан в ленте (typing-узел выше); в историю ответ пишется,
  // только если история не очищалась, пока запрос был в полёте
  if (generation === assistantGeneration) pushHistory('assistant', reply);
}

// Обработчик формы: гасит перезагрузку; чистит поле только после принятой
// отправки — блокировка (читается PDF / идёт запрос) текст не теряет
export function onAssistantFormSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('assistant-input');
  if (!input) return;
  if (onAssistantSubmit(input.value)) input.value = '';
}

// Чипы делегированы по контейнеру: текст команды — в data-chip.
export function onAssistantChipClick(event) {
  const chip = event.target.closest('.assistant-chip');
  if (!chip) return;
  onAssistantSubmit(chip.getAttribute('data-chip'));
}
