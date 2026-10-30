// YP-09: список ASSETS в sw.js должен покрывать всё, что грузит приложение.
// Пропуск не виден в обычном прогоне (сеть есть), но офлайн-режим ломается
// молча: файл есть в index.html или в графе импортов, а в кэше его нет.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const posix = (path) => path.split(sep).join('/');
const isExternal = (href) => /^[a-z]+:/i.test(href) || href.startsWith('//');

function readAssets() {
  const source = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const match = source.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(match, 'в sw.js не найден массив ASSETS');
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (m) => m[1]);
}

function normalize(href) {
  return href.replace(/^\.\//, '');
}

// Стили и скрипты, подключённые в index.html напрямую (внешние CDN не в счёт).
function indexReferences() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const references = [];

  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = tag[0].match(/\brel=["']([^"']+)["']/i);
    const href = tag[0].match(/\bhref=["']([^"']+)["']/i);
    if (rel && href && rel[1].toLowerCase().includes('stylesheet') &&
        !isExternal(href[1])) {
      references.push(normalize(href[1]));
    }
  }
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = tag[0].match(/\bsrc=["']([^"']+)["']/i);
    if (src && !isExternal(src[1])) {
      references.push(normalize(src[1]));
    }
  }
  return references;
}

// Транзитивно собирает модули, которые загрузятся из точек входа:
// статические import ... from, побочные import '...' и динамические
// import('...'). Содержимое js/vendor не разбираем (минифицировано).
function moduleGraph(entries) {
  const seen = new Set();
  const broken = [];
  const queue = [...entries];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith('js/vendor/')) continue;

    const source = readFileSync(join(ROOT, file), 'utf8');
    const specifiers = [];
    for (const m of source.matchAll(/\bimport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
      specifiers.push(m[1]);
    }
    for (const m of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
      specifiers.push(m[1]);
    }
    for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      specifiers.push(m[1]);
    }

    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue;   // внешние и bare-пакеты
      const target = posix(relative(ROOT, resolve(ROOT, dirname(file), spec)));
      if (!existsSync(join(ROOT, target))) {
        broken.push(file + ' → ' + spec);
        continue;
      }
      queue.push(target);
    }
  }
  return { modules: [...seen], broken };
}

test('sw.js: ASSETS покрывает стили, скрипты и импорты index.html', () => {
  const assets = new Set(readAssets().map(normalize));
  const direct = indexReferences();
  const { modules, broken } = moduleGraph(direct.filter((f) => f.endsWith('.js')));

  assert.deepEqual(broken, [], 'битые импорты: ' + broken.join(', '));

  const missing = [...new Set([...direct, ...modules])]
    .filter((file) => !assets.has(file));
  assert.deepEqual(missing, [],
    'нет в ASSETS (офлайн-режим сломается): ' + missing.join(', '));
});

test('sw.js: каждый файл из ASSETS существует', () => {
  const missing = readAssets()
    .map(normalize)
    .filter((file) => file && !existsSync(join(ROOT, file)));
  assert.deepEqual(missing, [], 'в ASSETS есть несуществующие файлы: '
    + missing.join(', '));
});

// Аудит 2026-10-31: icon-512.png из manifest.json не кэшировался — офлайн-
// установка PWA оставалась без иконки. Манифест и precache не должны расходиться
test('sw.js: все иконки из manifest.json есть в ASSETS', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const assets = new Set(readAssets().map(normalize));

  const missing = (manifest.icons || [])
    .map((icon) => normalize(icon.src))
    .filter((src) => src && !assets.has(src));
  assert.deepEqual(missing, [], 'иконок из manifest.json нет в ASSETS: '
    + missing.join(', '));
});
