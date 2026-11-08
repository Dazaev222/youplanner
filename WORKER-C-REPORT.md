# WORKER-C-REPORT — расширение гейта гонки конвертов целых разделов {v, ts} (P1-3)

## Роль и ветка
- Воркер C (исполнитель расширения гейта гонки проекта YouPlanner).
- Worktree: `C:\Users\Admin\Desktop\OpenCode\data\worktree\ad7253\gate-race-envelope`
- Ветка: `worker/gate-race-envelope` (worktree чист перед началом: `git status --short` пуст).
- Порт мока: 8936, `node_modules` через junction к основному репозиторию.

## Задача
Раширить `tests/e2e/sync-race.e2e.mjs` проверкой разрешения конфликтов ЦЕЛЬНЫХ РАЗДЕЛОВ по конвертам `{v, ts}` (раздел `qaza`, управляемые P1-3), помимо существующего 5/5 по привычкам (`habits`).

## Что изменено
Файл: `tests/e2e/sync-race.e2e.mjs` — добавлены шаги 6–9. Шаги 1–5 оставлены без изменений (ни одного ослабления).

Добавлено:
- фикстуры `qazaA`, `qazaB`, `qazaA2` (валидные по `validCloudQaza`: `version: 3`, курсор 0–4, остатки по 5 намазам, `history: []`);
- метки записи раздела `T1 < T2 < T3` заданы явно (от `Date.now()` сценария, а не часами приложения — иначе `loadQaza()` при загрузке страницы сдвинул бы метку на время загрузки и сравнение конвертов превратилось бы в гонку публикаций);
- хелперы `setQazaLocal(page, qaza, writes)` (прямая запись `youplanner.qaza` + `youplanner.sync.section-writes`, минуя `saveQaza`), `readQazaLocal(page)`, `syncPush(page, expectEnvelope)` (ручной push `#settings-sync-push` с ожиданием доставки PUT по разделяемому состоянию мока `fb`);
- шаги 6–9 со проверками реальных данных: `localStorage` (qaza, section-writes), `fb.snapshot.qaza`, `pageerror` (`page.errorsCollected`).

## Проверяемый сценарий (метки T1 < T2 < T3)

| Шаг | Действие | Ожидание (конверт P1-3) |
|-----|----------|-------------------------|
| 6 | A: локальная `qaza-A`, `section-writes.qaza = T1` → sync (push) | На сервере `fb.snapshot.qaza` = `{v: qaza-A, ts: T1}` — метка T1 ушла в конверт именно из section-writes |
| 7 | B: локальная `qaza-B`, `section-writes.qaza = T2` → sync (push) | На сервере `fb.snapshot.qaza` = `{v: qaza-B, ts: T2}` |
| 8 | A: `manualSync` (pull через `#settings-sync-now`) | При `T2 > T1` серверный конверт побеждает: A принимает `qaza-B`; `localStorage.qaza` = `qaza-B`, `section-writes.qaza` = `T2` |
| 9 | A: локальная `qaza-A2`, `section-writes.qaza = T3` → sync (push) | Серверный `T2` стареет: локальная правка не теряется, PUT уходит с `qaza-A2` (`fb.snapshot.qaza.v` = `qaza-A2`, `ts: T3`) |

Механизм под testes: `applyCloudData` применяет серверный конверт только если `sectionEnvelopeWins(envelopeTs, sectionWrites[row.name], true)` (строгоใหлее локальной метки раздела); `syncBody` публикует раздел через `publishSectionEnvelope('qaza', loadQaza())` с `ts = sectionWrittenTs('qaza')`.

## Доказательство (реальные данные, а не заглушки)
На каждом шаге 6–9 проверялись:
- `localStorage.getItem('youplanner.qaza')` — точная структура раздела на устройстве;
- `localStorage.getItem('youplanner.sync.section-writes')` — метка раздела `qaza` равна T1/T2/T3 соответственно;
- `fb.snapshot.qaza` — серверный конверт `{v, ts}` с ожидаемой версией и меткой;
- `page.errorsCollected` — пусто (нет `pageerror`).

Из логов прогона (итоговый, без отладочных выводов):
- шаг 6: сервер принял `{"v":{qazaA},"ts":1794156410024}` (T1);
- шаг 7: сервер принял `{"v":{qazaB},"ts":1794156411024}` (T2); кольцо 412 отработало (conflicts = 3);
- шаг 8: A при ручной сверке принял `qaza-B`, локальная метка переняла серверный T2;
- шаг 9: PUT ушёл с `{"v":{qazaA2},"ts":1794156412024}` (T3), серверный T2 не перекрыл локальную правку.

## Итоги прогонов
- `node tests/e2e/sync-race.e2e.mjs`: **9 PASS, 0 FAIL** (5 существующих шагов habits + 4 новых шага qaza; ожидаемо 7+, получено 9).
- `npm test`: **823/823, 0 fail** (контроль пройден полностью).

Примечание к контролю: в работе отсутствовал файл `database.rules.local.json` (он в `.gitignore`, существует в основном репозитории, не попал в worktree). Тест #784 `sync.test.mjs` падал с `ENOENT` до моих изменений — файл скопирован из основного репозитория для чистого контроля (gitignored, в коммит не входит). Моё изменение затрагивает только `tests/e2e/sync-race.e2e.mjs`, который `npm test` (глоб `tests/*.test.mjs`) не запускает.

## Выводы
- Конфликт целых разделов по конвертам `{v, ts}` (P1-3) работает на живом приложении с двумя контекстами Playwright против одного HTTP-мока Firebase (ETag/If-Match/412): серверный конверт с более новой меткой раздела побеждает при ручной сверке, а локальная правка с ещё более новой меткой уходит в PUT и не теряется.
- Все существующие шаги е2е сохранены без ослабления; добавленные шаги покрывают разделы `qaza` с конвертами, real data и отсутствие `pageerror`.
- Единственная особенность среды: эта сборка Playwright принимает в `page.evaluate` только один аргумент — аргументы завернуты в один объект.

## Файлы в коммите
- `tests/e2e/sync-race.e2e.mjs` — расширение гейта (шаги 6–9).
- `WORKER-C-REPORT.md` — настоящий отчёт.
