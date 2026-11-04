// Вкладка «ИИ-Ассистент»: чат с ходом к api.neuraldeep.ru.
//
// С этапа D.5 файл — оркестратор экрана: состояние (ключ/модель/история/
// персонализация), рендер ленты, модалка настроек и обработчики. Подсистемы
// вынесены в модули: js/ui/assistant-pdf.js — чтение PDF, умная нарезка и
// скан-фолбэк (страницы скана рендерятся в картинки и уходят в Vision как
// фото), js/ui/assistant-media.js — фото в чате и HTTP-клиент (fetch с
// таймаутом; слито из assistant-vision.js и assistant-api.js, этап Y1).
// Публичная поверхность файла не менялась: app.js и тесты импортируют отсюда.
//
// Ключ хранится в localStorage устройства (youplanner.api_key) и сознательно
// не входит в STORAGE_KEYS из js/data/storage.js: тот реестр — разделы данных
// для синхронизации и файла копии, а ключ так жизни не должен получать.
// В коде ключа нет — его вводит пользователь в модалке.
//
// Рядом с ключом живёт персонализация (youplanner.assistant_persona): JSON
// {instructions, contextDays, temperature, maxTokens, shiftEnter} из модалки
// «Настройки ассистента». В STORAGE_KEYS она не входит по той же причине,
// что и ключ: это настройка конкретного устройства и конкретной нейросети,
// а не данные трекера — синхронизировать и копировать в файл бэкапа её
// не нужно (как и ключ, она не должна уезжать на другой аккаунт).
//
// История диалога живёт рядом (youplanner.assistant_history): массив
// {role, content}, хвост из 50 сообщений. В запрос уходит системный промпт
// (первая фраза → инструкции пользователя → снимок данных трекера) и
// последние 20 реплик; генерацию ограничивают temperature и max_tokens
// из персонализации.

import { showErrorToast, showToast } from '../core/dom.js';
import { FAST_KEY } from '../data/fast.js';
import { PRAYER_KEY } from '../data/prayer.js';
import { QAZA_LOG_KEY, QAZA_STORAGE_KEY } from '../data/qaza.js';
import { SLEEP_KEY } from '../data/sleep.js';
import { STORAGE_KEYS } from '../data/storage.js';
import { isHeaderSafeKey, postAssistantChat } from './assistant-media.js';
import { buildHabitsAnalysisRequest } from './assistant-analysis.js';
import {
  PDF_MAX_CHARS,
  getPdfContext,
  getPdfPageImages,
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
} from './assistant-media.js';

// Ключ = доступ ассистента к neuraldeep.ru. Имя ключа — часть каркаса:
// следующему заходу менять его нельзя без миграции.
export const ASSISTANT_API_KEY = 'youplanner.api_key';
const ASSISTANT_MODEL_KEY = 'youplanner.assistant_model';
export const ASSISTANT_HISTORY_KEY = 'youplanner.assistant_history';
// Персонализация ассистента — поведенческие настройки из модалки «Настройки
// ассистента» (см. комментарий в шапке файла, почему ключа нет в STORAGE_KEYS).
export const ASSISTANT_PERSONA_KEY = 'youplanner.assistant_persona';
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

// --- Персонализация ассистента ------------------------------------------------
// Дефолты каждого поля продублированы в тестах: это контракт модалки.
// instructions — текст в системный промпт (пустой блок не попадает),
// contextDays — окно записей в снимке данных, temperature/max_tokens —
// параметры генерации в payload (OpenAI-совместимый snake_case для лимита),
// shiftEnter — разрешить перенос строки по Shift+Enter в поле ввода.
const PERSONA_DEFAULTS = {
  instructions: '',
  contextDays: 14,
  temperature: 0.3,
  maxTokens: 1000,
  shiftEnter: false,
};
const PERSONA_INSTRUCTIONS_MAX = 2000;   // инструкции не должны раздувать промпт

// Читатель одного поля с откатом на дефолт: тип/диапазон не сошлись — поле
// мусорное, берём дефолт и НЕ роняем соседние поля (валидация по-полевая,
// как обещано в контракте readAssistantPersona).
function personaInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return value >= min && value <= max ? value : fallback;
}

function personaNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value >= min && value <= max ? value : fallback;
}

