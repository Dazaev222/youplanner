# ARCHITECTURE.md — YouPlanner

Дата: 2026-10-31.
Перенесено из рабочих отчетов и README/Spec.

Этот файл — снимок архитектуры на момент чтения 2026-10-31. Будущие фичи из бэклога описаны только в разделе «Что НЕ входит». Работы, которые ещё идут (правила Firebase), — одной строкой в «В развитии» и не описаны как внедрённые.

Живые источники (читать актуальные версии):

- [README.md](../README.md) — Структура, Слои, Ключевые правила, Безопасность Firebase, История.
- [Spec.md](../Spec.md) — §0 текущий статус, §10 «Слой данных» / «Слой интерфейса», нормативные разделы.
- [NIGHT_REPORT.md](../NIGHT_REPORT.md) — §4 архитектура Vision (план фичи; код Vision на момент ночи не был написан — см. расхождение ниже).
- [DAY_REPORT.md](DAY_REPORT.md) — дневная сессия 2026-10-31 (сессия 2): Firebase auth, транзакционность, мемоизация.
- [status.md](../status.md) — текущий статус, «Работает», заходы.

## 1. Что это

PWA-трекер привычек: таблица недели и карточки дня, каза-намазы с очередью, времена молитв по координатам, счётчик уразы, цикл сна, статистика, ИИ-ассистент с чтением PDF. Работает офлайн, синхронизируется через Firebase Realtime Database (REST). [README.md, шапка]

ПК-версия, мобильная версия и синхронизация завершены. Приложение работает как PWA без сборки. [Spec.md §0; status.md]

## 2. Слои

Названия слоёв — как в источниках.

Стек (README.md): чистые ES-модули (ES2020), без сборки и сторонних библиотек. Единственная вендорная зависимость — pdf.js 4.10.38 (Apache-2.0), локальные копии в `js/vendor/`, офлайн через прекэш SW.

Пакеты `js/` (README.md «Структура»):

| Слой | Где | Назначение |
|---|---|---|
| Точка входа | `js/app.js` | главный экран, таблица, привычки, статистика, init/bindEvents, проводка шины событий |
| Ядро | `js/core/` | bus (события), dates, dom, storage, db (IndexedDB) |
| Данные | `js/data/` | домены: habits, records, qaza, prayer, fast, sleep, stats, schedule, backup, migrations, ui (константы), background |
| Синк | `js/sync/` | state (syncPending/saveNormalized), validators, sync (Firebase: сверки, PUT, бэкапы, single-flight) |
| Интерфейс | `js/ui/` | state (appState, ui, isMobileView), вьюхи assistant/ prayer/fast/sleep/qaza/schedule, main-table, stats |
| Вендор | `js/vendor/` | pdf.js 4.10.38: pdf.min.mjs + pdf.worker.min.mjs |
| Разметка | `index.html` | разметка + 19 стилей + единственный `<script type="module">` |
| Стили | `styles/` | CSS по секциям исходного монолита (порядок = каскад) |
| Service Worker | `sw.js` | HTML/JS/CSS — network-first с кэшем на офлайн; Firebase не кэшируется; vendor-файлы pdf.js — в прекэше ASSETS |

Spec.md §10 называет те же слои «Слой данных» и «Слой интерфейса» (функции). README.md «Слои общаются через шину событий».

Модули, которые есть на диске на момент чтения и упомянуты в README «История» / status.md, но не нарисованы в дереве «Структура» README: `js/core/debounce.js`, `js/data/archive.js`, `js/data/firebase-auth.js`, `js/data/image.js`, `js/sync/merge.js`, `js/ui/assistant-api.js`, `js/ui/assistant-pdf.js`, `js/ui/assistant-vision.js`, `js/ui/router.js` и другие вьюхи. Дерево README — краткое; полный список файлов `js/` шире.

## 3. Связи модулей

### 3.1 Шина событий (`js/core/bus.js`)

Слои общаются через шину событий. Прямых вызовов между слоями нет, граф импортов однонаправленный и проверяется тестами. [README.md «Структура»]

События, названные в README:

- `data:changed` — правка данных;
- `sync:applied` — применённый снимок сервера;
- `data:replaced` — замена бэкапом;
- `qaza:changed` — изменение очереди каза;
- `storage:error` — отказ хранилища.

[Источник: README.md «Структура», абзац после дерева]

Дополнительно из status.md/истории: `data:replaced` дорисовывает расписание; `sync:applied` и `data:replaced` перерисовывают только видимый экран (`js/app.js`, ROUTE_RENDER). [status.md, заход 2026-10-31 «Архитектурные фиксы»]

Исключение падений: в `js/core/bus.js` try/catch на handler — исключение в одном рендере не обрывает остальных подписчиков. [NIGHT_REPORT.md §2.1]

