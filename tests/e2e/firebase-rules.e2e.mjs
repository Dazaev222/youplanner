/* ═══════════════════════════════════════════════════════════════════
   E2E-проба правил безопасности Firebase (чистый node, без playwright).
   В npm test не входит (глоб tests/*.test.mjs не достаёт до tests/e2e):
   запуск руками —  node tests/e2e/firebase-rules.e2e.mjs

   ⚠️ СКРИПТ ХОДИТ В НАСТОЯЩИЙ FIREBASE. Он ничего не трогает кроме
   служебного узла «__rules_probe» (PUT и сразу DELETE), но это всё равно
   запись в прод — запускать осознанно и только после публикации правил.

   Проверяется контракт database.rules.json: в базу пускается ТОЛЬКО
   аутентифицированная сессия постоянного аккаунта владельца (auth.uid ===
   <uid>), а анонимная сессия — нет. Это ровно то, что ломает прежнюю
   формулировку «auth != null»: раньше анонимный токен был ключом от всего
   дерева, теперь он обязан упираться в 403.

     1. Константы читаются из исходников: FIREBASE_URL / FIREBASE_BACKUPS_URL
        (js/sync/core.js) и Web API Key (js/data/firebase-auth.js).
     2. PUT пробы __rules_probe БЕЗ auth — ожидаем 401/403. Ответ 200 значит,
        что правила вообще не опубликованы. Узел бэкапов щупается только
        ЧТЕНИЕМ (GET без auth): запись пробой в корень бэкапов превратила бы
        массив копий в объект, и следующая синхронизация затёрла бы историю.
     3. Анонимный signUp → PUT с его токеном — ожидаем 401/403. Ответ 200
        значит, что база по-прежнему открыта любой анонимной сессии этого
        проекта (правила не опубликованы или опубликованы без пина на uid).
     4. Правила с пином: локальный файл database.rules.local.json
        (gitignored, собирается _tools/set-owner-uid.mjs) — из него берётся
        uid, который сверяется с localId владельца в шаге 5.
     5. Вход постоянного аккаунта (YP_OWNER_EMAIL + YP_OWNER_PASSWORD из
        окружения — в репозитории пароля нет и быть не должно) → PUT с токеном
        ожидаем 200 → DELETE. localId сверяется с пином: расхождение значит,
        что правила закреплены за ДРУГИМ аккаунтом, и приложение с такими
        правилами синхронизироваться не будет никогда.

   Итог печатается построчно «PASS/FAIL/CONFIG-NEEDED имя — деталь»;
   код выхода 1, если есть хотя бы один FAIL (CONFIG-NEEDED не валит выход). */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCAL_PATH, pinnedUid } from '../../_tools/set-owner-uid.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const syncSrc = readFileSync(join(ROOT, 'js', 'sync', 'core.js'), 'utf8');
const authSrc = readFileSync(join(ROOT, 'js', 'data', 'firebase-auth.js'), 'utf8');

const mainUrl = (syncSrc.match(/const FIREBASE_URL = '([^']+)'/) || [])[1];
const backupsUrl = (syncSrc.match(/const FIREBASE_BACKUPS_URL = '([^']+)'/) || [])[1];
const apiKey = (authSrc.match(/FIREBASE_WEB_API_KEY = '([^']*)'/) || [])[1] || '';

const PROBE = '__rules_probe';
const REJECTED = [401, 403];
const verdicts = [];

function report(status, name, detail) {
  verdicts.push(status);
  console.log(`${status} ${name} — ${detail}`);
}

function ownerSteps() {
  console.log('  Шаги владельца:');
  console.log('  1) Firebase Console → Authentication → Users → добавить email/пароль (Password);');
  console.log('  2) войти в этот аккаунт в Настройках YouPlanner, взять показанный UID;');
  console.log('  3) node _tools/set-owner-uid.mjs --uid <UID>  → database.rules.local.json;');
  console.log('  4) Realtime Database → Rules → вставить собранный файл → Publish — ОТДЕЛЬНО');
  console.log('     для обоих инстансов: основного и «…-backups»;');
  console.log('  5) YP_OWNER_EMAIL и YP_OWNER_PASSWORD в окружении → повторить этот прогон.');
}

