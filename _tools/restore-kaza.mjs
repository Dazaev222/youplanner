#!/usr/bin/env node
// Восстановление статистики каза-намазов (ЗАДАЧА 1.3).
//
// Зачем: журнал выполнений (youplanner.qaza.log) и очередь (youplanner.qaza)
// можно потерять — чисткой хранилища, чужим снимком, сбоем. Приложение само
// восстанавливает только ПУСТУЮ очередь дефолтом (loadQaza, js/data/qaza.js),
// а историю выполнений не восстанавливает никогда. Этот инструмент возвращает
// статистику: пишет в разделы qaza/qazaLog тот же код записи, каким ходит
// само приложение (раздел qaza — конвертом LWW {v, ts}, как в sync.js).
//
// БЕЗОПАСНОСТЬ:
//   без --apply инструмент только ПЕЧАТАЕТ план (dry-run) и делает один
//   читающий GET текущего состояния. Ничего не пишет — ни сеть, ни файлы.
//   Перед записью печатает на экран предыдущее значение (бэкап) и сохраняет
//   его копию в .scratch/backup-kaza-<время>.json.
//
//   Секреты не хардкодятся: конфиг берётся из .env-подобного файла
//   (_tools/restore-kaza.env — в .gitignore) или переменных окружения.
//   Образец без секретов: _tools/restore-kaza.env.example.
//
// РЕЖИМЫ ЦЕЛИ (ровно один):
//   --count N        сколько ВЫПОЛНЕННЫХ каза должно быть в журнале после
//                    восстановления (статистика снова покажет N).
//                    Для N=1527 в очереди останется 1530 − 1527 = 3.
//   --remaining N    каким должен быть ОСТАТОК очереди (альтернатива).
//   --dump файл.json помесячная история {"2025-06": 90, ...}; с --count —
//                    суммы обязаны совпасть.
//
// ПРИМЕРЫ:
//   node _tools/restore-kaza.mjs --count 1527                # dry-run, облако
//   node _tools/restore-kaza.mjs --count 1527 --apply        # применить
//   node _tools/restore-kaza.mjs --remaining 1527            # вернуть очередь
//   node _tools/restore-kaza.mjs --dump история.json --apply
//   node _tools/restore-kaza.mjs --count 1527 --target local --state дамп.txt
//
// Настройки: --end ГГГГ-ММ-ДД (последний день истории, по умолчанию вчера),
//   --per-day N (записей в день, по умолчанию 3), --debt N (долг на один
//   намаз, по умолчанию 306 = стартовые 1530 на пятерых),
//   --env файл (конфиг), --token TOKEN (готовый idToken вместо конфига).
//
// Сеть скрипт трогает только при --target cloud (значение по умолчанию):
// GET текущих разделов и — лишь с --apply — один PATCH двух разделов.
// Файлы правил и сам Firebase Console не затрагиваются.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  planRestore,
  parseEnvFile,
  parseStateDump,
  buildLocalSnippet,
} from './restore-kaza-core.mjs';
import { NAMAZ_ORDER, QAZA_LOG_KEY, QAZA_STORAGE_KEY } from '../js/data/qaza.js';
import { toISODate } from '../js/core/dates.js';
// URL базы и веб-ключ — из кода приложения (не секреты: живут в публичных
// исходниках и ограничены правилами доступа). Конфиг может переопределить.
import { FIREBASE_URL } from '../js/sync/core.js';
import { FIREBASE_WEB_API_KEY } from '../js/data/firebase-auth.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Аргументы командной строки ──────────────────────────────────────────────

const ARGS_WITH_VALUE = [
  '--count', '--remaining', '--dump', '--end', '--per-day', '--debt',
  '--target', '--state', '--env', '--token',
];

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (ARGS_WITH_VALUE.indexOf(arg) !== -1) {
      if (i + 1 >= argv.length) {
        throw new Error('После ' + arg + ' нужно значение (пример: ' + arg + ' 1527)');
      }
      args[arg.slice(2)] = argv[i + 1];
      i++;
    } else if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error('Неизвестный аргумент: ' + arg + ' (см. node _tools/restore-kaza.mjs --help)');
    }
  }
  return args;
}

// ── Конфиг (секреты — из файла или окружения, не из кода) ───────────────────