### 3.2 Граф импортов

- `index.html` — единственный `<script type="module">`, точка входа ведёт в `js/app.js`. [README.md Структура]
- `js/app.js` проводит шину и init/bindEvents. [README.md]
- `js/sync/sync.js` — единственная обёртка `fetchWithTimeout`: каждый запрос синхронизации уходит с параметром `?auth=`; вызывающие про аутентификацию не знают. [README.md «Безопасность Firebase»; DAY_REPORT.md §2]
- `js/data/firebase-auth.js` — анонимная аутентификация REST identitytoolkit без Firebase SDK. [README.md; DAY_REPORT.md §2]
- `js/ui/assistant-view.js` — чат с api.neuraldeep.ru; PDF — `js/ui/assistant-pdf.js`; Vision — `js/ui/assistant-vision.js`; сжатие — `js/data/image.js`. [NIGHT_REPORT.md §4; status.md «ИИ-Ассистент»; README.md История 2026-10-31 Vision]
- Слияние снимков перед PUT — `js/sync/merge.js`. [status.md заход 2026-10-31; README.md История]
- Архивация историй — `js/data/archive.js`. [status.md; README.md История]
- Цикл импортов habits↔records не образуется (связь однонаправленная). [DAY_REPORT.md §6]

### 3.3 Ключевые контракты между слоями

- Boolean-контракт `save*`: `saveHabits`, `saveRecords`, `saveQaza`, `saveQazaLog`, `savePrayer`, `saveFast`, `saveSleep`, `saveStatsPeriod` возвращают boolean; обработчики обязаны проверять и не перерисовывать UI при `false`. [README.md «Ключевые правила»; Spec.md §10 «Контракт сохранения»]
- `loadRecords` кэшируется; прямые `localStorage.setItem` по этому ключу обязаны вызывать `invalidateRecordsCache()`. [README.md Ключевые правила]
- Снимок с сервера валидируется `validCloud*` — битый не затирает локальные данные. [README.md; Spec.md]
- `BACKUP_VERSION = 11`; импорт старых копий отвергается. [README.md Ключевые правила]
- `safeSetItem` защищает от `QuotaExceededError`. [README.md]

## 4. Карта каталогов

По README.md «Структура»:

```
index.html          # разметка + 19 стилей + единственный <script type="module">
styles/             # CSS по секциям исходного монолита (порядок = каскад)
js/
├── app.js          # точка входа: главный экран, таблица, привычки, статистика,
│                   # init/bindEvents, проводка шины событий
├── core/           # bus (события), dates, dom, storage, db (IndexedDB)
├── data/           # домены: habits, records, qaza, prayer, fast, sleep,
│                   # stats, schedule, backup, migrations, ui (константы),
│                   # background (сжатие фото фона + настройки)
├── sync/           # state (syncPending/saveNormalized), validators,
│                   # sync (Firebase: сверки, PUT, бэкапы, single-flight)
├── ui/             # state (appState, ui, isMobileView), вьюхи assistant/
│                   # prayer/fast/sleep/qaza/schedule, main-table, stats
└── vendor/         # pdf.js 4.10.38: pdf.min.mjs + pdf.worker.min.mjs
tests/              # smoke (граф, id, импорты), bus, backup, sync, core,
                    # modules, xss, timers, assistant, sleep, qaza-done,
                    # sw-assets, schedule, fast
sw.js               # service worker (версия кэша растёт с каждым релизом)
```

[Источник: README.md «Структура»]

Spec.md §0 (обновлено 2026-10-29) даёт `index.html` (768 строк) + 19 файлов `styles/` + ES-модули `js/` (core/data/sync/ui/vendor). README не указывает число строк index.html.

Дополнительно на диске и в историях заходов (не в кратком дереве README): `database.rules.json`, `manifest.json`, `js/core/debounce.js`, `js/data/{archive,firebase-auth,image}.js`, `js/sync/merge.js`, вьюхи и хелперы `js/ui/`. Кэш SW: README История и status.md — `youplanner-v29`; Spec.md §0 (2026-10-29) — `youplanner-v25`; DAY_REPORT.md (сессия 2, до Vision) — v27. Актуальное по status.md на 2026-10-31 — v29.

Firebase-узлы (status.md «Расположение»):

- основной: `https://youplanner-5c2f5-default-rtdb.firebaseio.com/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9`
- корень бэкапов: `FIREBASE_BACKUPS_URL` = `.../youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9-backups` (старый вложенный `youplanner-a7x9k2/backups` не используется).

## 5. Поток данных на примере одного запроса

### 5.1 UI → data → storage (отметка привычки)

