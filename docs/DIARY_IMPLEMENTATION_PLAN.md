# Дневник привычек — план реализации (этап 1)

Источник: `C:\Users\Admin\Desktop\TZ_DIARY.md` (разделы 3–6, 9–12).
Слой: `js/harness/diary/`, тесты: `tests/diary-*.test.mjs`. UI не реализуется.

## Порядок этапов (TDD: тест → RED → минимальный код → GREEN)

1. [x] `ids.js` + `schema.js` — ID, лимиты, HH:MM, валидаторы, нормализация.
2. [x] `canonical.js` — канонизация, semanticRecord, fingerprint снапшота/экспорта.
3. [x] `clock.js` — внедряемые часы, оценка смещения, качество времени.
4. [x] `projection.js` — цепочки mutations, эффективные события/триггеры/политика.
5. [x] `statistics.js` — интервалы, серии, рекорд, месячные сегменты (IANA, DST).
6. [x] `indexeddb-store.js` — records/outbox/receipts/importSessions/analysisDrafts/cache, атомарность.
7. [x] `firebase-repository.js` — внедряемый RTDB-транспорт, create-only, чтение цепочек.
8. [x] `sync.js` — DAG отправки, unknown, конфликты, lease.
9. [x] `commands.js` — initializeDiary, createTrigger, confirmRelapse, prepareMutation, commitMutation.
10. [x] `index.js` — createDiaryService, интеграционный тест двух устройств.
11. [x] Полный `npm test` + отчёт (`docs/DIARY_STAGE1_REPORT.md`).
12. [ ] Firebase Rules + эмулятор (этап 6 ТЗ) — отдельная работа.
13. [ ] `backup.js` — экспорт/добавляющий импорт (этап 8 ТЗ).
14. [ ] `analysis.js` — ИИ-анализ и принятие политики категорий (этап 7 ТЗ).

## Ограничения

- Ветка `initial` зарезервирована; slot = predecessorOperationId, operationId = новая операция.
- Онлайн-правки не попадают в outbox; офлайн разрешён для срывов и новых триггеров.
- `acceptedAtMs` — серверный timestamp, не время срыва; в fingerprint не входит.
- IndexedDB-тесты — fake-indexeddb (unit). Реальная браузерная проверка не проводилась.
- Эмулятор Rules и реальный провайдер ИИ не запускались.