// Файл → окружение → аргументы: чем позже источник, тем приоритетнее
function loadConfig(args) {
  const envPath = args.env
    ? resolve(process.cwd(), args.env)
    : join(ROOT, '_tools', 'restore-kaza.env');
  let fileConfig = {};
  try {
    fileConfig = parseEnvFile(readFileSync(envPath, 'utf8'));
  } catch (e) {
    if (args.env) {
      throw new Error('Не удалось прочитать --env ' + envPath + ': ' + e.message);
    }
    // Файла по умолчанию может не быть — это нормально, если задан --token
    // или переменные окружения.
  }
  const config = {};
  const keys = ['FIREBASE_URL', 'FIREBASE_API_KEY', 'FB_REFRESH_TOKEN', 'OWNER_EMAIL', 'OWNER_PASSWORD'];
  for (const key of keys) {
    if (process.env[key] !== undefined && process.env[key] !== '') config[key] = process.env[key];
    else if (fileConfig[key] !== undefined) config[key] = fileConfig[key];
  }
  if (args.token) config.idToken = args.token;
  if (args.url) config.FIREBASE_URL = args.url;
  return config;
}

// idToken для REST-запросов. Порядок: готовый --token → refresh-токен из
// конфига (его хранит браузер приложения в youplanner.fb.refresh) →
// вход по почте и паролю. Ни токены, ни пароль на экран не печатаются.
async function resolveToken(config) {
  if (config.idToken) return config.idToken;

  if (config.FB_REFRESH_TOKEN) {
    const response = await fetch(
      'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(webApiKey(config)),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: config.FB_REFRESH_TOKEN,
        }),
      }
    );
    const body = await response.json();
    if (!response.ok) {
      throw new Error('Обмен refresh-токена не удался (HTTP ' + response.status + '): ' +
        (body.error && body.error.message ? body.error.message : 'ответ без сообщения'));
    }
    if (body.user_id) console.log('Вход по refresh-токену: uid ' + body.user_id);
    return body.id_token;
  }

  if (config.OWNER_EMAIL && config.OWNER_PASSWORD) {
    const response = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' +
        encodeURIComponent(webApiKey(config)),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: config.OWNER_EMAIL,
          password: config.OWNER_PASSWORD,
          returnSecureToken: true,
        }),
      }
    );
    const body = await response.json();
    if (!response.ok) {
      throw new Error('Вход по почте/паролю не удался (HTTP ' + response.status + '): ' +
        (body.error && body.error.message ? body.error.message : 'ответ без сообщения'));
    }
    console.log('Вход выполнен: uid ' + body.localId);
    return body.idToken;
  }

  throw new Error(
    'Нет способа войти. Заполните _tools/restore-kaza.env (образец: ' +
    '_tools/restore-kaza.env.example) или передайте --token.'
  );
}

function webApiKey(config) {
  if (!config.FIREBASE_API_KEY) return FIREBASE_WEB_API_KEY;
  return config.FIREBASE_API_KEY;
}

function databaseUrl(config) {
  return config.FIREBASE_URL || FIREBASE_URL;
}

// ── Сеть: те же разделы, что у приложения (authedFetch, sync.js) ────────────

async function cloudGet(url, token, section) {
  const response = await fetch(url + '/' + section + '.json', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!response.ok) {
    throw new Error('Чтение раздела ' + section + ' не удалось (HTTP ' + response.status + ')');
  }
  return response.json();
}

// Один PATCH двух детей корня — атомарно, остальной снимок не трогается
// (корневой PUT приложения заменяет узел целиком, поэтому ему и нужен
// отдельный узел бэкапов; здесь дети пишутся адресно).
async function cloudPatch(url, token, payload) {
  const response = await fetch(url + '/.json', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('Запись не удалась (HTTP ' + response.status + '): ' + text.slice(0, 300));
  }
  return response.json();
}

// ── Печать плана ────────────────────────────────────────────────────────────

function remainingLine(remaining) {
  return NAMAZ_ORDER.map(function (namaz) {
    return namaz + ': ' + remaining[namaz];
  }).join(', ');
}

function logSummary(log) {
  if (!log) return 'журнала нет (раздел пуст)';
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const done = entries.filter(function (e) { return e && e.source === 'done'; }).length;
  const manual = entries.length - done;
  let first = null;
  let last = null;
  for (const entry of entries) {
    if (entry && entry.date && (first === null || entry.date < first)) first = entry.date;
    if (entry && entry.date && (last === null || entry.date > last)) last = entry.date;
  }
  return 'since=' + (log.since || '—') + ', записей ' + entries.length +
    ' (выполнений ' + done + ', ручных ' + manual + ')' +
    (first ? ', даты ' + first + ' … ' + last : '');
}