function personaInstructions(value) {
  if (typeof value !== 'string') return PERSONA_DEFAULTS.instructions;
  // Невидимые символы (zero-width, BOM, слово-разделители) — мусор
  // копирования из веба: в промпт они не добавляют смысла, но выдают себя
  // за «непустые» инструкции. Вычищаются до трима, и у нормального текста
  // тоже — по краям и внутри.
  const cleaned = value.replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  const trimmed = cleaned.trim();
  return trimmed.slice(0, PERSONA_INSTRUCTIONS_MAX);
}

// Единая нормализация записи персонализации: и чтение из хранилища, и сбор
// с контролов модалки прогоняются через одни и те же проверки — мусор в
// localStorage и кривое значение слайдера не могут дать разное поведение.
function normalizeAssistantPersona(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    instructions: personaInstructions(source.instructions),
    contextDays: personaInt(source.contextDays, 2, 30, PERSONA_DEFAULTS.contextDays),
    temperature: personaNumber(source.temperature, 0, 1, PERSONA_DEFAULTS.temperature),
    maxTokens: personaInt(source.maxTokens, 100, 4000, PERSONA_DEFAULTS.maxTokens),
    shiftEnter: source.shiftEnter === true,
  };
}

// Чтение персонализации с устройства. Битый JSON и отсутствие записи дают
// объект целиком из дефолтов; частично битая запись теряет только битые поля.
export function readAssistantPersona() {
  try {
    const raw = localStorage.getItem(ASSISTANT_PERSONA_KEY);
    return normalizeAssistantPersona(raw ? JSON.parse(raw) : {});
  } catch (e) {
    // хранилище недоступно или JSON битый — работают дефолты по каждому полю
    return normalizeAssistantPersona({});
  }
}

// Русское склонение слова «день» для подписи слайдера и заголовка снимка:
// диапазон слайдера 2..30, но «2 дней» читать стыдно.
function assistantPluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

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
    return -1;
  }
  // Индекс реплики в сохранённом массиве: он всегда последний, и по нему
  // пузырь ленты получает кнопку удаления (см. markBubbleDeletable). -1 —
  // запись не состоялась, кнопки быть не должно: удалять нечего, а индекс
  // несостоявшейся реплики срезал бы соседа
  return tail.length - 1;
}

// --- Удаление одной реплики ------------------------------------------------
// Пузырь ленты, которому есть что удалять: индекс в истории кладётся на узел,
// а не выводится из порядка детей. Узы, которых в истории нет (приветствие
// пустого чата, «Печатает…», пузырь ошибки хода к API), индекса не получают
// и кнопки не показывают: кнопка без цели была бы обещанием, которое не
// выполняется, и удаление по позиции молча срезало бы соседнюю реплику,
// стоит ленте разойтись с хранилищем
function markBubbleDeletable(node, index) {
  if (!node || typeof node.setAttribute !== 'function') return null;
  if (!(index >= 0)) return null;
  node.setAttribute('data-msg-index', String(index));
  const button = document.createElement('button');
  // type=button обязателен: лента живёт внутри #assistant-form, и кнопка без
  // типа стала бы submit-ом — тап по «удалить» отправил бы ещё и реплику
  button.type = 'button';
  button.className = 'assistant-msg-del';
  button.setAttribute('aria-label', 'Удалить сообщение');
  button.textContent = '✕';
  node.appendChild(button);
  return node;
}

// Делегирование по ленте: слушатель один на #assistant-chat, а пузырей
// десятки и перерисовываются они часто — вешать обработчик на каждый значило
// бы копить замыкания на узлах, которые уже отброшены
export function onAssistantChatClick(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== 'function') return;
  const button = target.closest('.assistant-msg-del');
  if (!button) return;
  const bubble = button.closest('.assistant-msg');
  if (!bubble || typeof bubble.getAttribute !== 'function') return;
  const index = Number(bubble.getAttribute('data-msg-index'));
  if (!Number.isInteger(index) || index < 0) return;
  askAssistantDelete(index);
}

// Лист подтверждения удаления — та же шторка приложения, что и попап уровня
// (styles/sheets.css): на телефоне панель приходит снизу, на ПК садится по
// центру. Централизованной модалки здесь нет намеренно: в проекте уже есть
// нижние листы, и второй способ спрашивать подтверждение был бы третья
// дорога, по которой пользователь спотыкается
let assistantDeleteIndex = null;

export function isAssistantDeleteSheetOpen() {
  const sheet = document.getElementById('assistant-delete-sheet');
  return !!sheet && !sheet.hidden;
}

