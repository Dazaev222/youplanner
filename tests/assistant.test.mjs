// Тесты умной нарезки PDF (чанкинг) в ассистенте.
//
// Длинный документ (> 50 000 символов) больше не обрезается по запросному
// лимиту, а нарезается на фрагменты по абзацам; в запрос уходят только
// фрагменты, отобранные по ключевым словам вопроса. Проверяются три звена:
// нарезка (chunkPdfText), разбор вопроса (pdfQueryTokens) и отбор
// (selectPdfChunks) — все они верхнеуровневые функции модуля ассистента,
// песочница отдаёт их напрямую (export-префиксы снимаются).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
// С этапа D.5 нарезка и поиск по PDF живут в отдельном модуле; песочница
// отдаёт их как и прежде (все модули конкатенируются), прямой ESM-импорт
// дополнительно закрепляет публичные экспорты нового файла.
import { chunkPdfText, pdfHasTextLayer, pdfQueryTokens, selectPdfChunks } from '../js/ui/assistant-pdf.js';

// Абзац заданной длины с маркером внутри: 'абзац 007: слово ...'
function paragraph(n, marker, filler) {
  const word = filler || 'наполнение';
  let out = marker + ' ';
  while (out.length < n) out += word + ' ';
  return out.trim();
}

test('assistant-pdf: нарезка и поиск экспортируются новым модулем напрямую', () => {
  assert.equal(typeof chunkPdfText, 'function');
  assert.equal(typeof pdfQueryTokens, 'function');
  assert.equal(typeof selectPdfChunks, 'function');
  // Скан-фолбэк: решение «есть ли у PDF текстовый слой» — тоже публичный экспорт
  assert.equal(typeof pdfHasTextLayer, 'function');
  assert.equal(pdfHasTextLayer('а'.repeat(40), 2), true, '40 симв. на 2 стр. — слой есть');
  assert.equal(pdfHasTextLayer('1\n2', 2), false, 'по номеру на страницу — скан');
  // Два абзаца по 1250 символов: каждый больше CHUNK_MIN, вместе не влезают
  // в CHUNK_SIZE — режутся ровно на два фрагмента с сохранением порядка
  const chunks = chunkPdfText(paragraph(1250, 'А-1') + '\n\n' + paragraph(1250, 'А-2'));
  assert.equal(chunks.length, 2, 'фрагментов: ' + chunks.length);
  assert.ok(chunks[0].indexOf('А-1') === 0, 'первый фрагмент — первый абзац');
  assert.ok(chunks[1].indexOf('А-2') === 0, 'второй фрагмент — второй абзац');
  assert.deepEqual(pdfQueryTokens('что про напоминания'), ['напоминания']);
});

test('chunkPdfText: пустой и короткий текст — деградация без сюрпризов', () => {
  const { context } = loadApp();
  // массивы из vm-контекста — другой реалм: deepEqual по прототипу не пройдёт,
  // поэтому сравниваем раскладку в хозяйский массив
  assert.deepEqual([...context.chunkPdfText('')], []);
  assert.deepEqual([...context.chunkPdfText(null)], []);
  const one = context.chunkPdfText('Один короткий абзац');
  assert.equal(one.length, 1);
  assert.equal(one[0], 'Один короткий абзац');
});

test('chunkPdfText: длинный текст режется на фрагменты и ничего не теряет', () => {
  const { context } = loadApp();
  // 60 абзацев по ~900 символов = ~54 000 символов: выше запросного лимита
  const paragraphs = [];
  for (let i = 0; i < 60; i++) paragraphs.push(paragraph(900, 'АБЗАЦ-' + i));
  const text = paragraphs.join('\n');

  const chunks = context.chunkPdfText(text);
  assert.ok(chunks.length > 10, 'фрагментов должно быть много, вышло ' + chunks.length);
  // каждый фрагмент в разумных пределах: абзац не больше CHUNK*2, склейка
  // может дотянуть до CHUNK*2 + CHUNK_MIN — жёсткий потолок 3 * 1200
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3600,
      'фрагмент раздут: ' + chunk.length);
    assert.ok(!chunk.includes('\n\n'), 'внутри фрагмента нет пустых строк');
  }
  // содержимое не потерялось: все маркеры абзацев дошли до фрагментов
  const joined = chunks.join('\n');
  for (let i = 0; i < 60; i++) {
    assert.ok(joined.includes('АБЗАЦ-' + i), 'потерян абзац ' + i);
  }
});

test('chunkPdfText: абзац-гигант без переносов режется жёстким окном', () => {
  const { context } = loadApp();
  const giant = paragraph(30000, 'Гигант');   // одна строка, ни одного \n
  const chunks = context.chunkPdfText(giant);
  assert.ok(chunks.length >= 6, 'гигант должен нарезаться, фрагментов: ' + chunks.length);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1200, 'окно фрагмента превышено: ' + chunk.length);
  }
  const joined = chunks.join('');
  assert.ok(joined.includes('Гигант'));
});

test('pdfQueryTokens: служебные и короткие слова не попадают в поиск', () => {
  const { context } = loadApp();
  const tokens = context.pdfQueryTokens('Что там про каза-намазы и как дела?');
  assert.deepEqual([...tokens], ['каза', 'намазы', 'дела']);
  assert.deepEqual([...context.pdfQueryTokens('и в во не на')], []);
  assert.deepEqual([...context.pdfQueryTokens('')], []);
  assert.deepEqual([...context.pdfQueryTokens(null)], []);
});

test('selectPdfChunks: находит фрагмент по слову вопроса', () => {
  const { context } = loadApp();
  const chunks = [
    paragraph(800, 'ФРАГМЕНТ-0', 'прочее'),
    paragraph(800, 'ФРАГМЕНТ-1', 'напоминание о намазе'),
    paragraph(800, 'ФРАГМЕНТ-2', 'прочее'),
  ];
  // «напоминания» должно найти фрагмент 1 и по усечённой форме («напомин»), и по целому слову
  const picked = context.selectPdfChunks('Расскажи про напоминания', chunks, 50000);
  assert.ok(picked.includes('ФРАГМЕНТ-1'), 'релевантный фрагмент не выбран: ' + picked.slice(0, 80));
  assert.ok(!picked.includes('ФРАГМЕНТ-2'), 'нерелевантный фрагмент прицепился');
});

