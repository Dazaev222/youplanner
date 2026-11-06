// Задача 2.1 (P1-4 из GPT-аудита): Content-Security-Policy в index.html.
//
// Мета-CSP держит политику честной в обе стороны:
//   * без забытых хостов — всё, к чему код реально ходит, покрыто connect-src,
//     иначе фича молча ломается под CSP (запрос отклонён, UI думает «нет сети»);
//   * без ослаблений «на вырост» — лишние источники в connect-src это дыра
//     (украденный через XSS токен уезжает на хост атакующего), поэтому тест
//     требует и обратного: в connect-src нет хостов, которых нет в коде.
//
// Аудит, на котором построен файл (2026-11-06):
//   * index.html: единственный скрипт — внешний модуль js/app.js (низ body);
//     inline-скриптов и on*=-обработчиков нет; в js/ нет eval/new Function и
//     строковых setTimeout — script-src 'self' ничего не ломает;
//   * сеть — только REST fetch, WebSocket/EventSource/XHR в коде нет:
//       - youplanner-5c2f5-default-rtdb.firebaseio.com — js/sync/core.js:22,27;
//       - identitytoolkit.googleapis.com — js/data/firebase-auth.js:190,255;
//       - securetoken.googleapis.com — js/data/firebase-auth.js:275;
//       - api.neuraldeep.ru — js/ui/assistant-media.js:34;
//   * шрифты Inter — Google Fonts: stylesheet fonts.googleapis.com
//     (index.html:18 → style-src) и woff2-файлы fonts.gstatic.com
//     (index.html:17 → font-src); это ресурсы, а не соединения, поэтому
//     их место НЕ в connect-src (см. тест про ресурсы ниже);
//   * картинки — favicon 'self' (index.html:11-13), фото пользователя
//     blob:-URL (js/app.js:1217,1270,1237; js/data/image.js:43-51),
//     вложения ассистента data:-URL (js/ui/assistant-view.js:979,
//     js/ui/assistant-pdf.js:419);
//   * pdf.js — воркер same-origin: js/ui/assistant-pdf.js:446 задаёт
//     workerSrc прямым путём (js/vendor/pdf.worker.min.mjs), pdf.min.mjs
//     создаёт new Worker(url, {type:'module'}), blob-обёртка (_createCDNWrapper)
//     включается только для cross-origin workerSrc — blob: в worker-src не нужен;
//   * свг-пространства имён в vendor (w3.org, adobe, xfa) — идентификаторы,
//     по ним сеть не ходит; vendor минифицирован и парсером не разбирается
//     (правило то же, что в tests/sw-assets.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const posix = (path) => path.split(sep).join('/');

function readIndexHtml() {
  return readFileSync(join(ROOT, 'index.html'), 'utf8');
}

// Достаёт значение мета-CSP; порядок атрибутов не важен.
function readCsp() {
  const html = readIndexHtml();
  const tag = html.match(
    /<meta\b[^>]*\bhttp-equiv=["']Content-Security-Policy["'][^>]*>/i) ||
    html.match(
    /<meta\b[^>]*\bcontent=["'][^"']*["'][^>]*\bhttp-equiv=["']Content-Security-Policy["'][^>]*>/i);
  assert.ok(tag, 'в index.html нет мета-тега CSP (http-equiv="Content-Security-Policy")');
  // Пробел перед content обязателен, иначе матчнется «Content» внутри
  // значения http-equiv="Content-Security-Policy". Разделитель — обратная
  // ссылка: в значении есть одинарные кавычки ('self'), поэтому класс
  // [^"'] здесь не годится.
  const content = tag[0].match(/\scontent=(["'])([\s\S]*?)\1/i);
  assert.ok(content, 'у мета-CSP нет атрибута content');
  // Группа 2: группа 1 — сам разделитель (кавычка).
  return content[2];
}

// «default-src 'self'; script-src 'self'» → Map { default-src: ['self'], ... }
function parsePolicy(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    directives.set(tokens[0].toLowerCase(), tokens.slice(1));
  }
  return directives;
}

// Все js-файлы приложения рекурсивно, кроме js/vendor (минифицирован).
function listAppJs() {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name.endsWith('.js')) {
        files.push(posix(relative(ROOT, path)));
      }
    }
  })(join(ROOT, 'js'));
  return files.filter((file) => !file.startsWith('js/vendor/'));
}

// Сетевые хосты из URL-литералов кода приложения. Литералы https/wss в js/
// в этом проекте бывают только у адресов, к которым код реально ходит
// (fetch): аудит 2026-11-06 не нашёл иных сетевых API — WebSocket,
// EventSource, XHR и sendBeacon отсутствуют. Хост из относительного
// new URL(..., document.baseURI) (js/ui/assistant-pdf.js:58-59) литералом
// не является и потому не попадает — он same-origin, его покрывает 'self'.
function jsNetworkHosts() {
  const hosts = new Set();
  for (const file of listAppJs()) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const m of source.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)) {
      hosts.add(m[1].toLowerCase());
    }
  }
  return [...hosts];
}

