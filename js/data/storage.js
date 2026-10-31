// Ключи localStorage. Реестр — только разделы ДАННЫХ: они синхронизируются
// с сервером и уходят в файловые копии. Девайс-локальные настройки и секреты
// (youplanner.api_key, youplanner.assistant_persona, youplanner.assistant_history,
// youplanner.assistant_model и пр.) сюда сознательно не входят: ключ нейросети
// не должен покидать устройство, а поведение ассистента — настройка конкретного
// устройства (обоснование — в шапке js/ui/assistant-view.js).
export const STORAGE_KEYS = {
  habits: 'youplanner.habits',
  records: 'youplanner.records',
  // Ключ снятого раздела задач: нужен только миграции migrateDropTasks(),
  // которая один раз удаляет старые данные задач с устройства.
  tasks: 'youplanner.tasks',
  schedule: 'youplanner.schedule',
  migrations: 'youplanner.migrations',
  // Месячные сводки историй старше года (js/data/archive.js)
  archive: 'youplanner.archive',
  // Надгробия удалённых привычек: { habitId: ts } — привычка удалена в
  // момент ts (js/data/habits.js). След удаления нужен аддитивному слиянию
  // (js/sync/merge.js): без него удалённая на одном устройстве привычка
  // воскресает с сервера. Раздел снимка синхронизации; в файловые бэкапы
  // не входит (buildBackup), поэтому разбор копий его никогда не видит.
  tombstones: 'youplanner.tombstones',
};
