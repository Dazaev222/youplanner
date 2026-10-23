import { bus } from '../core/bus.js';
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
  localStorage.setItem(STORAGE_KEYS.migrations, JSON.stringify(migrations));
}
export function migrateDropTasks() {
  if (migrationDone('drop-tasks')) return;
  markMigration('drop-tasks');
  localStorage.removeItem(STORAGE_KEYS.tasks);
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
  markMigration('press');

  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === PRESS_HABIT_ID) return;
  }

  habits.push(defaultHabit(PRESS_HABIT_ID));
  saveNormalized(function () { saveHabits(habits); });
}
