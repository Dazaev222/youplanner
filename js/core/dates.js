// Date → 'YYYY-MM-DD' по локальным компонентам. UTC-сериализация запрещена
// (даёт сдвиг на день), поэтому дата собирается из getFullYear/getMonth/getDate.
function toISODate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
// 'YYYY-MM-DD' → Date в локальной зоне
function parseISODate(s) {
  const parts = String(s).split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  return new Date(year, month, day);
}
// Новая дата, сдвинутая на n дней (n может быть отрицательным)
function addDays(d, n) {
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
function getWeekStart(d) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const day = (copy.getDay() + 6) % 7; // 0 — понедельник, 6 — воскресенье
  return addDays(copy, -day);
}
// Даты месяца с 1-го числа по сегодня включительно — знаменатель месячного
// прогресса. Для месяца, который уже закончился, — все его дни;
// для месяца, который ещё не начался, — пустой массив.
function getMonthDatesToToday(year, month) {
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
