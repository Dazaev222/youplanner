import { bus } from './core/bus.js';
import { addDays, getMonthDatesToToday, getWeekStart, toISODate } from './core/dates.js';
import { cssEscape, escapeHtml, pad2, showToast } from './core/dom.js';
import { applyBackup, buildBackup, parseBackup } from './data/backup.js';
import { FAST_HISTORY_MIN, FAST_SOURCE_ADD, FAST_SOURCE_DONE, loadFast } from './data/fast.js';
import { CHOICE_OPTIONS, HABIT_TYPES, addHabit, hasRecords, loadHabits, removeHabit, updateHabit } from './data/habits.js';
import { migrateDropTasks } from './data/migrations.js';
import { QAZA_HABIT_ID, loadQaza, loadQazaLog, qazaLogDoneByDay, qazaTotalRemaining } from './data/qaza.js';
import { LEVEL_LATE, LEVEL_ON_TIME, LEVEL_TWO_MIN, QURAN_HABIT_ID, SPORT_VALUES, SPORT_VALUE_LABELS, calcProgress, defaultLevel, getEntry, getRecord, habitMarkDate, hasLevelPopup, invalidateRecordsCache, isChoiceLevelHabit, isLevelHabit, loadRecords, writeHabitEntry } from './data/records.js';
import { SCHEDULE_TYPES } from './data/schedule.js';
import { loadSleep, sleepAverageMinutes, sleepFormatDuration, sleepTimeLabel, sleepTimeMinutes } from './data/sleep.js';
import { STATS_PERIOD_BOXES, habitBestStreak, habitCurrentStreak, habitMarkedDays, habitsAveragePercent, loadStatsPeriod, qazaDoneOn, qazaStreak, saveStatsPeriod, statsPeriodDates } from './data/stats.js';
import { STORAGE_KEYS } from './data/storage.js';
import { SYNC_STATUS_MS } from './data/sync.js';
import { APP_BUILD, APP_VERSION, CIRCLE_CENTER, CIRCLE_LENGTH, CIRCLE_RADIUS, CIRCLE_SIZE, MONTHS_GENITIVE, MONTHS_NOMINATIVE, MONTHS_SHORT } from './data/ui.js';
import { clearSyncPending, syncPending } from './sync/state.js';
import { cloudReachable, cloudReady, flushPendingSync, markCloudReady, scheduleSync, settleHabitsAfterSync, syncFromCloud, syncToCloud } from './sync/sync.js';
import { onFastAdd, onFastDone, onFastEdit, onFastInitCancel, onFastInitSave, renderFastView, resetFastForm } from './ui/fast-view.js';
import { onPrayerGeo, onPrayerMadhhabChange, onPrayerManualSave, onPrayerMethodChange, onPrayerRefresh, onPrayerShowAll, renderPrayerSettings, renderPrayerView, resetPrayerShowAll, startPrayerClock } from './ui/prayer-view.js';
import { onSleepFieldChange, renderSleepView } from './ui/sleep-view.js';
import { appState, isMainDayView, isMobileView, ui } from './ui/state.js';
import { onScheduleAddSubmit, onScheduleEditListClick, renderScheduleEditView, renderScheduleView } from './ui/schedule-view.js';
import { markStatsPeriod, setStatsValue, statsChartMarkup, statsHabitGridMarkup, statsSummaryMarkup } from './ui/stats-helpers.js';
import { ensureQazaState, getQazaState, onQazaAddPick, onQazaAddSubmit, onQazaDone, onQazaStartChange, onQazaUndo, qazaCellMarkup, renderQazaView, setQazaState } from './ui/qaza-view.js';
import { applyScreen } from './ui/router.js';
/* YouPlanner — точка сборки интерфейса (app.js).
   Модульная сборка восстановлена (фазы 3.2–3.4): домены данных — js/data,
   синхронизация — js/sync, вьюхи — js/ui, общие утилиты — js/core.
   Здесь остались главный экран с таблицей, экраны привычек и статистики,
   рендеры уровня приложения, init/bindEvents и проводка шины событий. */

/* --- Статус ручной синхронизации в Настройках ------------------------------ */

export let syncStatusTimer = null;
//
// Один снимок приходит из Firebase целиком, и каждый раздел в нём проверяется
// содержимым, а не только типом «объект/массив»: раздел, не прошедший проверку,
// не применяется, а локальный остаётся как есть. Проверки повторяют те, что уже
// работают при чтении ключей и в parseBackup: молитвы — как loadPrayer, сон —
// как loadSleep, истории чистятся теми же valid* при записи раздела.










// Надпись под кнопками ручной синхронизации гаснет сама
export function showSyncStatus(message) {
  const status = document.getElementById('settings-sync-status');
  if (!status) return;
  status.textContent = message;
  if (syncStatusTimer) clearTimeout(syncStatusTimer);
  syncStatusTimer = setTimeout(function () {
    syncStatusTimer = null;
    status.textContent = '';
  }, SYNC_STATUS_MS);
}

/* ---------- Экспорт и импорт данных -------------------------------------- */