test('selectPdfChunks: соблюдает бюджет и отдаёт связный текст в порядке документа', () => {
  const { context } = loadApp();
  const chunks = [];
  for (let i = 0; i < 50; i++) {
    chunks.push(paragraph(1100, 'ФРАГ-' + i,
      i % 7 === 3 ? 'казахстан' : 'прочее'));
  }
  // 8 фрагментов по ~1100 = 8800: бюджет 5000 выдержит только часть
  const picked = context.selectPdfChunks('казахстан казахстан казахстан', chunks, 5000);
  assert.ok(picked.length > 0, 'отбор пуст');
  assert.ok(picked.length <= 5000, 'бюджет превышен: ' + picked.length);
  // фрагменты идут в порядке документа: «ФРАГ-3» раньше «ФРАГ-10»
  const first = picked.indexOf('ФРАГ-3');
  const second = picked.indexOf('ФРАГ-10');
  assert.ok(first !== -1 && second !== -1 && first < second,
    'порядок фрагментов перемешан');
});

test('selectPdfChunks: вопрос без ключевых слов — срез всего документа', () => {
  const { context } = loadApp();
  const chunks = ['НАЧАЛО ' + paragraph(500), 'СЕРЕДИНА ' + paragraph(500), 'КОНЕЦ ' + paragraph(500)];
  const picked = context.selectPdfChunks('и что тут вообще', chunks, 50000);
  assert.ok(picked.includes('НАЧАЛО'), 'фолбэк должен брать начало документа');
  assert.ok(picked.includes('КОНЕЦ'), 'фолбэк должен накрывать и конец документа');
});

test('selectPdfChunks: фолбэк-сетка накрывает весь длинный документ', () => {
  const { context } = loadApp();
  const chunks = [];
  for (let i = 0; i < 60; i++) chunks.push(paragraph(1100, 'ФРАГ-' + i, 'прочее'));
  // вопрос из одних служебных слов: релевантности нет — работает равномерная сетка
  const picked = context.selectPdfChunks('и в во не на', chunks, 50000);
  assert.ok(picked.includes('ФРАГ-0'), 'начало документа потеряно');
  assert.ok(picked.includes('ФРАГ-59'), 'конец документа потерян');
  // каждый фрагмент несёт свой маркер ровно один раз: считаем выбранные чанки
  const marks = (picked.match(/ФРАГ-\d+/g) || []).length;
  assert.ok(marks >= 20 && marks <= 60, 'выбрано фрагментов: ' + marks);
  // в каждой трети документа есть хотя бы один выбранный фрагмент
  let firstThird = 0, middleThird = 0, lastThird = 0;
  for (let i = 0; i < 60; i++) {
    // маркер ищем с хвостовым пробелом: «ФРАГ-5» иначе найдётся внутри «ФРАГ-59»
    if (picked.indexOf('ФРАГ-' + i + ' ') === -1) continue;
    if (i < 20) firstThird++;
    else if (i < 40) middleThird++;
    else lastThird++;
  }
  assert.ok(firstThird > 0, 'первая треть документа без отбора');
  assert.ok(middleThird > 0, 'середина документа без отбора');
  assert.ok(lastThird > 0, 'последняя треть документа без отбора');
});

test('selectPdfChunks: фолбэк соблюдает бюджет запроса', () => {
  const { context } = loadApp();
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(paragraph(1100, 'ФРАГ-' + i, 'прочее'));
  // в 5000 влезает 4 фрагмента среднего размера: сетка не должна раздуть отбор
  const picked = context.selectPdfChunks('и в во не на', chunks, 5000);
  assert.ok(picked.length <= 5000, 'бюджет превышен: ' + picked.length);
  assert.ok(picked.length >= 2000, 'фолбэк отдал слишком мало: ' + picked.length);
});

test('selectPdfChunks: ё и е взаимозаменяемы в вопросе и тексте', () => {
  const { context } = loadApp();
  const chunks = [
    paragraph(300, 'ФРАГ-0', 'прочее'),
    paragraph(300, 'ФРАГ-1', 'объём воды в реке'),
    paragraph(300, 'ФРАГ-2', 'прочее'),
  ];
  // «объем» (через е) должно найти «объём» (через ё)
  const picked = context.selectPdfChunks('что про объем', chunks, 50000);
  assert.ok(picked.includes('ФРАГ-1'), 'токен через е не нашёл фрагмент с ё');
  // «чём» гасится стоп-словом «чем»: вопрос из одних служебных слов — пустой список
  assert.deepEqual([...context.pdfQueryTokens('о чём тут')], []);
});

test('selectPdfChunks: токен матчится только на границе слова слева', () => {
  const { context } = loadApp();
  const chunks = [
    paragraph(300, 'ФРАГ-0', 'многогранник'),
    paragraph(300, 'ФРАГ-1', 'гранната'),
    paragraph(300, 'ФРАГ-2', 'прочее'),
  ];
  const picked = context.selectPdfChunks('гранн', chunks, 50000);
  assert.ok(!picked.includes('ФРАГ-0'),
    '«многогранник» не должен матчиться: вхождение в середине слова');
  assert.ok(picked.includes('ФРАГ-1'),
    '«гранната» должен матчиться: префикс в начале слова');
});

test('pdfIsBlankPage: пустота и одинокая цифра — скан, связный текст — нет', () => {
  const { context } = loadApp();
  assert.equal(context.pdfIsBlankPage(''), true);
  assert.equal(context.pdfIsBlankPage('7'), true, 'одинокий номер страницы — тоже скан');
  assert.equal(context.pdfIsBlankPage('Десять симв'), false);
});

test('pdfScannedWarning: предупреждает только при полускане больших файлов', () => {
  const { context } = loadApp();
  assert.equal(context.pdfScannedWarning(5, 5), '', 'мало страниц — предупреждение не нужно');
  assert.equal(context.pdfScannedWarning(20, 5), '', 'доля пустых мала — предупреждение не нужно');
  const warning = context.pdfScannedWarning(20, 13);
  assert.ok(typeof warning === 'string' && warning.includes('13 из 20'),
    'в предупреждении нет чисел страниц: ' + warning);
});