// Значения директивы, являющиеся источниками-хостами (scheme://host).
function policyHosts(directives, name) {
  return (directives.get(name) || [])
    .map((value) => value.toLowerCase())
    .filter((value) => /^[a-z]+:\/\//.test(value));
}

test('CSP: мета-тег есть и держит базовый набор директив', () => {
  const policy = parsePolicy(readCsp());

  // База из задачи 2.1: изолируемся от чужого origin, инъекций скриптов,
  // плагинов, подмены base и отправки форм наружу.
  assert.deepEqual(policy.get('default-src'), ["'self'"],
    "default-src должен быть 'self'");
  assert.deepEqual(policy.get('script-src'), ["'self'"],
    "script-src должен быть 'self'");
  assert.deepEqual(policy.get('base-uri'), ["'self'"], "base-uri должен быть 'self'");
  assert.deepEqual(policy.get('object-src'), ["'none'"],
    "object-src должен быть 'none'");
  assert.deepEqual(policy.get('form-action'), ["'none'"],
    "form-action должен быть 'none'");
});

test('CSP: каждый сетевой хост из js/ покрыт connect-src, и только он', () => {
  const policy = parsePolicy(readCsp());
  const connectHosts = policyHosts(policy, 'connect-src');
  const codeHosts = jsNetworkHosts();

  assert.ok(codeHosts.length > 0,
    'парсер не нашёл ни одного сетевого хоста в js/ — проверь разбор');

  // (б) из задачи: каждый хост, к которому ходит код, разрешён в connect-src.
  const missing = codeHosts
    .filter((host) => !connectHosts.some((entry) => entry.endsWith(host)));
  assert.deepEqual(missing, [],
    'хостов нет в connect-src (запросы под CSP будут отклонены): ' + missing.join(', '));

  // Обратная сторона «точного списка»: хост в connect-src, которого нет в
  // коде, — ослабление без причины (куда-то уехал хост кода — почини политику
  // или разбор; появился новый хост в коде — обнови connect-src).
  const extra = connectHosts
    .filter((entry) => !codeHosts.some((host) => entry.endsWith(host)));
  assert.deepEqual(extra, [],
    'в connect-src есть хосты, которых нет в js/: ' + extra.join(', '));
});

test('CSP: ресурсы index.html покрыты своими директивами', () => {
  const html = readIndexHtml();
  const policy = parsePolicy(readCsp());

  // Шрифты Google Fonts — ресурсы, а не соединения: stylesheet идёт в
  // style-src, файлы шрифта — в font-src. Класть их в connect-src значило бы
  // разрешать и fetch на эти хосты — расширение без необходимости.
  assert.ok(policy.get('style-src').includes('https://fonts.googleapis.com'),
    'style-src должен разрешать stylesheet Google Fonts (index.html:18)');
  assert.ok(policy.get('font-src').includes('https://fonts.gstatic.com'),
    'font-src должен разрешать woff2 с fonts.gstatic.com (index.html:16-17)');

  // Манифест PWA подключён относительной ссылкой — покрывается 'self'.
  assert.ok(policy.get('manifest-src').includes("'self'"),
    'manifest-src должен быть self (manifest.json подключён в index.html:14)');

  // Фавиконы — относительные пути, их покрывает img-src 'self'.
  assert.ok(policy.get('img-src').includes("'self'"),
    "img-src должен быть 'self' (фавиконы index.html:11-13)");

  // Ослабления img-src обоснованы аудитом: blob: — фото пользователя
  // (фон приложения из IndexedDB, превью в настройках, декодирование),
  // data: — вложения ассистента (фото и страницы PDF-скана).
  assert.ok(policy.get('img-src').includes('blob:'),
    'img-src должен разрешать blob: (фото пользователя, js/app.js:1217,1270)');
  assert.ok(policy.get('img-src').includes('data:'),
    'img-src должен разрешать data: (вложения ассистента, js/ui/assistant-view.js:979)');

  // Ослабление style-src: 'unsafe-inline' нужен, потому что в проекте есть
  // инлайн-стили-АТРИБУТЫ: статические в body index.html (блок
  // schedule-edit-view, body по условию задачи не трогается) и инъекция
  // через innerHTML (js/ui/main-table.js:134, js/ui/schedule-view.js:40-41).
  // CSSOM-присваивания
  // (el.style.x, setProperty) CSP не блокирует, а <style>-элементов и
  // инлайн-обработчиков стилей нет. Сужение до style-src-attr не годится:
  // Safari < 15.4 его не знает, а проект явно держит старые Safari
  // (fallback в js/sync/sync.js:32-38).
  assert.ok(policy.get('style-src').includes("'unsafe-inline'"),
    'style-src должен разрешать инлайн-стили-атрибуты (index.html, блок schedule-edit-view; main-table.js:134)');

  // pdf.js: воркер same-origin (assistant-pdf.js:446, blob-обёртка только для
  // cross-origin) — 'self' достаточно, blob: в worker-src не нужен.
  assert.deepEqual(policy.get('worker-src'), ["'self'"],
    "worker-src должен быть ровно 'self' (воркер pdf.js same-origin)");

  // Сервис-воркер CSP страницы не подчиняется, но регистрация './sw.js'
  // (js/app.js:1580) тоже same-origin — 'self' её не мешает в любом случае.
});

test('CSP: в index.html нет inline-обработчиков on*=', () => {
  // Обработчик-атрибут выполнялся бы только с 'unsafe-inline' в script-src,
  // которого в политике нет: любой on*= сломал бы страницу молча. Поэтому
  // тест ловит его появление, а не терпит: расширять script-src до
  // unsafe-hashes под каждый обработчик — отдельное решение (см. задачу 2.1,
  // пункт «в»).
  const html = readIndexHtml();
  const offenders = [];
  const lines = html.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/\son[a-z]+\s*=/i);
    if (match) offenders.push('строка ' + (i + 1) + ': ' + lines[i].trim());
  }
  assert.deepEqual(offenders, [],
    'в index.html есть inline-обработчики on*= (сломаются под script-src \'self\'):\n' +
    offenders.join('\n'));
});

test('CSP: в index.html нет inline-скриптов', () => {
  // <script> без src под script-src 'self' не выполнится: тест держит
  // правило «код — только в модулях js/», как сейчас (index.html, низ body).
  const inline = [];
  const lines = readIndexHtml().split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const tag of lines[i].matchAll(/<script\b[^>]*>/gi)) {
      if (!/\bsrc\s*=/.test(tag[0])) inline.push('строка ' + (i + 1));
    }
  }
  assert.deepEqual(inline, [],
    'в index.html есть inline-<script> (сломаются под script-src \'self\'): ' +
    inline.join(', '));
});