// Скачивание резервной копии через Blob. Дата в имени — локальная, тем же
// toISODate, что и в записях: UTC-вариант сдвигал бы имя на день назад.
export function exportData() {
  const blob = new Blob([JSON.stringify(buildBackup(), null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = 'youplanner-backup-' + toISODate(new Date()) + '.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Импорт выбранного файла. Пока разбор не удался или пользователь не подтвердил
// замену, текущие данные не трогаются.
export function importData(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function () { onBackupRead(String(reader.result)); };
  reader.onerror = function () { alert('Не удалось прочитать файл.'); };
  reader.readAsText(file);
}

export function onBackupRead(text) {
  const data = parseBackup(text);
  if (!data) {
    alert('Не удалось прочитать файл. Это резервная копия YouPlanner?');
    return;
  }

  if (!confirm('Импорт заменит все текущие данные. Продолжить?')) return;

  applyBackup(data);
}

/* ==========================================================================
   YouPlanner — логика интерфейса

   Скрипт не модуль и не IIFE: все имена объявляются в глобальной области
   видимости. Функции слоя данных только ВЫЗЫВАЮТСЯ, но никогда
   не переобъявляются.

   Ключевая архитектурная особенность: ячейки таблицы перерисовываются целиком
   (renderTable), поэтому обработчики событий навешиваются ОДИН РАЗ на
   #habits-table и #habit-list — делегирование. Иначе после перерисовки
   слушатели на ячейках терялись бы.
   ========================================================================== */

/* --- Состояние приложения ------------------------------------------------ */
// appState живёт в js/ui/state.js: его читают и мутируют несколько модулей.

// Мобильная вёрстка: -1 не выбрана, 0 Пн–Чт, 1 Пт–Вс
export let mobileDayPage = -1;

/* --- Константы ----------------------------------------------------------- */

/* --- Вспомогательные функции (не пересекаются с именами data.js) --------- */

// Привычка из текущего состояния по id
export function findHabit(habitId) {
  for (let i = 0; i < appState.habits.length; i++) {
    if (appState.habits[i].id === habitId) return appState.habits[i];
  }
  return null;
}

// Даты отображаемой недели: понедельник и шесть следующих дней
export function getWeekDates(weekStart) {
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(toISODate(addDays(weekStart, i)));
  return dates;
}

// Прогресс привычки за отображаемую неделю. Знаменатель всегда 7 дней,
// поэтому с каждым новым понедельником круг естественно обнуляется.
export function weekPercent(habit) {
  const weekStart = appState.weekStart;
  if (!weekStart) return 0;
  return calcProgress(habit, getWeekDates(weekStart));
}

// Прогресс привычки за месяц: с 1-го числа по сегодня включительно
export function monthPercent(habit) {
  const weekStart = appState.weekStart;
  if (!weekStart) return 0;
  const dates = getMonthDatesToToday(weekStart.getFullYear(), weekStart.getMonth());
  return calcProgress(habit, dates);
}

// Высота, на которую клавиатура перекрывает окно. В медиа-запросе телефона
// шторки стоят по bottom и поднимаются на эту величину: без неё клавиатура
// накрывает панель формы вместе с полем ввода.
export function syncSheetToKeyboard() {
  if (!window.visualViewport) return;
  const offset = Math.max(0,
    window.innerHeight - window.visualViewport.height
    - window.visualViewport.offsetTop);
  document.documentElement.style.setProperty('--keyboard-offset', offset + 'px');
}

/* --- Разметка (строки, чтобы собрать таблицу одним присвоением) ---------- */

// Опции выпадающего списка типов привычек
export function typeOptionsMarkup(current) {
  let html = '';
  for (let i = 0; i < HABIT_TYPES.length; i++) {
    const type = HABIT_TYPES[i];
    html += '<option value="' + escapeHtml(type.value) + '"' +
      (type.value === current ? ' selected' : '') + '>' + escapeHtml(type.label) + '</option>';
  }
  return html;
}

// Подпись типа привычки для экрана «Привычки»
export function habitTypeLabel(type) {
  for (let i = 0; i < HABIT_TYPES.length; i++) {
    if (HABIT_TYPES[i].value === type) return HABIT_TYPES[i].label;
  }
  return '';
}

// Опции выпадающего списка значений ячейки choice. У Спорта и Пресса свой
// список кодов и свои подписи (§3.1), у прочих привычек типа choice — общий.
export function choiceOptionsMarkup(current, habitId) {
  const isCoded = isChoiceLevelHabit(habitId);
  const codes = isCoded ? SPORT_VALUES : CHOICE_OPTIONS;

  let html = '<option value=""' + (current === '' ? ' selected' : '') + '>—</option>';
  for (let i = 0; i < codes.length; i++) {
    const option = codes[i];
    const label = isCoded ? SPORT_VALUE_LABELS[option] : option;
    html += '<option value="' + escapeHtml(option) + '"' +
      (option === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }
  return html;
}

// Класс границы поля отметки по уровню записи (§1.5). Уровня нет — класс
// не ставится, и поле остаётся с обычной рамкой --border.
export function levelClass(level) {
  if (level === LEVEL_ON_TIME) return ' is-on-time';
  if (level === LEVEL_LATE) return ' is-late';
  if (level === LEVEL_TWO_MIN) return ' is-two-min';
  return '';
}

// Маленькая кнопка вызова попапа уровня — только у Корана (§1.2)
export function levelButtonMarkup(habit, date) {
  const entry = getEntry(date, habit.id);
  const isSet = entry && entry.level ? ' is-set' : '';
  return '<button type="button" class="cell-level-btn' + isSet + '"' +
    ' data-habit-id="' + escapeHtml(habit.id) + '"' +
    ' data-date="' + escapeHtml(date) + '" aria-label="Как выполнено">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
    ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 9l6 6 6-6"></path></svg></button>';
}

// Разметка одной ячейки дня: <td class="cell" data-habit-id data-date>…</td>
export function cellMarkup(habit, date) {
  const entry = getEntry(date, habit.id);
  const value = entry ? entry.value : undefined;
  const dataAttrs = ' data-habit-id="' + escapeHtml(habit.id) + '"' +
    ' data-date="' + escapeHtml(date) + '"';
  let inner = '';

  if (habit.type === 'boolean') {
    // Чекбокс = true, кнопка «✗» = false, пусто = записи нет
    const checked = value === true ? ' checked' : '';
    const xActive = value === false ? ' is-active' : '';
    inner =
      '<input type="checkbox" class="cell-check"' + dataAttrs + checked +
      ' aria-label="Выполнено">' +
      '<button type="button" class="cell-x' + xActive + '"' + dataAttrs +
      ' aria-label="Не выполнено">✗</button>';
  } else if (habit.id === QAZA_HABIT_ID) {
    // Каза ведётся во вкладке «Каза-намазы», ячейка только показывает счётчик дня
    inner = qazaCellMarkup(date);
  } else if (habit.id === QURAN_HABIT_ID) {
    // Коран: инпут + кнопка уровня (как у обычной числовой привычки)
    const text = typeof value === 'number' ? String(value) : '';
    const withButton = hasLevelPopup(habit.id);
    inner = '<input type="number" class="cell-number' +
      levelClass(entry ? entry.level : null) + (withButton ? ' has-level-btn' : '') +
      '" min="0" step="1"' + dataAttrs +
      ' value="' + escapeHtml(text) + '" aria-label="Значение">';
    if (withButton) inner += levelButtonMarkup(habit, date);
  } else if (habit.type === 'number') {
    const text = typeof value === 'number' ? String(value) : '';
    // Класс нужен только мобильному медиа-запросу: там поле делит ширину
    // колонки с кнопкой попапа, иначе кнопка уезжает на вторую строку
    const withButton = hasLevelPopup(habit.id);
    inner = '<input type="number" class="cell-number' +
      levelClass(entry ? entry.level : null) + (withButton ? ' has-level-btn' : '') +
      '" min="0" step="1"' + dataAttrs +
      ' value="' + escapeHtml(text) + '" aria-label="Значение">';
    if (withButton) inner += levelButtonMarkup(habit, date);
  } else {
    const current = typeof value === 'string' ? value : '';
    inner = '<select class="cell-select' +
      levelClass(entry ? entry.level : null) + '"' + dataAttrs + ' aria-label="Значение">' +
      choiceOptionsMarkup(current, habit.id) + '</select>';
  }

  return '<td class="cell"' + dataAttrs + '>' + inner + '</td>';
}

// SVG-круг прогресса. percent — недельный процент (может быть больше 100),
// дуга при этом обрезается по 100%. monthPct — месячный процент, выводится
// второй строкой внутри круга.
export function circleMarkup(percent, habitId, monthPct) {
  const raw = Number(percent);
  const safe = isFinite(raw) ? raw : 0;
  const clamped = Math.min(Math.max(safe, 0), 100);
  const dashoffset = CIRCLE_LENGTH * (1 - clamped / 100);
  // Цвет ставим инлайновым стилем, чтобы он перебивал возможные правила CSS
  const strokeStyle = safe >= 100 ? 'stroke:var(--success)' : 'stroke:var(--accent)';
  const label = Math.round(safe) + '%';

  const monthRaw = Number(monthPct);
  const monthLabel = 'М: ' + Math.round(isFinite(monthRaw) ? monthRaw : 0) + '%';

  const idAttr = habitId === null || habitId === undefined
    ? '' : ' data-habit-id="' + escapeHtml(habitId) + '"';

  return '<svg class="progress-circle" viewBox="0 0 ' + CIRCLE_SIZE + ' ' + CIRCLE_SIZE + '"' +
    ' width="' + CIRCLE_SIZE + '" height="' + CIRCLE_SIZE + '"' +
    ' role="img" aria-label="Неделя ' + escapeHtml(label) +
    ', месяц ' + escapeHtml(monthLabel) + '"' + idAttr + '>' +
    '<circle class="progress-track" cx="' + CIRCLE_CENTER + '" cy="' + CIRCLE_CENTER + '"' +
    ' r="' + CIRCLE_RADIUS + '" fill="none" stroke="var(--border)" stroke-width="5"></circle>' +
    '<circle class="progress-arc" cx="' + CIRCLE_CENTER + '" cy="' + CIRCLE_CENTER + '"' +
    ' r="' + CIRCLE_RADIUS + '" fill="none" stroke-width="5" stroke-linecap="round"' +
    ' style="' + strokeStyle + '"' +
    ' stroke-dasharray="' + CIRCLE_LENGTH.toFixed(3) + '"' +
    ' stroke-dashoffset="' + dashoffset.toFixed(3) + '"' +
    ' transform="rotate(-90 ' + CIRCLE_CENTER + ' ' + CIRCLE_CENTER + ')"></circle>' +
    '<text x="' + CIRCLE_CENTER + '" y="27" class="progress-text" text-anchor="middle"' +
    ' dominant-baseline="central">' + escapeHtml(label) + '</text>' +
    '<text x="' + CIRCLE_CENTER + '" y="41" class="progress-month" text-anchor="middle"' +
    ' dominant-baseline="central">' + escapeHtml(monthLabel) + '</text>' +
    '</svg>';
}

/* --- Инициализация ------------------------------------------------------- */


export function init() {
  // Межвкладочная страховка: событие storage приходит только из других
  // вкладок, поэтому с write-through в текущей оно не конфликтует.
  window.addEventListener('storage', function (event) {
    if (event.key === null || event.key === STORAGE_KEYS.records) invalidateRecordsCache();
  });

  appState.habits = loadHabits();
  appState.weekStart = getWeekStart(new Date());

  // Начальные данные каза записываются при первом запуске, а не при открытии
  // вкладки: так состояние очереди существует до первого показа
  setQazaState(loadQaza());

  renderHeader();
  renderMainView();
  updateFormFields();

  bindEvents();

  // Стартовый раздел ставим тем же переключателем, что и кнопки:
  // так главная вкладка сразу подсвечена, а таб-бар скрыт на ПК
  switchAppView('main');

  // Раз в минуту обновляются счётчик и окно намаза. Таймер один на приложение
  // и идёт всегда: вкладка может быть закрыта, а при её открытии экран всё
  // равно собирается заново. Перезапуск таймера — в самом модуле молитв.
  startPrayerClock();

  // Пустой сервер заполняем своей копией, иначе забираем то, что там новее.
  // Только после этого разрешаем отправку: loadQaza() выше уже зовёт
  // saveQaza() → scheduleSync(), и если ответ сервера придёт позже задержки,
  // отправка уходила бы вперёд ответа и затирала чужой снимок (в том числе
  // привычек — пустой локальный список ложился на сервер вместо серверного).
  //
  // Сверка разрешает отправку при любом исходе, включая недоступный сервер:
  // приложение работает офлайн, и ждать сети, чтобы разрешить запись, значило
  // бы копить правки в syncPending без срока. Итог сверки берём через
  // Promise.resolve(), потому что fetch вызывается синхронно: его бросок
  // вылетел бы из syncFromCloud до возврата промиса, и .catch ниже его не
  // увидел бы. Отправка после неудачной сверки просто упадёт молча — это
  // штатный путь syncToCloud, а следующая правка отправит всё разом.
  Promise.resolve()
    .then(syncFromCloud)
    .catch(function () { return null; })
    .then(function (result) {
      // Дефолты и миграция — до cloudReady: запись под saveNormalized не
      // взводит syncPending, а отправку заберёт init ниже
      settleHabitsAfterSync(result);
      markCloudReady();
      migrateDropTasks();
      // Накопленную правку забирает отправка, и приоритет локального на этом
      // исчерпан: оставленный флаг запирал бы применение серверных снимков
      // до конца сеанса.
      const pending = syncPending;
      clearSyncPending();
      if ((result && result.serverEmpty) || pending) syncToCloud();

      // Список привычек мог измениться только что — перерисовываем главную,
      // чтобы вместе с ним появилась или пропала пометка «не загружены»
      appState.habits = loadHabits();
      renderMainView();
    });
}

// Все обработчики навешиваются один раз. События внутри таблицы и списка
// привычек — делегированные, поэтому перерисовка не теряет слушатели.
export function bindEvents() {
  const table = document.getElementById('habits-table');
  if (table) {
    table.addEventListener('change', onTableChange);
    table.addEventListener('click', onTableClick);
  }

  const habitList = document.getElementById('habit-list');
  if (habitList) {
    habitList.addEventListener('click', onHabitListClick);
  }

  // Раздел «Настройки»: кнопка в шапке ПК и стрелка «Назад» внутри раздела
  const settingsButton = document.getElementById('settings-btn');
  if (settingsButton) {
    settingsButton.addEventListener('click', function () { switchAppView('settings'); });
  }

  const settingsBack = document.getElementById('settings-back');
  if (settingsBack) {
    settingsBack.addEventListener('click', function () { switchAppView('main'); });
  }

  // Вкладка «Молитвы»: кнопка в шапке каза, возврат в неё же
  const prayerButton = document.getElementById('prayer-btn');
  if (prayerButton) {
    prayerButton.addEventListener('click', function () { switchAppView('prayer'); });
  }

  const prayerBack = document.getElementById('prayer-back');
  if (prayerBack) {
    prayerBack.addEventListener('click', function () { switchAppView('qaza'); });
  }

  const prayerGeo = document.getElementById('prayer-geo');
  if (prayerGeo) prayerGeo.addEventListener('click', onPrayerGeo);

  const prayerSave = document.getElementById('prayer-save');
  if (prayerSave) prayerSave.addEventListener('click', onPrayerManualSave);

  const prayerShowAllButton = document.getElementById('prayer-show-all');
  if (prayerShowAllButton) prayerShowAllButton.addEventListener('click', onPrayerShowAll);

  // Экран настроек молитв: строка из Настроек, мазхаб и обновление координат
  const settingsPrayer = document.getElementById('settings-prayer');
  if (settingsPrayer) {
    settingsPrayer.addEventListener('click', function () { switchAppView('prayer-settings'); });
  }

  const prayerSettingsBack = document.getElementById('prayer-settings-back');
  if (prayerSettingsBack) {
    prayerSettingsBack.addEventListener('click', function () { switchAppView('settings'); });
  }

  const prayerMadhhab = document.getElementById('prayer-madhhab');
  if (prayerMadhhab) prayerMadhhab.addEventListener('change', onPrayerMadhhabChange);

  const prayerMethod = document.getElementById('prayer-method');
  if (prayerMethod) prayerMethod.addEventListener('change', onPrayerMethodChange);

  const prayerRefresh = document.getElementById('prayer-refresh');
  if (prayerRefresh) prayerRefresh.addEventListener('click', onPrayerRefresh);

  // Раздел «Статистика»: строка из Настроек, возврат в них же,
  // из категории каза — назад в хаб
  const settingsStats = document.getElementById('settings-stats');
  if (settingsStats) {
    settingsStats.addEventListener('click', function () { switchAppView('stats'); });
  }

  // Панель навигации статистики: кнопка в шапке, подложка и пункты списка.
  // Пункты — делегированием: экран живёт в data-stats-view, и обработчик
  // не переписывается, когда в панель добавляется строка
  const statsMenuBtn = document.getElementById('stats-menu-btn');
  if (statsMenuBtn) statsMenuBtn.addEventListener('click', openStatsMenu);

  const statsMenuBackdrop = document.getElementById('stats-menu-backdrop');
  if (statsMenuBackdrop) statsMenuBackdrop.addEventListener('click', closeStatsMenu);

  const statsMenu = document.getElementById('stats-menu');
  if (statsMenu) {
    statsMenu.addEventListener('click', function (event) {
      const item = event.target.closest('.stats-menu-item');
      if (!item) return;
      // У пунктов статистики экран лежит в data-stats-view, у «Цикла сна»
      // его нет: экран живёт вне раздела, и атрибут у него свой. Без этой
      // проверки switchAppView получил бы null и не открыл ничего
      if (item.hasAttribute('data-sleep-view')) {
        closeStatsMenu();
        switchAppView('sleep');
        return;
      }
      if (item.hasAttribute('data-stats-view')) {
        switchAppView(item.getAttribute('data-stats-view'));
      }
    });
  }

  // Стрелка аккордеона. Класс у неё свой, и делегирование по .stats-menu-item
  // её не ловит — обработчик отдельный. Раскрытие помечает панель классом
  // is-hub-open (по нему разворачивается иконка), а aria-expanded говорит
  // то же самое голосом
  const statsHubToggle = document.getElementById('stats-hub-toggle');
  const statsHubSub = document.getElementById('stats-hub-sub');
  if (statsHubToggle && statsHubSub && statsMenu) {
    statsHubToggle.addEventListener('click', function () {
      const willOpen = statsHubSub.hidden;
      statsHubSub.hidden = !willOpen;
      statsMenu.classList.toggle('is-hub-open', willOpen);
      statsHubToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  }

  // Строка «Цикл сна» в Настройках: на ПК это единственный вход в раздел,
  // на телефоне — второй, после пункта гамбургера
  const settingsSleep = document.getElementById('settings-sleep');
  if (settingsSleep) {
    settingsSleep.addEventListener('click', function () {
      switchAppView('sleep');
    });
  }

  // Экран «Цикл сна»: возврат туда, откуда вошли, и пересчёт при правке любого
  // поля. Слушаются оба события — колесо времени на телефоне присылает только change
  const sleepBack = document.getElementById('sleep-back');
  if (sleepBack) sleepBack.addEventListener('click', function () { switchAppView(sleepReturnView); });

  ['sleep-bed', 'sleep-fall', 'sleep-wake'].forEach(function (id) {
    const field = document.getElementById(id);
    if (!field) return;
    field.addEventListener('input', onSleepFieldChange);
    field.addEventListener('change', onSleepFieldChange);
  });

  // Галочка «встану по рекомендации» пересчитывает итог тем же обработчиком:
  // она меняет время для истории, а не только подсказку
  const sleepFollow = document.getElementById('sleep-follow-rec');
  if (sleepFollow) sleepFollow.addEventListener('change', onSleepFieldChange);

  // Галочка «встал по плану», поле фактического подъёма и галочка исключения
  // из статистики — все пересчитывают итог тем же обработчиком
  const sleepOnPlan = document.getElementById('sleep-on-plan');
  if (sleepOnPlan) sleepOnPlan.addEventListener('change', onSleepFieldChange);
  const sleepExcluded = document.getElementById('sleep-excluded');
  if (sleepExcluded) sleepExcluded.addEventListener('change', onSleepFieldChange);
  const sleepRealWake = document.getElementById('sleep-real-wake');
  if (sleepRealWake) {
    sleepRealWake.addEventListener('input', onSleepFieldChange);
    sleepRealWake.addEventListener('change', onSleepFieldChange);
  }

  // «Назад» из хаба ведёт туда, откуда в раздел вошли: на ПК это Настройки,
  // на телефоне — главная с гамбургером
  const statsBack = document.getElementById('stats-back');
  if (statsBack) statsBack.addEventListener('click', function () { switchAppView(statsReturnView); });

  const statsQazaBack = document.getElementById('stats-qaza-back');
  if (statsQazaBack) {
    statsQazaBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsRowQaza = document.getElementById('stats-row-qaza');
  if (statsRowQaza) {
    statsRowQaza.addEventListener('click', function () { switchAppView('stats-qaza'); });
  }

  const statsRowFast = document.getElementById('stats-row-fast');
  if (statsRowFast) {
    statsRowFast.addEventListener('click', function () { switchAppView('stats-fast'); });
  }

  const statsRowSleep = document.getElementById('stats-row-sleep');
  if (statsRowSleep) {
    statsRowSleep.addEventListener('click', function () { switchAppView('stats-sleep'); });
  }

  const statsFastBack = document.getElementById('stats-fast-back');
  if (statsFastBack) {
    statsFastBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsSleepBack = document.getElementById('stats-sleep-back');
  if (statsSleepBack) {
    statsSleepBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsRowHabits = document.getElementById('stats-row-habits');
  if (statsRowHabits) {
    statsRowHabits.addEventListener('click', function () { switchAppView('stats-habits'); });
  }

  const statsHabitsBack = document.getElementById('stats-habits-back');
  if (statsHabitsBack) {
    statsHabitsBack.addEventListener('click', function () { switchAppView('stats'); });
  }

  const statsHabitBack = document.getElementById('stats-habit-back');
  if (statsHabitBack) {
    statsHabitBack.addEventListener('click', function () { switchAppView('stats-habits'); });
  }

  // Строка списка привычек: id едет в data-habit-id, карточка читает его из
  // statsHabitId — так у выбора один источник, а не два. Слушатель один на
  // список: строк в нём столько же, сколько привычек у человека
  const statsHabitsList = document.getElementById('stats-habits-list');
  if (statsHabitsList) {
    statsHabitsList.addEventListener('click', function (event) {
      const row = event.target.closest('[data-habit-id]');
      if (!row) return;
      statsHabitId = row.getAttribute('data-habit-id');
      switchAppView('stats-habit');
    });
  }

  // Сегмент-контрол периодов. Категория берётся из id блока, а не из общей
  // переменной: у каждой категории свой период (§11y), поэтому выбор в каза
  // период привычек не трогает. Выбор запоминается на устройстве,
  // перерисовываются экраны только этой категории
  Object.keys(STATS_PERIOD_BOXES).forEach(function (id) {
    const box = document.getElementById(id);
    if (!box) return;
    const category = STATS_PERIOD_BOXES[id];
    box.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      if (!saveStatsPeriod(category, btn.getAttribute('data-period'))) return;
      renderStatsCategory(category);
    });
  });

  // Экран «Привычки» в настройках
  const settingsEdit = document.getElementById('settings-edit-habits');
  if (settingsEdit) {
    settingsEdit.addEventListener('click', function () { switchAppView('edit-habits'); });
  }

  const habitsEditBack = document.getElementById('habits-edit-back');
  if (habitsEditBack) {
    habitsEditBack.addEventListener('click', function () { switchAppView('settings'); });
  }

  const habitsEditAdd = document.getElementById('habits-edit-add');
  if (habitsEditAdd) habitsEditAdd.addEventListener('click', openModal);

  const habitsEditList = document.getElementById('habits-edit-list');
  if (habitsEditList) {
    habitsEditList.addEventListener('click', onHabitsEditClick);
    habitsEditList.addEventListener('change', onHabitsEditChange);
  }

  // Ручная синхронизация из настроек. Итог у неё тот же, что у первой:
  // пустой сервер засевает дефолты — иначе пустая таблица осталась бы и без
  // данных, и без пометки. Отправку ставит сама запись (§11t)
  const syncNow = document.getElementById('settings-sync-now');
  if (syncNow) {
    syncNow.addEventListener('click', function () {
      syncFromCloud().then(function (result) {
        settleHabitsAfterSync(result);
        appState.habits = loadHabits();
        renderMainView();
        showSyncStatus('Обновлено');
      });
    });
  }

  const syncPush = document.getElementById('settings-sync-push');
  if (syncPush) {
    syncPush.addEventListener('click', function () {
      syncToCloud().then(function () { showSyncStatus('Отправлено'); });
    });
  }

  // Экспорт и импорт данных
  const exportButton = document.getElementById('settings-export');
  if (exportButton) exportButton.addEventListener('click', exportData);

  const importButton = document.getElementById('settings-import');
  if (importButton) {
    importButton.addEventListener('click', function () {
      document.getElementById('settings-import-file').click();
    });
  }

  const importFile = document.getElementById('settings-import-file');
  if (importFile) {
    importFile.addEventListener('change', function () {
      importData(this.files && this.files[0]);
      // Значение сбрасывается сразу: иначе повторный выбор того же файла
      // не вызовет change — браузер считает файл уже выбранным
      this.value = '';
    });
  }

  const weekPrev = document.getElementById('week-prev');
  if (weekPrev) weekPrev.addEventListener('click', function () { changeWeek(-1); });

  const weekNext = document.getElementById('week-next');
  if (weekNext) weekNext.addEventListener('click', function () { changeWeek(1); });

  const weekToday = document.getElementById('week-today');
  if (weekToday) weekToday.addEventListener('click', goToday);

  const qazaButton = document.getElementById('qaza-btn');
  if (qazaButton) {
    qazaButton.addEventListener('click', function () { switchAppView('qaza'); });
  }

  const qazaBack = document.getElementById('qaza-back');
  if (qazaBack) {
    qazaBack.addEventListener('click', function () { switchAppView('main'); });
  }

  const scheduleBack = document.getElementById('schedule-back');
  if (scheduleBack) {
    scheduleBack.addEventListener('click', function () {
      switchAppView('main');
    });
  }

  // Нижний таб-бар: тот же переключатель разделов, что и у кнопок шапки
  const tabItems = document.querySelectorAll('#tab-bar .tab-item');
  for (let i = 0; i < tabItems.length; i++) {
    tabItems[i].addEventListener('click', function () {
      switchAppView(this.getAttribute('data-view'));
    });
  }

  const qazaUndoButton = document.getElementById('qaza-undo');
  if (qazaUndoButton) qazaUndoButton.addEventListener('click', onQazaUndo);

  const qazaPlanBox = document.getElementById('qaza-plan');
  if (qazaPlanBox) qazaPlanBox.addEventListener('click', onQazaDone);

  const qazaStartBox = document.getElementById('qaza-start');
  if (qazaStartBox) qazaStartBox.addEventListener('change', onQazaStartChange);

  const qazaAddBox = document.getElementById('qaza-add');
  if (qazaAddBox) qazaAddBox.addEventListener('change', onQazaAddPick);

  const qazaAddButton = document.getElementById('qaza-add-btn');
  if (qazaAddButton) qazaAddButton.addEventListener('click', onQazaAddSubmit);

  // Вкладка «Ураза»: кнопка в шапке каза, возврат в неё же и три кнопки
  // обычного экрана. Форма ввода — одна на все случаи, поэтому и
  // «Сохранить» у неё одно
  const fastButton = document.getElementById('fast-btn');
  if (fastButton) {
    fastButton.addEventListener('click', function () { switchAppView('fast'); });
  }

  const fastBack = document.getElementById('fast-back');
  if (fastBack) {
    fastBack.addEventListener('click', function () { switchAppView('qaza'); });
  }

  const fastInitSave = document.getElementById('fast-init-save');
  if (fastInitSave) fastInitSave.addEventListener('click', onFastInitSave);

  const fastInitCancel = document.getElementById('fast-init-cancel');
  if (fastInitCancel) fastInitCancel.addEventListener('click', onFastInitCancel);

  const fastDoneButton = document.getElementById('fast-done');
  if (fastDoneButton) fastDoneButton.addEventListener('click', onFastDone);

  const fastAddButton = document.getElementById('fast-add');
  if (fastAddButton) fastAddButton.addEventListener('click', onFastAdd);

  const fastEditButton = document.getElementById('fast-edit');
  if (fastEditButton) fastEditButton.addEventListener('click', onFastEdit);

  // Enter в поле — то же, что «Сохранить»: экран первый, и лишний тап
  // по кнопке на телефоне читается как помеха
  const fastInitValue = document.getElementById('fast-init-value');
  if (fastInitValue) {
    fastInitValue.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') onFastInitSave();
    });
  }

  // Вкладка «Расписание»: кнопка в шапке ПК и таб-бар (таб-бар — общим циклом выше)
  const scheduleButton = document.getElementById('schedule-btn');
  if (scheduleButton) {
    scheduleButton.addEventListener('click', function () {
      switchAppView('schedule');
    });
  }

  const scheduleSwitch = document.getElementById('schedule-switch');
  if (scheduleSwitch) {
    scheduleSwitch.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      const value = btn.getAttribute('data-schedule');
      if (SCHEDULE_TYPES.indexOf(value) === -1) return;
      ui.scheduleType = value;
      renderScheduleView();
    });
  }

  // Клавиатура меняет visualViewport, а не resize окна
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncSheetToKeyboard);
    window.visualViewport.addEventListener('scroll', syncSheetToKeyboard);
  }

  // Поднимать поле ввода над клавиатурой при фокусе внутри шторок
  document.addEventListener('focusin', function(e) {
    const input = e.target;
    if (!input || !input.matches) return;
    const sheetPanel = input.closest('.sheet-panel');
    if (!sheetPanel) return;
    requestAnimationFrame(function() {
      input.scrollIntoView({ block: 'nearest' });
      sheetPanel.style.paddingBottom = '40px';
    });
  });

  document.addEventListener('focusout', function(e) {
    const input = e.target;
    if (!input || !input.matches) return;
    const sheetPanel = input.closest('.sheet-panel');
    if (!sheetPanel) return;
    sheetPanel.style.paddingBottom = '';
  });

  const levelOptions = document.querySelectorAll('#level-sheet .level-option');
  for (let i = 0; i < levelOptions.length; i++) {
    levelOptions[i].addEventListener('click', onLevelPick);
  }

  // Подложка и «Отмена» попапа уровня
  const levelClosers = document.querySelectorAll('[data-level-sheet-close]');
  for (let i = 0; i < levelClosers.length; i++) {
    levelClosers[i].addEventListener('click', closeLevelSheet);
  }

  // Кнопка закрытия и подложка помечены атрибутом data-modal-close
  const closers = document.querySelectorAll('[data-modal-close]');
  for (let i = 0; i < closers.length; i++) {
    closers[i].addEventListener('click', closeModal);
  }
  const modalClose = document.getElementById('modal-close');
  if (modalClose) modalClose.addEventListener('click', closeModal);

  // Уход со вкладки — повод не потерять неотправленную правку: если она есть
  // (syncTimer стоит), debounce снимаем и отправляем сразу — приложение могут
  // закрыть раньше, чем истекут его 1.5с. Без правки не делаем ничего: иначе
  // каждое переключение вкладки клало бы в узел бэкапов одинаковый снимок и
  // вытесняло настоящую историю. Возврат — повод проверить, нет ли свежих.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushPendingSync();
      return;
    }
    syncFromCloud();
  });

  // Escape разбирает окна по слоям: сначала верхнее меню, потом то, что под
  // ним, и только затем саму форму. Иначе форма закрылась бы, оставив меню
  // висеть на экране.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    // Панель статистики — верхний слой и в цепочке проверяется первой:
    // она висит поверх таб-бара, и Escape обязан снять сначала её
    if (isStatsMenuOpen()) {
      closeStatsMenu();
      return;
    }

    const modal = document.getElementById('habit-modal');
    if (modal && !modal.hidden) closeModal();

    // Попап уровня открывается из таблицы, но снимается
    // тем же правилом: Escape гасит верхнюю шторку за раз
    const levelSheet = document.getElementById('level-sheet');
    if (levelSheet && !levelSheet.hidden) {
      closeLevelSheet();
      return;
    }

  });

  const form = document.getElementById('habit-form');
  if (form) form.addEventListener('submit', onFormSubmit);

  const formType = document.getElementById('form-type');
  if (formType) formType.addEventListener('change', updateFormFields);

  const formCancel = document.getElementById('form-cancel');
  if (formCancel) {
    formCancel.addEventListener('click', function () {
      if (form) form.reset();
      updateFormFields();
      setFormError('');
    });
  }

  // Переключатель «День / Неделя». Выбор запоминается на будущие запуски
  const switchBox = document.getElementById('main-view-switch');
  if (switchBox) {
    switchBox.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      ui.mainView = btn.getAttribute('data-view');
      localStorage.setItem('youplanner.mainView', ui.mainView);
      renderMainView();
    });
  }

  // Карточки дня: те же обработчики, что у таблицы
  const dayBox = document.getElementById('day-cards');
  if (dayBox) {
    dayBox.addEventListener('change', onTableChange);
    dayBox.addEventListener('click', onTableClick);
  }

  // Переключатель половин недели на телефоне
  const dayTabFirst = document.getElementById('day-tab-1');
  if (dayTabFirst) {
    dayTabFirst.addEventListener('click', function () {
      mobileDayPage = 0;
      renderTable();
    });
  }

  const dayTabSecond = document.getElementById('day-tab-2');
  if (dayTabSecond) {
    dayTabSecond.addEventListener('click', function () {
      mobileDayPage = 1;
      renderTable();
    });
  }

  // Смена ширины окна переводит таблицу в другой режим: набор дней разный.
  // В iOS Safari сворачивание адресной строки тоже шлёт resize, режим при этом
  // не меняется — перерисовываем только на настоящей смене режима.
  let lastIsMobile = isMobileView();
  window.addEventListener('resize', function () {
    const now = isMobileView();
    if (now !== lastIsMobile) {
      lastIsMobile = now;
      renderMainView();
      // Ширина сменилась — таб-бар появляется или исчезает вместе с режимом
      document.getElementById('tab-bar').hidden = !now;
    }
  });

  // Редактор расписания: вход из Настроек, выход стрелкой «Назад»
  const btnEditSchedule = document.getElementById('settings-edit-schedule');
  if (btnEditSchedule) {
    btnEditSchedule.addEventListener('click', function () {
      switchAppView('schedule-edit');
      renderScheduleEditView();
    });
  }

  const btnScheduleEditBack = document.getElementById('schedule-edit-back');
  if (btnScheduleEditBack) {
    btnScheduleEditBack.addEventListener('click', function () {
      switchAppView('settings');
    });
  }

  // Тип дня в редакторе: подсветку кнопки держим здесь, а не отдельной
  // marking-функцией — последний выбор не сохраняется между экранами
  const scheduleEditSwitch = document.getElementById('schedule-edit-switch');
  if (scheduleEditSwitch) {
    scheduleEditSwitch.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      ui.scheduleEditType = btn.getAttribute('data-schedule-type');

      scheduleEditSwitch.querySelectorAll('.view-switch-btn').forEach(function(b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');

      renderScheduleEditView();
    });
  }

  const formScheduleAdd = document.getElementById('schedule-add-form');
  if (formScheduleAdd) formScheduleAdd.addEventListener('submit', onScheduleAddSubmit);

  const listScheduleEdit = document.getElementById('schedule-edit-list');
  if (listScheduleEdit) listScheduleEdit.addEventListener('click', onScheduleEditListClick);
}

