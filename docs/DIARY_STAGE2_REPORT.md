# Дневник привычек — отчёт по этапу 2

Дата: 16.11.2026. Проект: `C:\Users\Admin\Desktop\youplanner-new`.
Основание: `C:\Users\Admin\Desktop\TZ_DIARY.md` (разделы 4, 8, 9, 10, 11).
Объём этапа: Firebase Rules для `diaryV1`, JSON-экспорт, добавляющий импорт,
TDD-тесты, согласование с существующим скриптом публикации правил.
UI (HTML/CSS/JS-экраны) не изменялся. Правила в живой Firebase не публиковались.

## Новые файлы

| Файл | Назначение |
|---|---|
| `js/harness/diary/backup.js` | `exportDiary`, `validateImport`, `planImport`, `executeImport`, `resumeImport` |
| `tests/diary-rules.test.mjs` | 13 статических тестов `diaryV1` в обоих файлах правил |
| `tests/diary-backup.test.mjs` | 18 тестов экспорта, импорта, конфликтов, лимитов и resume |
| `docs/DIARY_STAGE2_REPORT.md` | этот отчёт |

## Изменённые файлы

| Файл | Что изменено |
|---|---|
| `database.rules.json` | добавлен `diaryV1`; в каждом разрешении литерал `OWNER_UID` |
| `database.rules.local.json` | пересобран `_tools/set-owner-uid.mjs`: живой uid подставлен в 12 разрешений |
| `js/harness/diary/schema.js` | `originImportId` в allowlist и проверка ключа RTDB |
| `js/harness/diary/index.js` | методы `exportBackup`, `validateBackup`, `planBackupImport`, `importBackup`, `resumeBackupImport` |
| `tests/diary-service.test.mjs` | интеграционный тест экспорта/импорта через service API |
| `tests/firebase-rules.test.mjs` | корень `diaryV1` берётся из `firebase-repository.js`; домен исключён из проверок, которые к write-only листьям неприменимы |
| `tests/set-owner-uid.test.mjs` | ожидания расширены с 6 до 12 разрешений; отдельная проверка `diaryV1` |
| `_tools/set-owner-uid.mjs` | обновлён комментарий о новом домене; логика подстановки не менялась |
| `package.json`, `package-lock.json` | `fake-indexeddb@6.2.8` (добавлен на этапе 1) |

`database.rules.local.json` содержит живой uid и не публикуется. Публичный
`database.rules.json` остаётся fail-closed: uid `OWNER_UID` не существует,
поэтому шаблон не даёт доступа никому.

## Контракт Firebase Rules (§4, §11)

- Чтение разрешено только на `diaryV1/$ownerUid`, условие:
  `auth != null && auth.uid === $ownerUid && auth.uid === "OWNER_UID"`.
  На `diaryV1`, `journals` и `$journalId` разрешающей `.write` нет.
- Запись разрешена только на листьях:
  `initialization`, `events/$eventId`, `triggerCreations/$triggerId`,
  `mutations/$entityKey/$predecessorOperationId`, `analyses/$analysisId`.
- Каждый лист create-only:
  `auth.uid === $ownerUid && auth.uid === "<owner>" && !data.exists() && newData.exists()`.
  Перезапись и удаление запрещены; проверка идёт и для публичного шаблона,
  и для собранного local-файла.
- `.validate` проверяет `schemaVersion === 1`, совпадение id с ключом пути,
  `acceptedAtMs === now`, обязательные поля и типы, лимиты строк.
- Неизвестные поля запрещены через `$other: {".validate": false}` на каждом
  уровне, включая `changes`.
- Цепочка правок: `predecessorSlot` обязателен для слота не `initial`;
  из него читается предыдущий узел, и его `operationId` обязан совпадать с
  `predecessorOperationId`. `operationId === 'initial'` запрещён.
- Проверяются тип операции и целевая сущность: `event_*` → `editEvent` и
  существующее событие, `trigger_*` → `renameTrigger` и существующий триггер,
  `categoryPolicy` → `applyCategoryPolicy`.
- `basisFingerprint` обязан соответствовать `^sha256:[0-9a-f]{64}$`.
- `analyses` проверяют `analysisId`, `sourceFingerprint`, непустой
  `coveredEventIds`, `model`, `generatedAtMs` и `acceptedAtMs === now`.

Использованные методы сверены с официальным справочником правил RTDB:
`data.parent()`, `newData.parent()`, `hasChild()`, `hasChildren()`,
`val()`, `isString()`, `isNumber()`, `matches()`, `replace()`, `length`.
Эмулятор не запускался (см. раздел «Не проверено»).

## Контракт экспорта и импорта (§8, §11)

### Экспорт

- Снимок читается из IndexedDB и не требует сети.
- В файл входят все доступные локальные записи, включая pending; это явно
  отражено в `snapshot.pendingEventIds`, `snapshot.syncComplete` и
  `recordStates`.
- `statistics` считается на одном `exportedAtMs`; нормализуется до хеширования,
  чтобы JSON-parse не менял `contentHash`.
- `acceptedAtMs`-placeholder `{".sv":"timestamp"}` заменяется числом; uid,
  токены, outbox, receipts, lease и тексты ошибок в файл не попадают.
- `snapshot.fingerprint` — SHA-256 предметного содержимого,
  `integrity.contentHash` — SHA-256 файла без самого поля hash.

### Импорт

Порядок: `validateImport` → `planImport` → `executeImport` → `resumeImport`.