// Одна REST-операция, возвращает пару «статус, тело». Token добавляется к URL
// параметром ?auth=, как это делает синхронизация.
async function rest(url, { method = 'PUT', body = null, auth = null } = {}) {
  let full = url;
  if (auth !== null) {
    full += (full.indexOf('?') === -1 ? '?' : '&') + 'auth=' + encodeURIComponent(auth);
  }
  const options = { method };
  if (body !== null) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(full, options);
  const text = await response.text();
  return { status: response.status, text: text };
}

// Проба по дочернему пути, не по корню: PUT в корень заменил бы весь снимок
// данных целиком, если правила ещё публичны.
const mainProbeUrl = mainUrl + '/' + PROBE + '.json';

// POST к identitytoolkit: анонимный signUp либо вход по паролю.
async function identity(endpoint, body) {
  const response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:' + endpoint + '?key=' + encodeURIComponent(apiKey),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data: data };
}

async function probeWrite(label, auth) {
  const probeBody = { ts: Date.now() };
  let result = null;
  try {
    result = await rest(mainProbeUrl, { method: 'PUT', body: probeBody, auth: auth });
  } catch (e) {
    report('FAIL', label, 'сеть недоступна: ' + e.message);
    return null;
  }
  // Принятую пробу снимаем сразу: в базе не должно оставаться мусора
  if (result.status === 200) {
    try { await rest(mainProbeUrl, { method: 'DELETE', auth: auth }); } catch (e) { /* уйдёт при следующем PUT данных */ }
  }
  return result;
}