/* --- Шапка и таблица ----------------------------------------------------- */

// Подпись недели: «Сентябрь 2026 · 7–13 сентября» либо
// «31 авг – 6 сент 2026», если неделя пересекает границу месяца.
export function renderHeader() {
  const label = document.getElementById('week-label');
  if (!label || !appState.weekStart) return;

  const weekStart = appState.weekStart;
  const weekEnd = addDays(weekStart, 6);
  const dayStart = weekStart.getDate();
  const dayEnd = weekEnd.getDate();
  const monthStart = weekStart.getMonth();
  const monthEnd = weekEnd.getMonth();
  const yearStart = weekStart.getFullYear();
  const yearEnd = weekEnd.getFullYear();

  let text;
  if (monthStart === monthEnd && yearStart === yearEnd) {
    text = MONTHS_NOMINATIVE[monthStart] + ' ' + yearStart +
      ' · ' + dayStart + '–' + dayEnd + ' ' + MONTHS_GENITIVE[monthStart];
  } else {
    text = dayStart + ' ' + MONTHS_SHORT[monthStart] + ' – ' +
      dayEnd + ' ' + MONTHS_SHORT[monthEnd] + ' ' + yearEnd;
  }

  label.textContent = text;
}

/* --- Мобильная вёрстка --------------------------------------------------- */