export function askAssistantDelete(index) {
  const sheet = document.getElementById('assistant-delete-sheet');
  if (!sheet) return false;
  const history = readHistory();
  const entry = history[index];
  // Индекс мог устареть (лента не перерисована после очистки/другого
  // удаления): ничего не удаляем и не закрываем то, что не открывали
  if (!entry) {
    showToast('Это сообщение уже удалено');
    return false;
  }
  const preview = document.getElementById('assistant-delete-preview');
  if (preview) {
    // textContent, не innerHTML: реплика — пользовательский текст, и в
    // превью листе он не должен становиться разметкой (см. tests/xss.test.mjs)
    preview.textContent = entry.content;
  }
  const role = document.getElementById('assistant-delete-role');
  if (role) role.textContent = entry.role === 'user' ? 'Ваш вопрос' : 'Ответ ассистента';
  assistantDeleteIndex = index;
  sheet.hidden = false;
  return true;
}

export function closeAssistantDeleteSheet() {
  const sheet = document.getElementById('assistant-delete-sheet');
  if (sheet) sheet.hidden = true;
  assistantDeleteIndex = null;
}

export function confirmAssistantDelete() {
  const index = assistantDeleteIndex;
  closeAssistantDeleteSheet();
  if (index === null) return false;
  return removeHistoryAt(index);
}