// --- Скан-фолбэк: решение «есть ли у PDF текстовый слой» ---------------------
// У файла без текстового слоя (скан) первые страницы рендерятся в картинки
// и уходят в Vision тем же путём, что и фото. Проверяется сама чистая
// функция решения, а не pdf.js: порог — среднее число символов на страницу
// (обоснование — у константы в js/ui/assistant-pdf.js).

test('pdfHasTextLayer: пустота и номера страниц — скан, обычный текст — нет', () => {
  const { context } = loadApp();
  // getTextContent не дал ничего
  assert.equal(context.pdfHasTextLayer('', 12), false);
  assert.equal(context.pdfHasTextLayer('  \n ', 12), false);
  assert.equal(context.pdfHasTextLayer(null, 12), false);
  // Скан с нумерацией: «1\n2\n…\n200» — около трёх символов на страницу
  const numbered = [];
  for (let i = 1; i <= 200; i++) numbered.push(String(i));
  assert.equal(context.pdfHasTextLayer(numbered.join('\n'), 200), false,
    'документ из одних номеров страниц — скан');
  // Настоящий текст: даже скромные 200 символов на страницу проходят
  assert.equal(context.pdfHasTextLayer(paragraph(200), 1), true);
});

test('pdfHasTextLayer: порог 20 символов на страницу — границы и полускан', () => {
  const { context } = loadApp();
  // Граница: ровно 20 симв./стр. — слой есть, на символ меньше — уже скан
  assert.equal(context.pdfHasTextLayer('а'.repeat(20 * 10), 10), true);
  assert.equal(context.pdfHasTextLayer('а'.repeat(20 * 10 - 1), 10), false);
  // Полускан: половина страниц с текстом, половина пустые — среднее высокое,
  // фолбэк не нужен (это путь pdfScannedWarning, текст важнее картинок)
  const halfScan = [];
  for (let i = 0; i < 10; i++) halfScan.push(i % 2 === 0 ? paragraph(400, 'Т-' + i) : '');
  assert.equal(context.pdfHasTextLayer(halfScan.join('\n'), 10), true);
  // Почти целиком скан: одна текстовая страница на двести — среднее ниже
  // порога, фолбэк включается даже при ненулевом тексте
  let rare = paragraph(900, 'ЕДИНСТВЕННАЯ');
  for (let i = 1; i <= 199; i++) rare += '\n' + i;
  assert.equal(context.pdfHasTextLayer(rare, 200), false);
  // Страниц не прочитано — решаем по самому факту текста
  assert.equal(context.pdfHasTextLayer('Немного текста', 0), true);
  assert.equal(context.pdfHasTextLayer('', 0), false);
});

test('resetPdfContext: страницы скана сбрасываются вместе с текстовым контекстом', () => {
  const app = loadApp();
  app.run('pdfPageImages = [{ dataUrl: "data:image/jpeg;base64,QQ==", '
    + 'name: "скан.pdf — стр. 1", bytes: 2048 }];');
  assert.equal(app.context.getPdfPageImages().length, 1, 'страницы скана не прикрепились');
  app.context.resetPdfContext();
  assert.equal(app.context.getPdfPageImages(), null,
    'страницы скана пережили сброс PDF — убранный скан остался бы в чате');
});

test('selectPdfChunks: пустой вопрос и пустой список — без падений', () => {
  const { context } = loadApp();
  assert.equal(context.selectPdfChunks('', ['абзац'], 50000), 'абзац');
  assert.equal(context.selectPdfChunks('вопрос', [], 50000), '');
  assert.equal(context.selectPdfChunks(null, null, 50000), '');
});

// --- Клавиатура iOS: класс body.keyboard-open (bindViewportDockFix) --------
// Классом ведёт CSS в mobile.css: прячет таб-бар и снимает запас под него,
// пока клавиатура открыта. Здесь проверяется сам переключатель: реальный
// слушатель visualViewport из песочницы, без DOM-дерева — body.classList
// подменяется на записывающую заглушку, как и весь document в loadApp.

test('keyboard-open: класс ставится по перекрытию вьюпорта и снимается с гистерезисом', () => {
  const { sandbox, context } = loadApp();
  const classes = new Set();
  sandbox.document.body.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: () => {},
    contains: (c) => classes.has(c),
  };
  const view = { style: {} };
  sandbox.document.getElementById = (id) => (id === 'assistant-view' ? view : null);
  const handlers = {};
  sandbox.window.visualViewport = {
    height: 800,
    offsetTop: 0,
    addEventListener(type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
    },
  };
  sandbox.window.innerHeight = 800;
  context.bindViewportDockFix();
  // второй вызов не должен ставить параллельный слушатель
  context.bindViewportDockFix();
  assert.equal(handlers.resize.length, 1, 'слушатель resize ставится один раз');
  const resize = handlers.resize[0];
  assert.ok(resize, 'слушатель visualViewport.resize должен существовать');

  // закрытая клавиатура: перекрытия нет — ни класса, ни подъёма
  resize();
  assert.ok(!classes.has('keyboard-open'), 'без перекрытия класса быть не должно');
  assert.equal(view.style.marginBottom, '');

  // клавиатура открылась: iOS не сжимает окно, перекрытие 340px
  sandbox.window.visualViewport.height = 460;
  resize();
  assert.ok(classes.has('keyboard-open'), 'перекрытие 340px — класс должен ставиться');
  assert.equal(view.style.marginBottom, '340px', 'экран поднимается на перекрытие');

  // гистерезис: перекрытие 90px (шум вьюпорта) не гасит уже открытый класс
  sandbox.window.visualViewport.height = 710;
  resize();
  assert.ok(classes.has('keyboard-open'), 'в мёртвой зоне класс держится');
  assert.equal(view.style.marginBottom, '90px');

  // клавиатура закрылась: класс снят, стиль вернулся к safe-area CSS
  sandbox.window.visualViewport.height = 800;
  resize();
  assert.ok(!classes.has('keyboard-open'), 'при закрытии класс снимается');
  assert.equal(view.style.marginBottom, '');
});

