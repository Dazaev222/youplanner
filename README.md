# YouPlanner

PWA-трекер привычек.

## Стек

- Чистый HTML/CSS/JS (ES2020), без сторонних библиотек и сборки.
- Firebase Realtime Database через REST API.
- Кэширование в `localStorage`.

## Демо

https://dazaev222.github.io/youplanner/ — развёрнут на GitHub Pages,
устанавливается на iOS как PWA.

## Установка

- Открыть файл `index.html` в браузере.
- Либо развернуть как PWA на iPhone (добавить на экран «Домой»).

Для проверки офлайн/PWA поднять любой статический сервер в корне:
`python -m http.server 8000` (или `npx serve .`). Service worker
регистрируется только по https (или localhost) — по `file://` его
регистрация молча пропускается.

## Архитектура (кратко)

- Весь код в одном файле `index.html`.
- Логика синхронизации: `syncToCloud`, `syncFromCloud`, `applyCloudData`.
- Сохранение данных: функции `save*` (возвращают `boolean`); кэш — `loadRecords`.
- Разделы: Привычки, Каза (молитвы), Пост, Сон, Статистика, Расписание.

## Дизайн-система

- Шрифт Inter, палитра TickTick (акцент `#5870C5`).
- Эффект Liquid Glass (`backdrop-filter`) для модалок.

## Тесты

```
npm test
```

Запускает `tests/smoke.test.mjs` (7 дымовых проверок через `node:test`):
синтаксис встроенного скрипта, дубли id, мёртвые ссылки, конфиг Firebase.
Playwright-наборы живут в `.scratch/` (не в репо) и требуют ручного запуска
на Windows — см. `Spec.md`.

## Ключевые правила проекта

- Задачи (`youplanner.tasks`) удалены навсегда — миграция drop-tasks.
  Вместо них — «Расписание» (пока read-only).
- `BACKUP_VERSION = 10`. Импорт старых бэкапов с tasks отвергается.
- `safeSetItem` защищает от `QuotaExceededError`. Все `save*` возвращают
  `boolean`, обработчики обязаны проверять и не перерисовывать UI при `false`.
- `loadRecords` кэшируется; прямые `localStorage.setItem` по этому ключу
  обязаны вызывать `invalidateRecordsCache()`.
- `applyCloudData` валидирует снимок с сервера семью `validCloud*` —
  битый снимок не затирает локальные данные.

## Документация

- `Spec.md` — архитектура, схемы данных, бизнес-правила.
- `status.md` — текущий статус и бэклог.

## Лицензия

Без лицензии (личный проект).