// Индексы дней недели (0 — понедельник), попадающие в текущий вид.
// На ПК это вся неделя, на телефоне — выбранная половина.
export function getVisibleDays() {
  if (!isMobileView()) return [0, 1, 2, 3, 4, 5, 6];
  return mobileDayPage === 1 ? [4, 5, 6] : [0, 1, 2, 3];
}

// Первый выбор половины: показываем ту, где сегодняшний день.
// Дальше выбор пользователя не перебиваем.
export function initMobileDayPage() {
  if (mobileDayPage !== -1) return;
  const d = new Date().getDay(); // 0 — воскресенье, 1–6 — понедельник…суббота
  mobileDayPage = (d >= 1 && d <= 4) ? 0 : 1;
}

// Переключатель половин виден только в мобильном режиме;
// активная кнопка показывает текущую половину
export function updateMobileTabs() {
  const box = document.getElementById('mobile-day-tabs');
  if (box) box.hidden = !isMobileView();

  const tab1 = document.getElementById('day-tab-1');
  const tab2 = document.getElementById('day-tab-2');
  if (tab1) tab1.classList.toggle('is-active', mobileDayPage === 0);
  if (tab2) tab2.classList.toggle('is-active', mobileDayPage === 1);
}

/* --- Режим «День» -------------------------------------------------------- */

// Единая точка перерисовки главного экрана: выбирает между карточками дня
// и таблицей недели и приводит видимость блоков в соответствие режиму
export function renderMainView() {
  const switchBox = document.getElementById('main-view-switch');
  if (switchBox) {
    switchBox.hidden = !isMobileView();
    switchBox.querySelectorAll('.view-switch-btn').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === ui.mainView);
    });
  }

  const dayBox = document.getElementById('day-cards');
  const tabs = document.getElementById('mobile-day-tabs');
  const weekNav = document.getElementById('week-nav');
  const table = document.getElementById('habits-table');

  // Пустая таблица при неотвеченной сверке — это «данные не загружены».
  // Пустая таблица после ответа сервера — «человек всё удалил», и молчит
  const note = document.getElementById('habits-note');
  if (note) note.hidden = !(cloudReady && !cloudReachable && appState.habits.length === 0);

  if (isMainDayView()) {
    if (dayBox) dayBox.hidden = false;
    if (tabs) tabs.hidden = true;
    if (weekNav) weekNav.hidden = true;
    if (table) table.hidden = true;
    renderDayCards();
  } else {
    if (dayBox) dayBox.hidden = true;
    if (tabs) tabs.hidden = !isMobileView();
    if (weekNav) weekNav.hidden = false;
    if (table) table.hidden = false;
    renderTable();
  }
}

// По карточке на привычку за сегодня. Контролы те же, что в ячейках таблицы,
// но крупнее — размеры заданы правилами .day-card .cell-* в медиа-запросе.
export function renderDayCards() {
  const box = document.getElementById('day-cards');
  if (!box) return;

  const today = toISODate(new Date());
  let html = '';

  for (let h = 0; h < appState.habits.length; h++) {
    const habit = appState.habits[h];
    let inner = '';

    if (habit.type === 'boolean') {
      const value = getRecord(today, habit.id);
      const checked = value === true ? ' checked' : '';
      const xActive = value === false ? ' is-active' : '';
      inner = '<div class="day-card-controls">' +
        '<input type="checkbox" class="cell-check" data-habit-id="' + escapeHtml(habit.id) +
        '" data-date="' + escapeHtml(today) + '"' + checked + ' aria-label="Выполнено">' +
        '<button type="button" class="cell-x' + xActive + '" data-habit-id="' +
        escapeHtml(habit.id) + '" data-date="' + escapeHtml(today) + '" aria-label="Не выполнено">✗</button>' +
        '</div>';
    } else if (habit.id === QAZA_HABIT_ID) {
      // Каза ведётся во вкладке, карточка только показывает счётчик дня
      inner = '<div class="day-card-controls">' + qazaCellMarkup(today) + '</div>';
    } else if (habit.type === 'number') {
      const entry = getEntry(today, habit.id);
      const value = entry ? entry.value : undefined;
      const text = typeof value === 'number' ? String(value) : '';
      inner = '<div class="day-card-controls">' +
        '<input type="number" class="cell-number' +
        levelClass(entry ? entry.level : null) + '" min="0" step="1" data-habit-id="' +
        escapeHtml(habit.id) + '" data-date="' + escapeHtml(today) + '" value="' + escapeHtml(text) +
        '" aria-label="Значение">' +
        (hasLevelPopup(habit.id) ? levelButtonMarkup(habit, today) : '') + '</div>';
    } else {
      const entry = getEntry(today, habit.id);
      const current = entry && typeof entry.value === 'string' ? entry.value : '';
      inner = '<div class="day-card-controls">' +
        '<select class="cell-select' + levelClass(entry ? entry.level : null) +
        '" data-habit-id="' + escapeHtml(habit.id) +
        '" data-date="' + escapeHtml(today) + '" aria-label="Значение">' +
        choiceOptionsMarkup(current, habit.id) + '</select></div>';
    }

    html += '<div class="day-card">' +
      '<div class="day-card-name">' + escapeHtml(habit.name) +
      (habit.unit ? '<span class="day-card-unit">(' + escapeHtml(habit.unit) + ')</span>' : '') +
      '</div>' + inner + '</div>';
  }

  box.innerHTML = html;
}

// Полная перерисовка шапки и тела таблицы.
// Разметка собирается строками и вставляется через DocumentFragment
// (<template>.content) — одно присвоение innerHTML на контейнер и одна
// вставка в живой DOM, чтобы уложиться в 50 мс.
export function renderTable() {
  const weekStart = appState.weekStart;
  if (!weekStart) return;

  initMobileDayPage();

  // Даты отображаемых дней недели: на ПК это вся неделя,
  // на телефоне — выбранная половина (Пн–Чт или Пт–Вс)
  const visibleDays = getVisibleDays();
  const dates = [];
  for (let i = 0; i < visibleDays.length; i++) {
    const day = addDays(weekStart, visibleDays[i]);
    dates.push(new Date(day.getFullYear(), day.getMonth(), day.getDate()));
  }

  let thead = '<tr><th class="habit-col">Привычка</th>';
  for (let i = 0; i < dates.length; i++) {
    thead += '<th class="day-col">' + pad2(dates[i].getDate()) + '.' +
      pad2(dates[i].getMonth() + 1) + '</th>';
  }
  thead += '<th class="progress-col">Прогресс</th></tr>';

  // В круге — прогресс за неделю, второй строкой — за месяц
  let tbody = '';
  for (let h = 0; h < appState.habits.length; h++) {
    const habit = appState.habits[h];
    tbody += '<tr class="habit-row" data-habit-id="' + escapeHtml(habit.id) + '">';
    tbody += '<td><span class="habit-name">' + escapeHtml(habit.name) + '</span>';
    if (habit.unit) {
      tbody += '<span class="habit-unit">(' + escapeHtml(habit.unit) + ')</span>';
    }
    tbody += '</td>';
    for (let i = 0; i < dates.length; i++) {
      tbody += cellMarkup(habit, toISODate(dates[i]));
    }
    tbody += '<td class="progress-cell">' +
      circleMarkup(weekPercent(habit), habit.id, monthPercent(habit)) + '</td>';
    tbody += '</tr>';
  }

  const headTemplate = document.createElement('template');
  headTemplate.innerHTML = thead;
  const bodyTemplate = document.createElement('template');
  bodyTemplate.innerHTML = tbody;

  const theadEl = document.getElementById('habits-thead');
  const tbodyEl = document.getElementById('habits-tbody');
  if (theadEl) theadEl.replaceChildren(headTemplate.content);
  if (tbodyEl) tbodyEl.replaceChildren(bodyTemplate.content);

  updateMobileTabs();
}

