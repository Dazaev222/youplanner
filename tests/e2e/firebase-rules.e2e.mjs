/* ═══════════════════════════════════════════════════════════════════
   E2E-проба правил безопасности Firebase (чистый node, без playwright).
   В npm test не входит (глоб tests/*.test.mjs не достаёт до tests/e2e):
   запуск руками —  node tests/e2e/firebase-rules.e2e.mjs

   Скрипт ходит в НАСТОЯЩИЙ Firebase и проверяет, что правила
   database.rules.json (auth != null) действительно опубликованы в консоли
   и что анонимный токен их проходит:

     1. Константы читаются из исходников: FIREBASE_URL / FIREBASE_BACKUPS_URL
        (js/data/sync.js) и Web API Key (js/data/firebase-auth.js).
     2. PUT пробы __rules_probe БЕЗ auth — ожидаем 401/403. Ответ 200 значит:
        правила публичны — опубликуй database.rules.json в консоли ОБОИХ
        инстансов. Успешная проба тут же удаляется (чистка). Узел бэкапов
        щупается только ЧТЕНИЕМ (GET без auth): запись пробой в корень
        бэкапов превратила бы массив копий в объект, и следующая синхро-
        низация затёрла бы историю бэкапов.
     3. Ключ задан: анонимный signUp → PUT с ?auth= — ожидаем 200 —
        DELETE того же пути (чистка). Ключа нет — CONFIG-NEEDED.
     4. PUT с мусорным токеном ?auth=garbage — ожидаем 401/403.

   Итог печатается построчно «PASS/FAIL/CONFIG-NEEDED имя — деталь»;
   код выхода 1, если есть хотя бы один FAIL (CONFIG-NEEDED не валит
   выход, но печатает шаги владельца). ═════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const syncSrc = readFileSync(join(ROOT, 'js', 'data', 'sync.js'), 'utf8');
const authSrc = readFileSync(join(ROOT, 'js', 'data', 'firebase-auth.js'), 'utf8');

const mainUrl = (syncSrc.match(/const FIREBASE_URL = '([^']+)'/) || [])[1];
const backupsUrl = (syncSrc.match(/const FIREBASE_BACKUPS_URL = '([^']+)'/) || [])[1];
const apiKey = (authSrc.match(/FIREBASE_WEB_API_KEY = '([^']*)'/) || [])[1] || '';

const PROBE = '__rules_probe';
const verdicts = [];

function report(status, name, detail) {
  verdicts.push(status);
  console.log(`${status} ${name} — ${detail}`);
}

function ownerSteps() {
  console.log('  Шаги владельца:');
  console.log('  1) Firebase Console → Authentication → Sign-in method → включить Anonymous;');
  console.log('  2) Project settings → General → Web API Key вписать в js/data/firebase-auth.js;');
  console.log('  3) Realtime Database → Rules → вставить database.rules.json → Publish —');
  console.log('     ОТДЕЛЬНО для обоих инстансов: основного и «…-backups».');
}

// Одна REST-операция, возвращает HTTP-статус. auth — токен или null:
// Token добавляется к URL параметром ?auth=, как это делает синхронизация.
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
  // Тело читаем всегда: соединение должно закрыться, а ошибки Firebase
  // приходят JSON-ом
  await response.text();
  return response.status;
}

// Проба по дочернему пути, не по корню: PUT в корень заменил бы весь снимок
// данных целиком, если правила ещё публичны.
const mainProbeUrl = mainUrl + '/' + PROBE + '.json';

async function main() {
  // ── 1. Константы из исходников ────────────────────────────────────────
  if (!mainUrl || !backupsUrl) {
    report('FAIL', 'константы Firebase',
      'не нашёл FIREBASE_URL / FIREBASE_BACKUPS_URL в js/data/sync.js');
    process.exit(1);
  }
  report('PASS', 'константы Firebase', mainUrl.slice(0, 60) + '…');

  const probeBody = { ts: Date.now() };
  const REJECTED = [401, 403];

  // ── 2. Без auth: запись отвергается ───────────────────────────────────
  let status = null;
  try {
    status = await rest(mainProbeUrl, { method: 'PUT', body: probeBody });
  } catch (e) {
    report('FAIL', 'главный: PUT без auth', 'сеть недоступна: ' + e.message);
  }
  if (status !== null) {
    if (REJECTED.includes(status)) {
      report('PASS', 'главный: PUT без auth отвергнут', 'HTTP ' + status);
    } else {
      if (status === 200) {
        try { await rest(mainProbeUrl, { method: 'DELETE' }); } catch (e) { /* чистка не удалась — проба уйдёт при следующем PUT данных */ }
      }
      report('FAIL', 'главный: PUT без auth',
        status === 200
          ? 'правила публичны: опубликуй database.rules.json в консоли ОБОИХ инстансов (HTTP 200, проба удалена)'
          : 'неожиданный HTTP ' + status + ', ждали 401/403');
    }
  }

  status = null;
  try {
    // Чтение вместо записи: запись в корень бэкапов портит массив копий
    status = await rest(backupsUrl + '.json', { method: 'GET' });
  } catch (e) {
    report('FAIL', 'бэкапы: GET без auth', 'сеть недоступна: ' + e.message);
  }
  if (status !== null) {
    if (REJECTED.includes(status)) {
      report('PASS', 'бэкапы: GET без auth отвергнут', 'HTTP ' + status);
    } else if (status === 200) {
      report('FAIL', 'бэкапы: GET без auth',
        'правила публичны: опубликуй database.rules.json в консоли ОБОИХ инстансов (HTTP 200)');
    } else {
      report('FAIL', 'бэкапы: GET без auth', 'неожиданный HTTP ' + status + ', ждали 401/403');
    }
  }

  // ── 3. С анонимным токеном: запись проходит ───────────────────────────
  if (!apiKey) {
    report('CONFIG-NEEDED', 'анонимный токен',
      'Web API Key не вписан в js/data/firebase-auth.js — шаг 3 пропущен');
    ownerSteps();
  } else {
    let token = null;
    try {
      const signUp = await fetch(
        'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(apiKey),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ returnSecureToken: true }),
        });
      const data = await signUp.json();
      if (signUp.ok && data && data.idToken) {
        token = data.idToken;
      } else {
        report('FAIL', 'анонимный signUp', 'HTTP ' + signUp.status +
          (data && data.error && data.error.message ? ': ' + data.error.message : '') +
          ' — включи Authentication → Sign-in method → Anonymous');
      }
    } catch (e) {
      report('FAIL', 'анонимный signUp', 'сеть недоступна: ' + e.message);
    }

    if (token) {
      status = null;
      try {
        status = await rest(mainProbeUrl, { method: 'PUT', body: probeBody, auth: token });
      } catch (e) {
        report('FAIL', 'главный: PUT с ?auth=', 'сеть недоступна: ' + e.message);
      }
      if (status === 200) {
        report('PASS', 'главный: PUT с ?auth= принят', 'HTTP 200');
        try { await rest(mainProbeUrl, { method: 'DELETE', auth: token }); } catch (e) { /* чистка не удалась — проба уйдёт при следующем PUT данных */ }
      } else if (status !== null) {
        report('FAIL', 'главный: PUT с ?auth=', 'HTTP ' + status + ', ждали 200');
      }

      status = null;
      try {
        // Чтение: безопасная проверка, что второй инстанс тоже принимает токен
        status = await rest(backupsUrl + '.json', { method: 'GET', auth: token });
      } catch (e) {
        report('FAIL', 'бэкапы: GET с ?auth=', 'сеть недоступна: ' + e.message);
      }
      if (status === 200) {
        report('PASS', 'бэкапы: GET с ?auth= принят', 'HTTP 200');
      } else if (status !== null) {
        report('FAIL', 'бэкапы: GET с ?auth=',
          'HTTP ' + status + ' — правила не опубликованы на инстансе бэкапов');
      }
    }
  }

  // ── 4. Мусорный токен: запись отвергается ─────────────────────────────
  status = null;
  try {
    status = await rest(mainProbeUrl, { method: 'PUT', body: probeBody, auth: 'garbage' });
  } catch (e) {
    report('FAIL', 'главный: PUT с мусорным токеном', 'сеть недоступна: ' + e.message);
  }
  if (status !== null) {
    if (REJECTED.includes(status)) {
      report('PASS', 'главный: PUT с мусорным токеном отвергнут', 'HTTP ' + status);
    } else {
      if (status === 200) {
        try { await rest(mainProbeUrl, { method: 'DELETE' }); } catch (e) { /* чистка */ }
      }
      report('FAIL', 'главный: PUT с мусорным токеном',
        status === 200
          ? 'правила публичны: опубликуй database.rules.json в консоли ОБОИХ инстансов'
          : 'неожиданный HTTP ' + status + ', ждали 401/403');
    }
  }

  if (verdicts.includes('FAIL')) process.exit(1);
}

main();