test('keyboard-open: на Android (окно сжимается целиком) класс не ставится', () => {
  const { sandbox, context } = loadApp();
  const classes = new Set();
  sandbox.document.body.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: () => {},
    contains: (c) => classes.has(c),
  };
  const view = { style: {} };
  sandbox.document.getElementById = (id) => (id === 'assistant-view' ? view : null);
  const handlers = {};
  sandbox.window.visualViewport = {
    height: 800,
    offsetTop: 0,
    addEventListener(type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
    },
  };
  sandbox.window.innerHeight = 800;
  context.bindViewportDockFix();
  const resize = handlers.resize[0];

  // Android: клавиатура на 340px сжимает и окно, и visualViewport
  sandbox.window.innerHeight = 460;
  sandbox.window.visualViewport.height = 460;
  resize();
  assert.ok(!classes.has('keyboard-open'),
    'перекрытия нет — класс не должен ставиться');
  assert.equal(view.style.marginBottom, '', 'подъём тоже не нужен');
});

// --- Гонка рендера и «Очистить историю» --------------------------------------
// Лента #assistant-chat перерисовывается по textContent (защита от XSS), и
// пока запрос в полёте, перерисовка отрывает узел «Печатает…»: ответ
// записывается в отсоединённый узел и не виден, экран выглядит зависшим.
// А «Очистить история» посреди запроса не должен пропускать завершившийся
// ответ в персистентную историю: очистка честнее пришедшего позже ответа.
//
// Песочница без DOM: чат — ручной двухпанельный объект (textContent-сеттер
// чистит детей, appendChild пишет в массив), createElement отдаёт пузыри с
// classList и scrollIntoView и складывает их в список созданных. Так тест
// держит ссылку именно на живой typing-узел, а не ищет его заново.

function makeChat() {
  const children = [];
  const chat = {
    scrollTop: 0,
    scrollHeight: 1000,
    children: children,
    appendChild(child) { children.push(child); return child; },
  };
  Object.defineProperty(chat, 'textContent', {
    get() { return ''; },
    set() { children.length = 0; },   // как у настоящего узла: присваивание чистит ленту
  });
  return chat;
}

function bindAssistantDom(sandbox, chat) {
  const created = [];
  sandbox.document.getElementById = (id) => (id === 'assistant-chat' ? chat : null);
  sandbox.document.createElement = () => {
    const el = {
      className: '',
      textContent: '',
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
        toggle() {},
      },
      appendChild(child) { (el.children = el.children || []).push(child); return child; },
      scrollIntoView() {},
    };
    created.push(el);
    return el;
  };
  sandbox.document.createTextNode = (text) => ({ text: text });
  return created;
}

function findTyping(created) {
  return created.find((el) => el.textContent === 'Печатает…') || null;
}

function okReply(content) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: content } }] }),
  };
}

