# АДР: Дескрипторная таблица облачных разделов (applyCloudData / applyMergedFromCloud)

Дата: 2026-11-08. Статус: на рассмотрении владельца. Автор: Оркестратор Фабрики.
Основание: АДР Фазы 2 (предложение), приказ владельца 2026-11-08 «Рефакторинг applyCloudData».

## 1. Проблема

Знание «как раздел из облака ложится в хранилище» размазано по двум диспетчерам в двух файлах:

- `js/sync/sync.js` → `applyCloudData(data, ts)` — **232 строки, 11 inline-блоков** (путь «снимок целиком»);
- `js/sync/merge.js` → `mergeCloudIntoLocal()` — **116 строк** по-блочного хардкода (путь «гонка двух устройств»);
- `js/sync/sync.js` → `mergeSectionKey()` — switch на 10 случаев (раздел → ключ хранилища).

Три фазы атомарной записи (stage без записей → снимок прежнего состояния → запись с откатом) **скопированы дословно** в обеих функциях применения. Добавление нового раздела = правка в 2–3 местах плюс память о 7 осях семантики на раздел. Это цена каждого будущего раздела и главный источник риска рассинхронизации двух путей.

## 2. Матрица семантики разделов (выведена из кода, факт)

| Раздел | Конверт {v,ts} | Пустой с сервера | Pending-правка | Нормализация | Метка → карту | Слияние при гонке |
|---|---|---|---|---|---|---|
| habits | нет | не затирает локальный (`hasData ‖ локальный пуст`) | fill-holes (`cloudWins=!pending`) | — | — | `mergeHabitsById` + tombstones-ctx |
| records | нет | не затирает локальный | fill-holes | — | — | `mergeRecordsByDay` + tombstones-ctx |
| qaza | да | не затирает локальный | **skip** | — | да | правило конверта |
| prayer | да | не затирает локальный | apply | — | да | правило конверта |
| fast | да | не затирает локальный | apply | перестройка `{version, remaining, validFastHistory}` | да | правило конверта |
| qazaLog | нет | **затирает** (entries:[] непуст по ключам; «журнала нет» = null) | **skip** (отмена записи дороже) | `{version, since, validQazaLogEntries}` | — | аддитивное `mergeQazaLogEntries`, локального нет → сервер целиком |
| sleep | нет | не затирает локальный | fill-holes истории | `history: validSleepHistory` | — | `mergeSleepEntry(coreWins, historyWins=true)` |
| schedule | да | применяется всегда (валидный; дефолты подставляет load) | apply | — | да | правило конверта |
| archive | нет | заменяет целиком (данные производные) | apply | — | — | `mergeArchive` |
| tombstones | нет | не применяется вовсе (`hasData`) | apply | — | — | `mergeTombstonesById` (max-ts, аддитивно) + **в snapshot-пути тоже сливается с локальным** |

Плюс сквозные правила, не зависящие от раздела: общий гейт новизны (`serverSnapshotWins`: строго новее и без pending-спора); порядок stage; `SYNC_TS_KEY` — последний элемент stage; `SECTION_WRITE_TS_KEY` — в той же атомарной порции; `invalidateRecordsCache()` сразу после записи records; `bus.emit('sync:applied')` только при реально применённых данных; семантика возврата `true / false (откат) / undefined (нечего применять)`.

## 3. Решение

Знание о разделе становится **строкой данных**. Два применения становятся **движками**, которые читают таблицу.

### 3.1 `js/sync/sections.js` — таблица дескрипторов (новый файл, ~120 строк, чистые данные)

```js
export const CLOUD_SECTIONS = [
  {
    name: 'habits',                    // имя раздела в снимке
    key: STORAGE_KEYS.habits,          // ключ хранилища (замена mergeSectionKey)
    validate: validCloudHabits,        // (value) => bool — значение без конверта
    envelope: false,                   // {v, ts}-обёртка (unwrapSection)
    emptyWins: 'ifLocalEmpty',         // 'ifLocalEmpty' | 'always' | 'never'
    pending: 'fill',                   // 'skip' | 'fill' | 'apply'
    normalize: null,                   // (value) => stored | null
    snapshotMerge: null,               // (localValue, cloudValue) => stored (tombstones)
    raceMerge: 'collection:habits',    // стратегия гонки (см. 3.3)
    onWrite: null,                     // fn() после записи (records: invalidateRecordsCache)
    writeTs: false,                    // конвертная метка → SECTION_WRITE_TS
  },
  // ... 10 строк, порядок = порядок нынешних блоков applyCloudData
];
```

Импортирует только валидаторы из `merge.js` и ключи из `data/*`. Циклов нет. Валидаторы и merge-функции **не переписываются** — переиспользуются как есть.

### 3.2 `js/sync/apply-engine.js` — единая атомарная запись + путь снимка (новый файл, ~140 строк)

- `writeStaged(stage)` — **единственная** реализация трёх фаз (appliedLog, откат при первой ошибке, `storage:error`, `onWrite`-хуки). Её используют оба движка.
- `applyCloudSnapshot(data, ts)` — generic-луп по `CLOUD_SECTIONS` вместо 11 блоков: unwrap → validate → emptyWins → pending → envelope-win → normalize → snapshotMerge → stage; метки конвертов → карта; planner-ветка остаётся явной (после лупа, прежним кодом); `SECTION_WRITE_TS` и `SYNC_TS` — в конец stage; контракт возврата `true/false/undefined` и флаг `syncing` сохраняются дословно.