1. Пользователь отмечает привычку в таблице / карточке дня. Обработчик в `js/ui/` вызывает `setRecord` / составную операцию data-слоя. [Spec.md §10 «Обязательный паттерн обработчиков»]
2. Data-слой (`js/data/records.js` и домены) мутирует состояние, пишет через `save*` / `safeSetItem` в localStorage. `setRecord` до мутации делает снимок records, при `false` откатывает его и ставит `scheduleSync()` только при успехе. [Spec.md §10]
3. Если запись не удалась (`false` / QuotaExceeded) — обработчик прерывается до перерисовки, закрытия попапа и подтверждающих тостов; `safeSetItem` сам показывает тост «Не удалось сохранить: хранилище переполнено». [Spec.md §10; README.md Ключевые правила]
4. При успехе — `data:changed` по шине, UI перерисовывает нужный экран; `scheduleSync()` планирует синк. [README.md шина; Spec.md]
5. `calcProgress` мемоизирован (версия записей + поля habit + краи периода); `touchRecordsVersion()` вызван во всех шести точках мутаций recordsCache. [DAY_REPORT.md §4; status.md 2026-10-31 «Транзакционность и кэш»]

### 5.2 UI → data → sync → Firebase (обмен с облаком)

1. `js/sync/state.js` / `saveNormalized` — состояние синка; `js/sync/sync.js` выполняет сверку и PUT. [README.md Структура]
2. Все 5 обменов синка идут через единственную обёртку `fetchWithTimeout` с таймаутом 20 с; токен добавляется параметром `?auth=` в этой единственной точке. [DAY_REPORT.md §2; status.md 2026-10-31 «Безопасность Firebase»; README.md]
3. Токен: `js/data/firebase-auth.js` — анонимный signUp для нового устройства или обмен refresh-токена для знакомого; idToken кэшируется в памяти с запасом 5 минут; refresh-токен устройства лежит в localStorage `youplanner.fb.refresh` (вне STORAGE_KEYS, в синхронизацию и копии не входит). Любая неудача аутентификации даёт `null` — запрос идёт без токена, синк не останавливается; после неудачи пауза 5 минут. [README.md «Безопасность Firebase»; DAY_REPORT.md §2]
4. Перед PUT снимки двух устройств сливаются: `js/sync/merge.js` — коллекции сливаются аддитивно (привычки по id, записи по датам, дни сна, тройки журнала каза), цельные разделы — LWW по sectionTs. [status.md 2026-10-31; README.md История]
5. Применение снимка сервера — `applyCloudData` в `js/sync/sync.js`: три фазы (валидация ВСЕХ разделов в stage без записи; снимок предыдущего состояния; применение с откатом на первой ошибке). Отказ → `false`, `SYNC_TS` не записан, `sync:applied` не эмитится, `storage:error` → тост. [DAY_REPORT.md §3]
6. Применённый снимок — событие `sync:applied`; перерисовывается только видимый экран. [README.md шина; status.md 2026-10-31]
7. Бэкапы лежат в соседнем узле Firebase (`FIREBASE_BACKUPS_URL`), PUT данных их не трогает. [README.md Ключевые правила; status.md]

### 5.3 Ассистент (UI → внешний API)

1. `requestAssistantReply()` в `js/ui/assistant-view.js` → POST `https://api.neuraldeep.ru/v1/chat/completions`, payload `{ model, messages }`. [NIGHT_REPORT.md §4.1]
2. Системный промпт — снимок трекера до 20 000 символов; история последних 50 реплик (в запрос — 20), ключ и история только на устройстве. [README.md; status.md]
3. PDF: модульная переменная `pdfContext` (не в localStorage, не в история), прикрепляется к каждому запросу, пока не убран; длинные PDF (больше 50 000 символов) нарезаются на фрагменты по абзацам (до 200 000 символов чтения), в запрос уходят фрагменты по ключевым словам. [README.md; NIGHT_REPORT.md §4.1]
4. Vision (по status.md «Работает» и README История 2026-10-31 — уже в коде): до 3 фото через камеру у поля ввода, сжатие общим `compressImage` (`js/data/image.js`, 1568 px / 400 КБ), Base64 в payload к qwen3.8-27b (OpenAI-vision content), превью в ленте, чип сброса, гейтинг по модели. История остаётся текстовой с маркером `[фото: имя]`. [status.md «Работает» / заход 2026-10-31 Vision; README.md История]

Расхождение Vision: NIGHT_REPORT.md §4 называется «План фичи Vision — только план, кода нет». README.md История, status.md «Работает» и наличие на диске `js/ui/assistant-vision.js` / `js/data/image.js` описывают Vision как реализованный 2026-10-31 (тесты 145 → 153, SW v29). В этой выписке Vision описан как внедрённый — по более поздним README/status; ночной план оставлен как исторический источник идеи.

### 5.4 Офлайн и SW

Service Worker: HTML/JS/CSS — network-first с кэшем на офлайн; Firebase не кэшируется; vendor-файлы pdf.js — в прекэше ASSETS. При изменении списка файлов поднимается версия `CACHE` в `sw.js`. [README.md Стек, Зависимости]