/* --- Делегированные обработчики таблицы ---------------------------------- */

// Контейнер ячейки: в таблице это <td class="cell">, в режиме «День» — блок
// управления карточки. Нужен, чтобы после изменения обновить оба контрола
// boolean-ячейки (галочку и «✗»).
export function cellContainer(target) {
  return target.closest('td.cell') || target.closest('.day-card-controls');
}

// data-habit-id и data-date в таблице стоят на <td>, а в карточке — на самом
// контроле, поэтому читаем их с контейнера, а при отсутствии — с цели события.
export function cellData(container, target, name) {
  return container.getAttribute(name) || target.getAttribute(name);
}

export function onTableChange(event) {
  const target = event.target;
  if (!target || !target.classList || typeof target.closest !== 'function') return;

  const cell = cellContainer(target);
  if (!cell) return;

  const habitId = cellData(cell, target, 'data-habit-id');
  const date = cellData(cell, target, 'data-date');
  const habit = findHabit(habitId);
  if (!habit || !date) return;

  const entry = getEntry(date, habitId);
  const current = entry ? entry.value : undefined;
  // Уровень «2 минуты» выбран человеком и правку значения переживает (§2.4) —
  // но только у Корана: там значение и уровень независимы. У Спорта уровень
  // выводится из самого ответа, и «отдых» после «2 минут» не должен остаться
  // голубым, поэтому там он всегда пересчитывается.
  const kept = habitId === QURAN_HABIT_ID && entry && entry.level === LEVEL_TWO_MIN
    ? LEVEL_TWO_MIN : undefined;

  // boolean: галочка = true, снятая галочка = удаление записи
  if (target.classList.contains('cell-check')) {
    const value = target.checked ? true : undefined;
    if (current === value) {
      syncBooleanCell(cell, current);
      return;
    }
    if (!onCellChange(habit, date, value)) {
      // Запись не удалась: возвращаем галочку и «✗» к прежнему значению,
      // а не к новому. Тост уже показал safeSetItem.
      syncBooleanCell(cell, current);
      return;
    }
    syncBooleanCell(cell, value);
    return;
  }

  // choice: пустая опция = удаление записи
  if (target.classList.contains('cell-select')) {
    const value = target.value === '' ? undefined : target.value;
    if (current === value) return;
    if (!onCellChange(habit, date, value, kept === undefined ? defaultLevel(habit, value) : kept)) {
      target.value = current === undefined ? '' : current;
      return;
    }
    syncLevelCell(cell, habitId, date);
    return;
  }

  // number: '' -> удаление, 0 — значимое значение, отрицательное/NaN -> удаление
  if (target.classList.contains('cell-number')) {
    let value;
    if (target.value === '') {
      value = undefined;
    } else {
      const parsed = Number(target.value);
      value = (isFinite(parsed) && parsed >= 0) ? parsed : undefined;
    }
    if (current === value) return;
    if (!onCellChange(habit, date, value, kept === undefined ? defaultLevel(habit, value) : kept)) {
      target.value = current === undefined ? '' : current;
      return;
    }
    syncLevelCell(cell, habitId, date);
  }
}

// Вид полей ячейки после отметки: класс границы по уровню и метка на кнопке
export function syncLevelCell(cell, habitId, date) {
  if (!cell || !isLevelHabit(habitId)) return;

  const entry = getEntry(date, habitId);
  const level = entry ? entry.level : null;

  const field = cell.querySelector('.cell-number') || cell.querySelector('.cell-select');
  if (field) {
    field.classList.remove('is-on-time', 'is-late', 'is-two-min');
    const cls = levelClass(level).trim();
    if (cls) field.classList.add(cls);
  }

  const button = cell.querySelector('.cell-level-btn');
  if (button) button.classList.toggle('is-set', !!level);
}

export function onTableClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  // Кнопка уровня открывает попап на привычке и дне своей ячейки (§1.2)
  const levelButton = target.closest('.cell-level-btn');
  if (levelButton) {
    const levelCell = cellContainer(levelButton);
    if (!levelCell) return;
    openLevelSheet(
      cellData(levelCell, levelButton, 'data-habit-id'),
      cellData(levelCell, levelButton, 'data-date')
    );
    return;
  }

  const button = target.closest('.cell-x');
  if (!button) return;

  const cell = cellContainer(button);
  if (!cell) return;

  const habitId = cellData(cell, button, 'data-habit-id');
  const date = cellData(cell, button, 'data-date');
  const habit = findHabit(habitId);
  if (!habit || !date) return;

  // Повторный клик по «✗» сбрасывает запись в «пусто»
  const current = getRecord(date, habitId);
  const value = current === false ? undefined : false;

  if (!onCellChange(habit, date, value)) return;
  syncBooleanCell(cell, value);
}

// Синхронизация вида boolean-ячейки после изменения
export function syncBooleanCell(cell, value) {
  if (!cell) return;
  const check = cell.querySelector('.cell-check');
  const cross = cell.querySelector('.cell-x');
  if (check) check.checked = value === true;
  if (cross) cross.classList.toggle('is-active', value === false);
}

/* --- Изменение значения ячейки ------------------------------------------- */

// Записывает значение и обновляет ТОЛЬКО круг своей строки — без renderTable().
// День отметки может уехать во вчерашний (§4): тогда без перерисовки не
// обойтись — отметка встанет в чужую колонку и останется незамеченной.
export function onCellChange(habit, date, value, level) {
  if (!habit) return false;

  const markDate = habitMarkDate(habit, date, new Date());
  if (!writeHabitEntry(habit, markDate, value, level)) return false;

  if (markDate !== date) {
    renderTable();
    renderDayCards();
    return true;
  }

  updateRowCircle(habit.id);
  return true;
}

// Перерисовка круга одной строки (полная перерисовка таблицы не нужна)
export function updateRowCircle(habitId) {
  let habit = findHabit(habitId);
  if (!habit) {
    appState.habits = loadHabits();
    habit = findHabit(habitId);
  }
  if (!habit || !appState.weekStart) return;

  const row = document.querySelector(
    '#habits-tbody tr.habit-row[data-habit-id="' + cssEscape(habitId) + '"]'
  );
  if (!row) return;

  const cell = row.querySelector('.progress-cell');
  if (!cell) return;

  cell.innerHTML = circleMarkup(weekPercent(habit), habit.id, monthPercent(habit));
}

/* --- Навигация по неделям ------------------------------------------------ */

export function changeWeek(delta) {
  appState.weekStart = addDays(appState.weekStart, delta * 7);
  renderHeader();
  renderTable();
}

export function goToday() {
  appState.weekStart = getWeekStart(new Date());
  renderHeader();
  renderTable();
}


/* --- Редактор расписания (Настройки → Редактировать расписание) ------------ */




/* --- Попап уровня выполнения (§1.3) --------------------------------------- */

// Привычка и день, для которых открыт попап. День здесь уже выправленный
// правилом полуночи (§4): попап пишет туда же, куда писала бы клетка.
export let levelSheetTarget = null;

// Текущее значение отметки — из него считается «Полная версия».
// Пустое поле значит, что выполнять нечего, и пункт гаснет (§2.3).
export function openLevelSheet(habitId, date) {
  const habit = findHabit(habitId);
  if (!habit || !date || !hasLevelPopup(habitId)) return;

  const entry = getEntry(date, habitId);
  const value = entry ? entry.value : undefined;
  const hasValue = typeof value === 'number';

  levelSheetTarget = {
    habitId: habitId,
    date: habitMarkDate(habit, date, new Date()),
    value: value,
  };

  const full = document.getElementById('level-option-full');
  if (full) {
    full.disabled = !hasValue;
    full.classList.toggle('is-active', !!entry && entry.level !== LEVEL_TWO_MIN);
  }

  const twoMin = document.getElementById('level-option-two-min');
  if (twoMin) twoMin.classList.toggle('is-active', !!entry && entry.level === LEVEL_TWO_MIN);

  const sheet = document.getElementById('level-sheet');
  if (!sheet) return;

  // Для Корана показываем только «Полная версия» и «2 минуты»,
  // остальные кнопки скрываем
  const options = sheet.querySelectorAll('.level-option');
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (habitId === QURAN_HABIT_ID) {
      const lvl = opt.getAttribute('data-level');
      opt.style.display = (lvl === 'full' || lvl === 'two-min') ? '' : 'none';
    } else {
      opt.style.display = '';
    }
  }

  sheet.hidden = false;
  syncSheetToKeyboard();
}

export function closeLevelSheet() {
  const sheet = document.getElementById('level-sheet');
  if (sheet) sheet.hidden = true;
  levelSheetTarget = null;
  document.documentElement.style.setProperty('--keyboard-offset', '0px');
}

// Выбор пункта попапа. «2 минуты» пишутся и уровнем, и значением, если
// значения ещё нет: у Корана это 0, у Спорта — сам код «2 минуты».
export function onLevelPick(event) {
  const option = event.target.closest('.level-option');
  if (!option || option.disabled || !levelSheetTarget) return;

  const habit = findHabit(levelSheetTarget.habitId);
  const date = levelSheetTarget.date;
  const value = levelSheetTarget.value;
  if (!habit) return;

  let level;
  if (option.getAttribute('data-level') === 'two-min') {
    level = LEVEL_TWO_MIN;
  } else {
    level = defaultLevel(habit, value);
  }

  // Числа ещё нет — «2 минуты» пишутся нулём страниц (§2.4).
  // «Полная версия» без числа недоступна, поэтому дальше пути нет.
  let written = value;
  if (written === undefined && level === LEVEL_TWO_MIN) written = 0;
  if (written === undefined) return;

  if (!writeHabitEntry(habit, date, written, level)) return;

  closeLevelSheet();
  syncLevelCells(habit.id, date);
  updateRowCircle(habit.id);
}

// Вид полей уровня после выбора в попапе: клетки таблицы и, если открыт режим
// «День», карточки. Так же поступает updateQazaCells: на телефоне таблица
// скрыта медиа-запросом, но остаётся в DOM, и обновления одной её мало.
export function syncLevelCells(habitId, date) {
  const cells = document.querySelectorAll(
    'td.cell[data-habit-id="' + cssEscape(habitId) + '"]');
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].getAttribute('data-date') === date) syncLevelCell(cells[i], habitId, date);
  }

  if (isMainDayView()) renderDayCards();
}

/* --- Вкладка «Каза-намазы» ----------------------------------------------- */



/* --- Панель навигации статистики (заход 4) ------------------------------- */

// Панель открыта — на панели класс is-open: по нему едет transform,
// а visibility снимается без задержки. Подложка отдельным элементом
// и гасится атрибутом hidden.
export function openStatsMenu() {
  const menu = document.getElementById('stats-menu');
  const backdrop = document.getElementById('stats-menu-backdrop');
  if (!menu || !backdrop) return;
  menu.classList.add('is-open');
  backdrop.hidden = false;
}