### 3.3 `js/sync/merge-engine.js` — путь гонки (новый файл, ~120 строк)

- `applyMergedFromCloud(previous)` сохраняет сигнатуру и наблюдаемое поведение: локальные загрузки — тем же литералом (10 строк, как сейчас); стратегии гонки — диспетчер по `raceMerge`:

| raceMerge | Реализация |
|---|---|
| `collection:habits` / `collection:records` | `mergeHabitsById` / `mergeRecordsByDay` с `tombstonesForMerge` и `sectionTsOf` |
| `envelope` | `sectionEnvelopeWins(ts, sectionWrites[name], cloudWins(name))` |
| `sleep` | `mergeSleepEntry` (pending → fill-holes) |
| `qazaLog` | аддитивное слияние, локального нет → сервер |
| `archive` | `mergeArchive` |

- diff «merged vs local» по-ключу, stage только из изменившихся, writeTs только для `writeTs: true` строк (замена `ENVELOPE_SECTIONS`), `writeStaged`, `pruneResolvedTombstones`, `sync:applied` — как сейчас.
- `mergeCloudIntoLocal` в `merge.js` **переписывается в луп по таблице** — все merge-функции остаются без изменений; switch `mergeSectionKey` в `sync.js` удаляется (ключ берётся из дескриптора).

### 3.4 Что сознательно НЕ входит в таблицу

- **plannerV1** — отдельный корень, Lamport-версии вместо меток, материализация списка из envelope (2 ключа, 2 хранилища). Втискивание в дескриптор размыло бы обе модели согласованности. Остаётся явной веткой в обоих движках (строк не прибавится).
- `adoptServerHabitsIfLocalEmpty`, `settleHabitsAfterSync`, `markCloudReady`, транспорт (`syncFromCloud/syncToCloud`, ETag, перенос planner-узла) — не трогаются.
- `merge.js`-функции слияний (mergeHabitsById, mergeRecordsByDay, …) — без изменений.

### 3.5 Итог по файлам

| Файл | Было | Станет |
|---|---|---|
| js/sync/sections.js | — | ~120 (новый) |
| js/sync/apply-engine.js | — | ~140 (новый) |
| js/sync/merge-engine.js | — | ~120 (новый) |
| js/sync/sync.js | 1249 | ~950 (−300: applyCloudData, mergeSectionKey, дубль трёх фаз) |
| js/sync/merge.js | 987 | ~900 (mergeCloudIntoLocal → луп) |

## 4. Разбивка на воркеров (3, изолированные worktree)

| Воркер | Файл | Вход (контракт из этого АДР) | Выход |
|---|---|---|---|
| A | `js/sync/sections.js` | матрица §2 + контракт §3.1 | таблица + `MERGE-NOTES.md` |
| B | `js/sync/apply-engine.js` | §3.2 + тест-фикстуры sync.test | движок записи + `applyCloudSnapshot` + notes со строкой-рецептом замены в sync.js |
| C | `js/sync/merge-engine.js` | §3.3 | движок гонки + notes (замена applyMergedFromCloud, правка mergeCloudIntoLocal) |

app.js не трогается никем. Перепайку sync.js/merge.js и коммит делает Оркестратор на сборке (проверено пилотом: воркеры не сорят в общих файлах, я собираю по их notes).

## 5. Гейты (реальное использование, не вакуум)

1. **Юнит-спека**: 823/823 — sync.test, sync-merge.test, sync-render, sync-render-audit, planner-sync, backup — это зафиксированное поведение, не переписывается.
2. **Дифференциальный гейт (новый, один прогон)**: фикстуры существующих sync-тестов прогоняются через старую реализацию (сохранённый сниппет) и новую — побайтное равенство localStorage после применения. Ловит расхождение семантик, которое юнит-спека не заметила.
3. **Живой браузер**: user-crash e2e 9/9 (сценарии 5–8 — реальная синхронизация: офлайн, обрыв PUT, битый JSON, 401-гард) + chaos e2e 7/7.
4. **Новый e2e-сценарий гонки**: два контекста Playwright против одного HTTP-мока Firebase — правка на устройстве A → PUT; правка на B → сверкa → `applyMergedFromCloud`; проверка победителя по меткам конвертов и отсутствия потерь. Добавляется в tests/e2e как постоянный сценарий.

## 6. Риски и откат

- Тонкие семантики (пустой qazaLog, sleep-история, tombstones в snapshot-пути) закрыты матрицей §2 + дифференциальным гейтом.
- Порядок stage сохраняется (могут читать тесты) — порядок строк таблицы = порядок нынешних блоков.
- Откат — `git revert` одного коммита; merge-функции не менялись, значит откат восстанавливает поведение побайтно.
- Воркеры упрутся в лимиты — Anti-Freeze: артефакт воркера забирается из worktree, доделываю сам (протокол пилота обкатан).

## 7. Порядок

ADR → ОК владельца → 3 worktree + провижининг → 3 воркера (`-free`, superpowers git-версия) → сборка Оркестратором → гейты 1–4 → коммит (пуш — по разрешению). Без ОК на этот АДР код не пишется.
