// F6.4 (Раздел 6 ТЗ): точный перечень очистки без удаления рабочих функций.
// Проверено автором ТЗ: в локальной разметке «Экспорт чата», «Лимиты» и
// переключатель Shift+Enter НЕ найдены. Действие исполнителя — тест
// отсутствия этих элементов в Harness-разметке, не трогая
// #assistant-shift-enter (обычный ИИ-чат), #settings-export (экспорт данных
// YouPlanner) и настройки обычного чата.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = join(ROOT, 'index.html');
const CSS_PATH = join(ROOT, 'styles', 'harness.css');

function readIndexHtml() {
  return readFileSync(HTML_PATH, 'utf8');
}

// Блок #harness-view с учётом вложенности (section внутри section).
function harnessViewBlock(html) {
  const open = /<section[^>]*\bid="harness-view"[^>]*>/.exec(html);
  if (!open) return '';
  let depth = 1;
  const re = /<section\b|<\/section\s*>/gi;
  re.lastIndex = open.index + open[0].length;
  let m;
  let end = html.length;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') depth -= 1;
    else depth += 1;
    if (depth === 0) {
      end = m.index + m[0].length;
      break;
    }
  }
  return html.slice(open.index, end);
}

function harnessSources() {
  const files = ['firebase.js', 'chat.js', 'approvals.js', 'index.js',
    'viewport.js', 'settings.js', 'settings-view.js', 'commands.js'];
  return files
    .filter((name) => existsSync(join(ROOT, 'js', 'harness', name)))
    .map((name) => ['js/harness/' + name,
      readFileSync(join(ROOT, 'js', 'harness', name), 'utf8')]);
}

test('F6.4: «Экспорт чата»/«Экспорт» в Harness отсутствует (не найдено)', () => {
  const block = harnessViewBlock(readIndexHtml());
  assert.ok(block.length > 0, '#harness-view не найден');
  assert.doesNotMatch(block, /Экспорт/i,
    'в Harness-разметке нет «Экспорта» (фиктивная кнопка без обработчика)');
  // В js/harness важны UI-строки (Экспорт сразу после кавычки) и
  // export-подобные идентификаторы, а не слова в комментариях.
  for (const [name, source] of harnessSources()) {
    assert.doesNotMatch(source, /(['"`>])Экспорт/i,
      'в ' + name + ' нет UI-строки «Экспорт»');
    assert.doesNotMatch(source, /Экспорт чата|exportChat|harness-export/i,
      'в ' + name + ' нет логики экспорта чата');
  }
  const css = readFileSync(CSS_PATH, 'utf8');
  assert.doesNotMatch(css, /export-chat|exportChat/i,
    'в styles/harness.css нет стилей экспорта чата');
  // Рабочий экспорт данных YouPlanner не тронут — он вне Harness
  const html = readIndexHtml();
  assert.ok(html.includes('id="settings-export"'),
    '#settings-export (экспорт данных приложения) сохранён');
});

test('F6.4: фиктивные «Лимиты»/квоты/баланс в Harness отсутствуют; рабочий «Лимит ответа, токены» сохранён', () => {
  const block = harnessViewBlock(readIndexHtml());
  assert.doesNotMatch(block, /Квот|баланс|Лимиты/i,
    'нет фиктивных кнопок/счётчиков квот и баланса');
  // Единственный «лимит» в Harness — функциональный range настроек модели
  assert.ok(block.includes('id="harness-output-limit"'),
    'range «Лимит ответа, токены» (F6.2) сохранён — удалять его нельзя');
  assert.doesNotMatch(block, /id="harness-limits"|data-limits/i,
    'нет отдельного элемента «Лимиты»');
});

test('F6.4: переключатель/подсказка «Shift+Enter» в Harness отсутствует; обычный чат не тронут', () => {
  const block = harnessViewBlock(readIndexHtml());
  assert.doesNotMatch(block, /Shift\+Enter|shift-enter/i,
    'в Harness-разметке нет переключателя Shift+Enter');
  for (const [name, source] of harnessSources()) {
    assert.doesNotMatch(source, /Shift\+Enter|shiftEnter|shift-enter/i,
      'в ' + name + ' нет логики/хранилища Shift+Enter');
  }
  const html = readIndexHtml();
  assert.ok(html.includes('id="assistant-shift-enter"'),
    '#assistant-shift-enter (обычный ИИ-чат) сохранён без изменений');
  // Клавиатура композера Harness: Ctrl/Cmd+Enter — отправка, plain Enter —
  // новая строка, IME не отправляет (уже покрыто harness-chat тестами)
  const chat = readFileSync(join(ROOT, 'js', 'harness', 'chat.js'), 'utf8');
  assert.match(chat, /event\.ctrlKey \|\| event\.metaKey/);
  assert.doesNotMatch(chat, /shiftKey/i);
});

test('F6.4: резерв 84px и params.task как отправляемое заменены механизмами F6.1/F6.3', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  assert.doesNotMatch(css, /84px/, 'старый dock-резерв убран (F6.1)');
  for (const [name, source] of harnessSources()) {
    if (name === 'js/harness/commands.js' || name === 'js/harness/index.js') {
      // legacy-чтение textFromCommandParams допускает params.task;
      // отправка params.task запрещена (см. harness-contract)
      continue;
    }
    assert.doesNotMatch(source, /params:\s*\{\s*task:/,
      'в ' + name + ' нет отправки params.task');
  }
});
