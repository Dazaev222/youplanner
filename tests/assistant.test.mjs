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

// Абзац заданной длины с маркером внутри: 'абзац 007: слово ...'
function paragraph(n, marker, filler) {
  const word = filler || 'наполнение';
  let out = marker + ' ';
  while (out.length < n) out += word + ' ';
  return out.trim();
}

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