// Вырезает ОДНУ реплику из хранилища и перерисовывает ленту. Массив
// перечитывается через readHistory — те же фильтры и та же отсечка, что у
// записи; HISTORY_KEEP здесь не применяется: список только что пришёл из
// readHistory и длиннее лимита быть не может.
export function removeHistoryAt(index) {
  const history = readHistory();
  if (!Number.isInteger(index) || index < 0 || index >= history.length) {
    showToast('Это сообщение уже удалено');
    return false;
  }
  const removed = history.splice(index, 1)[0];
  try {
    localStorage.setItem(ASSISTANT_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    // Отказ квоты: старый массив остаётся в силе, лента не перерисовывается
    showErrorToast('Не удалось удалить: память устройства занята');
    return false;
  }
  // Лента перерисовывается целиком: индексы на пузырях после сдвига
  // расшлись бы, и следующее удаление срезало бы соседнюю реплику. Живой
  // «Печатает…» при этом не теряется — renderHistory возвращает typingNode
  // в ленту (reattachTyping)
  renderHistory();
  showToast(removed && removed.role === 'user' ? 'Вопрос удалён' : 'Ответ удалён');
  return true;
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
// contextDays — окно записей из персонализации (слайдер 2..30): переданное
// значение прогоняется через ту же проверку, что и при чтении хранилища,
// поэтому кривой вызов деградирует на дефолтные 14 дней.
function buildContext(contextDays) {
  const days = personaInt(contextDays, 2, 30, PERSONA_DEFAULTS.contextDays);
  const parts = [];

  const habits = readSection(STORAGE_KEYS.habits);
  if (Array.isArray(habits) && habits.length) {
    parts.push('Привычки: ' + compact(habits.map(function (h) {
      return h && h.name ? h.name + ' (' + (h.type || '?') + (h.goal ? ', цель ' + h.goal : '') + ')' : '';
    }).filter(Boolean), 1200));
  }

  const records = readSection(STORAGE_KEYS.records);
  if (records) {
    const windowDays = lastDays(records, days);
    if (windowDays.length) {
      parts.push('Записи за ' + days + ' ' + assistantPluralDays(days) + ':\n'
        + windowDays.join('\n'));
    }
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
  // Персонализация читается на каждый запрос: правки в модалке вступают
  // в силу без перезапуска, а хранилище остаётся единственным источником
  const persona = readAssistantPersona();
  const context = buildContext(persona.contextDays);
  let system = 'Ты — ИИ-ассистент трекера привычек YouPlanner. Отвечай кратко '
    + 'и по-русски, опираясь на данные пользователя. Если данных нет — так и скажи.\n';
  // Инструкции пользователя стоят после первой фразы и ДО данных трекера:
  // модель сначала читает правила, потом фактуру. Пустой блок не пишется —
  // промпт без персонализации остаётся ровно прежним.
  if (persona.instructions) {
    system += 'Инструкции пользователя: ' + persona.instructions + '\n';
  }
  system += context ? 'Данные пользователя:\n' + context : 'Данных пока нет.';
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
  // К фото добавляются страницы PDF-скана (фолбэк assistant-pdf.js): уходят
  // тем же vision-путём, что и фото, — одним массивом в последнюю user-реплику.
  const photos = getImageContext() || [];
  const scanPages = getPdfPageImages() || [];
  const images = photos.concat(scanPages);
  if (photos.length) {
    system = 'Пользователь приложил к вопросу фото ('
      + photos.length + ' шт.): рассмотрите их и опирайтесь на них в ответе.\n\n' + system;
  }
  if (scanPages.length) {
    system = 'PDF-файл пользователя — скан без текстового слоя: приложены '
      + 'изображения его первых ' + scanPages.length + ' страниц. '
      + 'Рассмотрите их как текст документа и отвечайте по ним.\n\n' + system;
  }
  return withVisionAttachments(
    [{ role: 'system', content: system }].concat(requestTail(readHistory())),
    images
  );
}

// Хвост истории, который уходит в запрос: последние HISTORY_SEND реплик, из
// которых срезаны ВЕДУЩИЕ assistant-реплики. Причина — удаление одной реплики
// (removeHistoryAt): вырезав вопрос из середины, можно оставить контекст,
// начинающийся с ответа модели, а OpenAI-совместимый эндпоинт ждёт, что диалог
// после system открывается репликой пользователя.
//
// Честная формулировка правила: удаляется сообщение, а не «пара». Соседняя
// реплика остаётся в истории и в ленте — просто пока она стоит первой в
// контексте, в запрос она не уходит. Ровно поэтому не устраивается
// автоудаление пары: начало диалога определяет сам разработчик API, а молча
// выбрасывать второй пузырёк пользователь не просил
function requestTail(history) {
  const tail = history.slice(-HISTORY_SEND);
  let from = 0;
  while (from < tail.length && tail[from].role === 'assistant') from++;
  return tail.slice(from);
}

// Реэкспорт чистой vision-функции под прежним именем: публичная поверхность
// assistant-view.js не меняется (tests/assistant-vision.test.mjs импортирует
// отсюда), реализация живёт в js/ui/assistant-media.js.
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
  // У скана текстового контекста нет, но страницы-изображения убирать нужно
  // так же, как текст у обычного PDF
  if (getPdfContext() || getPdfPageImages()) {
    resetPdfContext();
    showToast('PDF убран из чата');
  }
}

// --- Ход к API ---------------------------------------------------------------
// Тонкая обёртка сохраняет прежнее имя и нулевую сигнатуру: payload
// ({model, messages, temperature, max_tokens}) собирается из состояния
// ассистента, ключ читается с устройства, сам HTTP ход — в
// js/ui/assistant-media.js (postAssistantChat). temperature и max_tokens —
// OpenAI-совместимые параметры генерации (snake_case для лимита) из
// персонализации: температура правит «фантазийность», лимит не даёт
// Qwen писать простыни.
async function requestAssistantReply() {
  const persona = readAssistantPersona();
  return postAssistantChat(
    {
      model: readAssistantModel(),
      messages: buildMessages(),
      temperature: persona.temperature,
      max_tokens: persona.maxTokens,
    },
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
    const bubble = appendMessage(
      history[i].role === 'user' ? 'user' : 'bot', history[i].content, true);
    // Индекс = позиция в readHistory(): лента строится ровно по этому же
    // отфильтрованному массиву, поэтому пузырь и реплика сходятся один в
    // один, и удаление по индексу срезает именно показанное сообщение
    markBubbleDeletable(bubble, i);
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

// --- Модалка «Настройки ассистента»: два таба --------------------------------
// Таб 1 «Персонализация» — инструкции и параметры генерации, таб 2 «API Ключ» —
// ключ и модель. Переключение — чистый DOM (hidden на панелях), без
// hash-роутинга: модалка не является экраном приложения. Капля-индикатор
// у сегмента та же, что у переключателей приложения: контейнер внесён в
// LIQUID_SWITCH_SELECTORS (app.js) и в списки day-view.css.
const ASSISTANT_TAB_PERSONA = 'persona';
const ASSISTANT_TAB_API = 'api';

// Стартовая вкладка модалки: без ключа — «API Ключ» (модалка и так сама
// открывается при первом вопросе — человеку сразу нужно поле ключа),
// с ключом — «Персонализация». Явный аргумент перебивает вычисление:
// сценарии «ключ не принят» и «модель без зрения» обязаны открыть таб API.
function defaultAssistantTab() {
  return readAssistantApiKey() ? ASSISTANT_TAB_PERSONA : ASSISTANT_TAB_API;
}

// Переключение таба: кнопки сегмента (is-active + aria-selected) и панели
// (hidden). Класс переставляется через remove+add даже при неизменном
// состоянии: мутация атрибута — то, по чему MutationObserver в app.js
// пересчитывает каплю-индикатор после открытия модалки (из display:none
// ширины кнопок не измерить).
function applyAssistantSettingsTab(tab) {
  const container = document.getElementById('assistant-settings-switch');
  if (!container) return;
  const buttons = container.querySelectorAll('.view-switch-btn');
  for (let i = 0; i < buttons.length; i++) {
    const active = buttons[i].getAttribute('data-assistant-tab') === tab;
    buttons[i].classList.remove('is-active');
    if (active) buttons[i].classList.add('is-active');
    buttons[i].setAttribute('aria-selected', active ? 'true' : 'false');
  }
  const personaPanel = document.getElementById('assistant-persona-panel');
  const apiPanel = document.getElementById('assistant-api-panel');
  if (personaPanel) personaPanel.hidden = tab !== ASSISTANT_TAB_PERSONA;
  if (apiPanel) apiPanel.hidden = tab !== ASSISTANT_TAB_API;
}

// Клик по сегменту табов (делегирование по контейнеру — тот же паттерн, что
// у schedule-switch в app.js). Чужое значение data-assistant-tab игнорируется.
export function onAssistantSettingsTabClick(event) {
  if (!event || !event.target || typeof event.target.closest !== 'function') return;
  const btn = event.target.closest('.view-switch-btn');
  if (!btn) return;
  const tab = btn.getAttribute('data-assistant-tab');
  if (tab !== ASSISTANT_TAB_PERSONA && tab !== ASSISTANT_TAB_API) return;
  applyAssistantSettingsTab(tab);
}

// Формат подписи значения слайдера. Формат зашит в data-format разметки,
// поэтому обработчик ввода и заполнение при открытии модалки не расходятся.
function formatAssistantRangeValue(field) {
  const value = Number(field.value);
  switch (field.getAttribute('data-format')) {
    case 'days':
      return value + ' ' + assistantPluralDays(value);
    case 'temperature':
      return String(value);
    case 'tokens':
      return value + ' симв.';
    default:
      return field.value;
  }
}

// Живое обновление подписи под слайдером (input-событие; сохранение — кнопкой
// «Сохранить», как у всего остального в этой модалке)
export function onAssistantPersonaRangeInput(event) {
  const field = event && event.target ? event.target : null;
  if (!field || !field.id) return;
  const label = document.getElementById(field.id + '-value');
  if (label) label.textContent = formatAssistantRangeValue(field);
}

// Контролы персонализации заполняются из хранилища при каждом открытии:
// модалка — единственный редактор, и её поля не должны помнить прошлое
function fillAssistantPersonaControls(persona) {
  const instructions = document.getElementById('assistant-persona-instructions');
  if (instructions) instructions.value = persona.instructions;
  const shiftEnter = document.getElementById('assistant-shift-enter');
  if (shiftEnter) shiftEnter.checked = persona.shiftEnter === true;
  const ranges = ['assistant-context-days', 'assistant-temperature', 'assistant-max-tokens'];
  for (let i = 0; i < ranges.length; i++) {
    const field = document.getElementById(ranges[i]);
    if (!field) continue;
    field.value = String(ranges[i] === 'assistant-context-days' ? persona.contextDays
      : ranges[i] === 'assistant-temperature' ? persona.temperature
      : persona.maxTokens);
    const label = document.getElementById(ranges[i] + '-value');
    if (label) label.textContent = formatAssistantRangeValue(field);
  }
}

// Сбор персонализации с контролов модалки. Значения прогоняются через ту же
// нормализацию, что и чтение хранилища: в localStorage не может попасть
// ничего вне диапазонов, даже если разметку сломают. Отсутствующий контрол —
// NaN → дефолт поля, открытие модалки без панели не роняет сохранение.
function collectAssistantPersona() {
  const instructions = document.getElementById('assistant-persona-instructions');
  const contextDays = document.getElementById('assistant-context-days');
  const temperature = document.getElementById('assistant-temperature');
  const maxTokens = document.getElementById('assistant-max-tokens');
  const shiftEnter = document.getElementById('assistant-shift-enter');
  return normalizeAssistantPersona({
    instructions: instructions ? instructions.value : '',
    contextDays: contextDays ? Number(contextDays.value) : NaN,
    temperature: temperature ? Number(temperature.value) : NaN,
    maxTokens: maxTokens ? Number(maxTokens.value) : NaN,
    shiftEnter: shiftEnter ? shiftEnter.checked === true : false,
  });
}

export function openAssistantKeyModal(initialTab) {
  const modal = document.getElementById('assistant-key-modal');
  const input = document.getElementById('assistant-key-input');
  const error = document.getElementById('assistant-key-error');
  const select = document.getElementById('assistant-model-select');
  if (!modal) return;
  // Модалка может быть уже на экране: 401 пришёл, пока человек правит ключ,
  // или шестерёнка нажата повторно. Повторное заполнение с устройства
  // затёрло бы недопечатанное — поля трогаем только при открытии; залежалую
  // ошибку валидации при этом снимаем.
  const alreadyOpen = !modal.hidden;
  if (error) error.textContent = '';
  if (!alreadyOpen) {
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
    fillAssistantPersonaControls(readAssistantPersona());
  }
  modal.hidden = false;
  // Вкладку можно задать явно ('api' из сценариев «ключ не принят»/«модель
  // без зрения»); иначе — по наличию ключа. Шестерёнка app.js зовёт без
  // аргумента: клик пришёл бы сюда объектом события и был бы отброшен.
  const tab = initialTab === ASSISTANT_TAB_PERSONA || initialTab === ASSISTANT_TAB_API
    ? initialTab
    : defaultAssistantTab();
  applyAssistantSettingsTab(tab);
  // Автофокус — только в поле ключа: на вкладке персонализации самопро-
  // выльная клавиатура на телефоне мешала бы читать настройки
  if (input && tab === ASSISTANT_TAB_API) input.focus();
}

export function closeAssistantKeyModal() {
  const modal = document.getElementById('assistant-key-modal');
  if (modal) modal.hidden = true;
}

// Escape для модалки ключа обрабатывает общий послойный обработчик в app.js:
// у всех окон один жест «верхнее — первым», а не два независимых обработчика,
// закрывавших две модалки одним нажатием.

// Сохранение: кнопка пишет и ключ, и персонализацию. Пустая строка ключом
// не считается — это «ключа нет», как и у уразы, где ноль и отсутствие
// счётчика различаются сознательно; с пустым ключом ничего не пишется,
// чтобы правка персонализации не закрыла окно и не ушла незамеченной.
export function onAssistantKeySave() {
  const input = document.getElementById('assistant-key-input');
  const error = document.getElementById('assistant-key-error');
  const value = input ? input.value.trim() : '';
  if (!value) {
    if (error) error.textContent = 'Введите ключ или закройте окно кнопкой «Отмена».';
    return;
  }
  // Ключ с символами вне ISO-8859-1 (вставка с кириллицей и т.п.) никогда не
  // валиден: fetch падает на таком заголовке ещё до сети. Ловим при
  // сохранении с внятной ошибкой и ничего не пишем в хранилище.
  if (!isHeaderSafeKey(value)) {
    if (error) {
      error.textContent = 'Ключ должен содержать только латиницу, цифры и '
        + 'символы — проверьте вставку.';
    }
    return;
  }
  // Персонализация собирается до записи: сбор не меняет хранилище, и если
  // ключ не сохранится (отказ хранилища), окно останется открытым с ошибкой
  const persona = collectAssistantPersona();
  try {
    localStorage.setItem(ASSISTANT_API_KEY, value);
  } catch (e) {
    if (error) error.textContent = 'Браузер не дал сохранить ключ: память недоступна.';
    return;
  }
  try {
    localStorage.setItem(ASSISTANT_PERSONA_KEY, JSON.stringify(persona));
  } catch (e) {
    // Персонализация — настройка-расходник: переполненная квота не должна
    // отменять уже сохранившийся ключ и закрывать окно с ошибкой
  }
  closeAssistantKeyModal();
  renderAssistantView();
  showToast('Настройки сохранены');
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
// Отложенные реплики (баг 1 из iPhone-теста Vision, 2026-11-01): отправка
// во время сжатия фото больше не отбивается ошибкой «ещё сжимается» — текст
// встаёт в очередь и уходит сам, когда сжатие закончится (flush в
// updateAssistantControls, его зовёт compressChatImages в finally).
// Очередь FIFO, а не одна строка: вторая отправка во время сжатия раньше
// ЗАТИРАЛА первую (текст терялся бесследно). Реплики уходят по одной: после
// отправки первой запрос делает assistantBusy — оставшиеся ждут его снятия
// (setAssistantBusy(false) снова зовёт updateAssistantControls).
// Тост с ошибкой загрузки теперь честный: только при реальной неудаче
// обработки фото, а не как ложная тревога при уже ушедшем ответе.
let pendingSubmitQueue = [];   // [{ text, at }]
const PENDING_SUBMIT_LIMIT_MS = 35000;

// Очередь не ушла и не дождалась (протухла или отказ без ключа): все
// накопленные реплики возвращаются в поле — текст не теряется.
function restorePendingToInput() {
  const input = document.getElementById('assistant-input');
  if (input) {
    const queued = pendingSubmitQueue.map(function (p) { return p.text; }).join('\n');
    // Поле во время сжатия НЕ блокируется (input гасится только на busy),
    // поэтому к моменту возврата пользователь уже мог набрать новое.
    // Присваивание в духе input.value = queued ЗАТИРАЛО бы эту работу
    // (F4, аудит GPT 2026-11-03): склеиваем очередь с тем, что в поле,
    // очередь — первой (она хронологически старше).
    const typed = String(input.value || '');
    input.value = queued && typed ? queued + '\n' + typed : (queued || typed);
    autosizeAssistantInput();   // многострочный текст — поле должно вырасти
  }
  pendingSubmitQueue = [];
}

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
  // Flush очереди: сжатие закончилось и запрос в полёте не идёт
  if (pendingSubmitQueue.length && !isImageCompressing() && !assistantBusy
      && !isPdfParsing()) {
    // Голова изымается из очереди ТОЛЬКО после принятой отправки (F4):
    // раньше shift стоял до onAssistantSubmit, и при отказе (нет ключа,
    // модель без vision) снятая голова оставалась за спиной
    // restorePendingToInput — первая реплика исчезала. Порядок FIFO не
    // меняется, дубля при успехе нет: очередь на этом синхронном участке
    // не пополняется (новых отправок быть не может), поэтому shift после
    // accept снимает ровно ушедшую голову.
    const head = pendingSubmitQueue[0];
    if (Date.now() - head.at > PENDING_SUBMIT_LIMIT_MS) {
      // Зависшее сжатие: тексты возвращаем в поле, решение за владельцем
      restorePendingToInput();
      showErrorToast('Фото обрабатывались слишком долго — отправьте реплику '
        + 'ещё раз');
      return;
    }
    if (onAssistantSubmit(head.text)) {
      pendingSubmitQueue.shift();
    } else {
      // Не ушла (нет ключа и т.п.) — голова ещё в очереди, возврат вернёт
      // всё накопленное, ничего не теряем
      restorePendingToInput();
    }
  }
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
    // Баг 1 (iPhone-тест Vision): вместо отказа «ещё сжимается» реплика
    // встаёт в очередь и уходит сама после сжатия (flush в
    // updateAssistantControls). Поле чистим — текст уже пойман в очередь.
    pendingSubmitQueue.push({ text: message, at: Date.now() });
    showToast('Фото обрабатываются — реплика уйдёт сразу после сжатия');
    return true;
  }
  if (assistantBusy) return false;
  // Ключ проверяется ДО приёма реплики: без него запрос всё равно не уйдёт,
  // а вопрос, осевший в истории, пришлось бы повторять после ввода ключа
  if (!readAssistantApiKey()) {
    showErrorToast('Сначала сохраните API-ключ — окно уже открыто');
    openAssistantKeyModal();
    return false;
  }
  // Фото пользователя и страницы PDF-скана под одним гейтом зрения: скану
  // без vision-модели так же бессмысленно уходить в API, как фото
  const attached = (getImageContext() || []).concat(getPdfPageImages() || []);
  const images = attached.slice();
  // Фото при модели без зрения не отправляются вовсе: API ответил бы
  // непонятной ошибкой. Модалка настроек открывается сразу на табе «API Ключ»:
  // селект модели живёт там, и «переключение рядом» должно его показать.
  if (images.length && !assistantModelSupportsVision(readAssistantModel())) {
    console.warn('[vision] отправка отсечена: модель без зрения — '
      + readAssistantModel());
    showErrorToast('Текущая модель не принимает изображения — переключитесь '
      + 'на Qwen (шестерёнка в шапке)');
    openAssistantKeyModal(ASSISTANT_TAB_API);
    return false;
  }
  const names = images.map(function (img) { return img.name; }).join(', ');
  const bubble = appendUserMessage(message, images);
  // В историю — только текст: маркер [фото: …] оставляет диалог читаемым
  // и на следующих репликах напоминает модели про приложенные снимки
  markBubbleDeletable(bubble, pushHistory('user',
    names ? message + '\n[фото: ' + names + ']' : message));
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
  // Пузырь ответа — тот же typing-узел: ссылка переживает finally, чтобы на
  // него попала кнопка удаления вместе с индексом в истории
  let replyBubble = null;
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
    replyBubble = typing;
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
    // «Ключ не принят» и «Ключ повреждён» — прямая дорога на таб «API Ключ»,
    // даже если ключ формально сохранён: модалка с дефолтной вкладкой
    // открыла бы «Персонализацию» мимо проблемы
    const message = String(error.message);
    if (message.indexOf('Ключ не принят') === 0
      || message.indexOf('Ключ повреждён') === 0) {
      openAssistantKeyModal(ASSISTANT_TAB_API);
    }
    return;
  }
  // Пузырь уже показан в ленте (typing-узел выше); в историю ответ пишется,
  // только если история не очищалась, пока запрос был в полёте. Удаление
  // ОДНОЙ реплики поколение не сдвигает: ответ относится к диалогу, и
  // «выкинуть» его из-за правки соседа было бы потерной данных, а не
  // защитой. Индекс берётся из pushHistory: он учитывает и то, что история
  // за время запроса могла измениться
  if (generation === assistantGeneration) {
    markBubbleDeletable(replyBubble, pushHistory('assistant', reply));
  }
}

// Общая отправка текста из поля: чистит его только после принятой отправки —
// блокировка (читается PDF / идёт запрос) текст не теряет. После очистки
// высота textarea сбрасывается на одну строку.
function submitAssistantInput() {
  const input = document.getElementById('assistant-input');
  if (!input) return;
  if (onAssistantSubmit(input.value)) {
    input.value = '';
    autosizeAssistantInput();
  }
}

// Обработчик формы: гасит перезагрузку, дальше — общая отправка
export function onAssistantFormSubmit(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  submitAssistantInput();
}

// Потолок высоты поля ввода: 5 строк по ~21px (15px × 1.4) + вертикальные
// отступы. Дальше текст прокручивается внутри поля (overflow-y в CSS), док
// чата не съедает ленту
const ASSISTANT_INPUT_MAX_HEIGHT = 119;

// Авто-высота textarea: классический приём «height: auto → scrollHeight».
// scrollHeight есть только у живого узла — в песочнице тестов и на пустом
// DOM функция молча выходит. CSS max-height страхует, если JS-вызов пропустить.
function autosizeAssistantInput() {
  const input = document.getElementById('assistant-input');
  if (!input || !input.style || typeof input.scrollHeight !== 'number') return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, ASSISTANT_INPUT_MAX_HEIGHT) + 'px';
}

// Ввод текста — только рост высоты. Вешается в app.js рядом с keydown.
export function onAssistantInputInput() {
  autosizeAssistantInput();
}

// Клавиатура textarea: Enter — отправка (у textarea нативный Enter вставляет
// перенос, поэтому отправка живёт здесь, а не в submit формы), Shift+Enter —
// перенос строки только при включённом тумблере персонализации, при
// выключенном — ничего (ни отправки, ни переноса). Вешается в app.js рядом
// с остальными обработчиками ассистента.
export function onAssistantInputKeydown(event) {
  if (!event || event.key !== 'Enter') return;
  // IME-композиция (китайский/японский ввод): Enter в это время подтверждает
  // выбор вариантов, а не отправляет реплику. isComposing — стандартный
  // флаг; keyCode 229 — дубль для старых браузеров, где флага нет.
  if (event.isComposing || event.keyCode === 229) return;
  const shiftEnter = readAssistantPersona().shiftEnter;
  if (event.shiftKey && shiftEnter) {
    return;   // перенос строки — нативное поведение textarea, не мешаем
  }
  if (typeof event.preventDefault === 'function') event.preventDefault();
  if (!event.shiftKey) submitAssistantInput();
  // Shift+Enter при выключенном тумблере: только preventDefault, без действий
}

// Чипы делегированы по контейнеру: текст команды — в data-chip. Кнопка
// «Анализ привычек» (data-action="analysis") вместо статического текста
// шлёт реплику, собранную из живой статистики (assistant-analysis.js).
// Гвард события — как у onAssistantSettingsTabClick: обработчик может быть
// вызван и без честного клика (синтетические события, будущие вызовы).
export function onAssistantChipClick(event) {
  if (!event || !event.target || typeof event.target.closest !== 'function') return;
  const chip = event.target.closest('.assistant-chip');
  if (!chip) return;
  if (chip.getAttribute('data-action') === 'analysis') {
    onAssistantSubmit(buildHabitsAnalysisRequest());
    return;
  }
  onAssistantSubmit(chip.getAttribute('data-chip'));
}
