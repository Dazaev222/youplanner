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

import { showErrorToast, showToast } from '../core/dom.js';

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
  // Длинный документ уходит фрагментами, отобранными по последнему вопросу:
  // весь текст не влезает в бюджет запроса, а нужное место модель видит.
  if (pdfContext) {
    if (pdfContext.chunks) {
      const selected = selectPdfChunks(lastUserQuestion(), pdfContext.chunks, PDF_MAX_CHARS);
      system = 'Вот фрагменты длинного документа «' + pdfContext.name + '» ('
        + pdfContext.pages + ' стр.), отобранные по вопросу пользователя:\n' + selected
        + '\n\nОтветь на вопрос пользователя, опираясь на эти фрагменты. '
        + 'Если ответа в них нет — так и скажи, не выдумывай.\n\n' + system;
    } else {
      system = 'Вот текст из PDF-файла «' + pdfContext.name + '» (' + pdfContext.pages
        + ' стр.):\n' + pdfContext.text
        + '\n\nОтветь на вопрос пользователя, опираясь на этот текст. '
        + 'Если ответа в тексте нет — так и скажи.\n\n' + system;
    }
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
// Потолок страниц 200: файлы «100+ страниц» из сценария тестирования раньше
// резались на 30-й странице, и модель видела четверть документа. 200 страниц
// читаются последовательно ~2–5 с.
const PDF_MAX_PAGES = 200;
// Потолок ЧТЕНИЯ в память. Раньше он совпадал с запросным (50 000) — и длинный
// документ обрезался на 50-й тысяче: модель не видела остальное никак. Теперь
// читается до 200 000 символов, а в запрос уходит отобранное (§ умной нарезки).
const PDF_READ_MAX_CHARS = 200000;
// Бюджет PDF-текста в ОДНОМ запросе: ~15–20k токенов, не упирается в контекст API.
const PDF_MAX_CHARS = 50000;
// --- Умная нарезка (чанкинг) длинных PDF ------------------------------------
// Документ больше PDF_MAX_CHARS не обрезается, а нарезается на фрагменты
// (чанки) по абзацам. При вопросе по ключевым словам выбираются релевантные
// фрагменты, и только они идут в системный промпт: модель видит нужное место
// из документа любой толщины, а контекст запроса остаётся в бюджете.
const PDF_CHUNK_SIZE = 1200;     // целевой размер фрагмента (~300–400 токенов)
const PDF_CHUNK_MIN = 400;       // мельче не склеиваем: точность поиска дороже
// Служебные слова вопроса: сами по себе они не ищутся, иначе вопрос
// «что там про каза?» находил бы каждый фрагмент со словом «что».
const PDF_STOPWORDS = ('и в во не что он на я с со как а то все она так его но да ты ' +
  'к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда ' +
  'даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь ' +
  'там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была ' +
  'сам чтоб без будто чего раз тоже себе под будет тогда кто этот потому этого ' +
  'какой совсем здесь этом один почти мой тем чтобы нее кажется сейчас были куда ' +
  'зачем сказать всех никогда сегодня можно при наконец два об другой хоть после ' +
  'над больше тот через эти нас про всего них какая много разве три четыре пусть ' +
  'кроме пожалуйста скажи расскажи должен должна нужно можно the and for that with ' +
  'this from have what when where your you are was were will they them their').split(' ');

// pdf.js лежит локально (js/vendor/) и прекэшируется сервис-воркером:
// офлайн-PWA продолжает читать PDF, без CDN. Абсолютный URL строится от
// baseURI документа при первом PDF: динамический import резолвит
// относительный спецификатор от URL МОДУЛЯ (js/ui/), и строка 'js/vendor/…'
// тянулась бы в js/ui/js/vendor. Абсолютный URL работает и на localhost,
// и в подпапке GitHub Pages. import.meta не годится: тестовая песочница
// гонит код классическим скриптом, где его синтаксис запрещён. Воркер
// same-origin — workerSrc задаётся прямым путём, без blob-обёртки эпохи CDN
function vendorPdfUrl(file) {
  return new URL('js/vendor/' + file, document.baseURI).href;
}

let pdfContext = null;   // { name, pages, text, chunks } | null
let pdfParsing = false;

export function onAssistantPdfPick() {
  const fileInput = document.getElementById('assistant-pdf-input');
  const file = fileInput && fileInput.files && fileInput.files[0];
  // Сброс значения — в любом пути, включая «занят»: иначе повторный выбор того
  // же файла не стреляет change, и скрепка кажется сломанной
  if (fileInput) fileInput.value = '';
  if (!file) return;
  if (pdfParsing) return;   // параллельный разбор не запускаем
  parsePdf(file);
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
}
// Текст страницы с сохранением переносов строк: item.hasEOL — перевод строки
// внутри страницы, и именно он разбивает текст на абзацы, по которым идут
// чанки. Старая склейка пробелом сливала документ в одну строку, и нарезать
// его по абзацам было бы нечем.
function pdfPageTextFromItems(content) {
  let out = '';
  const items = content.items;
  for (let i = 0; i < items.length; i++) {
    out += items[i].str;
    out += items[i].hasEOL ? '\n' : ' ';
  }
  return out.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}
// Ранний выход при переполнении: страница читается целиком, но в буфер
// попадает только остаток лимита — память не копит лишнее.
// Счётчик charsUsed считает СИМВОЛЫ: раньше лимит сравнивался с числом
// страниц (buffer.length), никогда не срабатывал, и текст мог уехать в
// запрос далеко за лимитом.
function appendPageText(buffer, pageText, charsUsed) {
  const room = PDF_READ_MAX_CHARS - charsUsed.value;
  if (room <= 0) return false;
  const piece = pageText.length > room ? pageText.slice(0, room) : pageText;
  buffer.push(piece);
  charsUsed.value += piece.length;
  return charsUsed.value < PDF_READ_MAX_CHARS;
}

// --- Нарезка и поиск по фрагментам -------------------------------------------

// Делит текст на фрагменты по абзацам (строкам — перенос строки внутри
// страницы это абзац). Абзацы докидываются в фрагмент, пока тот меньше
// PDF_CHUNK_SIZE; мелкий хвост добирается до PDF_CHUNK_MIN, чтобы последний
// фрагмент не был обрывком в три слова. Абзац-гигант (слитая таблица) режется
// отдельно: по предложениям, а совсем без предложений — жёстким окном.
export function chunkPdfText(text) {
  if (!text) return [];
  const paragraphs = String(text).split(/\n+/);
  const chunks = [];
  let buffer = '';
  const flush = function () {
    if (buffer) { chunks.push(buffer); buffer = ''; }
  };
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim();
    if (!p) continue;
    if (p.length > PDF_CHUNK_SIZE * 2) {
      flush();
      const pieces = pdfSplitBigParagraph(p);
      for (let k = 0; k < pieces.length; k++) chunks.push(pieces[k]);
      continue;
    }
    if (buffer && buffer.length + p.length + 1 > PDF_CHUNK_SIZE
        && buffer.length >= PDF_CHUNK_MIN) {
      flush();
    }
    buffer = buffer ? buffer + '\n' + p : p;
  }
  flush();
  return chunks;
}
// Резка одного длинного абзаца. Регулярка с lookbehind не годится: Safari
// старше 16.4 падает на ней ещё при разборе файла. Поэтому границы
// предложений ищутся проходом: знак конца предложения, за которым пробел.
function pdfSplitBigParagraph(p) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < p.length; i++) {
    const ch = p.charAt(i);
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    const next = i + 1 < p.length ? p.charAt(i + 1) : '';
    if (next !== '' && next !== ' ' && next !== '\n') continue;
    sentences.push(p.slice(start, i + 1));
    start = i + 1;
  }
  if (start < p.length) sentences.push(p.slice(start));

  const pieces = [];
  let piece = '';
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].trim();
    if (!s) continue;
    if (s.length > PDF_CHUNK_SIZE) {
      if (piece) { pieces.push(piece); piece = ''; }
      for (let k = 0; k < s.length; k += PDF_CHUNK_SIZE) {
        pieces.push(s.slice(k, k + PDF_CHUNK_SIZE));
      }
      continue;
    }
    if (piece && piece.length + s.length + 1 > PDF_CHUNK_SIZE) {
      pieces.push(piece);
      piece = '';
    }
    piece = piece ? piece + ' ' + s : s;
  }
  if (piece) pieces.push(piece);
  return pieces;
}
// Слова вопроса в нижнем регистре без служебных: короткие (< 3) и стоп-слова
// поиск не ведут, иначе каждый фрагмент «релевантен» любому вопросу.
export function pdfQueryTokens(question) {
  const words = String(question || '').toLowerCase().match(/[a-zа-яё0-9]+/g) || [];
  const tokens = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.length < 3 || PDF_STOPWORDS.indexOf(w) !== -1) continue;
    if (tokens.indexOf(w) === -1) tokens.push(w);
  }
  return tokens;
}
// Число вхождений needle в hay. indexOf-цикл вместо match: на 200 000
// символов регулярный обход в разы тяжелее, а считать нужно на каждый фрагмент.
function pdfCountOccurrences(hay, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = hay.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = hay.indexOf(needle, pos + needle.length);
  }
  return count;
}
// Фрагменты, отобранные под вопрос, одним куском текста. Слово ищется целиком
// и усечённо (без последних двух букв у длинных слов): «напомин» ловит и
// «напоминание», и «напоминания», не требуя настоящего стеммера.
// Пустой результат поиска (вопрос из одних служебных слов) — начало документа:
// оглавление и первые главы чаще прочего отвечают на общий вопрос. Выбранные
// фрагменты склеиваются в порядке документа — связный контекст, а не мешок.
export function selectPdfChunks(question, chunks, budget) {
  if (!chunks || !chunks.length) return '';
  if (budget === undefined) budget = PDF_MAX_CHARS;

  const tokens = pdfQueryTokens(question);
  const scores = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) scores[i] = 0;
  if (tokens.length) {
    const lower = new Array(chunks.length);
    for (let i = 0; i < chunks.length; i++) lower[i] = chunks[i].toLowerCase();
    for (let i = 0; i < chunks.length; i++) {
      let score = 0;
      for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t];
        let hits = pdfCountOccurrences(lower[i], token);
        if (!hits && token.length >= 5) {
          hits = pdfCountOccurrences(lower[i], token.slice(0, token.length - 2));
        }
        score += hits;
      }
      scores[i] = score;
    }
  }

  const order = chunks.map(function (_c, i) { return i; })
    .sort(function (a, b) { return scores[b] - scores[a] || a - b; });

  const picked = [];
  let used = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (!picked.length) {
      // первый — самый релевантный (или просто первый), берётся всегда
      picked.push(i);
      used += chunks[i].length > budget ? budget : chunks[i].length + 2;
      continue;
    }
    if (scores[i] <= 0) break;   // релевантные кончились
    if (used + chunks[i].length + 2 > budget) break;
    picked.push(i);
    used += chunks[i].length + 2;
  }
  picked.sort(function (a, b) { return a - b; });
  return picked.map(function (i) { return chunks[i]; }).join('\n\n');
}
// Последний вопрос пользователя из истории: по нему ищутся фрагменты.
// В истории его нет (старт чата) — пустая строка, поиск вернёт начало документа.
function lastUserQuestion() {
  const history = readHistory();
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return history[i].content;
  }
  return '';
}