// Промис ответа сервера держится до resolveReply(): тест успевает сделать
// перерисовку/очистку, пока запрос «в полёте»
function makeDeferredFetch() {
  let resolveReply = null;
  const fetchImpl = () => new Promise((resolve) => { resolveReply = resolve; });
  fetchImpl.resolveReply = (content) => resolveReply(okReply(content));
  return fetchImpl;
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function storedHistory(sandbox) {
  const raw = sandbox.localStorage.getItem('youplanner.assistant_history');
  return raw ? JSON.parse(raw) : [];
}

test('рендер при busy не сносит typing: ответ приходит в видимый узел ленты', async () => {
  const chat = makeChat();
  const fetchImpl = makeDeferredFetch();
  const { sandbox, context } = loadApp({ fetchImpl });
  const created = bindAssistantDom(sandbox, chat);
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');
  sandbox.localStorage.setItem('youplanner.assistant_history', JSON.stringify([
    { role: 'user', content: 'старый вопрос' },
    { role: 'assistant', content: 'старый ответ' },
  ]));

  context.renderHistory();
  assert.equal(chat.children.length, 2, 'история должна отрисоваться');

  assert.equal(context.onAssistantSubmit('Новый вопрос'), true);
  const typing = findTyping(created);
  assert.ok(typing, 'узел «Печатает…» должен быть создан');
  assert.ok(chat.children.indexOf(typing) !== -1, 'typing живёт в ленте до рендера');

  // Перерисовка (уход с вкладки и обратно) посреди запроса
  context.renderHistory();
  assert.ok(chat.children.indexOf(typing) !== -1,
    'перерисовка при busy выбросила typing: ответ уйдёт в отсоединённый узел');
  assert.equal(chat.children[chat.children.length - 1], typing,
    'typing должен остаться последним пузырём ленты');

  fetchImpl.resolveReply('СВЕЖИЙ ОТВЕТ');
  await settle();

  assert.equal(typing.textContent, 'СВЕЖИЙ ОТВЕТ', 'ответ не записался в узел');
  assert.ok(chat.children.indexOf(typing) !== -1,
    'ответ записан в узел, оторванный от ленты: экран выглядит зависшим');
  const history = storedHistory(sandbox);
  assert.ok(history.some((m) => m.content === 'СВЕЖИЙ ОТВЕТ'),
    'ответ должен попасть в историю (очистки не было)');
});

test('очистка истории во время запроса: ответ виден в чате, но не пишется в историю', async () => {
  const chat = makeChat();
  const fetchImpl = makeDeferredFetch();
  const { sandbox, context } = loadApp({ fetchImpl });
  const created = bindAssistantDom(sandbox, chat);
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');
  sandbox.localStorage.setItem('youplanner.assistant_history', JSON.stringify([
    { role: 'user', content: 'старый вопрос' },
  ]));
  sandbox.confirm = () => true;

  assert.equal(context.onAssistantSubmit('Вопрос'), true);
  const typing = findTyping(created);

  // Очистка, пока запрос в полёте
  context.onAssistantClear();
  assert.equal(storedHistory(sandbox).length, 0, 'история должна очиститься сразу');

  fetchImpl.resolveReply('ПОЗДНИЙ ОТВЕТ');
  await settle();

  assert.equal(typing.textContent, 'ПОЗДНИЙ ОТВЕТ', 'ответ не записался в узел');
  assert.ok(chat.children.indexOf(typing) !== -1,
    'очистка посреди запроса прячет ответ: пузырь должен остаться в текущей сессии');
  assert.ok(!storedHistory(sandbox).some((m) => m.content === 'ПОЗДНИЙ ОТВЕТ'),
    '«очищенная» история получила сообщение завершившегося запроса');
});

test('после очистки следующий запрос пишется в историю: инвалидация не залипает', async () => {
  const chat = makeChat();
  const fetchImpl = makeDeferredFetch();
  const { sandbox, context } = loadApp({ fetchImpl });
  const created = bindAssistantDom(sandbox, chat);
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');
  sandbox.localStorage.setItem('youplanner.assistant_history', JSON.stringify([
    { role: 'user', content: 'старый вопрос' },
  ]));
  sandbox.confirm = () => true;

  // Очистка без запроса в полёте
  context.onAssistantClear();
  assert.equal(storedHistory(sandbox).length, 0);

  // Новый запрос после очистки обязан персиститься как обычно
  assert.equal(context.onAssistantSubmit('Новый вопрос'), true);
  fetchImpl.resolveReply('ОТВЕТ ПОСЛЕ ОЧИСТКИ');
  await settle();

  const history = storedHistory(sandbox);
  assert.ok(history.some((m) => m.role === 'assistant' && m.content === 'ОТВЕТ ПОСЛЕ ОЧИСТКИ'),
    'инвалидирующий флаг пережил свой запрос и съел чужой ответ');
});

// --- Двойная отправка при медленной сети (adversarial-аудит 2026-10-31) ------
// assistantBusy гасит и повторную отправку (Enter/чип во время запроса ловили
// 429), и кнопку #assistant-send до завершения запроса.

test('двойная отправка при медленной сети: assistantBusy гасит кнопку и повтор', async () => {
  const chat = makeChat();
  const fetchImpl = makeDeferredFetch();
  const { sandbox, context } = loadApp({ fetchImpl });
  const created = bindAssistantDom(sandbox, chat);
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');

  const send = { disabled: false, classList: { toggle() {} } };
  const baseGet = sandbox.document.getElementById;
  sandbox.document.getElementById = (id) => (id === 'assistant-send' ? send : baseGet(id));

  assert.equal(context.onAssistantSubmit('Первый вопрос'), true);
  assert.equal(send.disabled, true, 'кнопка отправки не погашена на время запроса');

  assert.equal(context.onAssistantSubmit('Второй вопрос'), false,
    'повторная отправка при busy не должна отпускаться');
  fetchImpl.resolveReply('ОТВЕТ');
  await settle();

  assert.equal(send.disabled, false, 'кнопка не вернулась после ответа');
  assert.equal(context.onAssistantSubmit('Третий вопрос'), true, 'после ответа отправка заблокирована');

  const history = storedHistory(sandbox);
  assert.equal(history.filter((m) => m.role === 'user').length, 2,
    'второй вопрос должен был осеть в истории');
  assert.equal(history.filter((m) => m.role === 'assistant').length, 1);
});

// --- Отсутствующие контролы: функция не должна ронять страницу ---------------
// updateAssistantControls зовётся из многих мест (setAssistantBusy, чтение
// PDF, сжатие фото), и getElementById там может вернуть null, если разметка
// вкладки ещё не встала или частично не отрисовалась. Функция обязана молча
// пройти мимо отсутствующих узлов (там стоят if (input) / if (send)), а не
// уронить ход приложения исключением.

test('updateAssistantControls: нет кнопки и поля в DOM — функция молча проходит', () => {
  const { sandbox, context } = loadApp();
  // Жёстко фиксируем «элементов нет»: любой getElementById отдаёт null
  sandbox.document.getElementById = () => null;
  assert.equal(typeof context.updateAssistantControls, 'function',
    'updateAssistantControls должна быть доступна из песочницы');

  // Покой и оба края busy-цикла: ни один вызов не должен бросить исключение
  context.updateAssistantControls();
  context.setAssistantBusy(true);
  context.setAssistantBusy(false);
  context.updateAssistantControls();
});

// ═════════════════════════════════════════════════════════════════════════════
// Персонализация ассистента (модалка «Настройки ассистента», два таба)
//
// Персонализация живёт на устройстве одним JSON — youplanner.assistant_persona:
// инструкции для системного промпта, окно контекста данных (дни), температура,
// потолок длины ответа (max_tokens) и поведение Shift+Enter. Валидация
// по-полевая: мусор в одном поле не должен портить остальные, а отсутствие
// или битый JSON целиком откатывает КАЖДОЕ поле на дефолт — так же, как
// readAssistantModel откатывается на дефолтную модель.
// ═════════════════════════════════════════════════════════════════════════════

const PERSONA_KEY = 'youplanner.assistant_persona';

const PERSONA_DEFAULTS = {
  instructions: '',
  contextDays: 14,
  temperature: 0.3,
  maxTokens: 1000,
  shiftEnter: false,
};

// Объект, созданный в vm-реалме, → хозяйский: deepStrictEqual из strict-режима
// сравнивает прототипы, поэтому сравнивать можно только свои объекты
function personaOf(context) {
  return { ...context.readAssistantPersona() };
}

test('readAssistantPersona: пустое хранилище, мусор и не-объект — дефолты', () => {
  const { sandbox, context } = loadApp();
  assert.equal(typeof context.readAssistantPersona, 'function',
    'readAssistantPersona должна быть доступна из песочницы');
  assert.deepEqual(personaOf(context), PERSONA_DEFAULTS, 'пустое хранилище');

  sandbox.localStorage.setItem(PERSONA_KEY, '{битый json');
  assert.deepEqual(personaOf(context), PERSONA_DEFAULTS, 'битый JSON');

  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify([1, 2, 3]));
  assert.deepEqual(personaOf(context), PERSONA_DEFAULTS, 'массив — не персонализация');

  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify('строка'));
  assert.deepEqual(personaOf(context), PERSONA_DEFAULTS, 'строка — не персонализация');

  sandbox.localStorage.setItem(PERSONA_KEY, 'null');
  assert.deepEqual(personaOf(context), PERSONA_DEFAULTS, 'null — тоже мусор');
});