- Валидация отклоняет: битый JSON, неверную версию/формат, несовпадение
  fingerprint или contentHash, `__proto__`/`constructor`/`prototype`,
  неизвестные поля, placeholder времени, нечисловой `acceptedAtMs`, битую
  цепь правок, отсутствующие сущности, неверный `journalId`/`timeZone`,
  превышение лимитов размера и количества.
- План только добавляет. Семантически совпадающая запись → `skippedDuplicate`;
  тот же id с другим payload → `conflict`; отсутствующая зависимость →
  `blockedDependencies`. Ничего не перезаписывается и не удаляется.
- Правки к уже существующей сущности не применяются автоматически и попадают
  в `requiresSeparateConsent`. Правки `categoryPolicy` всегда требуют
  отдельного согласия.
- Новые записи получают `originImportId = sessionId`; повторный импорт того же
  файла не растёт и не создаёт серверных дублей.
- Исполнение сначала коммитит локальные записи и outbox, затем пытается
  серверный create. Одинаковые ID сохраняются при повторе и resume.
- Конфликт на сервере не перезаписывает чужую запись. Если сущность появилась
  независимо, импортированные правки к ней не добавляются.
- Прогресс сессии сохраняется в `importSessions`. Если прогресс не сохраняется,
  импорт возвращает ошибку, а не отчёт об успехе.
- Отчёт разделяет `localComplete` (локально всё записано) и
  `serverAcknowledged` (сервер подтвердил всё, конфликтов и блокировок нет);
  `complete` — только их конъюнкция.

## RED → GREEN (фактические результаты)

| Шаг | RED | GREEN |
|---|---|---|
| `backup.js` + `diary-backup.test.mjs` | `ERR_MODULE_NOT_FOUND` для `backup.js` | 15/15, затем 18/18 после трёх edge-case тестов |
| `diary-rules.test.mjs` | в правилах отсутствовал `diaryV1` | 13/13 |
| `firebase-rules.test.mjs` после расширения | домен не был учтён в проверках корней | вместе с `diary-rules` 19/19 |
| service API экспорта/импорта | `a.service.exportBackup is not a function` | 1/1 |
| три edge-case теста backup | 3 `not ok` | 3/3 |
| `set-owner-uid` после добавления `diaryV1` | 3 `not ok`: wildcard не закреплялся за uid | 27/27 в наборе правил |

Найденные тестами и исправленные дефекты:

1. `statistics` содержал `null`-поля, из-за чего `contentHash` не совпадал
   после JSON-parse. Исправлено нормализацией статистики перед хешированием.
2. В отчёте отсутствовал `addedIds` в состоянии импорта.
3. Rules использовали только `$ownerUid`; скрипт публикации заменяет лишь
   литерал `OWNER_UID`, поэтому `diaryV1` оставался бы без пина на владельца.
   Добавлен литерал `OWNER_UID` рядом с `$ownerUid`; local-файл пересобран.
4. Импорт мог счесть успехом ситуацию, когда локальная и серверная версии
   записи расходятся. Теперь это `LOCAL_PAYLOAD_DIFFERS`.
5. Чужой `initialization` на сервере теперь даёт `JOURNAL_MISMATCH`, а не
   обычный конфликт записи.

## Фактические команды

```text
node --test "tests/diary-backup.test.mjs"
  → 18 pass, 0 fail

node --test "tests/diary-*.test.mjs"
  → 125 pass, 0 fail, ~3.6 s

node --test "tests/set-owner-uid.test.mjs" "tests/diary-rules.test.mjs" "tests/firebase-rules.test.mjs"
  → 27 pass, 0 fail

node _tools/set-owner-uid.mjs --uid <uid-владельца>
  → написано database.rules.local.json, 12 подстановок

node _tools/set-owner-uid.mjs --check
  → ok: database.rules.local.json — uid … в 12 разрешениях

npm test
  → 1195 tests, 1195 pass, 0 fail, 0 cancelled, 0 skipped, ~86.2 s
```

Временный генератор `diaryV1` и отладочные скрипты удалены. Каталог `.scratch`
не трогался, кроме двух созданных в этой сессии файлов.

## Не проверено (честные границы)

- **Firebase Rules не исполнялись.** В окружении нет Java, поэтому
  `firebase emulators:exec` и RTDB-эмулятор не запускались. Правила проверены
  статически: структура, отсутствие наследуемой `.write`, create-only,
  обязательные поля и текст проверок цепи. Это не доказательство поведения
  правил в живом RTDB.
- **Правила не опубликованы.** `database.rules.local.json` собран, но в
  Firebase Console не вставлялся; `firebase deploy` не выполнялся.
- **Нет проверки на реальном Firebase.** Транспорт в тестах — in-memory
  (`tests/helpers/diary-memory-server.mjs`), а не REST/SDK с реальной
  аутентификацией, задержками и серверными timestamp.
- **Нет браузерного E2E.** `fake-indexeddb` проверяет логику хранилища, но не
  реальный IndexedDB, PWA-перезапуск и квоты браузера.
- **UI не проверялся и не менялся** — по условию этапа.
- **`onEntry` и resume** проверены имитацией offline и потери ответа, а не
  реальным обрывом сети.
- **Интеграция с существующим синком приложения** (`js/sync/*`, экраны
  дневника) не выполнялась: домен дневника пока вызывается только тестами.

## Следующий шаг

1. Установить Java с согласия владельца и прогнать
   `firebase emulators:exec --only database "<тесты правил>"`.
2. Опубликовать `database.rules.local.json` вручную и проверить запрет
   перезаписи и удаления на живом проекте.
3. Подключить `createDiaryService` к экранам дневника (отдельный этап, UI).
4. Добавить браузерный E2E: экспорт → очистка → импорт → fingerprint.
