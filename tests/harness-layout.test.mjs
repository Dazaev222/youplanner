// ТЗ U5.9.1 (первая партия): тесты РАСКЛАДКИ/СОСТОЯНИЙ и каркаса Harness
// фиксируются ДО реализации. Часть проверок статическая (index.html /
// harness.css / маршрутизация) — реальную геометрию на 390/768/1440/320 px
// проверяет браузер, и эти пункты отдельно помечены непроверенными в отчёте.
//
// Источники: MASTER_TZ_HARNESS_V2.md U5.1–U5.5, U5.9.1; CONTRACT-0.5 §3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/load-app.mjs';
import { readIndexHtml } from './helpers/sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function harnessCss() {
  const path = join(ROOT, 'styles', 'harness.css');
  assert.ok(existsSync(path), 'styles/harness.css не создан');
  return readFileSync(path, 'utf8');
}

// Один элемент по id из index.html с разбором его тега и внутренностей.
// Вложенность учитывается: #harness-messages — section внутри
// #harness-view, и первый </section> закрывает внутренний элемент.
function elementBlock(html, id) {
  const open = new RegExp('<([a-z0-9]+)([^>]*\\bid="' + id + '"[^>]*)>', 'i');
  const m = open.exec(html);
  if (!m) return null;
  const tag = m[1];
  const start = m.index;
  const tagRe = new RegExp('<' + tag + '\\b|</' + tag + '\\s*>', 'gi');
  tagRe.lastIndex = start + m[0].length;
  let depth = 1;
  let match;
  while ((match = tagRe.exec(html))) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) {
        return { tag, attrs: m[2], start, end: match.index + match[0].length };
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

test('U5.2: harness-view — section с точными атрибутами, а не второй main', () => {
  const html = readIndexHtml();
  const view = elementBlock(html, 'harness-view');
  assert.ok(view, 'в index.html нет #harness-view');
  assert.equal(view.tag, 'section',
    'при внешнем main контейнер Harness обязан быть section (U5.2)');
  assert.match(view.attrs, /class="harness-view"/);
  assert.match(view.attrs, /aria-labelledby="harness-title"/);
  assert.match(view.attrs, /hidden/);
  // Ровно один активный main в документе
  const mains = [...html.matchAll(/<main\b[^>]*>/gi)];
  assert.equal(mains.length, 1, 'main в документе должен остаться один');
});

test('U5.2: шапка Harness — назад/заголовок/presence/меню ПК', () => {
  const html = readIndexHtml();
  const head = elementBlock(html, undefined) || elementBlock(html, 'harness-view');
  const block = html.slice(head.start, head.end);
  assert.match(block, /<header class="harness-head">/);
  assert.match(block, /aria-label="Назад"/);
  assert.match(block, /<h1 id="harness-title">ПК-агент<\/h1>/);
  assert.match(block, /<p id="harness-presence" role="status">/);
  assert.match(block, /aria-label="Меню ПК"/);
  assert.match(block, /aria-expanded="false"/);
});

test('U5.2: лента, announcer и dock с точными именами', () => {
  const html = readIndexHtml();
  const view = elementBlock(html, 'harness-view');
  const block = html.slice(view.start, view.end);
  assert.match(block, /<section id="harness-messages" class="harness-messages" aria-label="Сообщения и задачи" tabindex="0">/);
  assert.match(block, /<ol class="harness-message-list"><\/ol>/);
  assert.match(block, /<p id="harness-announcer" class="harness-sr-only" role="status" aria-live="polite"><\/p>/);
  assert.match(block, /<footer class="harness-dock">/);
  assert.match(block, /id="harness-new-messages" class="harness-secondary" hidden/);
  assert.match(block, /id="harness-pending" class="harness-secondary" hidden/);
  assert.match(block, /<p id="harness-feedback" role="status" hidden><\/p>/);
  assert.match(block, /<form id="harness-form">/);
  assert.match(block, /<div class="harness-input-row">/);
  assert.match(block, /<textarea id="harness-input" rows="1" placeholder="Напишите задачу…" aria-describedby="harness-feedback"><\/textarea>/);
  assert.match(block, /<button id="harness-send" type="submit" aria-label="Отправить задачу">/);
});

test('U5.2: dialog подтверждения — рядом с корневой оболочкой, не внутри view', () => {
  const html = readIndexHtml();
  const view = elementBlock(html, 'harness-view');
  const dialog = elementBlock(html, 'harness-approval');
  assert.ok(dialog, 'в index.html нет #harness-approval');
  assert.ok(dialog.start < view.start || dialog.start > view.end,
    'dialog обязан стоять рядом с корневой оболочкой, не внутри скрываемой вкладки');
  assert.equal(dialog.tag, 'dialog');
  assert.match(dialog.attrs, /class="harness-approval"/);
  assert.match(dialog.attrs, /aria-labelledby="harness-approval-title"/);
  assert.match(dialog.attrs, /aria-describedby="harness-approval-summary"/);
  const block = html.slice(dialog.start, dialog.end);
  assert.match(block, /<h2 id="harness-approval-title" tabindex="-1">Требуется подтверждение<\/h2>/);
  assert.match(block, /<p class="harness-approval-counter"><\/p>/);
  assert.match(block, /<p id="harness-approval-summary"><\/p>/);
  assert.match(block, /<dl class="harness-approval-facts"><\/dl>/);
  assert.match(block, /<details class="harness-approval-details">/);
  assert.match(block, /<summary>Точная команда и параметры<\/summary>/);
  assert.match(block, /<pre class="harness-approval-arguments"><\/pre>/);
  assert.match(block, /<p class="harness-approval-state" role="status" aria-live="polite"><\/p>/);
  assert.match(block, /<button type="button" class="harness-reject">Отклонить<\/button>/);
  assert.match(block, /<button type="button" class="harness-approve">Разрешить один раз<\/button>/);
  assert.match(block, /<button type="button" class="harness-collapse">Свернуть без решения<\/button>/);
  // Решения не через form method="dialog": автозакрытие не запись в Firebase
  assert.doesNotMatch(block, /method="dialog"/i);
});

test('U5.2: кнопки каркаса — type="button", иконки SVG с currentColor, без emoji', () => {
  const html = readIndexHtml();
  const view = elementBlock(html, 'harness-view');
  const dialog = elementBlock(html, 'harness-approval');
  const block = html.slice(view.start, view.end) + html.slice(dialog.start, dialog.end);
  // Кнопки вне отправки формы обязаны быть type="button"
  for (const m of block.matchAll(/<button\b([^>]*)>/gi)) {
    const attrs = m[1];
    const isSubmit = /type="submit"/.test(attrs);
    assert.ok(isSubmit || /type="button"/.test(attrs),
      'кнопка Harness без type: <button' + attrs + '>');
  }
  assert.doesNotMatch(block, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    'в каркасе Harness эмодзи запрещены — только SVG');
  assert.match(block, /aria-hidden="true"/, 'иконки должны быть aria-hidden');
  assert.match(block, /currentColor/, 'иконки наследуют цвет (currentColor)');
});

test('U5.3: harness.css подключён после tokens.css по схеме проекта', () => {
  const html = readIndexHtml();
  const tokensAt = html.indexOf('styles/tokens.css');
  const harnessAt = html.indexOf('styles/harness.css');
  assert.ok(tokensAt !== -1, 'styles/tokens.css исчез из index.html');
  assert.ok(harnessAt !== -1, 'styles/harness.css не подключён в index.html');
  assert.ok(harnessAt > tokensAt, 'harness.css обязан идти после tokens.css');
});

test('U5.3: токены Harness — только var(--…), радиусы/тени из assistant.css', () => {
  const css = harnessCss();
  // Защита от «своей палитры»: области Harness используют существующие токены
  assert.match(css, /color-scheme:\s*light/, 'в области Harness color-scheme: light');
  assert.match(css, /var\(--accent\)/);
  assert.match(css, /var\(--bg\)/);
  assert.match(css, /var\(--surface-card\)/);
  assert.match(css, /var\(--radius-pill\)/);
  // Хвост пузырей 4px и тень ответа — точное повторение assistant.css
  assert.match(css, /var\(--radius-lg\) var\(--radius-lg\) 4px var\(--radius-lg\)/,
    'хвост пузыря владельца, как в assistant.css');
  assert.match(css, /0 1px 3px rgba\(0, ?0, ?0, ?0?\.05\)/,
    'тень ответа ассистента, как в assistant.css');
  // ::backdrop — единственный новый полупрозрачный слой
  assert.match(css, /rgba\(20, ?20, ?40, ?0?\.12\)/, 'backdrop rgba(20,20,40,.12)');
});

test('U5.4: геометрия — 44px, textarea 16px/126px, колонка 760px от 768px', () => {
  const css = harnessCss();
  assert.match(css, /min-height:\s*44px/, 'интерактивные цели 44px');
  assert.match(css, /font-size:\s*16px/, 'textarea 16px против авто-зума iOS');
  assert.match(css, /max-height:\s*126px/, 'рост textarea до ~5 строк');
  assert.match(css, /100dvh/, 'полноэкранный режим через dvh');
  assert.match(css, /env\(safe-area-inset-bottom/, 'safe-area в dock');
  assert.match(css, /max-width:\s*760px/, 'колонка max-width:760px от 768px');
  assert.match(css, /@media \(min-width:\s*768px\)/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    'scoped [hidden] обязан побеждать display:flex');
});

test('U5.3/U5.5: focus-visible, reduced-motion, disabled без opacity/filter', () => {
  const css = harnessCss();
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  assert.match(css, /prefers-reduced-motion: reduce/,
    'анимации отключаются при reduced-motion');
  assert.match(css, /cursor:\s*not-allowed/, 'disabled-кнопки дают not-allowed');
  assert.match(css, /var\(--surface-pressed\)/, 'disabled-заливка --surface-pressed');
  assert.doesNotMatch(css, /opacity:\s*0\.[0-9]+\s*;?\s*\/\* disabled/,
    'disabled без снижения opacity');
  assert.match(css, /\(hover:\s*hover\)/, 'hover только под (hover: hover)');
});

test('маршрут harness существует и подсвечивает свою вкладку', () => {
  const ctx = loadApp().context;
  assert.ok(ctx.screenNames().includes('harness'),
    'экран harness не зарегистрирован в реестре SCREENS');
  assert.equal(ctx.tabFor('harness'), 'main',
    'вход в ПК-агент — с главной, подсветка «Главного»');
});

test('безопасный вывод: в js/harness нет innerHTML', () => {
  const files = ['firebase.js', 'chat.js', 'approvals.js', 'index.js'];
  for (const name of files) {
    const path = join(ROOT, 'js', 'harness', name);
    assert.ok(existsSync(path), 'js/harness/' + name + ' не создан');
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\.innerHTML\s*=/,
      'в js/harness/' + name + ' innerHTML запрещён — только textContent (U5.6.1)');
    assert.doesNotMatch(source, /insertAdjacentHTML|document\.write/,
      'в js/harness/' + name + ' есть HTML-инъекция');
  }
});

test('sw.js: ASSETS покрывает harness-файлы (офлайн-режим)', () => {
  const assets = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.match(assets, /['"]\.\/styles\/harness\.css['"]/,
    'styles/harness.css не в ASSETS св-воркера');
  for (const name of ['firebase.js', 'chat.js', 'approvals.js', 'index.js']) {
    assert.match(assets, new RegExp("['\"]\\./js/harness/" + name + "['\"]"),
      'js/harness/' + name + ' не в ASSETS св-воркера');
  }
});
