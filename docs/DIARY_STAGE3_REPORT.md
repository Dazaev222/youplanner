# Дневник привычек — отчёт по этапу 3

Дата: 16.11.2026. Проект: `C:\Users\Admin\Desktop\youplanner-new`.
Основание: `C:\Users\Admin\Desktop\TZ_DIARY.md` (разделы 7, 9, 10 этап 7, 11)
и `C:\Users\Admin\Desktop\TZ_DIARY_FRONTEND.md` (разделы 13, 16).
Объём этапа: анализ ИИ, композиция Auth/RTDB/IndexedDB и контракт `subscribe`
в сервисе дневника. UI (HTML/CSS/`diary-ui/`, `js/ui/*`) не изменялся.
Живая Firebase и платный провайдер ИИ не вызывались.

## Новые файлы

| Файл | Назначение |
|---|---|
| `js/harness/diary/analysis.js` | `buildAnalysisDataset`, `planAnalysisChunks`, `requestAnalysis`, `validateAnalysisProposal`, `prepareCategoryPolicy`, `applyAnalysis` |
| `js/harness/diary/composition.js` | `createFirebaseRestTransport`, `createLocalKeyStore`, `createAnalysisProvider`, `createDiaryComposition` |
| `tests/diary-analysis.test.mjs` | 15 тестов анализа, порций, недоверенного JSON, согласия и `STALE_ANALYSIS` |
| `tests/diary-composition.test.mjs` | 8 тестов REST-транспорта, keyStore, провайдера и сборки сервиса |
| `docs/DIARY_STAGE3_REPORT.md` | этот отчёт |

## Изменённые файлы

| Файл | Что изменено |
|---|---|
| `js/harness/diary/index.js` | методы `requestAnalysis`, `prepareCategoryPolicy`, `applyAnalysis`, `subscribe`; общий `projectionFor`; уведомления после успешных команд, синхронизации и импорта |
| `js/harness/diary/errors.js` | коды `PROVIDER_KEY_MISSING`, `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_CANCELLED`, `PROVIDER_UNAVAILABLE`; retryable для 429/timeout/500 |
| `js/harness/diary/schema.js` | `validateAnalysis`, `validateAnalysisProposal` и allowlist полей анализа |
| `js/harness/diary/commands.js` | `prepareMutation`/`commitMutation` для `applyCategoryPolicy` с явным согласием и fingerprint |
| `js/harness/diary/projection.js` | `effectivePolicy` и эффективная атрибуция событий категорией |
| `package.json`, `package-lock.json` | без новых зависимостей на этом этапе (`fake-indexeddb` добавлен ранее) |

## Контракт анализа (§7, §9)

- `buildAnalysisDataset` берёт **всю доступную историю** из локального снимка,
  включая committed pending; 30-дневного среза нет. Точные числа считает
  `statistics.js`, а не модель.
- Полнота помечается `complete` / `partial` / `unknown`; для `partial`
  перечислены `pendingEventIds`, `syncComplete === false`.
- В датасет не попадают `uid`, `deviceId`, `acceptedAtMs`, outbox, receipts,
  lease и тексты ошибок.
- Ответ провайдера — недоверенный JSON. Разрешены только `categories`,
  `triggerMappings`, `reasonGroups`, `summary`; проверяются существующие
  `triggerId`/`eventId`, лимиты и запрещённые ключи.
- `planAnalysisChunks` строит manifest всех покрытых событий. При превышении
  бюджета возвращается `ANALYSIS_TOO_LARGE` с `requiredChunks`; молчаливой
  обрезки и частичного плана нет.
- `requestAnalysis` вызывается только явно. Ключ читается через внедрённый
  `keyStore`, передаётся только в `Authorization` провайдера и не попадает в
  prompt, черновик, Firebase, экспорт, логи или тесты. Автоматических повторов
  после 401/429/timeout/отмены нет.
- `requestAnalysis` сохраняет черновик только после полной проверки ответа;
  невалидный JSON и неизвестные ID черновиком не становятся.
- `applyAnalysis` требует отдельного `consent: true`, сверяет локальный
  fingerprint, цепь политики и существование триггеров. Устаревший снимок и
  конфликт головы политики дают `STALE_ANALYSIS`.
- Принятая политика — обычная мутация `applyCategoryPolicy` с полной картой и
  необязательным `sourceAnalysisId`. Ручные категории сохраняются, если явно
  не переданы заменяющие карты. Старые события не переписываются: новая
  категория применяется к новым событиям.

## Контракт композиции (§7, §9)