test('readAssistantPersona: валидация по-полевая — партиал и мусор в отдельных полях', () => {
  const { sandbox, context } = loadApp();

  // Партиальный объект: известное поле применяется, остальные — дефолты
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({ contextDays: 7 }));
  assert.deepEqual(personaOf(context), { ...PERSONA_DEFAULTS, contextDays: 7 });

  // Мусор в каждом поле — поле откатывается на дефолт, соседние не трогаются
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    good: { contextDays: 5 },
    instructions: 42,
    contextDays: 'семь',
    temperature: 'много',
    maxTokens: null,
    shiftEnter: 1,
  }));
  const mixed = personaOf(context);
  assert.equal(mixed.contextDays, 14, 'строковое окно — дефолт');
  assert.equal(mixed.temperature, 0.3, 'строковая температура — дефолт');
  assert.equal(mixed.maxTokens, 1000, 'null вместо лимита — дефолт');
  assert.equal(mixed.shiftEnter, false, 'единица вместо булева — дефолт');
  assert.equal(mixed.instructions, '', 'число вместо инструкций — дефолт');

  // Нижние границы диапазонов принимаются
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    instructions: '  Кратко.  ',
    contextDays: 2,
    temperature: 0,
    maxTokens: 100,
    shiftEnter: true,
  }));
  assert.deepEqual(personaOf(context), {
    instructions: 'Кратко.',   // трим обязателен
    contextDays: 2,
    temperature: 0,
    maxTokens: 100,
    shiftEnter: true,
  });

  // Верхние границы диапазонов принимаются
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    contextDays: 30, temperature: 1, maxTokens: 4000,
  }));
  const top = personaOf(context);
  assert.equal(top.contextDays, 30);
  assert.equal(top.temperature, 1);
  assert.equal(top.maxTokens, 4000);

  // Вне диапазона — дефолт поля
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    contextDays: 31, temperature: 1.5, maxTokens: 50,
  }));
  const off = personaOf(context);
  assert.equal(off.contextDays, 14);
  assert.equal(off.temperature, 0.3);
  assert.equal(off.maxTokens, 1000);

  // Не-целые для целочисленных полей — дефолт поля
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    contextDays: 7.5, maxTokens: 250.5,
  }));
  const frac = personaOf(context);
  assert.equal(frac.contextDays, 14, 'дробное окно — дефолт');
  assert.equal(frac.maxTokens, 1000, 'дробный лимит — дефолт');

  // Инструкции длиннее 2000 символов обрезаются до 2000
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    instructions: 'а'.repeat(2500),
  }));
  assert.equal(personaOf(context).instructions.length, 2000);
});

test('buildMessages: инструкции попадают в системный промпт после первой фразы и до данных', () => {
  const { sandbox, context } = loadApp();
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    instructions: 'Отвечай как кот',
  }));

  const messages = context.buildMessages();
  const system = messages[0].content;
  assert.ok(system.indexOf('Инструкции пользователя: Отвечай как кот') !== -1,
    'инструкций нет в системном промпте: ' + system.slice(0, 200));
  const atFirstSentence = system.indexOf('так и скажи.');
  const atInstructions = system.indexOf('Инструкции пользователя');
  // Данные могут отсутствовать (пустой трекер) — тогда сравниваем с блоком
  // «Данных пока нет», который идёт на том же месте
  const atData = system.indexOf('Данные пользователя');
  const atDataBlock = atData !== -1 ? atData : system.indexOf('Данных пока нет');
  assert.ok(atInstructions > atFirstSentence,
    'инструкции должны стоять после первой фразы промпта');
  assert.ok(atInstructions < atDataBlock,
    'инструкции должны стоять ПЕРЕД данными трекера');
});

test('buildMessages: пустые инструкции — блока «Инструкции пользователя» нет', () => {
  const { sandbox, context } = loadApp();
  const bare = context.buildMessages()[0].content;
  assert.ok(bare.indexOf('Инструкции пользователя') === -1,
    'без персонализации блока инструкций быть не должно');

  // Пробельные инструкции после трима — пустые: блока тоже нет
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({ instructions: '   ' }));
  assert.ok(context.buildMessages()[0].content.indexOf('Инструкции пользователя') === -1,
    'блок инструкций не должен появляться из одних пробелов');
});

test('buildContext: contextDays задаёт окно записей в снимке данных', () => {
  const { sandbox, context } = loadApp();
  // 40 дней записей: маркер ДЕНЬ-N, где N — сколько дней назад была запись
  const records = {};
  const now = new Date();
  for (let i = 0; i < 40; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
    records[iso] = { note: 'ДЕНЬ-' + i };
  }
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));

  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({ contextDays: 7 }));
  let system = context.buildMessages()[0].content;
  assert.ok(system.indexOf('Записи за 7 дней') !== -1,
    'подпись должна называть реальное окно');
  assert.ok(system.indexOf('ДЕНЬ-6') !== -1, 'последний день окна потерялся');
  assert.ok(system.indexOf('ДЕНЬ-0') !== -1, 'сегодняшний день потерялся');
  assert.ok(system.indexOf('ДЕНЬ-7') === -1, 'в окно попал день за его пределами');

  // Без персонализации окно прежнее — 14 дней
  sandbox.localStorage.removeItem(PERSONA_KEY);
  system = context.buildMessages()[0].content;
  assert.ok(system.indexOf('Записи за 14 дней') !== -1);
  assert.ok(system.indexOf('ДЕНЬ-13') !== -1);
  assert.ok(system.indexOf('ДЕНЬ-14') === -1);

  // Русское склонение в подписи: «21 день», а не «21 дней»
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({ contextDays: 21 }));
  system = context.buildMessages()[0].content;
  assert.ok(system.indexOf('Записи за 21 день\n') !== -1
    || system.indexOf('Записи за 21 день:') !== -1,
    'склонение «21 дней» — уродливо: ' + system.slice(0, 300));
});

test('payload: temperature и max_tokens из персонализации уходят в тело запроса', async () => {
  const bodies = [];
  const fetchImpl = (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return Promise.resolve(okReply('ок'));
  };
  const chat = makeChat();
  const { sandbox, context } = loadApp({ fetchImpl });
  bindAssistantDom(sandbox, chat);
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({
    temperature: 0.7, maxTokens: 2500,
  }));

  assert.equal(context.onAssistantSubmit('Вопрос'), true);
  await settle();

  assert.equal(bodies.length, 1, 'запрос не дошёл до fetch');
  assert.equal(bodies[0].temperature, 0.7, 'temperature не из персонализации');
  assert.equal(bodies[0].max_tokens, 2500,
    'max_tokens должен быть snake_case (OpenAI-совместимо) и из персонализации');
  assert.ok(bodies[0].model, 'модель потерялась из payload');
  assert.ok(Array.isArray(bodies[0].messages), 'messages потерялись из payload');
});

