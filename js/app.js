import { bus } from './core/bus.js';
import { getWeekStart, toISODate } from './core/dates.js';
import { cssEscape, handleNetworkError, showErrorToast, showToast, syncSheetToKeyboard } from './core/dom.js';
import { compressBgImage, loadBgBlob, loadBgDim, resetBg, saveBgBlob, saveBgDim } from './data/background.js';
import { applyBackup, buildBackup, parseBackup } from './data/backup.js';
import { archiveHistories } from './data/archive.js';
import { loadFast } from './data/fast.js';
import { getOwnerAccount, ownerSignIn, ownerSignOut } from './data/firebase-auth.js';
import { loadHabits } from './data/habits.js';
import { migrateDropTasks } from './data/migrations.js';
import { QAZA_HABIT_ID, QAZA_LOG_KEY, QAZA_STORAGE_KEY, kazaDayFor, loadQaza } from './data/qaza.js';
import { loadPrayer, prayerDateISO } from './data/prayer.js';
import { invalidateRecordsCache } from './data/records.js';
import { loadSchedule, SCHEDULE_TYPES } from './data/schedule.js';
import { STATS_PERIOD_BOXES, saveStatsPeriod } from './data/stats.js';
import { STORAGE_KEYS } from './data/storage.js';
import { SYNC_STATUS_MS, clearSyncPending, syncPending } from './sync/core.js';
import { deniedStatus, flushPendingSync, markCloudReady, scheduleSync, settleHabitsAfterSync, syncFromCloud, syncToCloud } from './sync/sync.js';
import {
  bindAssistantChatLongPress, closeAssistantDeletePopup, closeAssistantKeyModal,
  isAssistantDeletePopupOpen, onAssistantChipClick, onAssistantClear,
  onAssistantFormSubmit, onAssistantImageClear, onAssistantImagePick,
  onAssistantInputInput, onAssistantInputKeydown, onAssistantKeyCancel,
  onAssistantKeySave, onAssistantModelChange, onAssistantPdfClear,
  onAssistantPdfPick, onAssistantPersonaRangeInput, onAssistantSettingsTabClick,
  openAssistantKeyModal, renderAssistantView,
} from './ui/assistant-view.js';
import { fastInitMode, onFastAdd, onFastDone, onFastEdit, onFastInitCancel, onFastInitSave, renderFastView, resetFastForm } from './ui/fast-view.js';
import { closeModal, onFormSubmit, onHabitListClick, onHabitsEditChange, onHabitsEditClick, openModal, renderHabitsEditList, setFormError, updateFormFields } from './ui/habits-edit.js';
import { closeLevelSheet, onLevelPick } from './ui/level-sheet.js';
import { changeWeek, goToday, onTableChange, onTableClick, refreshMainSnapshot, renderDayCards, renderHeader, renderMainView, renderTable, syncMainViewFromData, updateRowCircle } from './ui/main-table.js';
import { onPrayerGeo, onPrayerMadhhabChange, onPrayerManualSave, onPrayerMethodChange, onPrayerRefresh, onPrayerShowAll, renderPrayerSettings, renderPrayerView, resetPrayerShowAll, startPrayerClock } from './ui/prayer-view.js';
import { ensureQazaState, getQazaState, onQazaAddPick, onQazaAddSubmit, onQazaDone, onQazaStartChange, onQazaUndo, qazaCellMarkup, renderQazaView, setQazaState } from './ui/qaza-view.js';
import { applyScreen, SCREENS } from './ui/router.js';
import { onScheduleAddSubmit, onScheduleEditListClick, renderScheduleEditView, renderScheduleView } from './ui/schedule-view.js';
import { flushPendingSleepSave, onSleepFieldChange, renderSleepView } from './ui/sleep-view.js';
import { handleMatrixEscape, handleMatrixNavigation, renderMatrixView } from './ui/matrix-view.js';
import { createNoticeCenter } from './ui/matrix-notices.js';
import { createReminderController } from './core/matrix-reminders.js';
import { loadTasks } from './data/matrix.js';
import { APP_BUILD, APP_VERSION, appState, isMainDayView, isMobileView, ui } from './ui/state.js';
import { closeStatsMenu, isStatsMenuOpen, isStatsView, openStatsMenu, renderStatsCategory, renderStatsFastView, renderStatsHabitView, renderStatsHabitsView, renderStatsQazaView, renderStatsSleepView, renderStatsView, setStatsHabitId } from './ui/stats-view.js';
/* YouPlanner — точка сборки интерфейса (app.js).
   Модульная сборка восстановлена (фазы 3.2–3.4): домены данных — js/data,
   синхронизация — js/sync, вьюхи — js/ui, общие утилиты — js/core.
   Здесь остались главный экран с таблицей, экраны привычек и статистики,
   рендеры уровня приложения, init/bindEvents и проводка шины событий. */
