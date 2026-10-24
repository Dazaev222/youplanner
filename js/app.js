import { bus } from './core/bus.js';
import { getWeekStart, toISODate } from './core/dates.js';
import { cssEscape, showToast, syncSheetToKeyboard } from './core/dom.js';
import { applyBackup, buildBackup, parseBackup } from './data/backup.js';
import { loadHabits } from './data/habits.js';
import { migrateDropTasks } from './data/migrations.js';
import { QAZA_HABIT_ID, loadQaza } from './data/qaza.js';
import { invalidateRecordsCache } from './data/records.js';
import { SCHEDULE_TYPES } from './data/schedule.js';
import { STATS_PERIOD_BOXES, saveStatsPeriod } from './data/stats.js';
import { STORAGE_KEYS } from './data/storage.js';
import { SYNC_STATUS_MS } from './data/sync.js';
import { APP_BUILD, APP_VERSION } from './data/ui.js';
import { clearSyncPending, syncPending } from './sync/state.js';
import { flushPendingSync, markCloudReady, scheduleSync, settleHabitsAfterSync, syncFromCloud, syncToCloud } from './sync/sync.js';
import { onFastAdd, onFastDone, onFastEdit, onFastInitCancel, onFastInitSave, renderFastView, resetFastForm } from './ui/fast-view.js';
import {
  closeAssistantKeyModal, onAssistantChipClick, onAssistantClear,
  onAssistantFormSubmit, onAssistantKeyCancel, onAssistantKeyKeydown,
  onAssistantKeySave, openAssistantKeyModal, renderAssistantView,
} from './ui/assistant-view.js';
import { closeModal, onFormSubmit, onHabitListClick, onHabitsEditChange, onHabitsEditClick, openModal, renderHabitsEditList, setFormError, updateFormFields } from './ui/habits-edit.js';
import { closeLevelSheet, onLevelPick } from './ui/level-sheet.js';
import { changeWeek, goToday, onTableChange, onTableClick, renderDayCards, renderHeader, renderMainView, renderTable, updateRowCircle } from './ui/main-table.js';
import { onPrayerGeo, onPrayerMadhhabChange, onPrayerManualSave, onPrayerMethodChange, onPrayerRefresh, onPrayerShowAll, renderPrayerSettings, renderPrayerView, resetPrayerShowAll, startPrayerClock } from './ui/prayer-view.js';
import { ensureQazaState, onQazaAddPick, onQazaAddSubmit, onQazaDone, onQazaStartChange, onQazaUndo, qazaCellMarkup, renderQazaView, setQazaState } from './ui/qaza-view.js';
import { applyScreen } from './ui/router.js';
import { onScheduleAddSubmit, onScheduleEditListClick, renderScheduleEditView, renderScheduleView } from './ui/schedule-view.js';
import { onSleepFieldChange, renderSleepView } from './ui/sleep-view.js';
import { appState, isMainDayView, isMobileView, ui } from './ui/state.js';
import { closeStatsMenu, isStatsMenuOpen, isStatsView, openStatsMenu, renderStatsCategory, renderStatsFastView, renderStatsHabitView, renderStatsHabitsView, renderStatsQazaView, renderStatsSleepView, renderStatsView, setStatsHabitId } from './ui/stats-view.js';
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

/* --- Константы ----------------------------------------------------------- */

/* --- Вспомогательные функции (не пересекаются с именами data.js) --------- */

// syncSheetToKeyboard переехала в core/dom.js: ею пользуются шторки
// уровня (js/ui/level-sheet.js) и подписка на клавиатуру в bindEvents

/* --- Разметка (строки, чтобы собрать таблицу одним присвоением) ---------- */







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
      setStatsHabitId(row.getAttribute('data-habit-id'));
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

  // Вкладка «ИИ-Ассистент»: входы — кнопка шапки на ПК и таб-бар на телефоне,
  // выход — «← Назад». Модалка ключа открывается шестерёнкой и сама, когда
  // вопрос задан без ключа
  const assistantButton = document.getElementById('assistant-btn');
  if (assistantButton) assistantButton.addEventListener('click', function () { switchAppView('assistant'); });

  const assistantBack = document.getElementById('assistant-back');
  if (assistantBack) assistantBack.addEventListener('click', function () { switchAppView('main'); });

  const assistantSettings = document.getElementById('assistant-settings');
  if (assistantSettings) assistantSettings.addEventListener('click', openAssistantKeyModal);

  const assistantClear = document.getElementById('assistant-clear');
  if (assistantClear) assistantClear.addEventListener('click', onAssistantClear);

  const assistantForm = document.getElementById('assistant-form');
  if (assistantForm) assistantForm.addEventListener('submit', onAssistantFormSubmit);

  const assistantChips = document.getElementById('assistant-chips');
  if (assistantChips) assistantChips.addEventListener('click', onAssistantChipClick);

  const assistantKeySave = document.getElementById('assistant-key-save');
  if (assistantKeySave) assistantKeySave.addEventListener('click', onAssistantKeySave);

  const assistantKeyCancel = document.getElementById('assistant-key-cancel');
  if (assistantKeyCancel) assistantKeyCancel.addEventListener('click', onAssistantKeyCancel);

  const assistantKeyClose = document.getElementById('assistant-key-close');
  if (assistantKeyClose) assistantKeyClose.addEventListener('click', closeAssistantKeyModal);

  const assistantKeyBackdrop = document.querySelector('.modal-backdrop[data-assistant-key-close]');
  if (assistantKeyBackdrop) assistantKeyBackdrop.addEventListener('click', closeAssistantKeyModal);

  // Escape закрывает модалку ключа — тот же жест, что крестик и фон
  document.addEventListener('keydown', onAssistantKeyKeydown);

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
      ui.mobileDayPage = 0;
      renderTable();
    });
  }

  const dayTabSecond = document.getElementById('day-tab-2');
  if (dayTabSecond) {
    dayTabSecond.addEventListener('click', function () {
      ui.mobileDayPage = 1;
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


/* --- Мобильная вёрстка --------------------------------------------------- */




/* --- Режим «День» -------------------------------------------------------- */




/* --- Делегированные обработчики таблицы ---------------------------------- */







/* --- Изменение значения ячейки ------------------------------------------- */



/* --- Навигация по неделям ------------------------------------------------ */




/* --- Редактор расписания (Настройки → Редактировать расписание) ------------ */




/* --- Попап уровня выполнения (§1.3) --------------------------------------- */






/* --- Вкладка «Каза-намазы» ----------------------------------------------- */








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
  'stats-habits': function () { setStatsHabitId(null); renderStatsHabitsView(); },
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
  // Ассистенту на входе нужно только обновить подпись про ключ
  'assistant': renderAssistantView,
};

export function switchAppView(name) {
  // Панель статистики принадлежит главной: любой переход её закрывает.
  // Попап уровня — тоже: программный переход (из консоли, теста или будущего
  // кода) без этого оставил бы его висеть поверх нового экрана.
  // Модалка ключа ассистента — третий такой попап: у таб-бара z-index выше,
  // и без закрытия он бы переключал вкладки под открытой модалкой.
  closeStatsMenu();
  closeLevelSheet();
  closeAssistantKeyModal();

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


// Выбранный период живёт на устройстве, а не в данных человека: как ui.mainView,
// это отметка последнего просмотра, а не запись. Категория у каждой своя,
// поэтому общей переменной нет — её читает loadStatsPeriod(category)
















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





/* --- Экран «Привычки» (настройки, телефон) ------------------------------- */







/* --- Форма добавления привычки ------------------------------------------- */





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
  





