// Дымовые тесты YouPlanner. Только стандартная библиотека Node — ставить
// ничего не нужно: `npm test` (или `node --test tests/*.test.mjs`).
//
// Зачем: ревью 2026-10-16 нашло, что приложение падало при запуске —
// switchAppView() обращался к #task-add-btn удалённой вкладки задач,
// из-за чего не стартовали навигация, таймер молитв и синхронизация.
// Такие поломки ловятся сверкой «каждый id из JS есть в разметке» —
// она и есть ядро этого файла.
//
// С Фазы 2 декомпозиции код приложения — это несколько <script src>
// (js/data/*.js) плюс инлайн-скрипт. Проверки работают с конкатенацией
// всех источников в порядке подключения — ровно то, что исполняет браузер.
// Порядок и состав источников — tests/helpers/sources.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  readIndexHtml, getEntry, getModuleOrder, getAppJs, stripModuleSyntax,
} from './helpers/sources.mjs';

const html = readIndexHtml();
const js = getAppJs();
// Статичная разметка — всё до первого тега <script: id, которые JS создаёт
// сам через innerHTML-шаблоны, сюда не попадают и в сверку не идут.
const markup = html.slice(0, html.indexOf('<script'));
const markupIds = new Set(
  [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]),
);

test('приложение подключается модулем js/app.js', () => {
  assert.equal(getEntry(), 'js/app.js',
    'вход приложения должен быть ES-модулем js/app.js');
  assert.ok(existsSync(join(process.cwd(), 'js/app.js')) === true ||
    getModuleOrder().includes('js/app.js'), 'js/app.js не входит в граф модулей');
});

test('граф модулей разрешается, все файлы непустые и валидные', () => {
  const order = getModuleOrder();
  assert.ok(order.length >= 20, `граф подозрительно мал: ${order.length} файлов`);
  for (const file of order) {
    assert.ok(existsSync(join(process.cwd(), file)), `файл модуля не найден: ${file}`);
    const code = readFileSync(join(process.cwd(), file), 'utf8');
    assert.ok(code.trim().length > 0, `${file} пуст`);
    assert.doesNotThrow(() => new Function(stripModuleSyntax(code)),
      `${file}: синтаксическая ошибка`);
  }
});