async function parsePdf(file) {
  pdfParsing = true;
  updateAssistantControls();
  setPdfIndicator('Читаю ' + file.name + '…');
  try {
    // Динамический import: pdf.js нужен только при выборе файла, старт
    // PWA и офлайн-режим он не утяжеляет. Файл локальный и same-origin —
    // воркер стартует прямым путём, без blob-обёртки
    const pdfjs = await import(vendorPdfUrl('pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = vendorPdfUrl('pdf.worker.min.mjs');
    const data = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: data }).promise;
    const buffer = [];
    const charsUsed = { value: 0 };
    let pages = 0;
    for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages = i;
      if (!appendPageText(buffer, pdfPageTextFromItems(content), charsUsed)) {
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
    const truncated = pages < doc.numPages || text.length >= PDF_READ_MAX_CHARS;
    const finalText = truncated
      ? text.replace(/\s+\S*$/, '') + ' …[текст обрезан]'
      : text;
    const long = finalText.length > PDF_MAX_CHARS;
    const chunks = long ? chunkPdfText(finalText) : null;
    console.log('[assistant] PDF ' + file.name + ': страниц в файле ' + doc.numPages
      + ', прочитано ' + pages + ', символов ' + text.length
      + (chunks ? ', фрагментов ' + chunks.length : ''));
    await doc.destroy();
    if (!finalText.trim()) {
      resetPdfContext();
      showErrorToast('В PDF не найдено текста — возможно, это сканы');
      return;
    }
    pdfContext = {
      name: file.name,
      pages: pages,
      text: finalText,
      // Длинный документ живёт фрагментами: в запрос уйдут только те, что
      // отвечают на вопрос (умная нарезка). Короткий — как был, целиком.
      chunks: chunks,
    };
    setPdfIndicator('✕ ' + pdfContext.name + ' · ' + pages + ' стр.'
      + (chunks ? ' · нарезан: ' + chunks.length + ' фраг.' : '')
      + ' — нажмите, чтобы убрать');
    showToast(chunks
      ? 'PDF прочитан: ' + pages + ' стр., нарезан на ' + chunks.length + ' фрагментов'
      : 'PDF прочитан: ' + pages + ' стр.');
  } catch (e) {
    console.error('[assistant] разбор PDF не удался:', e);
    resetPdfContext();
    showErrorToast('Не удалось прочитать PDF: ' + (e && e.message ? e.message : 'ошибка'));
  } finally {
    pdfParsing = false;
    updateAssistantControls();
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
      ? 'Сервис не ответил за 60 секунд. Попробуйте ещё раз.'
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
    appendMessage(history[i].role === 'user' ? 'user' : 'bot', history[i].content, true);
  }
  // Одна прокрутка в конец вместо плавной на каждый пузырь
  chat.scrollTop = chat.scrollHeight;
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

function appendUserMessage(text) {
  return appendMessage('user', text);
}

// Точка входа и для формы, и для чипов: у чипа текст сообщения лежит
// в data-chip, у формы — в поле ввода.
// Пока идёт запрос к API, новый не отпускается: кнопки гасятся (анти-спам,
// иначе быстрые повторные вопросы ловили 429), а Enter игнорится флагом.
let assistantBusy = false;

// Один источник правды для состояния кнопок. Гасит отправку и скрепку и на
// время запроса, и на время разбора PDF: раньше вопрос, отправленный пока
// большой PDF ещё читался, уходил в API вообще без текста файла — модель
// честно отвечала «в отрывке нет содержания». Ввод текста при разборе PDF
// остаётся доступным: печатать можно, отправится после.
function updateAssistantControls() {
  const input = document.getElementById('assistant-input');
  const send = document.getElementById('assistant-send');
  const pdfBtn = document.getElementById('assistant-pdf-btn');
  const blocked = assistantBusy || pdfParsing;
  if (input) input.disabled = assistantBusy;
  if (send) send.disabled = blocked;
  if (pdfBtn) pdfBtn.classList.toggle('is-disabled', blocked);
}

function setAssistantBusy(busy) {
  assistantBusy = busy;
  updateAssistantControls();
}

// false — отправка не состоялась (занято/читается PDF/нет ключа), поле не чистится
export function onAssistantSubmit(text) {
  const message = String(text || '').trim();
  if (!message) return false;
  if (pdfParsing) {
    showErrorToast('PDF ещё читается — повторите отправку через пару секунд');
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
  appendUserMessage(message);
  pushHistory('user', message);
  runAssistantReply();
  return true;
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