export function closeStatsMenu() {
  const menu = document.getElementById('stats-menu');
  const backdrop = document.getElementById('stats-menu-backdrop');
  if (!menu || !backdrop) return;
  menu.classList.remove('is-open');
  // Аккордеон категорий возвращается в свёрнутый вид: следующее открытие
  // панели не должно показывать чужое состояние. Работает для всех способов
  // закрытия — Escape, тап по подложке, выбор пункта: все они идут сюда
  menu.classList.remove('is-hub-open');
  const sub = document.getElementById('stats-hub-sub');
  if (sub) sub.hidden = true;
  const toggle = document.getElementById('stats-hub-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  backdrop.hidden = true;
}

// Открыта ли панель. Спрашивает Escape: он разбирает шторки по слоям
export function isStatsMenuOpen() {
  const menu = document.getElementById('stats-menu');
  return !!menu && menu.classList.contains('is-open');
}

// Экраны раздела «Статистика»: у них общий вход и общий возврат «Назад»
export function isStatsView(name) {
  return name === 'stats' || name === 'stats-qaza' || name === 'stats-habits' ||
    name === 'stats-habit' || name === 'stats-fast' || name === 'stats-sleep';
}

// Куда вернёт «Назад» с экранов статистики. Входов два — строка в Настройках
// на ПК и гамбургер на телефоне, — и вернуть надо туда, откуда вошли.
// Значение снимается один раз, на входе в раздел: иначе переход между
// категориями переписывал бы его, и возврат уводил бы в прошлый экран
export let statsReturnView = 'settings';

// Куда вернёт «Назад» с экрана «Цикл сна». Входов два — строка в Настройках
// на ПК и пункт гамбургера на телефоне, — и вернуть надо туда, откуда вошли.
// Снимается один раз, на входе в экран, как у статистики
export let sleepReturnView = 'main';

// Текущий вид приложения. Нужен затем, чтобы отличить вход в статистику
// от перехода внутри неё
export let currentView = 'main';

// Переключение разделов. Единая точка входа для таб-бара на телефоне,
// кнопки «Каза-намазы» и «Назад» на ПК. Видимость контейнеров, подсветка
// вкладок и классы тела — applyScreen из js/ui/router.js; здесь —
// запоминание точки возврата и перерисовка при входе.
const ROUTE_RENDER = {
  'main': renderMainView,
  'qaza': function () { ensureQazaState(); renderQazaView(); },
  'edit-habits': function () { appState.habits = loadHabits(); renderHabitsEditList(); },
  'settings': renderSettingsView,
  'stats': renderStatsView,
  'stats-qaza': renderStatsQazaView,
  // Вход в список обнуляет выбранную привычку: карточка открывается только
  // тапом по строке, а не остатком прошлого захода
  'stats-habits': function () { statsHabitId = null; renderStatsHabitsView(); },
  'stats-habit': renderStatsHabitView,
  'stats-fast': renderStatsFastView,
  'stats-sleep': renderStatsSleepView,
  'sleep': renderSleepView,
  'schedule': renderScheduleView,
  // Список времён открывается свёрнутым: «Показать все» — разовый взгляд
  'prayer': function () { resetPrayerShowAll(); renderPrayerView(); },
  'prayer-settings': renderPrayerSettings,
  // Незакрытая форма не переживает уход с экрана: возвращаться к наполовину
  // заполненному полю незачем, а первый запуск снова покажет форму сам
  'fast': function () { resetFastForm(); renderFastView(); },
};

export function switchAppView(name) {
  // Панель статистики принадлежит главной: любой переход её закрывает.
  // Попап уровня — тоже: программный переход (из консоли, теста или будущего
  // кода) без этого оставил бы его висеть поверх нового экрана
  closeStatsMenu();
  closeLevelSheet();

  // Вход в раздел запоминает, откуда вошли, — туда «Назад» из хаба и вернёт
  if (isStatsView(name) && !isStatsView(currentView)) statsReturnView = currentView;

  // То же для «Цикла сна»: у экрана два входа — строка в Настройках и пункт
  // гамбургера, — и «Назад» должен вернуть в тот, откуда вошли
  if (name === 'sleep' && currentView !== 'sleep') sleepReturnView = currentView;

  applyScreen(name);
  const render = ROUTE_RENDER[name];
  if (render) render();

  window.scrollTo(0, 0);
  currentView = name;

  // Обновить каплю-индикаторы всех переключателей через общий планировщик
  scheduleLiquidIndicators();
}

// Строка версии в Настройках
export function renderSettingsView() {
  const version = document.getElementById('settings-version');
  if (version) version.textContent = 'Версия: ' + APP_VERSION + ' · сборка ' + APP_BUILD;
}

/* ---------- Экран «Статистика» ------------------------------------------- */

// Выбранный период живёт на устройстве, а не в данных человека: как ui.mainView,
// это отметка последнего просмотра, а не запись. Категория у каждой своя,
// поэтому общей переменной нет — её читает loadStatsPeriod(category)

// Перерисовка экранов одной категории. Скрытые трогать незачем: их нарисует
// вход на экран (switchAppView)
export function renderStatsCategory(category) {
  if (category === 'hub') {
    renderStatsView();
  } else if (category === 'qaza') {
    renderStatsQazaView();
  } else if (category === 'habits') {
    renderStatsHabitsView();
    renderStatsHabitView();
  } else if (category === 'fast') {
    renderStatsFastView();
  } else if (category === 'sleep') {
    renderStatsSleepView();
  }
}






// Хаб: четыре строки. Цифры считаются по хранилищу, а не по appState:
// раздел открывается из Настроек, где состояние таблицы могло устареть.
export function renderStatsView() {
  markStatsPeriod('stats-period');

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('hub'), today);

  ensureQazaState();
  setStatsValue('#stats-list [data-stat="qaza"] .stats-row-value',
    qazaTotalRemaining(getQazaState()));

  // Сон — средняя длительность записи за период хаба. Дни берутся уже
  // собранные: период у строки тот же, что у остальных цифр. Записи
  // excluded пропускаются целиком, значение дня — realSleepMin ?? sleepMin
  const sleep = loadSleep();
  let sleepValue = '—';
  if (sleep && sleep.history.length > 0) {
    const dayIndex = {};
    for (let i = 0; i < dates.length; i++) dayIndex[dates[i]] = i;

    let sum = 0;
    let count = 0;
    for (let i = 0; i < sleep.history.length; i++) {
      const entry = sleep.history[i];
      if (entry.excluded === true) continue;
      if (dayIndex[entry.date] === undefined) continue;
      sum += entry.realSleepMin ?? entry.sleepMin;
      count++;
    }
    if (count > 0) sleepValue = sleepFormatDuration(Math.round(sum / count));
  }
  setStatsValue('#stats-list [data-stat="sleep"] .stats-row-value', sleepValue);

  const fast = loadFast();
  setStatsValue('#stats-list [data-stat="fast"] .stats-row-value',
    fast ? fast.remaining : '—');

  const average = habitsAveragePercent(loadHabits(), dates);
  setStatsValue('#stats-list [data-stat="habits"] .stats-row-value',
    average === null ? '—' : Math.round(average) + '%');
}

export function renderStatsQazaView() {
  markStatsPeriod('stats-qaza-period');

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('qaza'), today);
  const records = loadRecords();

  // Источник за день зависит от журнала (§5). Журнала нет — как было: поле h6
  // в записях дня, единственный свидетель каза за день. Журнал заведён — за
  // дни до since всё ещё h6, а с since и позже считает журнал: стек очереди
  // живёт только за сегодня, журнал же по датам не чистится
  const log = loadQazaLog();
  const logDone = qazaLogDoneByDay(log);

  let done = 0;
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    const count = log && dates[i] >= log.since
      ? (logDone[dates[i]] || 0)
      : qazaDoneOn(records, dates[i]);
    values.push(count);
    done += count;
  }

  ensureQazaState();
  const average = done / dates.length;

  const summary = document.getElementById('stats-qaza-summary');
  if (summary) {
    summary.innerHTML = statsSummaryMarkup([
      ['done', 'Выполнено за период', String(done)],
      ['average', 'Средний темп в день', average.toFixed(1).replace('.', ',')],
      ['streak', 'Текущая серия, дней', String(qazaStreak(records, today))],
      ['total', 'Общий остаток', String(qazaTotalRemaining(getQazaState()))],
    ]);
  }

  const chart = document.getElementById('stats-qaza-chart');
  if (chart) chart.innerHTML = statsChartMarkup(values);
}

// Категория «Ураза». Источник — растущая история счётчика (§5): интерфейс
// уразы её только пишет, читает раздел статистики. Счётчика нет — ни цифр,
// ни графика: собрать их не из чего
export function renderStatsFastView() {
  markStatsPeriod('stats-fast-period');

  const summary = document.getElementById('stats-fast-summary');
  const chart = document.getElementById('stats-fast-chart');
  const note = document.getElementById('stats-fast-empty-note');
  if (!summary || !chart || !note) return;

  const fast = loadFast();
  if (!fast) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'Счётчик не заведён';
    note.hidden = false;
    return;
  }

  summary.hidden = false;

  const dates = statsPeriodDates(loadStatsPeriod('fast'), new Date());
  const dayIndex = {};
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    dayIndex[dates[i]] = i;
    values.push(0);
  }

  let done = 0;
  let added = 0;
  let since = null;

  for (let i = 0; i < fast.history.length; i++) {
    const event = fast.history[i];
    // Начало истории — по всей истории, а не по периоду: «с какого дня
    // копится» не должно меняться от выбранного окна
    if (since === null || event.date < since) since = event.date;

    const day = dayIndex[event.date];
    if (day === undefined) continue;
    if (event.source === FAST_SOURCE_DONE) {
      done += event.count;
      values[day] += event.count;
    } else if (event.source === FAST_SOURCE_ADD) {
      added += event.count;
    }
  }

  summary.innerHTML = statsSummaryMarkup([
    ['remaining', 'Остаток', String(fast.remaining)],
    ['done', 'Возмещено за период', String(done)],
    ['added', 'Добавлено за период', String(added)],
    ['since', 'История копится с', since === null ? '—' : since],
  ]);

  // Истории мало — вместо графика строка текста: три столбика на всю ширину
  // читались бы как «данных достаточно», хотя это ещё начало
  if (fast.history.length < FAST_HISTORY_MIN) {
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'История копится с ' + (since === null ? '—' : since) +
      '. Данных пока мало для графика';
    note.hidden = false;
  } else {
    chart.hidden = false;
    chart.innerHTML = statsChartMarkup(values, 'Возмещено по дням');
    note.hidden = true;
  }
}

// Категория «Сон». Источник — история раздела «Цикл сна» (§11ab): форма её
// только пишет, читает раздел статистики. Пустых состояний два, и это разные
// вещи: истории нет вовсе — показывать нечего, истории нет за выбранное окно
// — данные есть, но не здесь. Средние отбоя и подъёма считает
// sleepAverageMinutes: у времени суток своя арифметика, и обычное среднее
// на ней врёт. Средний подъём — по полю actualWake, а не wake: в историю
// идёт то, что вышло на самом деле, а wake — цель
export function renderStatsSleepView() {
  markStatsPeriod('stats-sleep-period');

  const sleep = loadSleep();
  const summary = document.getElementById('stats-sleep-summary');
  const chart = document.getElementById('stats-sleep-chart');
  const note = document.getElementById('stats-sleep-empty-note');
  if (!summary || !chart || !note) return;

  if (!sleep || sleep.history.length === 0) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'Истории сна нет';
    note.hidden = false;
    return;
  }

  const dates = statsPeriodDates(loadStatsPeriod('sleep'), new Date());
  const dayIndex = {};
  const values = [];
  for (let i = 0; i < dates.length; i++) {
    dayIndex[dates[i]] = i;
    values.push(0);
  }

  // Записи периода. Одна запись на день — держит sleepHistoryEntry, — но
  // сумма на день, а не присваивание: вторая запись о том же дне сложилась бы
  // в значение дня, а не затёрла первую. Записи excluded пропускаются целиком:
  // человек сказал «не считать этот день», и он не должен попасть ни в средние,
  // ни в график, ни в счётчик
  const inPeriod = [];
  for (let i = 0; i < sleep.history.length; i++) {
    const entry = sleep.history[i];
    if (entry.excluded === true) continue;
    const day = dayIndex[entry.date];
    if (day === undefined) continue;
    inPeriod.push(entry);
    values[day] += entry.realSleepMin ?? entry.sleepMin;
  }

  if (inPeriod.length === 0) {
    summary.innerHTML = '';
    summary.hidden = true;
    chart.innerHTML = '';
    chart.hidden = true;
    note.textContent = 'За выбранный период записей нет';
    note.hidden = false;
    return;
  }

  summary.hidden = false;

  // Оба конца ночи — время суток, и history их уже проверила при чтении:
  // каждое значение здесь число, а не null. Средний подъём — по факту
  // (realWake), если он задан, иначе по actualWake. Средняя длительность —
  // по realSleepMin, если он задан, иначе по sleepMin
  const bedMinutes = inPeriod.map(function (e) { return sleepTimeMinutes(e.bed); });
  const wakeMinutes = inPeriod.map(function (e) {
    return sleepTimeMinutes(e.realWake ?? e.actualWake);
  });

  let durationSum = 0;
  for (let i = 0; i < inPeriod.length; i++) {
    durationSum += inPeriod[i].realSleepMin ?? inPeriod[i].sleepMin;
  }
  const averageDuration = Math.round(durationSum / inPeriod.length);

  const averageBed = sleepAverageMinutes(bedMinutes);
  const averageWake = sleepAverageMinutes(wakeMinutes);

  summary.innerHTML = statsSummaryMarkup([
    ['bed',     'Средний отбой',        averageBed === null ? '—' : sleepTimeLabel(averageBed)],
    ['wake',    'Средний подъём',       averageWake === null ? '—' : sleepTimeLabel(averageWake)],
    ['average', 'Средняя длительность', sleepFormatDuration(averageDuration)],
    ['count',   'Записей за период',    String(inPeriod.length)],
  ]);

  chart.hidden = false;
  chart.innerHTML = statsChartMarkup(values, 'Длительность сна по дням');
  note.hidden = true;
}