## 6. Железные правила проекта

Коротко; полностью — [README.md «Ключевые правила проекта»](../README.md) и [Spec.md](../Spec.md).

- `safeSetItem` защищает от `QuotaExceededError`; все `save*` возвращают `boolean`, обработчики обязаны проверять и не перерисовывать UI при `false`. [README.md]
- `loadRecords` кэшируется; прямые `localStorage.setItem` по этому ключу обязаны вызывать `invalidateRecordsCache()`. [README.md]
- Снимок с сервера валидируется `validCloud*` — битый не затирает локальные данные; бэкапы лежат в соседнем узле Firebase. [README.md]
- `BACKUP_VERSION = 11`; импорт старых копий отвергается. [README.md]
- Обновление ассетов — вместе с бампом версии кэша в `sw.js`. [README.md]
- Правки — в `index.html`, `styles/` и `js/`; сборки нет. [Spec.md §2a]
- Firebase SDK не вводился (запрещён правилом проекта) — аутентификация напрямую REST. [DAY_REPORT.md §2]

## 7. Тесты (слои проверки)

`npm test` — `node --test "tests/*.test.mjs"`: README.md — **153/153 в 20 файлах**. Chaos-E2E (Playwright): `node tests/e2e/chaos.e2e.mjs` — 7/7 сценариев. Проба правил — `node tests/e2e/firebase-rules.e2e.mjs` (вне npm test). [README.md Тесты]

Хронология счётчиков за 2026-10-31 (все даты один день, разные сессии):

- NIGHT_REPORT.md §1: 90/90 (ночь);
- DAY_REPORT.md §1: 110/110 (день, сессия 2);
- README.md / status.md: 145 → 153 (Vision), chaos 7/7, SW v29.

Актуальное — README/status (153/153, v29). Spec.md §0 (обновлено 2026-10-29) застал 57/57 и v25 — устаревшее относительно README.

## 8. Безопасность Firebase — что внедрено, а что нет

Код аутентификации есть: `js/data/firebase-auth.js`, обёртка `fetchWithTimeout` с `?auth=`, `database.rules.json` с `auth != null`, graceful-деградация. Шаги 1–2 владельца выполнены 2026-10-31: Anonymous включён, Web API Key вписан. [README.md «Безопасность Firebase»; DAY_REPORT.md §2]

Шаг 3 — Publish правил в консоли для обоих инстансов (основного и `-backups`) — по README «осталось»; DAY_REPORT.md: «правила пока публичны», E2E-скрипт честно репортит `FAIL правила публичны`. До публикации правил приложение работает как раньше. [README.md; DAY_REPORT.md §2]

В этой выписке правила `auth != null` описаны как подготовленные, но не как опубликованные. Проверки опубликованной версии в консоли Firebase в рамках чтения источников не было.

## 9. В развитии

Идут работы по Firebase-правилам (публикация `database.rules.json` на обоих инстансах) — в этой выписке как внедрённые не описаны. [README.md «Безопасность Firebase», шаг 3; задание документатору]

## 10. Что НЕ входит (будущие фичи из бэклога)

Из Spec.md §0 «Вне области»: аккаунт, планшет, уведомления и звуки. [Spec.md §0]

Из NIGHT_REPORT.md §3 (стоп-кран, требовали решения владельца; часть позже закрыта — см. ниже):

- Транзакционность применения снимка — закрыта в DAY_REPORT.md §3 (applyCloudData / applyBackup «всё или ничего»). В бэклоге не числится.
- Частичный импорт бэкапа — закрыт там же (applyBackup).
- Гонка бэкапов двух устройств — закрыта слиянием снимков перед PUT (`js/sync/merge.js`). [status.md 2026-10-31]
- Публичный Firebase-узел — код auth готов, публикация правил осталась (см. §8 этого файла).
- Неограниченный рост историй — частично закрыт архивацией старше года в месячные своды (`js/data/archive.js`). [status.md 2026-10-31] Политика чистки сверх архивации в прочитанных источниках как закрытая не названа.
- Производительность: карточка привычки ~1500 вызовов `calcProgress` — закрыто мемоизацией (DAY_REPORT.md §4); `saveSleep` под debounce 500 мс; `sync:applied` перерисовывает только видимый экран. [status.md 2026-10-31]

Спецификация §0: «Следующее: не зафиксировано, работы — по запросу владельца». Открытых пунктов аудита Opus 5.5 нет. [Spec.md §0]

Снятые записи журнала Spec.md: §2b, §11.4, §11.4б, §11.4в, §11f–§11p (в архитектуру не входят). Раздел «Задачи» снят 2026-10-14, вместо него «Расписание». [Spec.md §0]