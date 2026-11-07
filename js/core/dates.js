// Миллисекунды в сутках для разниц дат (Date.UTC, метки времени). Календарные
// дни из таких разниц достают целым округлением, а не накоплением миллисекунд:
// в зонах с переводом часов сутки бывают не ровно 24 часа.
export const DAY_MS = 86400000;
// Date → 'YYYY-MM-DD' по локальным компонентам. UTC-сериализация запрещена
// (даёт сдвиг на день), поэтому дата собирается из getFullYear/getMonth/getDate.
export function toISODate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
// Дата, проверенная без instanceof: песочница тестов (node:vm) живёт в другом
// реалме, и `hostDate instanceof vmDate` там ложно даже на настоящую Date —
// подставленная фиксированная дата терялась и цифры съезжали на часы машины.
// Invalid Date тоже не годится: из неё не собрать ни окно, ни сравнение.
export function isDateLike(value) {
  return Object.prototype.toString.call(value) === '[object Date]'
    && !Number.isNaN(value.getTime());
}
// 'YYYY-MM-DD' → Date в локальной зоне; на мусоре возвращает Invalid Date,
// поэтому проверяйте результат через isDateLike, а не на истинность (объект
// ложен только по getTime()).
export function parseISODate(s) {
  const parts = String(s).split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  return new Date(year, month, day);
}
// Новая дата, сдвинутая на n дней (n может быть отрицательным)
export function addDays(d, n) {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + n,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds()
  );
}
// Понедельник недели этой даты, время 00:00
export function getWeekStart(d) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const day = (copy.getDay() + 6) % 7; // 0 — понедельник, 6 — воскресенье
  return addDays(copy, -day);
}
// Даты месяца с 1-го числа по сегодня включительно — знаменатель месячного
// прогресса. Для месяца, который уже закончился, — все его дни;
// для месяца, который ещё не начался, — пустой массив.
export function getMonthDatesToToday(year, month) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const end = lastDay < today ? lastDay : today;
  if (end < first) return [];

  const dates = [];
  for (let day = 1; day <= end.getDate(); day++) {
    dates.push(toISODate(new Date(year, month, day)));
  }
  return dates;
}
// Русское склонение слова «день» при числе: 1 и 21 — день, 2–4 и 22–24 —
// дня, 0, 5–20 и 11–14 — дней. Жило тремя копиями (матрица, ассистент,
// ураза) с одним правилом — сведено сюда, чтобы формы на разных экранах
// не разъезжались.
export function pluralDays(n) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}
