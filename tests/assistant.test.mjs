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
