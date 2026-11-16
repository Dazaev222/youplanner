# Дневник привычек — отчёт по этапу 1

Дата: 16.11.2026. Проект: `C:\Users\Admin\Desktop\youplanner-new`.
Основание: `C:\Users\Admin\Desktop\TZ_DIARY.md` (разделы 3–6, 9–12).
Объём этапа: сервис данных, локальное хранилище, синхронизация, команды, тесты.
UI (HTML/CSS), Firebase Rules, ИИ и импорт/экспорт в этот этап не входили.

## Новые файлы

| Файл | Назначение |
|---|---|
| `js/harness/diary/errors.js` | единый контракт `{ok,value}` / `{ok:false,error}` |
| `js/harness/diary/ids.js` | `newId`, `assertFirebaseKey`, зарезервированный `initial` |
| `js/harness/diary/schema.js` | лимиты, HH:MM, allowlist, валидаторы, `normalizeRecord` |
| `js/harness/diary/canonical.js` | канонический JSON, `semanticRecord`, SHA-256 fingerprint |
| `js/harness/diary/clock.js` | внедряемые часы, смещение сервера, качество времени |
| `js/harness/diary/projection.js` | `walkMutationChain`, `effectiveEvent/Triggers/Policy`, `replayJournal` |
| `js/harness/diary/statistics.js` | интервалы, текущая серия/рекорд, месячные сегменты, DST, частоты |
| `js/harness/diary/indexeddb-store.js` | records/outbox/receipts/importSessions/analysisDrafts/cache, lease, миграции |
| `js/harness/diary/firebase-repository.js` | внедряемый RTDB-транспорт, create-only, чтение цепочек |
| `js/harness/diary/sync.js` | DAG outbox, unknown/конфликты, merge серверных записей |
| `js/harness/diary/commands.js` | `initializeDiary`, `createTrigger`, `confirmRelapse`, `prepareMutation`, `commitMutation` |
| `js/harness/diary/index.js` | `createDiaryService` — стабильный API без UI |
| `tests/diary-*.test.mjs` (10 файлов) | 93 теста |
| `tests/helpers/diary-memory-server.mjs` | in-memory RTDB-транспорт для тестов |
| `docs/DIARY_IMPLEMENTATION_PLAN.md` | план этапов |
| `docs/DIARY_STAGE1_REPORT.md` | этот отчёт |

Также изменены: `package.json`, `package-lock.json` — devDependency
`fake-indexeddb@6.2.8` для unit-тестов IndexedDB.

## Контракты реализации

- Путь: `diaryV1/{uid}/journals/{journalId}/{initialization|events|triggerCreations|mutations|analyses}`.
- Слот цепочки = `predecessorOperationId`; поле `operationId` — новая операция.
  Первая правка: путь `/initial`, `predecessorOperationId='initial'`,
  `predecessorSlot` отсутствует. Вторая: путь `/{opA}`, `predecessorSlot='initial'`.
- `acceptedAtMs` — серверный timestamp, не время срыва; в fingerprint не входит.
- `originImportId` поддержан в allowlist и исключён из `semanticRecord`.
- Офлайн разрешён только новым срывам/триггерам (outbox). `editEvent`,
  `renameTrigger`, `applyCategoryPolicy` — только онлайн, без скрытой очереди.
- Outbox: `pending/sending/unknown/acknowledged/blocked`, payload не удаляется,
  `sending` после перезапуска становится `unknown`, повтор сверяет тот же путь.
- `commitMutation`: согласие обязательно; head и целевая сущность перечитываются;
  чужая сущность не блокирует правку. `UNKNOWN_COMMIT` не меняет локальную проекцию.
- `getProjection()` возвращает `timeAnomaly`, если событие оказалось в будущем;
  серия не становится отрицательной.
- `initializeDiary`: локальная initialization не требует сети; конкурентный
  create-only проигрыш принимает серверную (часы повторно не запрашиваются).

## RED → GREEN (фактические команды)

Каждый модуль: тест написан первым, запуск давал `ERR_MODULE_NOT_FOUND`
(модуль ещё не существовал), затем минимальная реализация и GREEN.

| Тесты | RED | GREEN |
|---|---|---|
| `diary-schema` + `diary-ids` | `ERR_MODULE_NOT_FOUND` | 15 + 5 |
| `diary-canonical` + `diary-clock` | `ERR_MODULE_NOT_FOUND` | 8 + 6 |
| `diary-projection` | `ERR_MODULE_NOT_FOUND` | 11 |
| `diary-statistics` | `ERR_MODULE_NOT_FOUND` | 12 |
| `diary-store` | `ERR_MODULE_NOT_FOUND`, затем ошибки транзакции/чтения | 8 |
| `diary-sync` | `ERR_MODULE_NOT_FOUND`, затем 4 падения логики | 9 |
| `diary-mutations` + `diary-service` | `ERR_MODULE_NOT_FOUND`, затем 4 падения | 9 + 10 |

Последующие добавления (guard триггера, `timeAnomaly`) также начинались
с падающего теста и заканчивались GREEN.

Финальные прогоны:

```text
node --test "tests/diary-*.test.mjs"   → tests 93, pass 93, fail 0
npm test                              → tests 1163, pass 1163, fail 0
```

## Что НЕ проверено (честные ограничения)

1. **Firebase Rules / эмулятор не запускались.** `database.rules.json` не менялся.
   Этап 6 ТЗ (эмулятор Auth+RTDB) не выполнялся; Java/Firebase CLI не проверялись.
2. **Реальная IndexedDB в браузере не проверена.** Использован maintained
   `fake-indexeddb`; это unit-доказательство, а не сохранение на телефоне.
3. **ИИ-анализ не реализован** (`analysis.js`, этап 7), реальный провайдер не вызывался.
4. **Экспорт/импорт не реализованы** (`backup.js`, этап 8); `importSessions`
   подготовлены в хранилище, но контракты `exportDiary/planImport/...` ещё нет.
5. **Service worker** не обновлён: новых UI-точек входа нет, precache не менялся.
6. **Production Firebase, реальные личные данные, платный ИИ** не использовались.

## Следующие этапы

1. Firebase Rules только для `diaryV1` + тесты на эмуляторе (этап 6).
2. Браузерная проверка IndexedDB (`npm run test:diary:storage`) и эмулятор
   (`npm run test:diary:rules`) с реальными командами.
3. `backup.js`: экспорт доступного снимка, добавляющий импорт, resume (этап 8).
4. `analysis.js`: явный вызов, порции, согласие на политику категорий (этап 7).
5. Подключение модулей к UI — отдельным исполнителем, после данных.
