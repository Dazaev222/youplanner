// YP-16: правила Realtime Database должны различать «свою» и «чужую» сессию.
//
// Предыстория: `database.rules.json` годами жил в форме
// `{".read": "auth != null", ".write": "auth != null"}` — то есть любая
// действующая сессия этого Firebase-проекта умела читать и ПЕРЕЗАПИСЫВАТЬ всё
// дерево. Аудит GPT (F1) предложил привязать правила к UID владельца. Так
// делать нельзя, и этот тест фиксирует почему:
//
//   * аутентификация здесь анонимная (js/data/firebase-auth.js: signUp
//     `anonymous` либо обмен refresh-токена), а анонимный UID выдаётся при
//     регистрации — У КАЖДОГО устройства свой. Правило вида
//     `auth.uid === '<один uid>'` отрезало бы второе и третье устройство
//     владельца, то есть сломало бы ровно ту синхронизацию, ради которой
//     всё затевалось;
//   * настоящего способа отличить владельца от посторонней анонимной сессии
//     на клиенте нет: custom-токен с claim `owner` mintится сервером (так
//     устроены права Mini App в telegram-bridge), а здесь сервера нет.
//
// Что реально улучшается и проверяется ниже: deny-by-default на корне
// (посторонняя сессия больше не трогает ничего вне рабочего узла), разрешение
// только на те узлы, которые приложение адресует явно, и обязательное
// `auth != null`. Это сужение области поражения, а не мнимая «защита от
// всего» — формулировка честная, потому что узел лежит в клиентском бандле.
//
// Публикация правил — ручной шаг владельца (README §«Безопасность Firebase»),
// тест проверяет текст файла, а не живую базу.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRules() {
  const source = readFileSync(join(ROOT, 'database.rules.json'), 'utf8');
  return JSON.parse(source).rules;
}

// Узлы, которые приложение адресует как корни запросов: FIREBASE_URL и
// FIREBASE_BACKUPS_URL. Берём из исходника, а не пересказываем, иначе тест
// проверял бы мои ожидания, а не контракт кода.
function readCloudRoots() {
  const source = readFileSync(join(ROOT, 'js/sync/core.js'), 'utf8');
  const roots = [];
  for (const name of ['FIREBASE_URL', 'FIREBASE_BACKUPS_URL']) {
    const match = source.match(new RegExp(name + "\\s*=\\s*'([^']+)'"));
    assert.ok(match, `в js/sync/core.js не найден ${name}`);
    const url = match[1];
    assert.ok(url.startsWith('https://'), `${name} обязан быть https`);
    const path = url.slice(url.indexOf('.com/') + '.com/'.length);
    const node = path.split('/')[0];
    assert.ok(node, `${name} обязан указывать на именованный узел`);
    roots.push(node);
  }
  return roots;
}

// Все разрешения в дереве правил: [{node, effect, expression}]
function collectGrants(rules, prefix = '') {
  const out = [];
  for (const key of Object.keys(rules)) {
    if (key === '.read' || key === '.write' || key === '.validate') {
      if (prefix !== '') out.push({ node: prefix, effect: key, expression: rules[key] });
      continue;
    }
    const value = rules[key];
    if (value && typeof value === 'object') {
      for (const effect of ['.read', '.write']) {
        if (Object.prototype.hasOwnProperty.call(value, effect)) {
          out.push({ node: key === prefix ? prefix : (prefix ? prefix + '/' + key : key),
            effect, expression: value[effect] });
        }
      }
      collectGrants(value, prefix ? prefix + '/' + key : key);
    }
  }
  return out;
}

test('корень правил ничего не разрешает: deny-by-default', () => {
  const rules = readRules();
  assert.equal(rules['.read'], false,
    '".read" на корне обязан быть false — иначе разрешение наследуется вниз и дочерний запрет его не отменит');
  assert.equal(rules['.write'], false,
    '".write" на корне обязан быть false: PUT-null по родителю снимает всё дерево');
});

test('разрешены ровно те узлы, которые адресует sync-слой', () => {
  const rules = readRules();
  const roots = readCloudRoots();
  const granted = Object.keys(rules).filter(k => !k.startsWith('.'));
  assert.deepEqual(granted.sort(), [...new Set(roots)].sort(),
    'правила и js/sync/core.js должны называть одни и те же узлы: расхождение ломает синхронизацию молча');
  for (const node of granted) {
    assert.ok(node.length >= 16, `узл «${node}» подозрительно короткий — его легко подобрать`);
    assert.doesNotMatch(node, /\$/, 'узлы в правилах — конкретные имена, а не шаблон $wildcard: шаблон открыл бы доступ всем узлам этого уровня');
  }
});

test('каждое разрешение требует аутентификации и не является «всегда да»', () => {
  const grants = collectGrants(readRules());
  assert.ok(grants.length >= 4, 'в правилах вообще нет разрешений — синхронизация не сможет работать');
  for (const grant of grants) {
    const expression = String(grant.expression);
    assert.notEqual(expression.trim(), 'true',
      `${grant.node}${grant.effect}: константа true — это публичный узел`);
    assert.match(expression, /auth\s*!=\s*null|auth\.uid|auth\.token/,
      `${grant.node}${grant.effect}: обязан проверять сессию`);
  }
});

test('в правилах нет захардкоженного UID — анонимный UID уникален на устройство', () => {
  const source = readFileSync(join(ROOT, 'database.rules.json'), 'utf8');
  assert.doesNotMatch(source, /auth\.uid\s*==+\s*['"][^'"]+['"]/,
    'привязка к одному анонимному UID отрезала бы остальные устройства владельца (см. докстринг файла)');
});

test('узлы правил не пересекаются как префиксы: разрешение не вытекает наружу', () => {
  const nodes = Object.keys(readRules()).filter(k => !k.startsWith('.')).sort();
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      assert.ok(!(b.startsWith(a + '/') || a.startsWith(b + '/')),
        `«${a}» и «${b}» вложены друг в друга — внешнее разрешение наследуется внутрь и внутреннее его не отменит`);
    }
  }
});
