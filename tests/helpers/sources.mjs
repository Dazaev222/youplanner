// Источники JS приложения в порядке подключения: файлы <script src> по
// порядку из index.html, затем инлайн-скрипт. Единая точка правды для
// тестов: smoke проверяет синтаксис конкатенации, песочница — исполняет её.
// Когда инлайн-скрипт переедет в модули (Фаза 3), расширится только этот
// файл — сами тесты менять будет не нужно.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX_PATH = join(root, 'index.html');

export function readIndexHtml() {
  return readFileSync(INDEX_PATH, 'utf8');
}

export function getScriptSources() {
  const html = readIndexHtml();
  const files = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1])
    .map((path) => ({
      type: 'file',
      path,
      code: readFileSync(join(root, path), 'utf8'),
    }));
  const inline = html.match(/<script>([\s\S]*)<\/script>/);
  const inlineSource = {
    type: 'inline',
    path: 'index.html (инлайн)',
    code: inline ? inline[1] : '',
  };
  return [...files, inlineSource];
}

// Весь JS приложения одним куском — как его видит браузер,
// выполняющий скрипты по порядку подключения.
export function getAppJs() {
  return getScriptSources().map((s) => s.code).join('\n');
}