- `createFirebaseRestTransport`: RTDB REST `…/<path>.json`, Firebase ID token
  только параметром `?auth=`, не Bearer. `create` — `PUT`; отказ 401/403
  уточняется контрольным `GET`: занятый слот → `CONFLICT`, пустой →
  `PERMISSION_DENIED`.
- Сеть и таймаут различаются (`OFFLINE` / `TIMEOUT`); скрытого offline-replay
  в транспорте нет.
- `createLocalKeyStore` читает существующий ключ `youplanner.api_key`, не
  создаёт его и не смешивает с данными дневника.
- `createAnalysisProvider` — OpenAI-совместимый запрос к существующему
  `https://api.neuraldeep.ru/v1/chat/completions`, модель по умолчанию
  `qwen3.6-35b-a3b`. Ключ только в заголовке; тексты ошибок его не содержат.
  CORS/сеть → `PROVIDER_BROWSER_UNAVAILABLE`, 401/403 → `PROVIDER_AUTH`,
  429 → `PROVIDER_RATE_LIMIT`, 5xx → `PROVIDER_UNAVAILABLE`.
- `createDiaryComposition` связывает существующий Auth (`getOwnerAccount`,
  `getAuthToken`), IndexedDB-хранилище, RTDB-транспорт и сервис. Без uid —
  `AUTH_REQUIRED`; без IndexedDB — честная `INVALID_DATA`, без подмены памятью.
- `journalId` стабилен в `youplanner.diary.journalId.<uid>`, `deviceId` — в
  `youplanner.diary.deviceId`; повторная композиция не теряет историю.
- `subscribe` — read-only подписка сервиса: сразу отдаёт
  `{ journalId, projection, syncState }`, затем после успешных мутаций,
  `synchronize` и импорта. Возвращает `{ unsubscribe }`. Удалённые изменения
  появляются после `synchronize()`, фонового polling нет.

## RED → GREEN (фактическая последовательность)

1. Сначала написаны `tests/diary-analysis.test.mjs` и
   `tests/diary-composition.test.mjs`.
2. RED: `node --test "tests/diary-analysis.test.mjs" "tests/diary-composition.test.mjs"`
   завершился с `ERR_MODULE_NOT_FOUND` для `analysis.js` и `composition.js`,
   exit code 1 — модулей ещё не было.
3. Затем добавлены `errors.js`-коды, `analysis.js`, `composition.js` и методы
   `index.js`.
4. GREEN: те же 23 теста — `23 pass, 0 fail`.
5. Регрессия: `node --test "tests/diary-*.test.mjs"` — `148 pass, 0 fail`.
6. Полный прогон: `npm test` — `1218 pass, 0 fail` (~85,2 с).

## Тестовая статистика

| Команда | Результат |
|---|---|
| `node --test "tests/diary-analysis.test.mjs" "tests/diary-composition.test.mjs"` | 23 / 23 pass |
| `node --test "tests/diary-*.test.mjs"` | 148 / 148 pass |
| `npm test` | 1218 / 1218 pass |

## Локальная и серверная готовность

- **Локально завершено:** доменный код анализа и композиции, контракты
  сервиса, unit/integration-тесты на `fake-indexeddb` и in-memory RTDB.
- **На сервере не подтверждено:** реальные Firebase Rules, реальный RTDB REST,
  реальный браузерный IndexedDB/CORS и реальный вызов платного провайдера.
  Это не заявляется как production-готовность.

## Не проверено (честно)

1. **Firebase Rules/эмулятор.** Java не установлен, эмулятор не запускался;
   проверка правил остаётся статической (`tests/diary-rules.test.mjs`).
2. **Реальный RTDB REST.** Транспорт проверен на mock `fetch`; живой проект,
   токен владельца и сеть не использовались.
3. **Реальный браузер.** IndexedDB проверен через `fake-indexeddb`, CORS и
   поведение `fetch` в PWA — нет.
4. **Платный провайдер ИИ.** Реальный запрос к `api.neuraldeep.ru` не
   выполнялся: нет отдельного разрешения владельца. Проверен только
   mock-провайдер и mock `fetch`.
5. **Чат ассистента.** По `TZ_DIARY_FRONTEND.md` §13 готового адаптера передачи
   `summary` в `js/ui/assistant-view.js` нет; UI и этот контракт не трогались.
6. **Живая публикация Firebase.** Правила и приложение не публиковались.

## Следующий шаг

1. С согласия владельца — прогнать правила в эмуляторе (нужна Java) и один
   реальный RTDB-запрос под owner uid.
2. Отдельным этапом — браузерный smoke-тест композиции (IndexedDB + CORS) и,
   при явном разрешении, один реальный вызов провайдера.
3. Согласовать с владельцем модуля `assistant-view.js` доставку проверенного
   `summary` в существующую ленту; параллельную историю не создавать.