import { bindNavEvents } from './events/nav-events.js';
import { bindSyncDataEvents } from './events/sync-data-events.js';
import { bindScreensEvents } from './events/screens-events.js';

/* --- Статус ручной синхронизации в Настройках ------------------------------ */

let syncStatusTimer = null;
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

/* ---------- Аккаунт владельца в Настройках -------------------------------- */

// Правила базы (database.rules.json) пускают в узел ровно один auth.uid, а
// анонимный uid Firebase выдаёт отдельный для каждого устройства: обмен
// данными работает, только когда все устройства входят в один постоянный
// аккаунт. До входа приложение живёт локально — вход расходник, а не условие
// запуска. UID показывается наружу нарочно: это то, что владелец переносит в
// правила, и второго способа его узнать в этом проекте нет.
export function renderOwnerSettings() {
  const status = document.getElementById('settings-owner-status');
  const email = document.getElementById('settings-owner-email');
  const password = document.getElementById('settings-owner-password');
  const signIn = document.getElementById('settings-owner-signin');
  const signOut = document.getElementById('settings-owner-signout');
  if (!status || !email || !password || !signIn || !signOut) return;
  const account = getOwnerAccount();
  // Под полями входа владельца нет смысла: пароль уже не нужен, а email
  // показан в строке состояния. Скрытые поля ещё и не автозаполнятся чужим
  // аккаунтом при следующем входе на этом устройстве.
  email.hidden = Boolean(account);
  password.hidden = Boolean(account);
  signIn.hidden = Boolean(account);
  signOut.hidden = !account;
  if (account) {
    // UID отдельной строкой: его нужно выделять мышкой и переносить в
    // Console — в середине предложения это неудобно (перенос CSS-свойством
    // white-space: pre-line, см. styles/settings.css)
    status.textContent = 'Владелец: ' + account.email +
      '\nUID: ' + account.uid + ' — его вписывать в database.rules.json';
    return;
  }
  status.textContent = deniedStatus
    ? 'Сервер ответил ' + deniedStatus + ': правила пускают только аккаунт владельца — войдите'
    : 'Анонимный режим: правила базы синхронизацию не пустят, войдите в аккаунт владельца';
}

// Тост про отказ по правам — один раз за сессию. Обмен идёт на каждой правке,
// и повторный тост перекрывал бы интерфейс бесконечно; строка Настроек
// (renderOwnerSettings) остаётся видимой всегда.
let deniedToastShown = false;
// Тост «Сессия истекла, войдите заново» уже показан: syncFromCloud делает
// несколько запросов, и ПОСЛЕ принудительного разлогина каждый из них
// получает свой 401 -> sync:denied затирал бы объяснение общим тостом
// «Синхронизация запрещена». Один раз за сессию — та же семантика, что у
// deniedToastShown ниже.
let authExpiredToastShown = false;

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

// Потолок размера файла копии: файл больше квоты хранилища всё равно не
// применился бы (запись отбилась бы по квоте), а FileReader до разбора
// читал бы его целиком в строку. Проверка по file.size — ДО чтения.
const BACKUP_FILE_MAX_BYTES = 5 * 1024 * 1024;

