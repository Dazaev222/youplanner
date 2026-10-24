# YouPlanner

PWA-трекер привычек: таблица недели и карточки дня, каза-намазы с очередью,
времена молитв по координатам, счётчик уразы, цикл сна, статистика.
Работает офлайн, синхронизируется через Firebase Realtime Database (REST).

## Стек

- Чистые ES-модули (ES2020), без сборки и сторонних библиотек.
- Service Worker: HTML/JS/CSS — network-first с кэшем на офлайн,
  Firebase не кэшируется.
- Тесты — стандартная библиотека Node (`node --test`), песочница `node:vm`
  и настоящее исполнение модульного графа.

## Структура

```
index.html          # разметка + 18 стилей + единственный <script type="module">
styles/             # CSS по секциям исходного монолита (порядок = каскад)
js/
├── app.js          # точка входа: главный экран, таблица, привычки, статистика,
│                   # init/bindEvents, проводка шины событий
├── core/           # bus (события), dates, dom, storage
├── data/           # домены: habits, records, qaza, prayer, fast, sleep,
│                   # stats, schedule, backup, migrations, ui (константы)
├── sync/           # state (syncPending/saveNormalized), validators,
│                   # sync (Firebase: сверки, PUT, бэкапы, single-flight)
└── ui/             # state (appState, ui, isMobileView), вьюхи prayer/fast/
                    # sleep/qaza/schedule, stats-helpers
tests/              # smoke (граф, id, импорты), bus, backup, sync, core, modules
sw.js               # service worker (версия кэша растёт с каждым релизом)
```

Слои общаются через шину событий (`js/core/bus.js`): правка данных —
`data:changed`, применённый снимок сервера — `sync:applied`, замена бэкапом —
`data:replaced`, изменение очереди каза — `qaza:changed`, отказ хранилища —
`storage:error`. Прямых вызовов между слоями нет, граф импортов
однонаправленный и проверяется тестами.

## Запуск

- Локально: `python -m http.server 8000` (или `npx serve .`) и открыть
  `http://localhost:8000`. Service Worker работает только по http(s).
- Деплой — GitHub Pages, PWA устанавливается на iPhone («На экран Домой»).

## Тесты

```
npm test
```

`node --test "tests/*.test.mjs"`: дымовые (граф модулей, связность id,
отсутствие инлайн-обработчиков и дублей объявлений, каждый import находит
export, нет неявных зависимостей), шина событий, разбор бэкапов,
single-flight синхронизации, утилиты ядра, исполнение модульного графа.

## Ключевые правила проекта

- `safeSetItem` защищает от `QuotaExceededError`; все `save*` возвращают
  `boolean`, обработчики обязаны проверять и не перерисовывать UI при `false`.
- `loadRecords` кэшируется; прямые `localStorage.setItem` по этому ключу
  обязаны вызывать `invalidateRecordsCache()`.
- Снимок с сервера валидируется `validCloud*` — битый не затирает локальные
  данные; бэкапы лежат в соседнем узле Firebase (PUT данных их не трогает).
- `BACKUP_VERSION = 11`; импорт старых копий отвергается.
- Обновление ассетов — вместе с бампом версии кэша в `sw.js`.

## Документация

- `Spec.md` — архитектура, схемы данных, бизнес-правила.
- `status.md` — текущий статус и бэклог.

## История

- 2026-10-23/24 — монолитный index.html (10 430 строк) декомпозирован
  фазово: CSS → 18 файлов, данные → 11 модулей, ES-модули, шина событий,
  sync и вьюхи в доменных модулях; index.html — 657 строк. Тесты выросли
  с 7 до 34, все фазы проверялись побайтовыми сверками, песочницей и
  живым браузером.