test('каждый именованный import находит реальный export', () => {
  // вырезанный import-синтаксис должен соответствовать настоящим export'ам —
  // иначе браузер упадёт на загрузке модуля, а конкатенация этого не видит
  for (const file of getModuleOrder()) {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    const importBlockRe = /^import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
    for (const m of text.matchAll(importBlockRe)) {
      const names = m[1].split(',').map((s) => s.trim())
        .filter(Boolean).map((s) => s.split(/\s+as\s+/)[0]);
      const targetAbs = resolve(dirname(join(process.cwd(), file)), m[2]);
      assert.ok(existsSync(targetAbs), `${file}: import ${m[2]} не разрешается`);
      const targetText = readFileSync(targetAbs, 'utf8');
      const exported = new Set(
        [...targetText.matchAll(/^export\s+(?:const|let|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gm)]
          .map((x) => x[1]));
      for (const name of names) {
        assert.ok(exported.has(name),
          `${file}: импорт ${name} из ${m[2]} не экспортирован`);
      }
    }
  }
});

test('нет неявных зависимостей: чужое имя обязано быть в import', () => {
  // Конкатенация для песочницы прямет дыры связывания: имя, не вставленное
  // в import, разрешится в конкатенации глобально — а в браузере модуль
  // упадёт с ReferenceError. Правило: если файл использует имя,
  // экспортированное другим файлом, оно обязано стоять в его import-строке.
  const files = getModuleOrder();
  const ownerOf = new Map();
  for (const file of files) {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    for (const m of text.matchAll(/^export\s+(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      ownerOf.set(m[1], file);
    }
  }
  const KEYWORDS = new Set(('const let function var if else for while do return switch ' +
    'case break continue new typeof instanceof in of this null true false undefined try ' +
    'catch finally throw import export from as default class extends super delete void ' +
    'yield async await static get set document window localStorage navigator console ' +
    'performance fetch JSON Math Object Array String Number Boolean Date Promise Set Map ' +
    'RegExp Error isNaN isFinite parseInt parseFloat encodeURIComponent ' +
    'requestAnimationFrame MutationObserver ResizeObserver CSS Blob URL FileReader alert ' +
    'confirm').split(' '));
  for (const file of files) {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    const imported = new Set();
    for (const m of text.matchAll(/^import\s+\{([^}]*)\}\s+from/gm)) {
      m[1].split(',').map((s) => s.trim()).filter(Boolean)
        .forEach((s) => imported.add(s.split(/\s+as\s+/)[0]));
    }
    const declared = new Set([...text.matchAll(
      /^(?:export\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
    // код без строк и комментариев
    let code = '';
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
      code += ch;
    }
    const missing = new Set();
    for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      if (KEYWORDS.has(name) || declared.has(name) || imported.has(name)) continue;
      if (ownerOf.has(name)) missing.add(`${name} (из ${ownerOf.get(name)})`);
    }
    assert.deepEqual([...missing].sort(), [],
      `${file} использует чужие экспорты без import — в браузере это ReferenceError`);
  }
});

test('весь код приложения синтаксически валиден', () => {
  // new Function только парсит тело, но не выполняет его.
  assert.doesNotThrow(() => new Function(js));
});

test('нет дублей верхнеуровневых объявлений между скриптами', () => {
  // Повторное const/let/function на глобальном уровне — SyntaxError при
  // загрузке второго скрипта. Классическая ловушка разбиения на файлы,
  // поэтому охраняется тестом, а не надеждой.
  const names = new Map();
  for (const m of js.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    assert.ok(!names.has(m[1]), `дубль объявления: ${m[1]}`);
    names.set(m[1], 'var');
  }
  for (const m of js.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) {
    assert.ok(!names.has(m[1]), `дубль объявления: function ${m[1]}`);
    names.set(m[1], 'function');
  }
});

test('в статичной разметке нет инлайн-обработчиков', () => {
  // Обработчики живут только в bindEvents(): инлайн-onclick требует
  // глобальной функции и ломается при переходе на ES-модули (Фаза 3).
  // Уровни, шторки и модалки закрываются через data-атрибуты.
  const handlers = [...markup.matchAll(/\son[a-z]+="[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(handlers, [],
    `инлайн-обработчики в разметке: ${handlers.join(', ')}`);
});

test('в статичной разметке нет дублей id', () => {
  const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `дубли id в разметке: ${dupes.join(', ')}`);
});

test('каждый getElementById(...) находит элемент в разметке', () => {
  const refs = [
    ...new Set(
      [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ),
  ];
  const missing = refs.filter((id) => !markupIds.has(id));
  assert.deepEqual(
    missing,
    [],
    `getElementById обращается к отсутствующим id: ${missing.join(', ')}. ` +
      'Либо верните элементы в разметку, либо уберите обращения вместе ' +
      'с мёртвым кодом (как было с вкладкой задач).',
  );
});

test('каждый селектор вида querySelector(\'#id …\') находит элемент', () => {
  const refs = [
    ...new Set(
      [...js.matchAll(/querySelector(?:All)?\('#([A-Za-z0-9_-]+)/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  const missing = refs.filter((id) => !markupIds.has(id));
  assert.deepEqual(
    missing,
    [],
    `querySelector обращается к отсутствующим id: ${missing.join(', ')}`,
  );
});

test('снятая вкладка задач не оставила висячих ссылок', () => {
  // Раздел задач удалён из продукта: разметки нет, данные мигрирует
  // migrateDropTasks(), бэкапы с разделом tasks отвергаются. Оставаться
  // могут только сама миграция и проверка data.tasks в parseBackup.
  const dangling = [
    'renderTasksView',
    'loadTasks',
    'saveTasks',
    'addTask(',
    'updateTask(',
    'deleteTask(',
    'openTaskSheet',
    'closeTaskSheet',
    'task-add-btn',
    'tasks-view',
    'id="task-',
    "name !== 'tasks'",
    "name === 'tasks'",
  ].filter((token) => html.includes(token));
  assert.deepEqual(
    dangling,
    [],
    `остались ссылки на удалённый раздел задач: ${dangling.join(', ')}`,
  );
  // А миграция очистки старых данных обязана остаться.
  assert.ok(
    js.includes('function migrateDropTasks()'),
    'migrateDropTasks() пропала: старые данные задач перестанут чиститься',
  );
});

test('облачные бэкапы не лежат внутри синхронизируемого узла', () => {
  // PUT на узел Firebase заменяет его целиком вместе с детьми: бэкапы
  // ребёнком основного узла стирались каждой синхронизацией.
  const urlMatch = js.match(/const FIREBASE_URL = '([^']+)'/);
  const backupsMatch = js.match(/const FIREBASE_BACKUPS_URL = '([^']+)'/);
  assert.ok(urlMatch, 'не найдена константа FIREBASE_URL');
  assert.ok(backupsMatch, 'не найдена константа FIREBASE_BACKUPS_URL');
  assert.notEqual(backupsMatch[1], urlMatch[1]);
  assert.ok(
    !backupsMatch[1].startsWith(urlMatch[1] + '/'),
    'FIREBASE_BACKUPS_URL вложен в FIREBASE_URL: PUT данных сотрёт бэкапы',
  );
  assert.ok(
    !js.includes("FIREBASE_URL + '/backups"),
    'осталось обращение к вложенному /backups внутри узла данных',
  );
  const start = js.indexOf('function backupCloudSnapshot()');
  const end = js.indexOf('function scheduleSync()', start);
  assert.ok(start !== -1 && end > start, 'не найдена backupCloudSnapshot()');
  assert.ok(
    js.slice(start, end).includes('FIREBASE_BACKUPS_URL'),
    'backupCloudSnapshot() не использует отдельный узел бэкапов',
  );
});
