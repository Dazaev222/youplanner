// PDF-подсистема ассистента (вынесена из assistant-view.js, этап D.5).
//
// Текст из PDF живёт в переменной модуля: не в localStorage (переполнение
// хранилища и лишний вес кэша ни к чему), перезагрузка страницы его сбрасывает.
// Прикрепляется к каждому запросу, пока файл не сброшен; в историю диалога
// не попадает — только в системный промпт.
//
// Здесь же — умная нарезка длинных документов на фрагменты (чанки) и поиск
// по ним: chunkPdfText / pdfQueryTokens / selectPdfChunks — чистые функции,
// их проверяет tests/assistant.test.mjs.

import { showErrorToast, showToast } from '../core/dom.js';

// Потолок страниц 200: файлы «100+ страниц» из сценария тестирования раньше
// резались на 30-й странице, и модель видела четверть документа. 200 страниц
// читаются последовательно ~2–5 с.
const PDF_MAX_PAGES = 200;
// Потолок ЧТЕНИЯ в память. Раньше он совпадал с запросным (50 000) — и длинный
// документ обрезался на 50-й тысяче: модель не видела остальное никак. Теперь
// читается до 200 000 символов, а в запрос уходит отобранное (§ умной нарезки).
const PDF_READ_MAX_CHARS = 200000;
// Бюджет PDF-текста в ОДНОМ запросе: ~15–20k токенов, не упирается в контекст API.
export const PDF_MAX_CHARS = 50000;
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

// Состояние читает ассистент-оркестратор (assistant-view.js): сборка запроса
// идёт с PDF-контекстом, отправка и скрепка гаснут, пока файл читается.
export function getPdfContext() {
  return pdfContext;
}

export function isPdfParsing() {
  return pdfParsing;
}

// Обработчики скрепки (onAssistantPdfPick / onAssistantPdfClear) остаются в
// assistant-view.js: там живут делегированные события и updateAssistantControls,
// который передаётся сюда колбэком.

