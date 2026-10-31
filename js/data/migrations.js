import { bus } from '../core/bus.js';
import { safeSetItem } from '../core/storage.js';
import { defaultHabit, loadHabits, saveHabits } from './habits.js';
import { PRESS_HABIT_ID } from './records.js';
import { STORAGE_KEYS } from './storage.js';
import { saveNormalized } from '../sync/state.js';
import { hasData } from '../sync/validators.js';


// Какие разовые правки устройство уже прошло. Отметка нужна затем, чтобы
// правка не повторялась на каждой загрузке: иначе удалённую привычку
// возвращал бы каждый старт, а не только первый.
export function loadMigrations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.migrations);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    return {};
  }
}
export function migrationDone(name) {
  return loadMigrations()[name] === true;
}
export function markMigration(name) {
  const migrations = loadMigrations();
  if (migrations[name] === true) return;
  migrations[name] = true;
  safeSetItem(STORAGE_KEYS.migrations, JSON.stringify(migrations));
}
export function migrateDropTasks() {
  if (migrationDone('drop-tasks')) return;
  // Сначала действие, потом пометка: сбой между ними повторит миграцию
  // на следующем запуске, а removeItem сам по себе повторобезопасен.
  // Пометка до действия при сбое записи (квота) навсегда отменяла бы чистку.
  localStorage.removeItem(STORAGE_KEYS.tasks);
  markMigration('drop-tasks');
  bus.emit('data:changed');
}
// «Пресс» заведена в дефолтах позже остальных привычек, поэтому у устройства
// со сложившимся списком сама она не появится — список доводит эта миграция.
// Срабатывает один раз: удалённый «Пресс» после неё не возвращается.
// Зовётся только после сверки и только на непустом списке: пустое хранилище
// значит «ещё не знаем», и дополнять в нём нечего (§13).
export function migratePressHabit() {
  if (migrationDone('press')) return;

  const habits = loadHabits();
  if (!hasData(habits)) return;

  // Проверка «уже есть» — до добавления и до пометки: сбой между действием
  // и пометкой повторит прогон на следующем запуске, и без неё «Пресс»
  // дублировался бы в списке.
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === PRESS_HABIT_ID) {
      markMigration('press');
      return;
    }
  }

  // Порядок тот же — действие, потом пометка; пометка ставится только
  // после удавшейся записи: иначе несостоявшееся дополнение было бы
  // забыто навсегда
  habits.push(defaultHabit(PRESS_HABIT_ID));
  const saved = saveNormalized(function () { return saveHabits(habits); });
  if (saved === false) return;
  markMigration('press');
}
