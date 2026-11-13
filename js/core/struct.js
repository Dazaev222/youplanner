// Общие примитивы проверки структуры значений (аудит 2026-11-13, YP-08):
// четыре попарно одинаковых предиката «это plain object» — isRecord
// (matrix-schedule.js), plannerPlainObject (sync/merge.js), plannerPlainObj
// (data/storage.js), plainObject (matrix.js) — и две копии проверки
// ISO-даты (isoOrNull в matrix.js, isoDateOrNull в matrix-schedule.js)
// сведены сюда; в модулях-потребителях прежние имена остались алиасами,
// чтобы дифф не трогал десятки мест вызова. Модуль ЧИСТЫЙ: ни DOM, ни
// хранилища, ни часов — только проверки над значениями (как core/dates.js),
// поэтому его можно проверить node:test без браузера и без песочницы.

import { isDateLike, parseISODate, toISODate } from './dates.js';

// Plain object: объект, но не массив и не null. Массив — список, а не карта
// «имя поля → значение», поэтому отдельный случай.
export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ISO-дата 'YYYY-MM-DD' или null. Проверка круглая: parseISODate на мусоре
// возвращает Invalid Date (объект, а не false), а '2026-13-45' Date
// разворачивает в другую дату. Без этого битая строка из хранилища оседала
// бы в модели и рисовалась в карточке.
export function isoDateOrNull(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('-');
  if (parts.length !== 3) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = parseISODate(value);
  // Круглая проверка: '2026-11-31' Date разворачивает в 1 декабря, и молча
  // принять такую дату означало бы хранить не то, что человек выбрал.
  return isDateLike(parsed) && toISODate(parsed) === value ? value : null;
}
