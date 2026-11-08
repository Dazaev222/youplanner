// Обработчики навигации и статистики (вынесено из bindEvents() в js/app.js).
// Таблица и список привычек, навигация настроек/молитв, хаб статистики,
// периоды, экран правки привычек и нижний таб-бар. switchAppView,
// statsReturnView и sleepReturnView объявлены в app.js и импортируются
// напрямую: это live-значения модульных let, import даёт актуальное
// значение в момент обращения.
import { onTableChange, onTableClick } from '../ui/main-table.js';
import { openModal, onHabitListClick, onHabitsEditClick, onHabitsEditChange } from '../ui/habits-edit.js';
import { onPrayerGeo, onPrayerMadhhabChange, onPrayerManualSave, onPrayerMethodChange, onPrayerRefresh, onPrayerShowAll } from '../ui/prayer-view.js';
import { flushPendingSleepSave, onSleepFieldChange } from '../ui/sleep-view.js';
import { closeStatsMenu, openStatsMenu, renderStatsCategory, setStatsHabitId } from '../ui/stats-view.js';
import { STATS_PERIOD_BOXES, saveStatsPeriod } from '../data/stats.js';
import { switchAppView, statsReturnView, sleepReturnView } from '../app.js';

export function bindNavEvents() {

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
      if (item.hasAttribute('data-matrix-view')) {
        closeStatsMenu();
        switchAppView('matrix');
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
  // поля. Слушаются оба события — колесо времени на телефоне присылает только
  // change. Возврат выполняет отложенную запись сна сразу: экран закрывается,
  // и последний ввод не должен потеряться
  const sleepBack = document.getElementById('sleep-back');
  if (sleepBack) sleepBack.addEventListener('click', function () {
    flushPendingSleepSave();
    switchAppView(sleepReturnView);
  });

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

  const statsRowMatrix = document.getElementById('stats-row-matrix');
  if (statsRowMatrix) {
    statsRowMatrix.addEventListener('click', function () { switchAppView('matrix'); });
  }

  // Матрица: «Назад» перерисовывается вместе с экраном, поэтому ловится
  // делегированием на статичной секции — слушатель навешивается один раз
  const matrixView = document.getElementById('matrix-view');
  if (matrixView) {
    matrixView.addEventListener('click', function (event) {
      if (event.target.closest('#matrix-back')) switchAppView('main');
    });
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

  // Нижний таб-бар: тот же переключатель разделов, что и у кнопок шапки
  const tabItems = document.querySelectorAll('#tab-bar .tab-item');
  for (let i = 0; i < tabItems.length; i++) {
    tabItems[i].addEventListener('click', function () {
      switchAppView(this.getAttribute('data-view'));
    });
  }
}