/* ---------- Статистика: привычки ----------------------------------------- */

// Выбранная привычка. Живёт только в интерфейсе: список обнуляет её при входе,
// строка списка ставит своё значение перед показом карточки
export let statsHabitId = null;


// Список привычек. Процент за период — calcProgress, и это же делает «0%»
// при полном отсутствии записей: пустой день даёт ноль, ветка «—» не нужна
export function renderStatsHabitsView() {
  markStatsPeriod('stats-habits-period');

  const list = document.getElementById('stats-habits-list');
  if (!list) return;

  const dates = statsPeriodDates(loadStatsPeriod('habits'), new Date());
  const habits = loadHabits();

  // Строка — кнопка, как строка хаба: <div> выпал бы из таб-навигации
  let markup = '';
  for (let i = 0; i < habits.length; i++) {
    const habit = habits[i];
    markup += '<li><button type="button" class="settings-row" data-habit-id="' +
      escapeHtml(habit.id) + '"><span>' + escapeHtml(habit.name) + '</span>' +
      '<span class="stats-row-value">' + escapeHtml(Math.round(calcProgress(habit, dates))) +
      '%</span></button></li>';
  }
  list.innerHTML = markup;
}

// Карточка одной привычки. Без выбранного id рисовать нечего: экран
// открывается только тапом по строке списка
export function renderStatsHabitView() {
  if (statsHabitId === null) return;

  markStatsPeriod('stats-habit-period');

  // Список читается из хранилища, как в хабе: раздел открывают из Настроек,
  // где состояние таблицы могло устареть
  const habits = loadHabits();
  let habit = null;
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === statsHabitId) habit = habits[i];
  }
  if (!habit) return;

  const today = new Date();
  const dates = statsPeriodDates(loadStatsPeriod('habits'), today);

  const title = document.getElementById('stats-habit-title');
  if (title) title.textContent = habit.name;

  const summary = document.getElementById('stats-habit-summary');
  if (summary) {
    summary.innerHTML = statsSummaryMarkup([
      ['average', 'Средний процент за период', Math.round(calcProgress(habit, dates)) + '%'],
      ['streak', 'Текущая серия, дней', String(habitCurrentStreak(habit, today))],
      ['best', 'Лучшая серия за период, дней', String(habitBestStreak(habit, dates))],
      ['marks', 'Всего отметок за период', String(habitMarkedDays(habit, dates).length)],
    ]);
  }

  const values = [];
  for (let i = 0; i < dates.length; i++) values.push(calcProgress(habit, [dates[i]]));

  const chart = document.getElementById('stats-habit-chart');
  if (chart) chart.innerHTML = statsChartMarkup(values, 'Отметки по дням');

  const grid = document.getElementById('stats-habit-grid');
  if (grid) {
    grid.innerHTML = statsHabitGridMarkup(habit, dates);
    // Свежие отметки лежат справа: без этого «Всё время» открывалось бы
    // на неделях пустоты, а сегодняшний край оставался за кадром
    grid.scrollLeft = grid.scrollWidth;
  }
}

/* ---------- Экран «Молитвы» ---------------------------------------------- */









































// Обновление ячеек каза во всех днях отображаемой недели
export function updateQazaCells() {
  const cells = document.querySelectorAll(
    '#habits-tbody td.cell[data-habit-id="' + cssEscape(QAZA_HABIT_ID) + '"]'
  );
  for (let i = 0; i < cells.length; i++) {
    const date = cells[i].getAttribute('data-date');
    if (!date) continue;
    cells[i].innerHTML = qazaCellMarkup(date);
  }

  // В режиме «День» таблица скрыта — обновляем ещё и карточки
  if (isMainDayView()) renderDayCards();
}

/* --- Вкладка «Ураза» ----------------------------------------------------- */









/* --- Раздел «Цикл сна» --------------------------------------------------- */










/* --- Модальное окно ------------------------------------------------------ */

export function openModal() {
  appState.habits = loadHabits();
  renderHabitList();
  const modal = document.getElementById('habit-modal');
  if (modal) modal.hidden = false;
}

export function closeModal() {
  const modal = document.getElementById('habit-modal');
  if (modal) modal.hidden = true;
  setFormError('');
  // После добавления привычки список на экране «Привычки» устарел
  renderHabitsEditList();
}

// Список привычек в модалке. События делегированы на #habit-list.
export function renderHabitList() {
  const list = document.getElementById('habit-list');
  if (!list) return;

  let html = '';
  for (let i = 0; i < appState.habits.length; i++) {
    const habit = appState.habits[i];
    // У каза тип задаётся вкладкой «Каза-намазы» и заблокирован всегда;
    // у остальных — только если по привычке уже есть записи
    const isQaza = habit.id === QAZA_HABIT_ID;
    const locked = isQaza || hasRecords(habit.id);
    const lockedTitle = isQaza
      ? 'Тип каза задаётся вкладкой «Каза-намазы»'
      : 'Тип нельзя изменить: по привычке уже есть записи';
    const lockedAttr = locked
      ? ' disabled title="' + escapeHtml(lockedTitle) + '"'
      : '';
    const goalValue = habit.goal === null || habit.goal === undefined
      ? '' : String(habit.goal);

    html += '<li data-habit-id="' + escapeHtml(habit.id) + '">' +
      '<input type="text" class="habit-edit-name" value="' + escapeHtml(habit.name) +
      '" aria-label="Название">' +
      '<select class="habit-type"' + lockedAttr + ' aria-label="Тип">' +
      typeOptionsMarkup(habit.type) + '</select>' +
      '<input type="text" class="habit-edit-unit" value="' + escapeHtml(habit.unit || '') +
      '" placeholder="Ед." aria-label="Единица измерения">' +
      '<input type="number" class="habit-edit-goal" min="1" step="1" value="' +
      escapeHtml(goalValue) + '" placeholder="Цель" aria-label="Цель">' +
      // Время — только у привычек с уровнями: оно задаёт окно «вовремя»
      (isLevelHabit(habit.id)
        ? '<input type="time" class="habit-edit-time" value="' +
          escapeHtml(habit.time || '') + '" aria-label="Время">'
        : '') +
      '<button type="button" class="btn btn-secondary habit-save">Сохранить</button>' +
      // У каза кнопки удаления нет: удалив привычку, синхронизацию не восстановить
      (isQaza ? '' : '<button type="button" class="btn btn-danger habit-delete">Удалить</button>') +
      '</li>';
  }

  list.innerHTML = html;
}

// Делегированный обработчик кнопок «Сохранить» и «Удалить» в списке
export function onHabitListClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  const item = target.closest('li[data-habit-id]');
  if (!item) return;

  const habitId = item.getAttribute('data-habit-id');
  const habit = findHabit(habitId);
  if (!habit) return;

  if (target.closest('.habit-delete')) {
    if (!window.confirm('Удалить привычку «' + habit.name + '» и все её записи?')) return;
    if (!removeHabit(habitId)) return;
    appState.habits = loadHabits();
    setFormError('');
    renderHabitList();
    renderMainView();
    return;
  }

  if (target.closest('.habit-save')) {
    const data = readHabitItem(item);
    const result = validateHabitForm(data, habitId);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    const patch = { name: data.name.trim(), unit: data.unit, goal: data.goal };
    // Время есть только у привычек с уровнями: поле пустое — время не задано
    if (isLevelHabit(habitId)) patch.time = data.time;
    // Тип меняем только у привычки без записей
    if (!hasRecords(habitId)) patch.type = data.type;

    if (!updateHabit(habitId, patch)) return;
    appState.habits = loadHabits();
    setFormError('');
    renderHabitList();
    renderMainView();
  }
}

/* --- Экран «Привычки» (настройки, телефон) ------------------------------- */

// Строки-аккордеоны: поля раскрываются тапом по заголовку
export function renderHabitsEditList() {
  const list = document.getElementById('habits-edit-list');
  if (!list) return;

  let html = '';
  for (let i = 0; i < appState.habits.length; i++) {
    const habit = appState.habits[i];
    const isQaza = habit.id === QAZA_HABIT_ID;
    const locked = isQaza || hasRecords(habit.id);
    const lockedTitle = isQaza
      ? 'Тип каза задаётся вкладкой «Каза-намазы»'
      : 'Тип нельзя изменить: по привычке уже есть записи';
    const lockedAttr = locked
      ? ' disabled title="' + escapeHtml(lockedTitle) + '"'
      : '';
    const isNumber = habit.type === 'number';
    const numberHidden = isNumber ? '' : ' hidden';
    const goalValue = habit.goal === null || habit.goal === undefined
      ? '' : String(habit.goal);

    html += '<li class="habit-row-edit" data-habit-id="' + escapeHtml(habit.id) + '">' +
      '<button type="button" class="habit-row-head">' +
        '<span class="habit-row-name">' + escapeHtml(habit.name) + '</span>' +
        '<span class="habit-row-type">' + escapeHtml(habitTypeLabel(habit.type)) + '</span>' +
        '<span class="habit-row-chevron">›</span>' +
      '</button>' +
      '<div class="habit-row-body">' +
        '<label><span>Название</span>' +
          '<input type="text" class="edit-name" value="' + escapeHtml(habit.name) + '">' +
        '</label>' +
        '<label><span>Тип</span>' +
          '<select class="edit-type"' + lockedAttr + '>' +
          typeOptionsMarkup(habit.type) + '</select>' +
        '</label>' +
        '<label class="edit-number-field"' + numberHidden + '><span>Единица измерения</span>' +
          '<input type="text" class="edit-unit" value="' + escapeHtml(habit.unit || '') +
          '" placeholder="Ед.">' +
        '</label>' +
        '<label class="edit-number-field"' + numberHidden + '><span>Цель</span>' +
          '<input type="number" class="edit-goal" min="1" step="1" value="' +
          escapeHtml(goalValue) + '" placeholder="Цель">' +
        '</label>' +
        // Время — только у привычек с уровнями: оно задаёт окно «вовремя»
        (isLevelHabit(habit.id)
          ? '<label class="edit-time-field"><span>Время</span>' +
            '<input type="time" class="edit-time" value="' +
            escapeHtml(habit.time || '') + '">' +
            '</label>'
          : '') +
        '<p class="form-error" role="alert"></p>' +
        '<div class="habit-row-actions">' +
          '<button type="button" class="btn btn-primary edit-save">Сохранить</button>' +
          // У каза удаления нет: удалив привычку, синхронизацию не восстановить
          (isQaza ? '' : '<button type="button" class="btn btn-danger edit-delete">Удалить</button>') +
        '</div>' +
      '</div>' +
      '</li>';
  }

  list.innerHTML = html;
}

// Ошибка показывается внутри раскрытой строки — форма модалки здесь не видна
export function setRowError(item, message) {
  const error = item.querySelector('.form-error');
  if (error) error.textContent = message || '';
}

