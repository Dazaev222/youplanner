// Кнопка «Анализ привычек» в чате ассистента: снимок статистики трекера
// (js/data/stats.js — те же функции, что у экрана «Статистика») превращается
// в реплику пользователя. Снимок идёт обычной репликой, а не системным
// промптом: он оседает в истории, и уточняющие вопросы видят те же цифры,
// а не «забытый» контекст. Окно анализа — 30 дней: месяц стабилен и не
// зависит от периода, выбранного на экране статистики.
//
// Читается только живое состояние модулей данных (localStorage + кэш
// records.js), дата «сегодня» — параметр: тесты подставляют фиксированную.
// Цифры совпадают с экраном «Статистика» по построению — иначе ассистент
// и приложение спорили бы друг с другом.

import { addDays, toISODate } from '../core/dates.js';
import { calcProgress, loadRecords } from '../data/records.js';
import {
  habitBestStreak,
  habitCurrentStreak,
  habitMarkedDays,
  qazaDoneOn,
  qazaStreak,
} from '../data/stats.js';
import { FAST_KEY } from '../data/fast.js';
import { QAZA_HABIT_ID, QAZA_STORAGE_KEY } from '../data/qaza.js';
import { SLEEP_KEY } from '../data/sleep.js';
import { STORAGE_KEYS } from '../data/storage.js';

// Потолки снимка и всего запроса: реплика-анализ не должна раздувать
// историю чата (HISTORY_KEEP в assistant-view.js) и сама себя обрезает
const ANALYSIS_DAYS = 30;
const SNAPSHOT_MAX_CHARS = 2200;
const REQUEST_MAX_CHARS = 3000;

function readStoredSection(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function compactJson(value, max) {
  try {
    const text = JSON.stringify(value);
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  } catch (e) {
    return '';
  }
}

// Окно анализа: ANALYSIS_DAYS дат по сегодня включительно
export function analysisWindow(today, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(toISODate(addDays(today, -i)));
  }
  return out;
}

// Строка одной привычки: серия, лучшая серия и процент за окно — те же
// метрики, что видит экран статистики. Каза-привычка (h6) исключена: её
// цифры идут отдельной строкой «Каза-намазы»
function analysisHabitLine(habit, dates, today) {
  const marked = habitMarkedDays(habit, dates).length;
  const streak = habitCurrentStreak(habit, today);
  const best = habitBestStreak(habit, dates);
  const percent = Math.round(calcProgress(habit, dates));
  const goal = habit.goal ? ' (цель ' + habit.goal + ' ' + (habit.unit || '') + ')' : '';
  return '— «' + habit.name + '»' + goal + ': серия ' + streak + ' дн., лучшая '
    + best + ', отмечено ' + marked + '/' + dates.length + ', прогресс '
    + percent + '%';
}

// Снимок статистики для запроса. Пустые разделы пропускаются; совсем без
// данных — честная фраза вместо выдуманных цифр. «Сегодня» — параметр для
// тестов; в приложении зовётся без аргумента
export function buildHabitsAnalysisSnapshot(today) {
  if (!(today instanceof Date)) today = new Date();
  const dates = analysisWindow(today, ANALYSIS_DAYS);
  const records = loadRecords();
  const habits = readStoredSection(STORAGE_KEYS.habits);
  const recordsPresent = records && typeof records === 'object'
    && Object.keys(records).length > 0;
  const lines = [];

  if (Array.isArray(habits) && habits.length && recordsPresent) {
    lines.push('Привычки за последние ' + ANALYSIS_DAYS + ' дней:');
    for (let i = 0; i < habits.length; i++) {
      const habit = habits[i];
      if (habit && habit.name && habit.id !== QAZA_HABIT_ID) {
        lines.push(analysisHabitLine(habit, dates, today));
      }
    }
  }

  if (recordsPresent) {
    let done = 0;
    for (let i = 0; i < dates.length; i++) {
      done += qazaDoneOn(records, dates[i]);
    }
    const queue = readStoredSection(QAZA_STORAGE_KEY);
    lines.push('Каза-намазы: серия ' + qazaStreak(records, today) + ' дн., '
      + 'выполнено ' + done + ' за ' + ANALYSIS_DAYS + ' дней'
      + (typeof queue === 'number' && queue > 0
        ? ', в очереди ' + queue
        : ''));
  }

  const fast = readStoredSection(FAST_KEY);
  if (fast !== null && fast !== undefined) {
    lines.push('Ураза: ' + compactJson(fast, 200));
  }
  const sleep = readStoredSection(SLEEP_KEY);
  if (sleep) {
    lines.push('Сон: ' + compactJson(sleep, 300));
  }

  if (!lines.length) {
    return 'Записей пока нет — статистики для анализа нет.';
  }
  return lines.join('\n').slice(0, SNAPSHOT_MAX_CHARS);
}

// Полная реплика пользователя для кнопки: команда + снимок + формат ответа.
// Просят кратко и с эмодзи: лимит длины ответа (max_tokens из персонализации)
// ограничивает вывод со стороны API, а инструкция — со стороны модели
export function buildHabitsAnalysisRequest(today) {
  const snapshot = buildHabitsAnalysisSnapshot(today);
  return ('Сделай анализ моих привычек.\n\n' + snapshot
    + '\n\nОтветь по-русски, кратко и с эмодзи: 💪 что идёт хорошо (2-3 '
    + 'пункта), ⚠️ что проседает (2-3 пункта), 🎯 одна конкретная '
    + 'рекомендация на неделю.').slice(0, REQUEST_MAX_CHARS);
}
