// Ключи localStorage
const STORAGE_KEYS = {
  habits: 'youplanner.habits',
  records: 'youplanner.records',
  // Ключ снятого раздела задач: нужен только миграции migrateDropTasks(),
  // которая один раз удаляет старые данные задач с устройства.
  tasks: 'youplanner.tasks',
  schedule: 'youplanner.schedule',
  migrations: 'youplanner.migrations',
};
