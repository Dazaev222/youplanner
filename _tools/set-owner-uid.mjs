// Подстановка UID владельца в правила Firebase (ЗАДАЧА «привязка к UID»).
//
// Зачем скрипт, а не ручная правка: пин должен стоять ровно в четырёх
// разрешениях — .read и .write на узле данных и на узле копий. Пропустить
// одно значит получить базу, где синхронизация работает наполовину, и
// заметить это можно только после публикации правил.
//
// database.rules.json остаётся в публичном репозитории с заглушкой OWNER_UID:
// живой UID — идентификатор аккаунта, и в открытом репе ему не место
// (этого же требует tests/firebase-rules.test.mjs). Скрипт пишет рядом
// database.rules.local.json — он в .gitignore, его и вставлять в Console.
//
//   node _tools/set-owner-uid.mjs --uid <UID>     # собрать local-файл
//   node _tools/set-owner-uid.mjs --check         # сверить local с шаблоном
//
// UID берётся из Firebase Console (Authentication → Users → колонка UID) либо
// из Настроек самого YouPlanner сразу после входа — там он показан нарочно.
//
// Сеть скрипт не трогает вообще: ни GET, ни PUT к правилам. Публикация —
// руками владельца в Console (README §«Безопасность Firebase»).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_PATH = join(ROOT, 'database.rules.json');
export const LOCAL_PATH = join(ROOT, 'database.rules.local.json');
export const PLACEHOLDER = 'OWNER_UID';

// Формат uid, который выдаёт identitytoolkit: буква/цифра, без пробелов и
// кавычек (кавычка сломала бы JSON внутри выражения). Верхняя граница щедрая:
// у кастомных токенов uid бывает длиннее обычных 28 символов.
// Заглушка отсекается отдельно: по алфавиту она проходит, а правила с
// пином на «OWNER_UID» не пустят в базу никого — и молча.
export function validUid(uid) {
  if (typeof uid !== 'string') return false;
  if (uid === PLACEHOLDER) return false;
  return /^[A-Za-z0-9_-]{8,128}$/.test(uid);
}

// Глубокий обход дерева правил: замена подстроки-заглушки в выражениях
// .read/.write. Возвращает пару «новое дерево, число замен» — молча
// несделанная замена дороже ошибки.
function substitute(node, uid, path) {
  const changes = [];
  const out = {};
  for (const key of Object.keys(node)) {
    const value = node[key];
    if ((key === '.read' || key === '.write') && typeof value === 'string') {
      if (value.indexOf(PLACEHOLDER) !== -1) {
        out[key] = value.split(PLACEHOLDER).join(uid);
        changes.push(path + key);
      } else {
        out[key] = value;
      }
    } else if (value && typeof value === 'object') {
      const nested = substitute(value, uid, path + key + '/');
      out[key] = nested.tree;
      changes.push(...nested.changes);
    } else {
      out[key] = value;
    }
  }
  return { tree: out, changes: changes };
}

export function buildRules(sourceText, uid) {
  const parsed = JSON.parse(sourceText);
  const { tree, changes } = substitute(parsed.rules || {}, uid, '');
  if (changes.length === 0) {
    throw new Error('в ' + TEMPLATE_PATH + ' нет заглушки ' + PLACEHOLDER +
      ': шаблон испорчен, правь его, а не скрипт');
  }
  return { text: JSON.stringify({ rules: tree }, null, 2) + '\n', changed: changes };
}

function readArgs(argv) {
  const args = { out: LOCAL_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (token === '--uid') args.uid = String(argv[++i] || '');
    else if (token === '--out') args.out = resolve(String(argv[++i] || ''));
    else if (token === '--check') args.check = true;
    else throw new Error('неизвестный аргумент: ' + token);
  }
  return args;
}

// Разрешения дерева правил: [{where, expression}]. Разбор по РАСПАРСЕННОМУ
// JSON, не по сырому тексту: JSON.stringify экранирует кавычки внутри
// выражений («auth.uid === \"…\"»), и регулярка по тексту не нашла бы ни
// одного пина — проверка отвергла бы правильный файл.
function collectGrants(node, path, out) {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if ((key === '.read' || key === '.write') && typeof value === 'string') {
      out.push({ where: path + key, expression: value });
    } else if (value && typeof value === 'object') {
      collectGrants(value, path + key + '/', out);
    }
  }
  return out;
}