// Импорт выбранного файла. Пока разбор не удался или пользователь не подтвердил
// замену, текущие данные не трогаются.
export function importData(file) {
  if (!file) return;
  if (file.size > BACKUP_FILE_MAX_BYTES) {
    alert('Файл слишком большой для импорта (лимит — 5 МБ).');
    return;
  }

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

   ES-модуль и точка входа: index.html подключает его через
   <script type="module">, он собирает слои core/data/sync/ui и по
   DOMContentLoaded запускает init() — инициализация состояния, затем
   bindEvents и проводка шины событий.

   Ключевая архитектурная особенность: ячейки таблицы перерисовываются целиком
   (renderTable), поэтому обработчики событий навешиваются ОДИН РАЗ на
   #habits-table и #habit-list — делегирование. Иначе после перерисовки
   слушатели на ячейках терялись бы.
   ========================================================================== */

/* --- Состояние приложения ------------------------------------------------ */
// appState живёт в js/ui/state.js: его читают и мутируют несколько модулей.

// syncSheetToKeyboard переехала в core/dom.js: ею пользуются шторки
// уровня (js/ui/level-sheet.js) и подписка на клавиатуру в bindEvents

export function init() {
  // Межвкладочная страховка: событие storage приходит только из других
  // вкладок, поэтому с write-through в текущей оно не конфликтует.
  window.addEventListener('storage', function (event) {
    if (event.key === null || event.key === STORAGE_KEYS.records) invalidateRecordsCache();
    // Чужая запись qaza-разделов (другая вкладка) обязана попасть в память:
    // иначе следующий локальный saveQaza перезатрёт её LWW-конвертом со
    // свежим временем, и правка другой вкладки потеряется. Порядок тот же,
    // что у sync:applied ниже: сначала состояние (skipSave — чтение не
    // «правка»), затем guarded-перерисовка.
    if (event.key === null || event.key === QAZA_STORAGE_KEY ||
        event.key === QAZA_LOG_KEY) {
      setQazaState(loadQaza(true));
      renderAfterRemoteDataGuarded();
    }
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

  // Напоминания Матрицы стартуют вместе с приложением и работают на любом
  // разделе; без этого пункта план не исполняется никогда (Б5.2).
  initMatrixReminders();

  // Стартовый раздел ставим тем же переключателем, что и кнопки:
  // так главная вкладка сразу подсвечена, а таб-бар скрыт на ПК
  switchAppView('main');

  // Фон приложения из IndexedDB — асинхронно и молча: без записи фон
  // просто отсутствует, ошибка хранилища не должна ронять запуск
  restoreAppBackground().catch(function () { return null; });

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
      // Первый проход архивации (js/data/archive.js): локальные истории
      // старше года срезаются в своды до отправки — наверх уходит уже
      // обрезанная копия. Повторные проходы делает подписчик sync:applied.
      archiveHistories();
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
  bindNavEvents();

  bindSyncDataEvents({ onBgDimChange, onBgDimInput, onBgFilePick, onBgReset });

  bindScreensEvents();
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
  'stats-habits': function () { setStatsHabitId(null); renderStatsHabitsView(); },
  'stats-habit': renderStatsHabitView,
  'stats-fast': renderStatsFastView,
  'stats-sleep': renderStatsSleepView,
  'sleep': renderSleepView,
  'matrix': renderMatrixView,
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

// Предупреждение о битом имени экрана уже выведено (switchAppView)
let warnedUnknownView = false;

export function switchAppView(name) {
  // Неизвестное имя раньше скрывало ВСЕ экраны разом (белый лист): реестр
  // SCREENS такого ключа не знает, и каждый контейнер получал hidden.
  // Битое имя — не повод терять интерфейс: предупреждаем один раз (не спамим
  // в консоль при повторных переходах) и открываем главный экран.
  if (!Object.prototype.hasOwnProperty.call(SCREENS, name)) {
    if (!warnedUnknownView) {
      console.warn('switchAppView: неизвестный экран "' + name + '", открыт главный');
      warnedUnknownView = true;
    }
    name = 'main';
  }

  // Лист создания задачи в Матрице — не расходник переключения вкладок:
  // непустой черновик требует явного «Продолжить редактирование»/«Отбросить»,
  // и переход ждёт ответа. false означает «вопрос уже показан» — остаёмся там,
  // где человек пишет, и ничего не закрываем.
  if (!handleMatrixNavigation(name)) return;

  // Панель статистики принадлежит главной: любой переход её закрывает.
  // Попап уровня — тоже: программный переход (из консоли, теста или будущего
  // кода) без этого оставил бы его висеть поверх нового экрана.
  // Модалка ключа ассистента — третий такой попап: у таб-бара z-index выше,
  // и без закрытия он бы переключал вкладки под открытой модалкой.
  // Модалка привычки — четвёртый: она живёт вне секций экранов (вне #app),
  // поэтому setHidden её не гасит, и без явного закрытия она осталась бы
  // поверх нового раздела.
  closeStatsMenu();
  closeLevelSheet();
  closeAssistantKeyModal();
  // Попап удаления реплики — окно экрана ассистента: программный переход
  // без этого оставил бы его висеть поверх нового раздела
  closeAssistantDeletePopup();
  closeModal();

  // Вход в раздел запоминает, откуда вошли, — туда «Назад» из хаба и вернёт
  if (isStatsView(name) && !isStatsView(currentView)) statsReturnView = currentView;

  // То же для «Цикла сна»: у экрана два входа — строка в Настройках и пункт
  // гамбургера, — и «Назад» должен вернуть в тот, откуда вошли
  if (name === 'sleep' && currentView !== 'sleep') sleepReturnView = currentView;

  applyScreen(name, currentView);
  const render = ROUTE_RENDER[name];
  if (render) render();
  // Экран показал текущие данные — гвард sync:applied сравнивает следующие
  // сверки с тем, что на самом деле видно, а не с устаревшей сигнатурой
  noteViewRendered(name);

  window.scrollTo(0, 0);
  currentView = name;

  // Обновить каплю-индикаторы всех переключателей через общий планировщик
  scheduleLiquidIndicators();
}

// Строка версии в Настройках
export function renderSettingsView() {
  const version = document.getElementById('settings-version');
  if (version) version.textContent = 'Версия: ' + APP_VERSION + ' · сборка ' + APP_BUILD;
  renderBackgroundSettings();
  renderOwnerSettings();
}

/* ---------- Фон приложения ------------------------------------------------ */

// Живой objectURL текущего фона: при замене/сбросе старый отзывается,
// иначе blob висит в памяти до перезагрузки страницы
let bgObjectUrl = null;
// Blob последней установки — превью в Настройках показывает его же,
// без второго чтения IDB
let bgCurrentBlob = null;

// Применить фон к странице: URL картинки и плотность скрима — переменные
// на :root, видимость слоёв — классом body.has-app-bg (без фона скрим
// не должен затемнять обычный белый фон)
function applyBackgroundToPage(url, dim) {
  const root = document.documentElement;
  root.style.setProperty('--app-bg-image', url ? 'url("' + url + '")' : 'none');
  root.style.setProperty('--bg-scrim-opacity', String(Math.round(dim) / 100));
  document.body.classList.toggle('has-app-bg', Boolean(url));
}

// Восстановление при старте: Blob из IndexedDB → objectURL → переменные.
// Без IDB (песочница тестов) и без записи фон просто отсутствует
async function restoreAppBackground() {
  const blob = await loadBgBlob();
  if (!blob) return;
  bgCurrentBlob = blob;
  bgObjectUrl = URL.createObjectURL(blob);
  applyBackgroundToPage(bgObjectUrl, loadBgDim());
}

// Панель «Фон приложения» в Настройках: статус, миниатюра, слайдер, сброс
function renderBackgroundSettings() {
  const status = document.getElementById('settings-bg-status');
  const preview = document.getElementById('settings-bg-preview');
  const reset = document.getElementById('settings-bg-reset');
  const dim = document.getElementById('settings-bg-dim');
  const dimValue = document.getElementById('settings-bg-dim-value');
  if (!status || !dim || !dimValue) return;
  const has = Boolean(bgCurrentBlob);
  if (status) {
    status.textContent = has
      ? 'Фото установлено · ' + Math.round(bgCurrentBlob.size / 1024) + ' КБ'
      : 'Фото не установлено';
  }
  if (preview) {
    preview.hidden = !has;
    if (has) preview.src = bgObjectUrl || '';
  }
  if (reset) reset.hidden = !has;
  dim.value = String(loadBgDim());
  dimValue.textContent = dim.value + '%';
}

// Выбор файла: сжать под экран, положить в IDB, применить. Затемнение
// сбрасывается на авто-уровень для нового фото (по его яркости)
async function onBgFilePick() {
  const input = document.getElementById('settings-bg-file');
  const file = input && input.files && input.files[0];
  if (input) input.value = '';   // повторный выбор того же файла снова сработает
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) {
    showToast('Это не изображение — выберите фото');
    return;
  }
  let packed;
  try {
    packed = await compressBgImage(file);
  } catch (e) {
    showToast('Не удалось обработать фото: ' + (e && e.message ? e.message : 'ошибка'));
    return;
  }
  const saved = await saveBgBlob(packed.blob);
  if (!saved) {
    showToast('Браузер не дал сохранить фон: память недоступна');
    return;
  }
  saveBgDim(packed.dim);
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  bgCurrentBlob = packed.blob;
  bgObjectUrl = URL.createObjectURL(packed.blob);
  applyBackgroundToPage(bgObjectUrl, packed.dim);
  renderBackgroundSettings();
  showToast('Фон установлен · ' + Math.round(packed.blob.size / 1024) + ' КБ');
}

// Ползунок затемнения: живая перестановка переменной, сохранение — на change
function onBgDimInput() {
  const dim = document.getElementById('settings-bg-dim');
  const dimValue = document.getElementById('settings-bg-dim-value');
  if (!dim) return;
  if (dimValue) dimValue.textContent = dim.value + '%';
  applyBackgroundToPage(bgObjectUrl, Number(dim.value));
}

function onBgDimChange() {
  const dim = document.getElementById('settings-bg-dim');
  if (!dim) return;
  saveBgDim(Number(dim.value));
}

// Сброс: убрать картинку из IDB и настройку затемнения из localStorage,
// погасить слои. С подтверждением — действие мгновенное и необратимое
async function onBgReset() {
  if (!confirm('Убрать фото фона?')) return;
  await resetBg();
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  bgObjectUrl = null;
  bgCurrentBlob = null;
  applyBackgroundToPage(null, 100);
  renderBackgroundSettings();
  showToast('Фон сброшен');
}

// Выбранный период живёт на устройстве, а не в данных человека: как ui.mainView,
// это отметка последнего просмотра, а не запись. Категория у каждой своя,
// поэтому общей переменной нет — её читает loadStatsPeriod(category)

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

  // Ячейки каза переписаны мимо renderTable — снимок главного экрана
  // должен узнать новые значения, иначе следующий sync:applied примет
  // эти счетчики за неприменённый дифф и перепишет их вслепую
  refreshMainSnapshot();
}

/* --- Напоминания Матрицы (ТЗ Б5) ------------------------------------------
   Раздел живёт на устройстве и не синхронизируется, поэтому напоминания
   локальные: ни push, ни Notification API, ни сети. Контроллер решает «когда»,
   центр уведомлений — «как он выглядит и чем закрывается».

   Создаётся ОДИН раз при старте и работает на любом разделе: человек может
   смотреть намаз, а напоминание назовёт себя вслух (Б5.2). Повторная
   перерисовка экрана его не перезапускает (Б5.7). */

let matrixNotices = null;
let matrixReminders = null;

function initMatrixReminders() {
  if (matrixReminders) return matrixReminders;
  matrixNotices = createNoticeCenter({
    // «Открыть» ведёт в Матрицу — тот же переключатель, что и у таб-бара:
    // уведомление не имеет права само строить навигацию.
    onOpen: function () { switchAppView('matrix'); },
  });
  matrixReminders = createReminderController({
    load: loadTasks,
    isHidden: function () { return document.visibilityState === 'hidden'; },
    display: function (entry) {
      matrixNotices.show({
        // Ключ карточки = задача + правило + момент: то же напоминание дважды
        // над экраном не появляется, разные правила остаются разными строками.
        id: entry.taskId + '|' + entry.reminderId + '|' + entry.time,
        title: entry.title,
        at: entry.at,
      });
    },
    warn: function (message) { showToast(message); },
    storage: localStorage,
    lock: (typeof navigator !== 'undefined' && navigator.locks) ? navigator.locks : null,
    // Обёртки, а не голые ссылки: setInterval, вызванный как метод чужого
    // объекта, в браузере падает с «Illegal invocation» — receiver должен
    // остаться глобой.
    timers: {
      setInterval: function (fn, ms) { return setInterval(fn, ms); },
      clearInterval: function (id) { clearInterval(id); },
    },
    addListener: function (target, type, handler) {
      const host = target === 'document' ? document : window;
      host.addEventListener(type, handler);
      return function () { host.removeEventListener(type, handler); };
    },
  });
  matrixReminders.start();
  return matrixReminders;
}

/* --- Проводка слоёв через шину событий -------------------------------------
   Единственное место, где слои слышат друг друга: данные эмитят правку,
   синхронизация — применённый снимок, хранилище — ошибку записи. Прямых
   вызовов между слоями нет, поэтому при переходе на ES-модули (Фаза 3.2)
   граф импортов останется однонаправленным. */

bus.on('data:changed', scheduleSync);
// Сеть вернулась — недоезжавшие правки уходят сразу, не ждут следующей
// правки или дебаунса: pending-разделы копились, пока соединение лежало.
// Тоста «офлайн» нет и при потере сети: офлайн-first режим осознанный,
// приложение работает на локальных данных, и возвращение связи — тихий
// фон, а не событие для человека.
window.addEventListener('online', function () { scheduleSync(); });
// Правка матрицы пересобирает очередь напоминаний: снятое «выполнено»,
// архивация или новое время обязаны отменить прежний pending-момент (Б5.7).
// Своё событие вместо data:changed — раздел не синхронизируется, и поднимать
// облачный обмен из-за него нельзя.
bus.on('matrix:changed', function () {
  if (matrixReminders) matrixReminders.refresh();
});
// Изменение очереди каза (было телом afterQazaChange): вкладку перерисовывает
// сам модуль, а ячейки таблицы и круг строки h6 — этот подписчик
bus.on('qaza:changed', function () {
  updateQazaCells();
  updateRowCircle(QAZA_HABIT_ID);
});
/* --- Гвард перерисовки после чужих данных -----------------------------------
   sync:applied прилетает на каждую сверку с Firebase, и чаще всего — на
   «ничего нового»: версии совпали, диффы пусты. Полная перерисовка видимого
   экрана на таких сверках — чистый расход: на телефоне это микро-лаги и
   потеря скролла при каждом периодическом обмене. Поэтому проводка двухуровневая:

   Уровень 1 — сигнатура данных. Для каждого экрана ниже хранится дешёвый
   снимок того, от чего зависит его отрисовка; не изменился — перерисовки нет.
   Главный экран ведёт полный снимок видимых ячеек и умеет уровень 2:
   точечный дифф ячеек и кругов (syncMainViewFromData в main-table.js).

   Броня — общая для обоих уровней: любое исключение из сравнения или диффа
   откатывает экран к полному рендеру. Экран обязан быть целым, дифф обязан
   лишь экономить работу. */

// Сигнатуры данных экранов на момент последней отрисовки. null — экран ещё
// не рисовался через эту проводку: сигнатуры снимаются в switchAppView
// (noteViewRendered) и после полного рендера в гварде.
const VIEW_SIGNATURES = {
  qaza: null,
  prayer: null,
  fast: null,
  schedule: null,
};

// Экран каза зависит от очереди: курсор (список «сейчас»), остатки (сумма,
// строки), дата последней записи (кнопка «Отменить» жива только сегодня) и
// сам день каза — в полночь план перестраивается при тех же данных.
function qazaViewSignature() {
  const qaza = getQazaState();
  if (!qaza) return null;
  const history = qaza.history;
  const lastDate = history.length > 0 ? history[history.length - 1].date : null;
  return JSON.stringify([qaza.cursor, qaza.remaining, lastDate, kazaDayFor(new Date())]);
}

// Экран молитв зависит только от раздела координат. День в сигнатуре — на
// случай полуночи между сверками: времена нового дня не должны рисоваться
// только по минутному таймеру
function prayerViewSignature() {
  return JSON.stringify([loadPrayer() || null, prayerDateISO(new Date())]);
}

// Экран уразы — раздел счётчика плюс открытая форма: заголовок и видимость
// блоков зависят от fastInitMode, а он к данным не сводится
function fastViewSignature() {
  return JSON.stringify([loadFast() || null, fastInitMode]);
}

// Экран расписания — раздел целиком (списки короткие) и выбранный тип дня
function scheduleViewSignature() {
  return JSON.stringify([loadSchedule(), ui.scheduleType]);
}

function viewSignature(view) {
  switch (view) {
    case 'qaza': return qazaViewSignature();
    case 'prayer': return prayerViewSignature();
    case 'fast': return fastViewSignature();
    case 'schedule': return scheduleViewSignature();
  }
  return null;
}

// Экран только что отрисован — его сигнатура теперь равна текущим данным.
// Вызывается из switchAppView (вход на экран) и из гварда ниже (полный
// рендер после реально изменившихся данных). Сбой снимка не критичен:
// следующий sync:applied просто снова даст полный рендер.
function noteViewRendered(view) {
  if (view === 'main') {
    // Снимок главного экрана ставится самим renderTable/renderDayCards;
    // здесь только страховка на случай их раннего возврата
    refreshMainSnapshot();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(VIEW_SIGNATURES, view)) {
    VIEW_SIGNATURES[view] = viewSignature(view);
  }
}

// Точечная перерисовка после чужих данных (аудит 2026-10-31): раньше синк
// на каждое применение перерисовывал все вкладки, включая скрытые. Теперь
// перерисовывается только видимый экран: скрытые собираются заново при входе
// через ROUTE_RENDER, как уже живут статистика и сон. Перерисовка — только
// экранов, чьи данные реально приезжают в снимке; schedule-edit и stats
// остаются ленивыми, как и были.
function renderAfterRemoteData() {
  switch (currentView) {
    case 'main': renderMainView(); return;
    case 'qaza': renderQazaView(); return;
    case 'prayer': renderPrayerView(); return;
    case 'fast': renderFastView(); return;
    case 'schedule': renderScheduleView(); return;
  }
}

// Гвард: true — видимый экран уже актуален (сигнатура совпала или точечный
// дифф главного экрана наложен), false — нужен полный рендер.
function applyRemoteDataToVisibleView() {
  const view = currentView;

  if (view === 'main') {
    // Главный экран — единственный с уровнем 2: дифф сам решает, пропускать
    // ли перерисовку, и бросает исключение, если точечный путь не удался
    return syncMainViewFromData();
  }
  if (!Object.prototype.hasOwnProperty.call(VIEW_SIGNATURES, view)) {
    return false;  // экраны вне гварда (stats, settings, ...) — как раньше
  }
  const sig = viewSignature(view);
  if (sig !== null && sig === VIEW_SIGNATURES[view]) {
    return true;  // уровень 1: данные экрана не менялись
  }
  return false;
}

function renderAfterRemoteDataGuarded() {
  let handled = false;
  try {
    handled = applyRemoteDataToVisibleView();
  } catch (e) {
    // Броня: дифф не обязан быть безошибочным, экран обязан быть целым.
    // Полный рендер ниже пересобирает видимое с нуля
    console.error('[sync-render] точечное обновление экрана «' + currentView + '» не удалось, полный рендер:', e);
    handled = false;
  }
  if (!handled) {
    renderAfterRemoteData();
    // Рендер показал текущие данные — фиксируем снимок/сигнатуру, чтобы
    // следующая «пустая» сверка прошла мимо перерисовки. Храним сигнатуру
    // только ПОСЛЕ успешного рендера: упавший рендер не должен оставлять
    // снимок, по которому следующий sync:applied пропустит перерисовку
    try {
      noteViewRendered(currentView);
    } catch (e) { /* снимок — оптимизация, а не корректность */ }
  }
}

bus.on('data:replaced', function () {
  appState.habits = loadHabits();
  setQazaState(loadQaza(true));
  // Файл копии мог привезти полные истории: срезаем старше года
  archiveHistories();
  // Импорт и очистка меняют набор задач под ногами: висящие над экраном
  // напоминания про уже не существующие права человек прочитал бы как
  // актуальные, поэтому очередь снимается, а контроллер пересобирается.
  if (matrixNotices) matrixNotices.clear();
  if (matrixReminders) matrixReminders.refresh();
  renderAfterRemoteDataGuarded();
});
bus.on('sync:applied', function () {
  // сначала состояние (его раньше обновлял сам слой синхронизации),
  // затем архивация принесённых снимком историй и перерисовка —
  // экраны читают appState и qazaState
  appState.habits = loadHabits();
  setQazaState(loadQaza(true));
  archiveHistories();
  renderAfterRemoteDataGuarded();
});
bus.on('storage:error', function () {
  showToast('Не удалось сохранить: хранилище переполнено');
});
bus.on('sync:denied', function (payload) {
  // Отказ по правам (правила по auth.uid) молчит в данных — приложение
  // продолжает работать локально, и без этой надписи человек искал бы сетевую
  // ошибку там, где её нет. Строка Настроек обновляется всегда, тост — один
  // раз за сессию (deniedToastShown выше).
  renderOwnerSettings();
  if (authExpiredToastShown) {
    // Принудительный разлогин уже объяснён тостом «Сессия истекла»: хвост
    // 401 от запросов того же раунда синка не должен затирать его общим
    // «Синхронизация запрещена».
    return;
  }
  if (!deniedToastShown) {
    deniedToastShown = true;
    showToast('Синхронизация запрещена правилами: нужен вход владельца' +
      ((payload && payload.status) ? ' (код ' + payload.status + ')' : ''));
  }
});
bus.on('sync:auth-expired', function () {
  // Чистый разлогин (refresh-токен мёртв, отказ обмена 4xx): хранилище уже
  // стёрто firebase-auth.js, и без этой строки человек узнал бы о выходе
  // только по пропавшей синхронизации — тост объясняет причину и что делать,
  // Настройки перерисовываются без email/UID мёртвой сессии.
  authExpiredToastShown = true;
  renderOwnerSettings();
  showErrorToast('Сессия истекла, войдите заново');
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
// #assistant-settings-switch — табы модалки «Настройки ассистента»: капля
// живёт в display:none-модалке, поэтому applyAssistantSettingsTab в
// assistant-view.js специально переставляет классы через remove+add —
// мутация по наблюдателю (observeLiquidSwitches ниже) пересчитывает позицию
// уже после открытия модалки.
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
  '#stats-sleep-period',
  '#assistant-settings-switch'
];

// Делегат для клика: кнопка — прямой ребёнок переключателя, ровно как в
// moveIndicator (`:scope > button.is-active`). Суффикс навешивается на
// каждый селектор: `SELECTORS.join(', ') + ' > button'` дал бы «> button»
// только последнему элементу списка, и closest() начал бы находить сам
// контейнер — пересчёт капли стартовал бы от клика по любой точке контейнера.
export const LIQUID_SWITCH_BUTTON_SELECTOR = LIQUID_SWITCH_SELECTORS
  .map(function (selector) {
    return selector + ' > button';
  })
  .join(', ');

// Геометрия «капли» таб-бара и общего индикатора переключателей — подобрана
// под стили; менять только вместе с css. Таб-бар: капля-пилюля с собственными
// габаритами; остальные переключатели: индикатор на всю кнопку с отступами.
const TAB_PILL_MAX_WIDTH_PX = 60;
const TAB_PILL_WIDTH_INSET_PX = 12;
const TAB_PILL_HEIGHT_PX = '36px';
const TAB_PILL_TOP_PX = '14px';
const INDICATOR_INSET_PX = 8;
const INDICATOR_TOP_PX = 4;

function moveIndicator(container) {
  if (!container || container.hidden) return;

  const indicator = container.querySelector(':scope > .glass-indicator');
  const button = container.querySelector(':scope > button.is-active');

  if (!indicator || !button) return;
  if (button.offsetWidth <= 0 || button.offsetHeight <= 0) return;

  const containerRect = container.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();

  if (containerRect.width <= 0 || containerRect.height <= 0) return;

  if (container.id === 'tab-bar') {
    const pillWidth = Math.max(0,
      Math.min(TAB_PILL_MAX_WIDTH_PX, buttonRect.width - TAB_PILL_WIDTH_INSET_PX));

    const relativeLeft =
      (buttonRect.left - containerRect.left) +
      (buttonRect.width - pillWidth) / 2;

    const maxLeft = Math.max(0, containerRect.width - pillWidth);
    const clampedLeft = Math.max(0, Math.min(relativeLeft, maxLeft));

    indicator.style.width = pillWidth + 'px';
    indicator.style.height = TAB_PILL_HEIGHT_PX;
    indicator.style.top = TAB_PILL_TOP_PX;
    indicator.style.transform =
      'translate3d(' + clampedLeft + 'px, 0, 0)';
  } else {
    const rawLeft = buttonRect.left - containerRect.left;
    const maxWidth = Math.max(0, containerRect.width - Math.max(0, rawLeft));
    const buttonWidth = Math.max(0, Math.min(buttonRect.width, maxWidth));

    indicator.style.width = buttonWidth + 'px';
    indicator.style.height = 'calc(100% - ' + INDICATOR_INSET_PX + 'px)';
    indicator.style.top = INDICATOR_TOP_PX + 'px';
    indicator.style.transform =
      'translate3d(' + Math.max(0, rawLeft) + 'px, 0, 0)';
  }
}

export function getLiquidSwitchContainers() {
  return LIQUID_SWITCH_SELECTORS
    .map(function (selector) {
      return document.querySelector(selector);
    })
    .filter(Boolean);
}

export function moveAllIndicators() {
  getLiquidSwitchContainers().forEach(function (container) {
    moveIndicator(container);
  });
}

let liquidIndicatorFrame = 0;

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
  const button = event.target.closest(LIQUID_SWITCH_BUTTON_SELECTOR);

  if (!button) return;

  requestAnimationFrame(function () {
    requestAnimationFrame(scheduleLiquidIndicators);
  });
});

// Наблюдатель следит за class/hidden; style не наблюдаем, чтобы собственные
// изменения индикатора не зацикливали пересчёт.
const liquidObserver = new MutationObserver(function () {
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

let liquidResizeObserver = null;

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

// Число на иконке календаря в нижнем таб-баре фиксировано: владелец решил
// всегда показывать 27 вместо текущего дня месяца (решение от 2026-11-01).
// Это не забытый баг — вернуться к динамической дате можно, заменив
// строку ниже на String(new Date().getDate()).
export function updateTabCalendarDate() {
  const dateElement = document.getElementById('tab-calendar-date');
  if (!dateElement) return;

  dateElement.textContent = '27';
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
  