function printPlan(plan, previousQaza, previousLog) {
  const summary = plan.summary;
  console.log('');
  console.log('=== Текущее состояние (ПРЕДЫДУЩЕЕ ЗНАЧЕНИЕ — бэкап) ===');
  console.log('Раздел ' + QAZA_STORAGE_KEY + ':');
  console.log(JSON.stringify(previousQaza || null));
  console.log('Раздел ' + QAZA_LOG_KEY + ': ' + logSummary(previousLog));
  console.log('');
  console.log('=== План восстановления (dry-run: ничего не записано) ===');
  console.log('Режим цели: ' + summary.mode +
    (summary.mode === 'remaining' ? ' (остаток очереди)' : ' (выполненных в журнале)'));
  console.log('Выполнений в журнале сейчас: ' + summary.existingDone +
    ' (ручных добавлений ' + summary.existingManual + ')');
  console.log('Цель: ' + summary.doneTarget + ' выполненных');

  if (summary.nothingToDo) {
    console.log('ДЕЛАТЬ НЕЧЕГО: выполнений в журнале не меньше цели. Хранилище не меняется.');
  } else {
    console.log('Будет ДОБАВЛЕНО записей: ' + summary.addedCount +
      ' на ' + summary.addedDays + ' дн. (' +
      (summary.addedEarliest || '—') + ' … ' + (summary.addedLatest || '—') + '), по ≤ per-day в день');
    const sample = plan.toAdd.slice(0, 3).concat(plan.toAdd.slice(-3));
    console.log('Примеры добавляемых записей:');
    for (const entry of sample) {
      console.log('  ' + entry.date + '  ' + entry.namaz + '  (' + entry.source + ')');
    }
  }

  console.log('Очередь станет: ' + remainingLine(plan.finalQaza.remaining) +
    ' (сумма ' + summary.remainingTotal + '), курсор ' + plan.finalQaza.cursor);
  console.log('Итоговый журнал: ' + logSummary(plan.finalLog));

  if (plan.warnings.length > 0) {
    console.log('');
    console.log('Предупреждения:');
    for (const warning of plan.warnings) console.log('  ⚠ ' + warning);
  }
  console.log('');
}

