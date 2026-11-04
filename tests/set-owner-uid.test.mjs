// Тесты скрипта подстановки UID (_tools/set-owner-uid.mjs).
//
// Скрипт — единственная вещь, которая превращает публичный шаблон правил с
// заглушкой OWNER_UID в файл, который владелец вставляет в Console. Цена
// ошибки в нём удвоенная: лишний символ в uid → синхронизации нет, а пропуск
// заглушки в одно из четырёх разрешений → база открыта наполовину. Поэтому
// проверяем и чистую функцию, и CLI целиком (временный файл в .test_tmp,
// репозиторий не трогаем).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules, pinnedUid, validUid, PLACEHOLDER } from '../_tools/set-owner-uid.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, '_tools', 'set-owner-uid.mjs');
const TEMPLATE = join(ROOT, 'database.rules.json');
const UID = 'AnonOwnerUid1234567890abcdef';

function run(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT].concat(args),
      { encoding: 'utf8', cwd: cwd || ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

test('валидный uid проходит, мусор — нет', () => {
  assert.equal(validUid(UID), true);
  assert.equal(validUid('Ab0_-xxxxxxxx'), true, 'допустимые символы отброшены');
  assert.equal(validUid(''), false, 'пустая строка прошла валидацию');
  assert.equal(validUid(PLACEHOLDER), false, 'заглушка принята за настоящий uid');
  assert.equal(validUid('abc'), false, 'три символа — не uid');
  assert.equal(validUid('with space'), false, 'пробел в uid');
  assert.equal(validUid('evil\\"uid'), false, 'кавычка или слэш в uid сломали бы JSON');
  assert.equal(validUid(null), false, 'null прошёл валидацию');
});

test('сборка правил: заглушка заменена во всех разрешениях, структура цела', () => {
  const source = readFileSync(TEMPLATE, 'utf8');
  const { text, changed } = buildRules(source, UID);

  assert.equal(text.indexOf(PLACEHOLDER), -1, 'заглушка осталась в собранном файле');
  assert.equal(changed.length, 4,
    'ожидается четыре подстановки (.read и .write на двух узлах), реально: ' + changed.join(', '));

  const built = JSON.parse(text).rules;
  const template = JSON.parse(source).rules;
  // Дерево обязано совпадать побайтово, кроме выражений: узел, потерянный при
  // сборке, — это молча открытая (или молча закрытая) ветка базы
  assert.deepEqual(Object.keys(built), Object.keys(template));
  for (const node of Object.keys(template)) {
    if (node.startsWith('.')) continue;
    assert.deepEqual(Object.keys(built[node]), Object.keys(template[node]));
    for (const effect of ['.read', '.write']) {
      assert.equal(built[node][effect],
        'auth != null && auth.uid === "' + UID + '"',
        node + effect + ' собрано не по шаблону');
    }
  }
});

test('шаблон без заглушки: скрипт падает, а не пишет пустые правила', () => {
  assert.throws(() => buildRules('{"rules":{"node":{".read":true}}}', UID),
    /OWNER_UID|шаблон/);
});

// pinnedUid нужен не только проверке файла: e2e-проба сверяет с ним localId
// аккаунта, под которым пишет. Пустой публичный шаблон обязан давать null —
// иначе проба приняла бы заглушку за настоящего владельца.
test('pinnedUid: собранный файл отдаёт uid, шаблон и пустые правила — null', () => {
  const built = JSON.parse(buildRules(readFileSync(TEMPLATE, 'utf8'), UID).text);
  assert.deepEqual(pinnedUid(JSON.stringify(built)), { uid: UID, grants: 4 });
  assert.equal(pinnedUid(readFileSync(TEMPLATE, 'utf8')), null,
    'заглушка проведена как настоящий uid');
  assert.equal(pinnedUid('{"rules":{".read":false,".write":false}}'), null,
    'пустые правила (ни одного string-разрешения) проведены как закреплённые');
});

test('CLI: --uid пишет файл, --check его подтверждает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yp-uid-'));
  const out = join(dir, 'rules.json');

  const made = run(['--uid', UID, '--out', out]);
  assert.equal(made.code, 0, 'скрипт упал: ' + made.err);
  assert.ok(existsSync(out), 'файл не написан');
  assert.equal(readFileSync(out, 'utf8').indexOf(UID) !== -1, true,
    'в собранном файле нет uid');

  const checked = run(['--check', '--out', out]);
  assert.equal(checked.code, 0, 'собранный файл не прошёл проверку: ' + checked.err);
  assert.match(checked.out, /4 разрешениях/);
});

test('CLI: битый uid и отсутствие файла — ненулевой выход, файл не создан', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yp-uid-'));
  const out = join(dir, 'rules.json');

  const bad = run(['--uid', 'короче-восьми', '--out', out]);
  assert.notEqual(bad.code, 0, 'невалидный uid принят');
  assert.equal(existsSync(out), false, 'файл написан несмотря на отказ');

  // Заглушка по алфавиту валидна, но пин на неё закрыл бы базу для всех
  const stub = run(['--uid', PLACEHOLDER, '--out', out]);
  assert.notEqual(stub.code, 0, 'заглушка принята как настоящий uid');
  assert.equal(existsSync(out), false, 'файл с пином на заглушку написан');

  const missing = run(['--check', '--out', out]);
  assert.notEqual(missing.code, 0, '--check молча одобрил несуществующий файл');
});

// --check — та единственная проверка, которую владелец успевает сделать до
// публикации: живого эмулятора правил в проекте нет. Он обязан замечать
// незакреплённое разрешение и разные uid в одном файле.
test('--check не пропускает незакреплённое правило и разные uid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yp-uid-'));

  const loose = join(dir, 'loose.json');
  const openRules = { rules: { node: { '.read': 'auth != null', '.write': 'auth.uid === "aaaaaaaaaaaaaaaa"' } } };
  writeFileSync(loose, JSON.stringify(openRules, null, 2), 'utf8');
  const checkedLoose = run(['--check', '--out', loose]);
  assert.notEqual(checkedLoose.code, 0, 'правило без пина на uid одобрено');
  assert.match(checkedLoose.err, /node\/\.read/);

  const mixed = join(dir, 'mixed.json');
  const twoUids = {
    rules: {
      a: { '.read': 'auth.uid === "aaaaaaaaaaaaaaaa"' },
      b: { '.read': 'auth.uid === "bbbbbbbbbbbbbbbb"' },
    },
  };
  writeFileSync(mixed, JSON.stringify(twoUids, null, 2), 'utf8');
  assert.notEqual(run(['--check', '--out', mixed]).code, 0,
    'два разных uid в одном файле одобрены');
});

test('CLI: отказывается писать в публичный database.rules.json', () => {
  const result = run(['--uid', UID, '--out', TEMPLATE]);
  assert.notEqual(result.code, 0, 'публичный файл перезаписан живым uid');
  assert.match(result.err, /публичн/i, 'причина отказа не названа');
  // и сам файл не изменился
  assert.ok(readFileSync(TEMPLATE, 'utf8').indexOf(PLACEHOLDER) !== -1,
    'в публичном шаблоне не осталось заглушки');
});
