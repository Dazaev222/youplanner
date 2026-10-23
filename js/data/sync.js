export const FIREBASE_URL = 'https://youplanner-5c2f5-default-rtdb.firebaseio.com/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9';
// Бэкапы живут ОТДЕЛЬНЫМ корнем, а не ребёнком синхронизируемого узла:
// PUT на FIREBASE_URL заменяет узел целиком вместе со всеми детьми,
// поэтому вложенный /backups стирался бы каждой же синхронизацией
// сразу после записи. Соседний корень основной PUT не трогает.
export const FIREBASE_BACKUPS_URL = 'https://youplanner-5c2f5-default-rtdb.firebaseio.com/youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9-backups';
export const SYNC_TS_KEY = 'youplanner.sync.ts';
// Сколько версий держим в узле бэкапов (FIREBASE_BACKUPS_URL)
export const BACKUP_LIMIT = 10;
// Отправка после правки откладывается: серия тапов по клеткам даёт один PUT
export const SYNC_DEBOUNCE_MS = 1500;
// Сколько держится надпись о ручной синхронизации
export const SYNC_STATUS_MS = 2000;
