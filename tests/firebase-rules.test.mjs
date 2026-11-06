// Правила Realtime Database: доступ — только сессии владельца (YP-F1, путь 1).
//
// Эволюция контракта, важна предыстория:
//   1. `{".read": "auth != null", ".write": "auth != null"}` на всё дерево —
//      любая действующая сессия проекта читала и ПЕРЕЗАПИСЫВАЛА всё;
//   2. после аудита (2026-11-04) стало deny-by-default + разрешения только
//      рабочих узлов, но условие осталось «любая сессия»: вход был анонимный,
//      а анонимный uid выдаётся на каждое устройство заново, и пин по uid
//      отрезал бы второй и третий телефон владельца;
//   3. теперь вход — один постоянный аккаунт владельца (js/data/firebase-auth.js,
//      accounts:signInWithPassword), поэтому пин стал возможен и нужен.
//
// Почему в файле заглушка OWNER_UID, а не живой uid: `database.rules.json`
// лежит в ПУБЛИЧНОМ репозитории. Живой uid подставляет скрипт
// `scripts/set-owner-uid.mjs` в непубликуемый `database.rules.local.json`,
// который и вставляется в консоль Firebase. Заглушка в опубликованных правилах
// не даёт доступ НИКОМУ (uid'а «OWNER_UID» не существует) — это fail-closed,
// а не дыра: перепутать порядок безопаснее, чем открыть дерево.
//
// Тест проверяет текст файла, а не живую базу: публикация правил — ручной шаг
// владельца (README §«Безопасность Firebase», инструкция — FIREBASE_OWNER.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = 'OWNER_UID';

function readRules() {
  return JSON.parse(readFileSync(join(ROOT, 'database.rules.json'), 'utf8')).rules;
}

// Узлы, которые приложение адресует как корни запросов: FIREBASE_URL,
// FIREBASE_PLANNER_URL и FIREBASE_BACKUPS_URL. Берём из исходника, а не
// пересказываем, иначе тест проверял бы мои ожидания, а не контракт кода.
function readCloudRoots() {
  const source = readFileSync(join(ROOT, 'js/sync/core.js'), 'utf8');
  const roots = [];
  for (const name of ['FIREBASE_URL', 'FIREBASE_PLANNER_URL', 'FIREBASE_BACKUPS_URL']) {
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
    if (key.startsWith('.')) continue;
    const value = rules[key];
    if (value && typeof value === 'object') {
      for (const effect of ['.read', '.write']) {
        if (Object.prototype.hasOwnProperty.call(value, effect)) {
          out.push({ node: prefix ? prefix + '/' + key : key, effect, expression: value[effect] });
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
    assert.ok(node.length >= 16, `узел «${node}» подозрительно короткий — его легко подобрать`);
    assert.doesNotMatch(node, /\$/,
      'узлы в правилах — конкретные имена, а не шаблон $wildcard: шаблон открыл бы доступ всем узлам этого уровня');
  }
});

test('каждое разрешение привязано к uid владельца, а не к «любой сессии»', () => {
  const grants = collectGrants(readRules());
  assert.ok(grants.length >= 4, 'в правилах вообще нет разрешений — синхронизация не сможет работать');
  for (const grant of grants) {
    const expression = String(grant.expression);
    assert.notEqual(expression.trim(), 'true',
      `${grant.node}${grant.effect}: константа true — это публичный узел`);
    assert.match(expression, /auth\.uid\s*==/,
      `${grant.node}${grant.effect}: обязана сравнивать auth.uid с uid владельца; «auth != null» одна пропускает любую сессию проекта`);
    assert.match(expression, /auth\s*!=\s*null/,
      `${grant.node}${grant.effect}: сравнение uid без проверки наличия сессии читается как «аноним = null», проверка обязана быть явной`);
  }
});

test('условие одинаковое на read и write: «читаю, но не пишу» — ложная граница', () => {
  const byNode = new Map();
  for (const grant of collectGrants(readRules())) {
    byNode.set(grant.node, byNode.get(grant.node) || {});
    byNode.get(grant.node)[grant.effect] = String(grant.expression);
  }
  for (const [node, effects] of byNode) {
    assert.ok(effects['.read'] && effects['.write'],
      `узел «${node}»: разрешение должно быть и на чтение, и на запись — синк делает и то, и другое`);
    assert.equal(effects['.read'], effects['.write'],
      `узел «${node}»: разные условия read/write — одна из двух операций окажется открытой шире`);
  }
});

test('в публичном файле правил нет живого uid — только заглушка', () => {
  // Разбираем выражения из уже распарсенного JSON, а не сырой текст файла:
  // в JSON кавычки экранированы, и поиск по сырым байтам пропускал бы пин
  // целиком (проверено на этом же тесте), то есть молча «не видел» живой uid.
  const pins = [];
  for (const grant of collectGrants(readRules())) {
    for (const match of String(grant.expression).matchAll(/auth\.uid\s*==+\s*["']([^"']+)["']/g)) {
      pins.push({ where: grant.node + grant.effect, uid: match[1] });
    }
  }
  assert.ok(pins.length >= 4,
    'ожидалось не менее четырёх пинов (read+write на два узла) — найдено ' + pins.length);
  for (const pin of pins) {
    assert.equal(pin.uid, PLACEHOLDER,
      `${pin.where}: живой uid «${pin.uid}» в публичном репозитории — подставь его скриптом`
      + ' в database.rules.local.json');
  }
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