async function main() {
  // ── 1. Константы из исходников ────────────────────────────────────────
  if (!mainUrl || !backupsUrl) {
    report('FAIL', 'константы Firebase',
      'не нашёл FIREBASE_URL / FIREBASE_BACKUPS_URL в js/sync/core.js');
    process.exit(1);
  }
  if (!apiKey) {
    report('CONFIG-NEEDED', 'Web API Key', 'не вписан в js/data/firebase-auth.js');
    ownerSteps();
    process.exit(1);
  }
  report('PASS', 'константы Firebase', mainUrl.slice(0, 60) + '…');

  // ── 2. Без auth: и запись, и чтение отвергаются ───────────────────────
  const anonWrite = await probeWrite('главный: PUT без auth', null);
  if (anonWrite) {
    if (REJECTED.includes(anonWrite.status)) {
      report('PASS', 'главный: PUT без auth отвергнут', 'HTTP ' + anonWrite.status);
    } else if (anonWrite.status === 200) {
      report('FAIL', 'главный: PUT без auth',
        'правила не опубликованы: любой человек без ключа пишет в базу (HTTP 200, проба удалена)');
    } else {
      report('FAIL', 'главный: PUT без auth', 'неожиданный HTTP ' + anonWrite.status + ', ждали 401/403');
    }
  }

  try {
    // Чтение вместо записи: запись в корень бэкапов портит массив копий
    const backups = await rest(backupsUrl + '.json', { method: 'GET' });
    if (REJECTED.includes(backups.status)) {
      report('PASS', 'бэкапы: GET без auth отвергнут', 'HTTP ' + backups.status);
    } else if (backups.status === 200) {
      report('FAIL', 'бэкапы: GET без auth',
        'копии читаются без всякого ключа: опубликуй правила и на инстансе «…-backups»');
    } else {
      report('FAIL', 'бэкапы: GET без auth', 'неожиданный HTTP ' + backups.status + ', ждали 401/403');
    }
  } catch (e) {
    report('FAIL', 'бэкапы: GET без auth', 'сеть недоступна: ' + e.message);
  }

  // ── 3. Анонимный токен больше не ключ от базы ─────────────────────────
  const signUp = await identity('signUp', { returnSecureToken: true });
  if (!signUp.ok || !signUp.data || !signUp.data.idToken) {
    report(signUp.status === 400 ? 'FAIL' : 'CONFIG-NEEDED', 'анонимный signUp',
      'HTTP ' + signUp.status + ' — Anonymous в Authentication выключен? (для закрепления правил это нормально)');
  } else {
    const probe = await probeWrite('главный: PUT с анонимным токеном', signUp.data.idToken);
    if (probe) {
      if (REJECTED.includes(probe.status)) {
        report('PASS', 'главный: анонимная сессия отвергнута',
          'HTTP ' + probe.status + ' — база закрыта за uid владельца');
      } else if (probe.status === 200) {
        report('FAIL', 'главный: анонимная сессия принята',
          'правила всё ещё «auth != null»: закреплены не за uid (HTTP 200, проба удалена)');
      } else {
        report('FAIL', 'главный: PUT с анонимным токеном', 'неожиданный HTTP ' + probe.status);
      }
    }
  }

  // ── 4. Локальные правила: есть ли пин и какой uid в них ───────────────
  if (!existsSync(LOCAL_PATH)) {
    report('CONFIG-NEEDED', 'database.rules.local.json',
      'нет собранного файла правил: node _tools/set-owner-uid.mjs --uid <UID>');
    ownerSteps();
    if (verdicts.includes('FAIL')) process.exit(1);
    return;
  }
  const pinned = pinnedUid(readFileSync(LOCAL_PATH, 'utf8'));
  if (!pinned) {
    report('FAIL', 'database.rules.local.json',
      'разрешения не закреплены одним uid — собери файл заново');
    process.exit(1);
  }
  report('PASS', 'пин в правилах', pinned.uid + ' в ' + pinned.grants + ' разрешениях');

  // ── 5. Владелец: вход, сверка uid, запись ─────────────────────────────
  const email = String(process.env.YP_OWNER_EMAIL || '');
  const password = String(process.env.YP_OWNER_PASSWORD || '');
  if (!email || !password) {
    report('CONFIG-NEEDED', 'аккаунт владельца',
      'нет YP_OWNER_EMAIL / YP_OWNER_PASSWORD в окружении — проверка «владелец может писать» пропущена');
    ownerSteps();
  } else {
    const login = await identity('signInWithPassword',
      { email: email, password: password, returnSecureToken: true });
    if (!login.ok || !login.data || !login.data.idToken) {
      report('FAIL', 'вход владельца', 'HTTP ' + login.status + ': ' +
        ((login.data && login.data.error && login.data.error.message) || 'нет ответа'));
    } else {
      // Расхождение uid — главный смысл этого шага: приложение ходит под
      // одним аккаунтом, а правила закреплены за другим.
      if (login.data.localId !== pinned.uid) {
        report('FAIL', 'uid владельца', 'правила закреплены за ' + pinned.uid +
          ', а аккаунт «' + email + '» — это ' + String(login.data.localId) +
          ': синхронизации не будет');
      } else {
        report('PASS', 'uid владельца', String(login.data.localId));
      }
      const probe = await probeWrite('главный: PUT с токеном владельца', login.data.idToken);
      if (probe) {
        if (probe.status === 200) {
          report('PASS', 'главный: владелец пишет', 'HTTP 200 (проба удалена)');
        } else {
          report('FAIL', 'главный: владелец пишет', 'HTTP ' + probe.status +
            ', ждали 200 — правила опубликованы не на этом инстансе?');
        }
      }
      try {
        const backups = await rest(backupsUrl + '.json', { method: 'GET', auth: login.data.idToken });
        if (backups.status === 200) {
          report('PASS', 'бэкапы: владелец читает', 'HTTP 200');
        } else {
          report('FAIL', 'бэкапы: владелец читает', 'HTTP ' + backups.status +
            ' — правила не опубликованы на инстансе «…-backups»');
        }
      } catch (e) {
        report('FAIL', 'бэкапы: владелец читает', 'сеть недоступна: ' + e.message);
      }
    }
  }

  if (verdicts.includes('FAIL')) process.exit(1);
}

main();