// Делегированный обработчик экрана «Привычки»
export function onHabitsEditClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  if (target.closest('.habit-row-head')) {
    const row = target.closest('.habit-row-edit');
    if (!row) return;
    const wasOpen = row.classList.contains('is-open');
    // Открыта не более одной строки: раскрытие закрывает соседей
    const siblings = row.parentNode.children;
    for (let i = 0; i < siblings.length; i++) {
      siblings[i].classList.remove('is-open');
    }
    if (!wasOpen) row.classList.add('is-open');
    return;
  }

  const item = target.closest('li[data-habit-id]');
  if (!item) return;

  const habitId = item.getAttribute('data-habit-id');
  const habit = findHabit(habitId);
  if (!habit) return;

  if (target.closest('.edit-delete')) {
    if (!window.confirm('Удалить привычку «' + habit.name + '» и все её записи?')) return;
    if (!removeHabit(habitId)) return;
    appState.habits = loadHabits();
    renderHabitsEditList();
    renderMainView();
    return;
  }

  if (target.closest('.edit-save')) {
    const data = readHabitItem(item, EDIT_ROW_SELECTORS);
    const result = validateHabitForm(data, habitId);
    if (!result.ok) {
      setRowError(item, result.error);
      return;
    }
    const patch = { name: data.name.trim(), unit: data.unit, goal: data.goal };
    // Время есть только у привычек с уровнями: поле пустое — время не задано
    if (isLevelHabit(habitId)) patch.time = data.time;
    // Тип меняем только у привычки без записей
    if (!hasRecords(habitId)) patch.type = data.type;

    if (!updateHabit(habitId, patch)) return;
    appState.habits = loadHabits();
    renderHabitsEditList();
    renderMainView();
  }
}

// Поля «Единица» и «Цель» нужны только числовому типу
export function onHabitsEditChange(event) {
  const field = event.target;
  if (!field || !field.classList || !field.classList.contains('edit-type')) return;

  const item = field.closest('li[data-habit-id]');
  if (!item) return;

  const isNumber = field.value === 'number';
  const fields = item.querySelectorAll('.edit-number-field');
  for (let i = 0; i < fields.length; i++) {
    fields[i].hidden = !isNumber;
  }
}

// Селекторы строки экрана «Привычки» — имена классов отличаются от модалки
export const EDIT_ROW_SELECTORS = {
  name: '.edit-name',
  type: '.edit-type',
  unit: '.edit-unit',
  goal: '.edit-goal',
  time: '.edit-time',
};

// Данные одной строки списка привычек.
// cls переопределяет селекторы: в модалке и на экране «Привычки» они разные.
export function readHabitItem(item, cls) {
  const sel = cls || {};
  const nameField = item.querySelector(sel.name || '.habit-edit-name');
  const typeField = item.querySelector(sel.type || '.habit-type');
  const unitField = item.querySelector(sel.unit || '.habit-edit-unit');
  const goalField = item.querySelector(sel.goal || '.habit-edit-goal');
  const timeField = item.querySelector(sel.time || '.habit-edit-time');

  const type = typeField ? typeField.value : 'boolean';
  const unit = unitField ? unitField.value.trim() : '';
  const goalText = goalField ? goalField.value.trim() : '';
  // Пустое поле времени — это null, а не пустая строка: так «времени нет»
  // и «время затёрли» читаются одинаково
  const timeText = timeField ? timeField.value.trim() : '';

  return {
    name: nameField ? nameField.value : '',
    type: type,
    unit: type === 'number' ? unit : '',
    goal: type === 'number' ? Number(goalText) : null,
    time: timeText === '' ? null : timeText,
  };
}

/* --- Форма добавления привычки ------------------------------------------- */

export function setFormError(message) {
  const error = document.getElementById('form-error');
  if (error) error.textContent = message || '';
}

// Поля unit и goal имеют смысл только для числового типа
export function updateFormFields() {
  const typeField = document.getElementById('form-type');
  const unitField = document.getElementById('form-unit');
  const goalField = document.getElementById('form-goal');
  const isNumber = !!typeField && typeField.value === 'number';
  if (unitField) unitField.hidden = !isNumber;
  if (goalField) goalField.hidden = !isNumber;
}

export function onFormSubmit(event) {
  event.preventDefault();

  const nameField = document.getElementById('form-name');
  const typeField = document.getElementById('form-type');
  const unitField = document.getElementById('form-unit');
  const goalField = document.getElementById('form-goal');

  const type = typeField ? typeField.value : 'boolean';
  const data = {
    name: nameField ? nameField.value : '',
    type: type,
    unit: unitField ? unitField.value.trim() : '',
    goal: type === 'number' && goalField ? Number(goalField.value.trim()) : null,
  };

  const result = validateHabitForm(data);
  if (!result.ok) {
    setFormError(result.error);
    return;
  }

  const created = addHabit({
    name: data.name.trim(),
    type: data.type,
    unit: data.type === 'number' ? data.unit : '',
    goal: data.goal,
  });
  if (!created) return;

  appState.habits = loadHabits();
  setFormError('');

  const form = document.getElementById('habit-form');
  if (form) form.reset();
  updateFormFields();

  renderHabitList();
  renderMainView();
}

// validateHabitForm(data, excludeId) -> { ok: true } | { ok: false, error }
// excludeId позволяет не считать саму привычку дубликатом при редактировании.
export function validateHabitForm(data, excludeId) {
  const skipId = excludeId !== undefined && excludeId !== null
    ? excludeId
    : (data && data.excludeId !== undefined ? data.excludeId : null);

  const name = (data && data.name ? String(data.name) : '').trim();
  if (name === '') {
    return { ok: false, error: 'Введите название привычки' };
  }

  const habits = loadHabits();
  const lowerName = name.toLowerCase();
  for (let i = 0; i < habits.length; i++) {
    if (habits[i].id === skipId) continue;
    if (String(habits[i].name).trim().toLowerCase() === lowerName) {
      return { ok: false, error: 'Привычка с названием «' + name + '» уже существует' };
    }
  }

  if (data && data.type === 'number') {
    const goal = data.goal;
    const isInteger = typeof goal === 'number' && isFinite(goal) &&
      Math.floor(goal) === goal && goal > 0;
    if (!isInteger) {
      return { ok: false, error: 'Цель должна быть целым числом больше 0' };
    }
    if (!(data.unit ? String(data.unit) : '').trim()) {
      return { ok: false, error: 'Укажите единицу измерения для числовой привычки' };
    }
  }

  return { ok: true };
}

/* --- Проводка слоёв через шину событий -------------------------------------
   Единственное место, где слои слышат друг друга: данные эмитят правку,
   синхронизация — применённый снимок, хранилище — ошибку записи. Прямых
   вызовов между слоями нет, поэтому при переходе на ES-модули (Фаза 3.2)
   граф импортов останется однонаправленным. */

bus.on('data:changed', scheduleSync);
// Изменение очереди каза (было телом afterQazaChange): вкладку перерисовывает
// сам модуль, а ячейки таблицы и круг строки h6 — этот подписчик
bus.on('qaza:changed', function () {
  updateQazaCells();
  updateRowCircle(QAZA_HABIT_ID);
});
bus.on('data:replaced', function () {
  appState.habits = loadHabits();
  setQazaState(loadQaza());
  renderMainView();
  renderQazaView();
  renderPrayerView();
  renderFastView();
});
bus.on('sync:applied', function () {
  // сначала состояние (его раньше обновлял сам слой синхронизации),
  // затем перерисовка — экраны читают appState и qazaState
  appState.habits = loadHabits();
  setQazaState(loadQaza(true));
  renderMainView();
  renderQazaView();
  renderPrayerView();
  renderFastView();
  const sw = document.getElementById('schedule-view');
  if (sw && !sw.hidden) renderScheduleView();
});
bus.on('storage:error', function () {
  showToast('Не удалось сохранить: хранилище переполнено');
});

document.addEventListener('DOMContentLoaded', init);

// Регистрация service worker для офлайн-работы.
// По file:// регистрация невозможна — ошибку молча глотаем, страница работает как обычно.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}

// --- Liquid Glass: плавающая капсула для таб-бара и всех переключателей ---
export const LIQUID_SWITCH_SELECTORS = [
  '#tab-bar',
  '#main-view-switch',
  '#schedule-switch',
  '#schedule-edit-switch',
  '#stats-period',
  '#stats-qaza-period',
  '#stats-habits-period',
  '#stats-habit-period',
  '#stats-fast-period',
  '#stats-sleep-period'
];

window.moveIndicator = function (container) {
  if (!container || container.hidden) return;

  const indicator = container.querySelector(':scope > .glass-indicator');
  const button = container.querySelector(':scope > button.is-active');

  if (!indicator || !button) return;
  if (button.offsetWidth <= 0 || button.offsetHeight <= 0) return;

  const containerRect = container.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();

  if (containerRect.width <= 0 || containerRect.height <= 0) return;

  if (container.id === 'tab-bar') {
    const maxPillWidth = 60;
    const pillWidth = Math.max(0, Math.min(maxPillWidth, buttonRect.width - 12));

    const relativeLeft =
      (buttonRect.left - containerRect.left) +
      (buttonRect.width - pillWidth) / 2;

    const maxLeft = Math.max(0, containerRect.width - pillWidth);
    const clampedLeft = Math.max(0, Math.min(relativeLeft, maxLeft));

    indicator.style.width = pillWidth + 'px';
    indicator.style.height = '36px';
    indicator.style.top = '14px';
    indicator.style.transform =
      'translate3d(' + clampedLeft + 'px, 0, 0)';
  } else {
    const rawLeft = buttonRect.left - containerRect.left;
    const maxWidth = Math.max(0, containerRect.width - Math.max(0, rawLeft));
    const buttonWidth = Math.max(0, Math.min(buttonRect.width, maxWidth));

    indicator.style.width = buttonWidth + 'px';
    indicator.style.height = 'calc(100% - 8px)';
    indicator.style.top = '4px';
    indicator.style.transform =
      'translate3d(' + Math.max(0, rawLeft) + 'px, 0, 0)';
  }
};

export function getLiquidSwitchContainers() {
  return LIQUID_SWITCH_SELECTORS
    .map(function (selector) {
      return document.querySelector(selector);
    })
    .filter(Boolean);
}

export function moveAllIndicators() {
  getLiquidSwitchContainers().forEach(function (container) {
    window.moveIndicator(container);
  });
}

export let liquidIndicatorFrame = 0;

export function scheduleLiquidIndicators() {
  if (liquidIndicatorFrame) {
    cancelAnimationFrame(liquidIndicatorFrame);
  }

  liquidIndicatorFrame = requestAnimationFrame(function () {
    liquidIndicatorFrame = 0;
    moveAllIndicators();
  });
}

document.addEventListener('click', function (event) {
  const button = event.target.closest(
    LIQUID_SWITCH_SELECTORS.join(', ') + ' > button'
  );

  if (!button) return;

  requestAnimationFrame(function () {
    requestAnimationFrame(scheduleLiquidIndicators);
  });
});

// Наблюдатель следит за class/hidden; style не наблюдаем, чтобы собственные
// изменения индикатора не зацикливали пересчёт.
export const liquidObserver = new MutationObserver(function () {
  scheduleLiquidIndicators();
});

export function observeLiquidSwitches() {
  getLiquidSwitchContainers().forEach(function (container) {
    liquidObserver.observe(container, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden']
    });
  });
}

export let liquidResizeObserver = null;

export function observeLiquidSwitchSizes() {
  if (!('ResizeObserver' in window)) return;

  if (liquidResizeObserver) {
    liquidResizeObserver.disconnect();
  }

  liquidResizeObserver = new ResizeObserver(function () {
    scheduleLiquidIndicators();
  });

  getLiquidSwitchContainers().forEach(function (container) {
    liquidResizeObserver.observe(container);
  });
}

export function updateTabCalendarDate() {
  const dateElement = document.getElementById('tab-calendar-date');
  if (!dateElement) return;

  dateElement.textContent = String(new Date().getDate());
}

document.addEventListener('DOMContentLoaded', function () {
  updateTabCalendarDate();
  observeLiquidSwitches();
  observeLiquidSwitchSizes();
  scheduleLiquidIndicators();
});

window.addEventListener('resize', scheduleLiquidIndicators);

window.addEventListener('orientationchange', function () {
  scheduleLiquidIndicators();
});
  