test('payload: без персонализации уходят дефолты temperature 0.3 и max_tokens 1000', async () => {
  const bodies = [];
  const fetchImpl = (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return Promise.resolve(okReply('ок'));
  };
  const chat = makeChat();
  const { sandbox, context } = loadApp({ fetchImpl });
  bindAssistantDom(sandbox, chat);
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');

  assert.equal(context.onAssistantSubmit('Вопрос'), true);
  await settle();

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].temperature, 0.3, 'дефолт температуры должен уйти в payload');
  assert.equal(bodies[0].max_tokens, 1000, 'дефолт лимита должен уйти в payload');
});

// DOM модалки настроек: элементы, которые читают/пишут openAssistantKeyModal
// и onAssistantKeySave, плюс тост. Чего нет в overrides — создаётся заглушкой.
function bindAssistantSettingsDom(sandbox, overrides) {
  const els = {
    'assistant-key-modal': { hidden: true },
    'assistant-key-input': { value: '', focus() {} },
    'assistant-key-error': { textContent: '' },
    'assistant-model-select': {
      options: [],
      appendChild(option) { this.options.push(option); return option; },
    },
    'assistant-persona-instructions': { value: '' },
    // data-format у слайдеров живёт в разметке; заглушка отдаёт null —
    // форматирование деградирует на «как есть» (ветка default)
    'assistant-context-days': { value: '14', getAttribute: () => null },
    'assistant-context-days-value': { textContent: '' },
    'assistant-temperature': { value: '0.3', getAttribute: () => null },
    'assistant-temperature-value': { textContent: '' },
    'assistant-max-tokens': { value: '1000', getAttribute: () => null },
    'assistant-max-tokens-value': { textContent: '' },
    'assistant-shift-enter': { checked: false },
    'assistant-image-indicator': { textContent: '', hidden: true },
    'toast': { textContent: '', hidden: true, addEventListener() {} },
  };
  for (const key of Object.keys(overrides || {})) els[key] = overrides[key];
  sandbox.document.getElementById = (id) => (Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null);
  return els;
}

test('onAssistantKeySave: сохраняет и ключ, и персонализацию одним «Сохранить»', () => {
  const { sandbox, context } = loadApp();
  const els = bindAssistantSettingsDom(sandbox);
  els['assistant-key-input'].value = '  новый-ключ  ';
  els['assistant-persona-instructions'].value = '  Кратко, без воды  ';
  els['assistant-context-days'].value = '21';
  els['assistant-temperature'].value = '0.5';
  els['assistant-max-tokens'].value = '2000';
  els['assistant-shift-enter'].checked = true;

  context.onAssistantKeySave();

  assert.equal(sandbox.localStorage.getItem('youplanner.api_key'), 'новый-ключ',
    'ключ должен сохраниться тримленным');
  assert.deepEqual(JSON.parse(sandbox.localStorage.getItem(PERSONA_KEY)), {
    instructions: 'Кратко, без воды',
    contextDays: 21,
    temperature: 0.5,
    maxTokens: 2000,
    shiftEnter: true,
  }, 'персонализация должна записаться тем же «Сохранить»');
  assert.ok(els['toast'].textContent.indexOf('Настройки сохранены') !== -1,
    'тост должен быть «Настройки сохранены»: ' + els['toast'].textContent);
  assert.equal(els['assistant-key-modal'].hidden, true,
    'модалка должна закрыться после сохранения');
});

test('onAssistantKeySave: пустой ключ — ошибка, записей нет (ни ключа, ни персонализации)', () => {
  const { sandbox, context } = loadApp();
  const els = bindAssistantSettingsDom(sandbox);
  els['assistant-key-input'].value = '   ';
  els['assistant-persona-instructions'].value = 'Кратко';

  context.onAssistantKeySave();

  assert.ok(els['assistant-key-error'].textContent.length > 0,
    'при пустом ключе должна показываться ошибка');
  assert.equal(sandbox.localStorage.getItem('youplanner.api_key'), null,
    'пустая строка ключом не считается («ключа нет»)');
  assert.equal(sandbox.localStorage.getItem(PERSONA_KEY), null,
    'персонализация не должна сохраниться, если ключ не введён');
});

// Кнопка таба модалки: класс-набор и getAttribute, как у настоящего узла
function makeTabButton(tab) {
  const classes = new Set();
  const btn = {
    attrs: { 'data-assistant-tab': tab, 'aria-selected': 'false' },
    // обработчик клика делегирует через closest — кнопка матчится сама
    closest(selector) { return selector === '.view-switch-btn' ? btn : null; },
    getAttribute(name) { return btn.attrs[name] !== undefined ? btn.attrs[name] : null; },
    setAttribute(name, value) { btn.attrs[name] = value; },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, force) {
        const want = force === undefined ? !classes.has(c) : Boolean(force);
        if (want) classes.add(c); else classes.delete(c);
      },
      contains(c) { return classes.has(c); },
    },
  };
  return btn;
}

test('табы настроек: клик по кнопке переключает панели чистым DOM', () => {
  const { sandbox, context } = loadApp();
  const personaBtn = makeTabButton('persona');
  const apiBtn = makeTabButton('api');
  const personaPanel = { hidden: false };
  const apiPanel = { hidden: true };
  const container = {
    querySelectorAll: (sel) => (sel === '.view-switch-btn' ? [personaBtn, apiBtn] : []),
  };
  sandbox.document.getElementById = (id) => {
    if (id === 'assistant-settings-switch') return container;
    if (id === 'assistant-persona-panel') return personaPanel;
    if (id === 'assistant-api-panel') return apiPanel;
    return null;
  };

  context.onAssistantSettingsTabClick({ target: apiBtn });
  assert.ok(apiBtn.classList.contains('is-active'), 'активный класс не переехал на API');
  assert.equal(personaBtn.classList.contains('is-active'), false);
  assert.equal(apiBtn.attrs['aria-selected'], 'true', 'aria-selected не обновился');
  assert.equal(personaPanel.hidden, true, 'панель персонализации должна скрыться');
  assert.equal(apiPanel.hidden, false, 'панель API должна показаться');

  // Обратное переключение
  context.onAssistantSettingsTabClick({ target: personaBtn });
  assert.ok(personaBtn.classList.contains('is-active'));
  assert.equal(personaPanel.hidden, false);
  assert.equal(apiPanel.hidden, true);

  // Мусорное значение таба ничего не переключает
  context.onAssistantSettingsTabClick({ target: makeTabButton('мусор') });
  assert.ok(personaBtn.classList.contains('is-active'),
    'чужое значение кнопки не должно сбивать выбор');

  // Клик мимо кнопок и вовсе без события — no-op без исключений
  context.onAssistantSettingsTabClick({ target: { closest: () => null } });
  context.onAssistantSettingsTabClick(null);
});