export function grantsOf(rulesText) {
  return collectGrants(JSON.parse(rulesText).rules || {}, '', []);
}

const PIN_RE = /auth\.uid\s*==+\s*["']([^"']+)["']/;

// Единственный uid, закреплённый во ВСЕХ разрешениях, или null. Нужен не только
// проверке файла: e2e-проба (tests/e2e/firebase-rules.e2e.mjs) сверяет его с
// localId того аккаунта, под которым идёт запись, — расхождение означает, что
// правила опубликованы за другим аккаунтом и синхронизации не будет никогда.
export function pinnedUid(rulesText) {
  const grants = grantsOf(rulesText);
  if (grants.length === 0) return null;
  const uids = [];
  for (const grant of grants) {
    const match = PIN_RE.exec(grant.expression);
    if (!match || !validUid(match[1])) return null;
    uids.push(match[1]);
  }
  const distinct = [...new Set(uids)];
  return distinct.length === 1 ? { uid: distinct[0], grants: uids.length } : null;
}

function check(outPath) {
  if (!existsSync(outPath)) {
    throw new Error('нет файла ' + outPath +
      ' — сначала собери: node _tools/set-owner-uid.mjs --uid <UID>');
  }
  const text = readFileSync(outPath, 'utf8');
  if (text.indexOf(PLACEHOLDER) !== -1) {
    throw new Error('в собранном файле осталась заглушка ' + PLACEHOLDER +
      ': правила с ней не пустят никого');
  }
  const pinned = pinnedUid(text);
  if (pinned) {
    console.log('ok: ' + outPath + ' — uid ' + pinned.uid + ' в ' + pinned.grants + ' разрешениях');
    return;
  }
  if (grantsOf(text).length === 0) {
    throw new Error('в файле нет ни одного разрешения — база закрыта целиком, синхронизация не поднимется');
  }
  const naked = grantsOf(text)
    .filter((grant) => !PIN_RE.test(grant.expression))
    .map((grant) => grant.where + ' «' + grant.expression + '»');
  if (naked.length) {
    throw new Error('без пина на uid: ' + naked.join(', ') +
      ' — незакреплённое разрешение пустит в базу любую анонимную сессию');
  }
  throw new Error('разрешения закреплены за разными uid — синхронизация работала бы наполовину');
}

function main() {
  const args = readArgs(process.argv.slice(2));

  if (args.check) {
    try {
      check(args.out);
    } catch (e) {
      console.error(String(e.message || e));
      process.exitCode = 1;
    }
    return;
  }

  if (!validUid(args.uid || '')) {
    console.error('нужен --uid <UID>: 8–128 символов [A-Za-z0-9_-]. ' +
      'Взять его можно в Firebase Console → Authentication → Users, либо в Настройках YouPlanner сразу после входа.');
    process.exitCode = 1;
    return;
  }
  if (args.out === TEMPLATE_PATH) {
    // Публичный файл обязан оставаться с заглушкой: живой uid в открытом
    // репозитории — это ключ от понимания, чей аккаунт защищает база
    console.error('нельзя писать в ' + TEMPLATE_PATH + ': он публичный и живёт с заглушкой ' + PLACEHOLDER);
    process.exitCode = 1;
    return;
  }

  const { text, changed } = buildRules(readFileSync(TEMPLATE_PATH, 'utf8'), args.uid);
  writeFileSync(args.out, text, 'utf8');
  console.log('написано: ' + args.out);
  changed.forEach((where) => console.log('  подставлен uid → ' + where));
  console.log('\nДальше: npm test (проверка шаблона), затем содержимое файла →');
  console.log('Firebase Console → Realtime Database → Rules → Publish. Скрипт в сеть не ходил.');
}

// Модуль импортируют тесты; запуск — только как скрипт
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
