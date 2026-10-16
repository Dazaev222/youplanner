// Дымовые тесты YouPlanner. Только стандартная библиотека Node — ставить
// ничего не нужно: `npm test` (или `node --test tests/smoke.test.mjs`).
//
// Зачем: ревью 2026-10-16 нашло, что приложение падало при запуске —
// switchAppView() обращался к #task-add-btn удалённой вкладки задач,
// из-за чего не стартовали навигация, таймер молитв и синхронизация.
// Такие поломки ловятся сверкой «каждый id из JS есть в разметке» —
// она и есть ядро этого файла.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
const js = scriptMatch ? scriptMatch[1] : '';
// Статичная разметка — всё до скрипта: id, которые JS создаёт сам
// через innerHTML-шаблоны, сюда не попадают и в сверку не идут.
const markup = html.slice(0, html.indexOf('<script>'));
const markupIds = new Set(
  [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]),
);

test('в index.html есть встроенный скрипт', () => {
  assert.ok(scriptMatch, 'не найден блок <script>…</script>');
  assert.ok(js.trim().length > 0, 'скрипт пуст');
});

test('скрипт синтаксически валиден', () => {
  // new Function только парсит тело, но не выполняет его.
  assert.doesNotThrow(() => new Function(js));
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