test('openAssistantKeyModal: стартовая вкладка — API без ключа, Персонализация с ключом', () => {
  const { sandbox, context } = loadApp();
  const personaBtn = makeTabButton('persona');
  const apiBtn = makeTabButton('api');
  personaBtn.classList.add('is-active');   // как в разметке по умолчанию
  const personaPanel = { hidden: false };
  const apiPanel = { hidden: true };
  const els = bindAssistantSettingsDom(sandbox, {
    'assistant-settings-switch': {
      querySelectorAll: (sel) => (sel === '.view-switch-btn' ? [personaBtn, apiBtn] : []),
    },
    'assistant-persona-panel': personaPanel,
    'assistant-api-panel': apiPanel,
  });

  // Ключа нет: модалка открылась на вкладке «API Ключ»
  context.openAssistantKeyModal();
  assert.equal(els['assistant-key-modal'].hidden, false, 'модалка должна открыться');
  assert.equal(apiBtn.classList.contains('is-active'), true,
    'без ключа должен открываться таб «API Ключ»');
  assert.equal(personaBtn.classList.contains('is-active'), false);
  assert.equal(apiPanel.hidden, false);
  assert.equal(personaPanel.hidden, true);

  // С ключом: по умолчанию — «Персонализация», контролы заполнены дефолтами
  sandbox.localStorage.setItem('youplanner.api_key', 'ключ');
  context.openAssistantKeyModal();
  assert.equal(personaBtn.classList.contains('is-active'), true,
    'с ключом должен открываться таб «Персонализация»');
  assert.equal(apiPanel.hidden, true);
  assert.equal(personaPanel.hidden, false);
  assert.equal(els['assistant-persona-instructions'].value, '', 'инструкции не заполнены');
  assert.equal(els['assistant-context-days'].value, '14', 'окно контекста не заполнено');
  assert.equal(els['assistant-temperature'].value, '0.3', 'температура не заполнена');
  assert.equal(els['assistant-max-tokens'].value, '1000', 'лимит не заполнен');
  assert.equal(els['assistant-shift-enter'].checked, false, 'тумблер должен быть выключен');
});

// --- Shift+Enter и Enter в поле ввода (textarea) ------------------------------
// #assistant-input теперь textarea: Enter нативно вставляет перенос, поэтому
// отправка живёт в keydown-обработчике. Shift+Enter вставляет перенос только
// при включённом тумблере персонализации, при выключенном — ничего не делает.
// Песочница KeyboardEvent не умеет — обработчик зовётся с фейковым объектом.

function makeKeyEvent(key, shiftKey) {
  const event = { key, shiftKey: Boolean(shiftKey), prevented: false, defaultPrevented: false };
  event.preventDefault = function () { event.prevented = true; };
  return event;
}

test('onAssistantInputKeydown: Enter отправляет всегда, Shift+Enter зависит от тумблера', async () => {
  const chat = makeChat();
  const { sandbox, context } = loadApp();
  const created = bindAssistantDom(sandbox, chat);
  const inputEl = { value: '', disabled: false, style: {} };
  const baseGet = sandbox.document.getElementById;
  sandbox.document.getElementById = (id) => (id === 'assistant-input' ? inputEl : baseGet(id));
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');

  const users = () => storedHistory(sandbox).filter((m) => m.role === 'user').length;

  // Тумблер выключен (дефолт): Enter — отправка
  inputEl.value = 'Первый вопрос';
  const enter = makeKeyEvent('Enter', false);
  context.onAssistantInputKeydown(enter);
  assert.ok(enter.prevented, 'Enter должен preventDefault: textarea иначе вставил бы перенос');
  assert.equal(users(), 1, 'Enter должен отправлять реплику');
  assert.equal(inputEl.value, '', 'поле должно очиститься после отправки');
  await settle();   // запрос в полёте гасится, busy снимается

  // Shift+Enter при выключенном тумблере: ни отправки, ни переноса
  inputEl.value = 'не должен отправиться';
  const shift = makeKeyEvent('Enter', true);
  context.onAssistantInputKeydown(shift);
  assert.ok(shift.prevented, 'Shift+Enter должен блокироваться — перенос запрещён тумблером');
  assert.equal(users(), 1, 'Shift+Enter при выключенном тумблере не должен отправлять');
  await settle();

  // Тумблер включён: Shift+Enter не блокируется (браузер вставит перенос сам)
  sandbox.localStorage.setItem(PERSONA_KEY, JSON.stringify({ shiftEnter: true }));
  const shift2 = makeKeyEvent('Enter', true);
  context.onAssistantInputKeydown(shift2);
  assert.equal(shift2.prevented, false, 'перенос строки должен быть разрешён');
  assert.equal(users(), 1, 'Shift+Enter с включённым тумблером не отправляет');

  // Enter отправляет и при включённом тумблере
  inputEl.value = 'Второй вопрос';
  const enter2 = makeKeyEvent('Enter', false);
  context.onAssistantInputKeydown(enter2);
  assert.ok(enter2.prevented);
  assert.equal(users(), 2, 'Enter должен отправлять всегда, независимо от тумблера');
  await settle();

  // Не-Enter в обработчике — no-op (авто-высота живёт на отдельном событии)
  const letter = makeKeyEvent('a', false);
  context.onAssistantInputKeydown(letter);
  assert.equal(letter.prevented, false);
  assert.equal(users(), 2, 'нажатие буквы не должно отправлять реплику');
  assert.ok(created.length > 0, 'пузыри реплик должны были создаться');
});
