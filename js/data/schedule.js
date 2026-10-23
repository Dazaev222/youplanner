import { bus } from '../core/bus.js';
import { safeSetItem } from '../core/storage.js';
import { STORAGE_KEYS } from './storage.js';
// Базовое расписание. Хранится по ключу youplanner.schedule: ключа нет в
// хранилище штатно — человек ещё не редактировал расписание, и loadSchedule()
// подставляет DEFAULT_SCHEDULE. Редактирование через Настройки — Этап 6.
export const SCHEDULE_TYPES = ['weekday', 'weekend', 'fasting', 'physical'];
export const DEFAULT_SCHEDULE = {
  weekday: [
    { time: '04:30', text: 'Подъём' },
    { time: '04:45', text: 'Фаджр' },
    { time: '05:00', text: 'Тасбих' },
    { time: '05:05', text: 'Каза' },
    { time: '05:15', text: 'Коран' },
    { time: '05:45', text: 'Планер' },
    { time: '06:00', text: 'Кодинг' },
    { time: '08:00', text: 'Завтрак' },
    { time: '09:00', text: 'Кодинг' },
    { time: '12:30', text: 'Зухр' },
    { time: '12:50', text: 'Обед' },
    { time: '13:30', text: 'Домашние' },
    { time: '14:15', text: 'Кодинг' },
    { time: '15:00', text: 'Аср' },
    { time: '15:20', text: 'Спорт' },
    { time: '15:40', text: 'Кодинг' },
    { time: '18:00', text: 'Магриб' },
    { time: '18:20', text: 'Каза' },
    { time: '18:30', text: 'Ужин' },
    { time: '19:00', text: 'Иша' },
    { time: '19:30', text: 'Книга' },
    { time: '20:00', text: 'Дневник' },
    { time: '21:00', text: 'Отбой' },
  ],
  weekend: [
    { time: '04:30', text: 'Подъём' },
    { time: '04:45', text: 'Фаджр' },
    { time: '05:00', text: 'Тасбих' },
    { time: '05:05', text: 'Каза' },
    { time: '05:15', text: 'Коран' },
    { time: '05:45', text: 'Планер' },
    { time: '06:00', text: 'Кодинг' },
    { time: '12:30', text: 'Зухр' },
    { time: '12:50', text: 'Обед' },
    { time: '13:30', text: 'Выезд на учёбу' },
    { time: '17:15', text: 'Аср' },
    { time: '17:35', text: 'Спорт' },
    { time: '18:00', text: 'Магриб' },
    { time: '18:20', text: 'Каза' },
    { time: '18:30', text: 'Ужин' },
    { time: '19:00', text: 'Иша' },
    { time: '19:30', text: 'Домашние' },
    { time: '20:15', text: 'Книга' },
    { time: '20:30', text: 'Дневник' },
    { time: '21:30', text: 'Отбой' },
  ],
  fasting: [
    { time: '04:30', text: 'Подъём, сухур' },
    { time: '04:45', text: 'Фаджр' },
    { time: '05:00', text: 'Тасбих' },
    { time: '05:05', text: 'Каза' },
    { time: '05:15', text: 'Коран' },
    { time: '05:45', text: 'Планер' },
    { time: '06:00', text: 'Кодинг' },
    { time: '12:30', text: 'Зухр' },
    { time: '13:45', text: 'Кодинг' },
    { time: '15:00', text: 'Аср' },
    { time: '15:20', text: 'Кодинг' },
    { time: '18:00', text: 'Магриб (ифтар)' },
    { time: '18:20', text: 'Каза' },
    { time: '18:30', text: 'Еда' },
    { time: '19:00', text: 'Иша' },
    { time: '19:30', text: 'Книга' },
    { time: '20:00', text: 'Дневник' },
    { time: '21:00', text: 'Отбой' },
  ],
  physical: [
    { time: '04:30', text: 'Подъём (по возможности)' },
    { time: '04:45', text: 'Фаджр' },
    { time: '12:30', text: 'Зухр' },
    { time: '15:00', text: 'Аср' },
    { time: '18:00', text: 'Магриб' },
    { time: '19:00', text: 'Иша' },
    { time: '21:00', text: 'Отбой' },
  ],
};

// Возвращает расписание как оно лежит в хранилище. Ключа нет, пустая строка,
// битый JSON, не-объект или неполные четыре типа дня — всё читается как
// расписание по умолчанию: DEFAULT_SCHEDULE остаётся отсылкой, пока человек
// не отредактирует его через Настройки. Копия, а не ссылка: правки
// из редактора не должны мутировать сам константный список.
export function loadSchedule() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.schedule);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
    if (!Array.isArray(parsed.weekday) || !Array.isArray(parsed.weekend) ||
        !Array.isArray(parsed.fasting) || !Array.isArray(parsed.physical)) return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
    return parsed;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
  }
}
// Запись расписания. Как saveHabits: safeSetItem с тостом на переполнение,
// при успехе — отложенная отправка и boolean для вызывающего кода.
export function saveSchedule(schedule) {
  if (!safeSetItem(STORAGE_KEYS.schedule, JSON.stringify(schedule))) return false;
  bus.emit('data:changed');
  return true;
}