function setPdfIndicator(text) {
  const el = document.getElementById('assistant-pdf-indicator');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

export function resetPdfContext() {
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

// Пустая (сканированная) страница: pdf.js вытаскивает из скана пустоту или
// одинокий номер страницы, поэтому порог — «меньше 10 символов текста».
// Чистая функция: проверяется тестами без запуска разбора PDF.
export function pdfIsBlankPage(pageText) {
  return String(pageText).trim().length < 10;
}

// Предупреждение о «полускане»: если страниц достаточно много и больше
// половины без текста, пользователь должен узнать, что ассистент видит
// книгу не целиком. Меньше 10 страниц — молчим: пустые обложка и титульник
// бывают и у обычных текстовых файлов. Чистая функция: проверяется тестами.
export function pdfScannedWarning(pages, blankPages) {
  if (pages < 10 || blankPages / pages < 0.6) return '';
  return 'Внимание: ' + blankPages + ' из ' + pages + ' страниц без текста — '
    + 'похоже, часть книги сканы, ассистент увидит только страницы с текстом';
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
// Ё у слова вопроса нормализуется в Е: без этого «чём» не совпадал со
// стоп-словом «чем» и системно уводил вопрос в нулевой матч.
export function pdfQueryTokens(question) {
  const words = String(question || '').toLowerCase().match(/[a-zа-яё0-9]+/g) || [];
  const tokens = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/ё/g, 'е');
    if (w.length < 3 || PDF_STOPWORDS.indexOf(w) !== -1) continue;
    if (tokens.indexOf(w) === -1) tokens.push(w);
  }
  return tokens;
}
// Число вхождений needle в hay НА ГРАНИЦЕ СЛОВА СЛЕВА (префиксный поиск):
// вхождение засчитывается, только если слово начинается с needle — pos === 0
// или слева не буква/цифра. Голый substring-поиск ловил «каз» внутри
// «казаться» — шум; левая граница оставляет префиксную семантику (слово
// начинается с токена), что и нужно для русских словоформ. indexOf-цикл
// вместо match: на 200 000 символов регулярный обход в разы тяжелее, а
// считать нужно на каждый фрагмент.
function pdfCountOccurrences(hay, needle) {
  if (!needle) return 0;
  const letter = /[a-zа-яё0-9]/i;
  let count = 0;
  let pos = hay.indexOf(needle);
  while (pos !== -1) {
    if (pos === 0 || !letter.test(hay.charAt(pos - 1))) count++;
    pos = hay.indexOf(needle, pos + 1);
  }
  return count;
}
// Фрагменты, отобранные под вопрос, одним куском текста. Слово ищется целиком
// и усечённо (без последних двух букв у длинных слов): «напомин» ловит и
// «напоминание», и «напоминания», не требуя настоящего стеммера.
// Пустой результат поиска (вопрос из одних служебных слов или ни одного
// совпадения во всём документе) — равномерная выборка по всей книге: общий
// вопрос («о чём книга», «перескажи») должен давать модели срез всего текста,
// а не только оглавление. Выбранные фрагменты склеиваются в порядке
// документа — связный контекст, а не мешок.
export function selectPdfChunks(question, chunks, budget) {
  if (!chunks || !chunks.length) return '';
  if (budget === undefined) budget = PDF_MAX_CHARS;

  const tokens = pdfQueryTokens(question);
  const scores = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) scores[i] = 0;
  let maxScore = 0;
  if (tokens.length) {
    const lower = new Array(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      // ё в тексте фрагментов тоже нормализуем в е: иначе токен «объем»
      // не найдёт «объём», записанный через ё
      lower[i] = chunks[i].toLowerCase().replace(/ё/g, 'е');
    }
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
      if (score > maxScore) maxScore = score;
    }
  }

  // Фолбэк: содержательных слов в вопросе нет или они не встретились нигде —
  // релевантности нет, берём равномерную сетку по всей книге.
  if (!tokens.length || maxScore === 0) {
    return pdfSpreadPick(chunks, budget)
      .map(function (i) { return chunks[i]; }).join('\n\n');
  }

  const order = chunks.map(function (_c, i) { return i; })
    .sort(function (a, b) { return scores[b] - scores[a] || a - b; });

  const picked = [];
  let used = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (!picked.length) {
      // первый — самый релевантный, берётся всегда. Учёт честный (реальная
      // длина + разделитель): раньше длина клампилась «в потолок» бюджета,
      // хотя чанк уходил в промпт целиком, — остаток бюджета врал
      picked.push(i);
      used += chunks[i].length + 2;
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
// Равномерная сетка индексов фрагментов по всему документу — фолбэк отбора,
// когда совпадений с вопросом нет. maxPicks — сколько фрагментов среднего
// размера влезает в бюджет; сетка всегда включает начало И конец документа.
// Укладка идёт в порядке документа, и фрагмент, который не влезает,
// ПРОПУСКАЕТСЯ, а не обрывает подбор — иначе хвост документа снова выпадал.
// Совсем без вариантов остаётся индекс 0: инвариант старого поведения —
// в промпте не бывает пусто. Проверка повторов через indexOf: Set здесь
// избыточен, а в старых средах он дороже массива из десятков элементов.
function pdfSpreadPick(chunks, budget) {
  const maxPicks = Math.max(1, Math.floor(budget / (PDF_CHUNK_SIZE + 2)));
  const grid = [];
  if (chunks.length <= maxPicks) {
    for (let i = 0; i < chunks.length; i++) grid.push(i);
  } else {
    for (let i = 0; i < maxPicks; i++) {
      grid.push(Math.round(i * (chunks.length - 1) / (maxPicks - 1)));
    }
  }
  const picked = [];
  let used = 0;
  for (let i = 0; i < grid.length; i++) {
    const idx = grid[i];
    if (picked.indexOf(idx) !== -1) continue;
    if (used + chunks[idx].length + 2 > budget) continue;
    picked.push(idx);
    used += chunks[idx].length + 2;
  }
  if (!picked.length) return [0];
  return picked;
}

// Разбор выбранного файла. refreshControls — колбэк ассистента
// (updateAssistantControls): гасит/возвращает скрепку и кнопку отправки,
// пока идёт чтение. pdf.js нужен только здесь, поэтому импортируется динамически.
export async function parsePdf(file, refreshControls) {
  pdfParsing = true;
  if (refreshControls) refreshControls();
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
    let blankPages = 0;
    for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages = i;
      const pageText = pdfPageTextFromItems(content);
      // Пустые страницы считаем: доля сканов должна дойти до пользователя,
      // а не остаться только в диагностике
      if (pdfIsBlankPage(pageText)) blankPages += 1;
      if (!appendPageText(buffer, pageText, charsUsed)) {
        page.cleanup();
        break;
      }
      page.cleanup();   // освобождает ресурсы страницы сразу: Safari на
                        // iPhone не держит в памяти весь документ
    }
    const text = buffer.join('\n').trim();
    // Диагностика «читает только обложку»: видно, сколько страниц в файле
    // и сколько реально прочитано и вошло в лимит. numPages снимаем до
    // destroy(): у убитого документа его уже не прочитать, а понадобится
    // он и индикатору ниже — после destroy
    const docPages = doc.numPages;
    const truncated = pages < docPages || text.length >= PDF_READ_MAX_CHARS;
    const finalText = truncated
      ? text.replace(/\s+\S*$/, '') + ' …[текст обрезан]'
      : text;
    const long = finalText.length > PDF_MAX_CHARS;
    const chunks = long ? chunkPdfText(finalText) : null;
    console.log('[assistant] PDF ' + file.name + ': страниц в файле ' + docPages
      + ', прочитано ' + pages + ', символов ' + text.length
      + (chunks ? ', фрагментов ' + chunks.length : ''));
    await doc.destroy();
    if (!finalText.trim()) {
      resetPdfContext();
      showErrorToast('В PDF не найдено текста — возможно, это сканы');
      return;
    }
    // «Полускан»: больше половины страниц без текста. Разбор при этом
    // успешен — текстовые страницы прочитаны, поэтому предупреждение идёт
    // ПОСЛЕ успеха: это ограничение файла, а не ошибка чтения
    const scannedWarning = pdfScannedWarning(pages, blankPages);
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
      // Обрезка по лимиту раньше была видна только в console.log: пользователь
      // не знал, что вторая половина книги не прочитана
      + (truncated ? ' · прочитано ' + pages + ' из ' + docPages + ' стр.' : '')
      + ' — нажмите, чтобы убрать');
    showToast(chunks
      ? 'PDF прочитан: ' + pages + ' стр., нарезан на ' + chunks.length + ' фрагментов'
      : 'PDF прочитан: ' + pages + ' стр.');
    if (scannedWarning) showErrorToast(scannedWarning);
  } catch (e) {
    console.error('[assistant] разбор PDF не удался:', e);
    resetPdfContext();
    showErrorToast('Не удалось прочитать PDF: ' + (e && e.message ? e.message : 'ошибка'));
  } finally {
    pdfParsing = false;
    if (refreshControls) refreshControls();
  }
}
