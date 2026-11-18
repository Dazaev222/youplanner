// Архив обычных привычек: неделимая пара состояния и версии.
//
// Привычка не переезжает в отдельную коллекцию и не теряет id/имя/цель/время.
// Архивное состояние живёт в тех же объектах youplanner.habits:
//   isArchived: boolean
//   archiveVersion: { counter, actorId }
//
// Отсутствие обоих полей — legacy-привычка, она активна (версия 0).
// Версия без флага и флаг без версии — некорректная пара: на границе она
// снимается, но сама привычка остаётся. Так повреждённый снимок не прячет
// привычку и не затирает валидную пару другой стороны.
//
// Модуль чистый: без DOM, localStorage, fetch и без импорта sync/ui.

import { isPlainObject } from '../core/struct.js';

// Предел длины actorId. Значение — идентификатор установки, не пользователь:
// uid, почта, ключи и имена сюда не попадают.
export const HABIT_ARCHIVE_ACTOR_MAX_LENGTH = 128;
const ACTOR_MAX = 128;
const ACTOR_CONTROL_RE = /[\u0000-\u001F\u007F]/;

export function validHabitArchiveActorId(actorId) {
  return typeof actorId === 'string' && actorId.length > 0 &&
    actorId.length <= ACTOR_MAX && !ACTOR_CONTROL_RE.test(actorId);
}

// Валидная версия: положительный безопасный counter и ограниченный actorId.
// 0 — только legacy-отсутствие версии, отдельным значением он не пишется.
export function validHabitArchiveVersion(version) {
  if (!isPlainObject(version)) return false;
  if (!validHabitArchiveActorId(version.actorId)) return false;
  return Number.isSafeInteger(version.counter) && version.counter >= 1;
}

function pairOf(state) {
  return {
    isArchived: state.isArchived === true,
    archiveVersion: {
      counter: state.version.counter,
      actorId: state.version.actorId,
    },
  };
}

// Разбор пары: kind — 'legacy' | 'valid' | 'invalid'. Для невалидной пары
// возвращается безопасное активное состояние, но kind позволяет слиянию
// отличить «повреждено» от «полей не было».
export function readHabitArchive(habit) {
  const hasFlag = habit && typeof habit === 'object' && habit.isArchived !== undefined;
  const hasVersion = habit && typeof habit === 'object' && habit.archiveVersion !== undefined;
  if (!hasFlag && !hasVersion) {
    return { kind: 'legacy', isArchived: false, version: { counter: 0, actorId: '' } };
  }
  if (!habit || typeof habit.isArchived !== 'boolean' ||
      !validHabitArchiveVersion(habit.archiveVersion)) {
    return { kind: 'invalid', isArchived: false, version: { counter: 0, actorId: '' } };
  }
  return {
    kind: 'valid',
    isArchived: habit.isArchived,
    version: {
      counter: habit.archiveVersion.counter,
      actorId: habit.archiveVersion.actorId,
    },
  };
}

// Нормализация на границе (чтение, облако, файл копии): валидная пара
// пересобирается только из известных полей, повреждённая — снимается.
// Привычка и её остальные поля не теряются; вход не мутируется.
export function normalizeHabitArchive(habit) {
  if (!habit || typeof habit !== 'object' || Array.isArray(habit)) return habit;
  const state = readHabitArchive(habit);
  const copy = Object.assign({}, habit);
  if (state.kind === 'valid') {
    copy.isArchived = state.isArchived;
    copy.archiveVersion = {
      counter: state.version.counter,
      actorId: state.version.actorId,
    };
  } else {
    delete copy.isArchived;
    delete copy.archiveVersion;
  }
  return copy;
}

// Следующая версия: legacy/повреждённая — 1, иначе max известной + 1.
// null — версия невозможна (плохой actorId или предел счётчика).
export function nextHabitArchiveVersion(version, actorId) {
  if (!validHabitArchiveActorId(actorId)) return null;
  const current = validHabitArchiveVersion(version) ? version.counter : 0;
  if (current >= Number.MAX_SAFE_INTEGER) return null;
  return { counter: current + 1, actorId: actorId };
}

// Сравнение версий: counter, затем actorId по кодовым единицам (без locale).
// Возвращает -1/0/1; невалидные версии не сравниваются.
export function compareHabitArchiveVersions(a, b) {
  const left = validHabitArchiveVersion(a) ? a : { counter: 0, actorId: '' };
  const right = validHabitArchiveVersion(b) ? b : { counter: 0, actorId: '' };
  if (left.counter !== right.counter) return left.counter < right.counter ? -1 : 1;
  if (left.actorId === right.actorId) return 0;
  return left.actorId < right.actorId ? -1 : 1;
}

// Слияние пары по двум привычкам с одним id. Возвращает пару победителя или
// null — «пары нет» (обе стороны legacy/повреждены). Повреждённая сторона
// не затирает валидную пару другой. При равной версии и разных флагах
// побеждает true: скрытая привычка не должна воскресать из-за повреждения.
export function mergeHabitArchivePair(localHabit, cloudHabit) {
  const local = readHabitArchive(localHabit);
  const cloud = readHabitArchive(cloudHabit);
  if (local.kind === 'invalid') return cloud.kind === 'valid' ? pairOf(cloud) : null;
  if (cloud.kind === 'invalid') return local.kind === 'valid' ? pairOf(local) : null;
  if (local.kind === 'legacy') return cloud.kind === 'valid' ? pairOf(cloud) : null;
  if (cloud.kind === 'legacy') return pairOf(local);
  const cmp = compareHabitArchiveVersions(local.version, cloud.version);
  if (cmp !== 0) return cmp > 0 ? pairOf(local) : pairOf(cloud);
  if (local.isArchived !== cloud.isArchived) {
    return { isArchived: true, archiveVersion: pairOf(local).archiveVersion };
  }
  return pairOf(local);
}

// Копия привычки с парой. null — снять пару (legacy-активная привычка).
export function applyHabitArchive(habit, pair) {
  const copy = Object.assign({}, habit);
  if (!pair) {
    delete copy.isArchived;
    delete copy.archiveVersion;
    return copy;
  }
  copy.isArchived = pair.isArchived === true;
  copy.archiveVersion = {
    counter: pair.archiveVersion.counter,
    actorId: pair.archiveVersion.actorId,
  };
  return copy;
}
