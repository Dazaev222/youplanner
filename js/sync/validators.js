import { PRAYER_MADHHABS, PRAYER_METHODS } from '../data/prayer.js';
import { NAMAZ_ORDER, QAZA_VERSION, validQazaLogDate } from '../data/qaza.js';
import { SLEEP_MAX_MINUTES, sleepDurationMinutes, sleepFallMinutes, sleepTimeMinutes } from '../data/sleep.js';


// Раздел с данными: непустой список или непустой объект.
export function hasData(value) {
  if (!value || typeof value !== 'object') return false;
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}
// Привычки: массив, каждый элемент — объект со строковыми id и name
// и типом из набора привычек (тот же, что у HABIT_TYPES формы)
export function validCloudHabits(habits) {
  if (!Array.isArray(habits)) return false;
  const types = ['boolean', 'number', 'choice'];
  for (let i = 0; i < habits.length; i++) {
    const habit = habits[i];
    if (!habit || typeof habit !== 'object' || Array.isArray(habit)) return false;
    if (typeof habit.id !== 'string' || habit.id === '') return false;
    if (typeof habit.name !== 'string') return false;
    if (types.indexOf(habit.type) === -1) return false;
  }
  return true;
}
// Записи: объект, ключи — даты 'YYYY-MM-DD' (тот же формат, что validQazaLogDate),
// значения — объекты записей за день
export function validCloudRecords(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) return false;
  const dates = Object.keys(records);
  for (let i = 0; i < dates.length; i++) {
    if (!validQazaLogDate(dates[i])) return false;
    const day = records[dates[i]];
    if (!day || typeof day !== 'object' || Array.isArray(day)) return false;
  }
  return true;
}
// Очередь каза: текущая версия схемы, курсор — целое в пределах очереди,
// остаток — ровно пять ключей NAMAZ_ORDER с целыми неотрицательными
// значениями, история — массив (записи при чтении отфильтрует copyQaza)
export function validCloudQaza(qaza) {
  if (!qaza || typeof qaza !== 'object' || Array.isArray(qaza)) return false;
  if (qaza.version !== QAZA_VERSION) return false;
  if (!Number.isInteger(qaza.cursor) ||
      qaza.cursor < 0 || qaza.cursor >= NAMAZ_ORDER.length) return false;
  const remaining = qaza.remaining;
  if (!remaining || typeof remaining !== 'object' || Array.isArray(remaining)) return false;
  if (Object.keys(remaining).length !== NAMAZ_ORDER.length) return false;
  for (let i = 0; i < NAMAZ_ORDER.length; i++) {
    const value = remaining[NAMAZ_ORDER[i]];
    if (!Number.isInteger(value) || value < 0) return false;
  }
  return Array.isArray(qaza.history);
}
// Молитвы: координаты числами в тех же пределах, что у loadPrayer,
// мазхаб и метод — из своих списков
export function validCloudPrayer(prayer) {
  if (!prayer || typeof prayer !== 'object' || Array.isArray(prayer)) return false;
  if (!Number.isFinite(prayer.lat) || prayer.lat < -89.8 || prayer.lat > 89.8) return false;
  if (!Number.isFinite(prayer.lng) || prayer.lng < -180 || prayer.lng > 180) return false;
  if (PRAYER_MADHHABS.indexOf(prayer.madhhab) === -1) return false;
  return PRAYER_METHODS.indexOf(prayer.method) !== -1;
}
// Счётчик уразы: остаток — целое неотрицательное, история — массив
// (записи при записи раздела почистит validFastHistory)
export function validCloudFast(fast) {
  if (!fast || typeof fast !== 'object' || Array.isArray(fast)) return false;
  if (!Number.isInteger(fast.remaining) || fast.remaining < 0) return false;
  return Array.isArray(fast.history);
}
// Журнал выполнений каза: since — дата 'YYYY-MM-DD', entries — массив
// (записи при записи раздела почистит validQazaLogEntries)
export function validCloudQazaLog(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return false;
  if (!validQazaLogDate(log.since)) return false;
  return Array.isArray(log.entries);
}
// Запись о сне: те же проверки, что в loadSleep. bed и wake — время суток,
// fall — целое 0…120 по sleepFallMinutes. Пара actualWake/sleepMin либо
// отсутствует целиком, либо сходится: время — 'HH:MM', длительность — целое
// 0…1439 и равна расчётной от bed и fall. Пара realWake/realSleepMin —
// по тому же правилу. excluded, если задан, — только булев. История —
// массив (записи при записи раздела почистит validSleepHistory)
export function validCloudSleep(sleep) {
  if (!sleep || typeof sleep !== 'object' || Array.isArray(sleep)) return false;
  if (sleepTimeMinutes(sleep.bed) === null) return false;
  if (sleepTimeMinutes(sleep.wake) === null) return false;
  const fall = sleepFallMinutes(sleep.fall);
  if (fall === null) return false;
  if (sleep.actualWake !== undefined || sleep.sleepMin !== undefined) {
    if (sleepTimeMinutes(sleep.actualWake) === null) return false;
    if (!Number.isInteger(sleep.sleepMin) ||
        sleep.sleepMin < 0 || sleep.sleepMin >= SLEEP_MAX_MINUTES) return false;
    if (sleepDurationMinutes(sleep.bed, fall, sleep.actualWake) !== sleep.sleepMin) return false;
  }
  const hasRealWake = sleep.realWake !== null && sleep.realWake !== undefined;
  const hasRealSleepMin = sleep.realSleepMin !== null && sleep.realSleepMin !== undefined;
  if (hasRealWake !== hasRealSleepMin) return false;
  if (hasRealWake) {
    if (sleepTimeMinutes(sleep.realWake) === null) return false;
    if (!Number.isInteger(sleep.realSleepMin) ||
        sleep.realSleepMin < 0 || sleep.realSleepMin >= SLEEP_MAX_MINUTES) return false;
    if (sleepDurationMinutes(sleep.bed, fall, sleep.realWake) !== sleep.realSleepMin) return false;
  }
  if (sleep.excluded !== undefined && typeof sleep.excluded !== 'boolean') return false;
  return Array.isArray(sleep.history);
}
// Расписание с сервера — один раздел, минимум: объект без массива, у которого
// все четыре типа дня — массивы. Пункты не глубже проверяются: битый пункт
// не должен терять раздел целиком, отбросить его при чтении может
// loadSchedule (как validSleepHistory), а повторно сохранённая копия пройдёт
// через saveSchedule. Раздел без ключа schedule (снимок старой версии)
// отвергается этим же правилом.
export function validCloudSchedule(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!Array.isArray(data.weekday) || !Array.isArray(data.weekend) ||
      !Array.isArray(data.fasting) || !Array.isArray(data.physical)) return false;
  return true;
}
