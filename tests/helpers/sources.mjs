// Источники JS приложения в порядке загрузки. С Фазы 3.2b приложение —
// граф ES-модулей с корнем js/app.js. Для песочницы и статических проверок
// модульный синтаксис снимается (import-строки вырезаются, export-префиксы
// убираются): в порядке «зависимости раньше импортёра» конкатенация
// эквивалентна прежнему набору классических скриптов.

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX_PATH = join(root, 'index.html');
const ENTRY_RE = /<script type="module" src="([^"]+)"><\/script>/;
const IMPORT_RE = /^import\s+(?:[\w$*\s{},]+?\s+from\s+)?['"]([^'"]+)['"];?\s*$/gm;
const SIDE_EFFECT_IMPORT_RE = /^import\s+['"]([^'"]+)['"];?\s*$/gm;

export function readIndexHtml() {
  return readFileSync(INDEX_PATH, 'utf8');
}

export function getEntry() {
  const m = ENTRY_RE.exec(readIndexHtml());
  if (!m) throw new Error('в index.html нет <script type="module"> — вход приложения потерян');
  return m[1];
}

// Граф модулей: список файлов в порядке «зависимости раньше импортёра»
export function getModuleOrder() {
  const order = [];
  const seen = new Set();
  const entry = getEntry();
  const walk = (file) => {
    if (seen.has(file)) return;
    // защита от циклов: помечаем до обхода зависимостей
    seen.add(file);
    const text = readFileSync(join(root, file), 'utf8');
    for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const target = relative(root, resolve(dirname(join(root, file)), m[1]))
          .replace(/\\/g, '/');
        walk(target);
      }
    }
    order.push(file);
  };
  walk(entry);
  return order;
}

// Модульный файл как классический код: без import-строк и export-префиксов.
// async-экспорты (export async function) — тоже модульный синтаксис:
// регулярка ниже снимает и их, иначе песочница падает на 'Unexpected
// token export'
export function stripModuleSyntax(text) {
  return text
    .replace(IMPORT_RE, '')
    .replace(SIDE_EFFECT_IMPORT_RE, '')
    .replace(/^export\s+(?=const\b|let\b|function\b|class\b|async\s+function\b)/gm, '');
}

export function getScriptSources() {
  return getModuleOrder().map((path) => ({
    type: 'module',
    path,
    code: readFileSync(join(root, path), 'utf8'),
  }));
}

// Весь JS приложения одним куском — эквивалент прежней конкатенации
// классических скриптов, порядок — по графу импортов.
export function getAppJs() {
  return getScriptSources()
    .map((s) => stripModuleSyntax(s.code))
    .join('\n');
}