// ── main ────────────────────────────────────────────────────────────────────

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv || process.argv.slice(2));
  } catch (e) {
    console.error('ОШИБКА: ' + e.message);
    return 1;
  }
  if (args.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  // Цель и её параметры — через чистое ядро: оно проверит и выбросит
  // понятную ошибку, если владелец что-то перепутал.
  const todayISO = toISODate(new Date());
  let monthsDump = null;
  if (args.dump) {
    try {
      monthsDump = JSON.parse(readFileSync(resolve(process.cwd(), args.dump), 'utf8'));
    } catch (e) {
      console.error('ОШИБКА: не удалось прочитать --dump ' + args.dump + ': ' + e.message);
      return 1;
    }
  }

  const planInput = {
    todayISO: todayISO,
    perDay: args['per-day'] !== undefined ? Number(args['per-day']) : undefined,
    debtPerNamaz: args.debt !== undefined ? Number(args.debt) : undefined,
    endISO: args.end,
  };
  if (args.count !== undefined) planInput.done = Number(args.count);
  if (args.remaining !== undefined) planInput.remaining = Number(args.remaining);
  if (monthsDump) planInput.monthsDump = monthsDump;

  const target = args.target || 'cloud';
  if (target !== 'cloud' && target !== 'local') {
    console.error('ОШИБКА: --target понимает cloud или local, получено: ' + target);
    return 1;
  }

  try {
    // ── Текущее состояние: облако читает сеть, local — файл дампа ──
    let previousQaza = null;
    let previousLog = null;
    let config = null;
    let token = null;
    if (target === 'cloud') {
      config = loadConfig(args);
      token = await resolveToken(config);
      const url = databaseUrl(config);
      console.log('Читаю текущее состояние из облака (только GET)...');
      previousQaza = await cloudGet(url, token, 'qaza');
      previousLog = await cloudGet(url, token, 'qazaLog');
    } else {
      if (!args.state) {
        console.error('ОШИБКА: --target local требует --state файл (дамп localStorage: ' +
          '_tools/dump-localstorage.html или JSON с ключами youplanner.*)');
        return 1;
      }
      const state = parseStateDump(readFileSync(resolve(process.cwd(), args.state), 'utf8'));
      previousQaza = state.qaza && state.qaza.v ? state.qaza.v : state.qaza;
      previousLog = state.qazaLog && state.qazaLog.v ? state.qazaLog.v : state.qazaLog;
      console.log('Состояние читается из файла дампа (сеть не трогается).');
    }

    planInput.existingLog = previousLog;
    planInput.existingQaza = previousQaza;
    const plan = planRestore(planInput);
    printPlan(plan, previousQaza, previousLog);

    if (target === 'local') {
      // Node не достаёт до localStorage браузера: применение — вставкой
      // сниппета в консоль вкладки приложения. Ключи и формы записи — те же,
      // что у saveQaza; метка записи раздела двигается, чтобы облако
      // не затёрло правку при следующей сверке.
      console.log('=== Сниппет для консоли браузера (F12 → Console → вставить → Enter) ===');
      console.log(buildLocalSnippet(plan.finalQaza, plan.finalLog, Date.now()));
      return 0;
    }

    if (plan.summary.nothingToDo) return 0;

    if (!args.apply) {
      console.log('DRY-RUN: ничего не записано. Для применения повторите команду с --apply.');
      console.log('Для локального применения без сети: тот же запуск с --target local --state дамп.txt');
      return 0;
    }

    // ── Применение: сначала бэкап предыдущего значения ──
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(ROOT, '.scratch', 'backup-kaza-' + stamp + '.json');
    mkdirSync(join(ROOT, '.scratch'), { recursive: true });
    writeFileSync(backupPath, JSON.stringify({
      savedAt: new Date().toISOString(),
      qaza: previousQaza,
      qazaLog: previousLog,
    }, null, 2));
    console.log('Бэкап предыдущего значения: ' + backupPath);

    const url = databaseUrl(config);
    const payload = { qaza: { v: plan.finalQaza, ts: Date.now() } };
    if (plan.finalLog) payload.qazaLog = plan.finalLog;

    console.log('Пишу разделы qaza и qazaLog (один PATCH)...');
    await cloudPatch(url, token, payload);

    // Проверка применения: читаем обратно то, что увидит приложение
    const verifyQaza = await cloudGet(url, token, 'qaza');
    const verifyLog = await cloudGet(url, token, 'qazaLog');
    console.log('Готово. Сервер теперь отвечает:');
    console.log('Раздел qaza: ' + JSON.stringify(verifyQaza));
    console.log('Раздел qazaLog: ' + logSummary(verifyLog));
    console.log('');
    console.log('Проверка в приложении: откройте YouPlanner, дождитесь сверки');
    console.log('(секция «Синхронизация»), затем посмотрите экран каза и «Статистику».');
    return 0;
  } catch (e) {
    console.error('ОШИБКА: ' + e.message);
    return 1;
  }
}

const HELP_TEXT = [
  'Восстановление статистики каза-намазов (ЖИВЫЕ ДАННЫЕ: сначала dry-run!).',
  '',
  'Цель (ровно одна):',
  '  --count N          сколько ВЫПОЛНЕННЫХ каза должно быть в журнале после',
  '                     восстановления (для 1527 в очереди останется 1530−1527=3)',
  '  --remaining N      каким должен быть ОСТАТОК очереди (альтернатива --count)',
  '  --dump файл.json   помесячная история {"2025-06": 90, ...}',
  '',
  'Применение:',
  '  (без флага)        dry-run: печать плана, ничего не записывается',
  '  --apply            применить план (облако: PATCH разделов qaza/qazaLog)',
  '',
  'Настройки:',
  '  --target cloud|local   куда писать (по умолчанию cloud; local печатает',
  '                         сниппет для консоли браузера, требует --state)',
  '  --state файл           дамп localStorage для --target local',
  '                         (_tools/dump-localstorage.html или JSON)',
  '  --end ГГГГ-ММ-ДД       последний день истории (по умолчанию вчера)',
  '  --per-day N            записей в день максимум (по умолчанию 3)',
  '  --debt N               долг на один намаз (по умолчанию 306, всего 1530)',
  '  --env файл             конфиг (по умолчанию _tools/restore-kaza.env)',
  '  --token TOKEN          готовый idToken (иначе refresh-токен или логин/пароль из конфига)',
  '',
  'Конфиг (секреты): _tools/restore-kaza.env — образец в _tools/restore-kaza.env.example.',
  'Проверено в dry-run перед каждым применением: бэкап печатается на экран и',
  'сохраняется в .scratch/backup-kaza-<время>.json.',
].join('\n');

// CLI-гвард: main зовётся только при запуске файла нодой. При импорте из
// тестов (node --test) процесс.argv[1] — раннер тестов, и тело не исполняется.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(function (code) {
    process.exitCode = code;
  }).catch(function (e) {
    console.error('ОШИБКА: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}
