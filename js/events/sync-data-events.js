/* sync-data-events.js — обработчики «данные и синк» из bindEvents().
   Вынесено из js/app.js без изменения логики и комментариев: ручная
   синхронизация, аккаунт владельца, экспорт/импорт, фон приложения, неделя,
   форма привычки, переключатель «День/Неделя», карточки дня, табы половин
   недели и resize. Идентификаторы, объявленные и экспортированные в app.js
   (showSyncStatus, renderOwnerSettings, exportData, importData), импортируются
   напрямую; неэкспортированные обработчики фона onBg* приходят через ctx. */

import { handleNetworkError, showErrorToast } from '../core/dom.js';
import { ownerSignIn, ownerSignOut } from '../data/firebase-auth.js';
import { loadHabits } from '../data/habits.js';
import { deniedStatus, settleHabitsAfterSync, syncFromCloud, syncToCloud } from '../sync/sync.js';
import { onFormSubmit, setFormError, updateFormFields } from '../ui/habits-edit.js';
import { changeWeek, goToday, onTableChange, onTableClick, renderMainView, renderTable } from '../ui/main-table.js';
import { appState, isMobileView, ui } from '../ui/state.js';
import { exportData, importData, renderOwnerSettings, showSyncStatus } from '../app.js';

export function bindSyncDataEvents(ctx) {
  const { onBgDimChange, onBgDimInput, onBgFilePick, onBgReset } = ctx;

  // Ручная синхронизация из настроек. Итог у неё тот же, что у первой:
  // пустой сервер засевает дефолты — иначе пустая таблица осталась бы и без
  // данных, и без пометки. Отправку ставит сама запись (§11t).
  // На время обмена кнопка гаснет: повторный клик до ответа сервера мигал
  // бы статусом и плодил параллельные запросы (очередь syncExchange их
  // сериализует, но лишний UI-шум убирает она не полностью). Возврат —
  // в finally, при любом исходе обещания.
  const syncNow = document.getElementById('settings-sync-now');
  if (syncNow) {
    syncNow.addEventListener('click', function () {
      syncNow.disabled = true;
      syncFromCloud().then(function (result) {
        settleHabitsAfterSync(result);
        appState.habits = loadHabits();
        renderMainView();
        if (!result.reachable) {
          // «Обновлено» здесь было бы неправдой — но и «нет связи» тоже:
          // 401/403 значит «нас сюда не пускают», и искать сеть в этом случае
          // бесполезно. Различает их последний статус отказа (js/sync/sync.js).
          if (deniedStatus) {
            showSyncStatus('Доступ запрещён (' + deniedStatus + '): нужен вход владельца');
            renderOwnerSettings();
            return;
          }
          handleNetworkError(null, { context: '[sync]', display: showSyncStatus });
          return;
        }
        showSyncStatus('Обновлено');
      }).finally(function () {
        syncNow.disabled = false;
      });
    });
  }
  // Ручная отправка. syncToCloud разрешается Response при успешном PUT и
  // undefined при сетевом сбое: «Отправлено» без ответа сервера — ложь,
  // поэтому сбой виден как error-тост, а не как ложная удача
  const syncPush = document.getElementById('settings-sync-push');
  if (syncPush) {
    syncPush.addEventListener('click', function () {
      syncPush.disabled = true;
      syncToCloud().then(function (result) {
        if (result && result.ok) {
          showSyncStatus('Отправлено');
          return;
        }
        if (deniedStatus) {
          showSyncStatus('Не отправлено: доступ запрещён (' + deniedStatus +
            '), нужен вход владельца');
          renderOwnerSettings();
          return;
        }
        showErrorToast('Не отправлено: нет связи с сервером');
      }).finally(function () {
        syncPush.disabled = false;
      });
    });
  }

  // Вход в постоянный аккаунт владельца. uid из ответа показывается в строке
  // состояния: именно его владелец переносит в database.rules.json.
  const ownerSignInBtn = document.getElementById('settings-owner-signin');
  if (ownerSignInBtn) {
    ownerSignInBtn.addEventListener('click', function () {
      const email = document.getElementById('settings-owner-email');
      const password = document.getElementById('settings-owner-password');
      ownerSignInBtn.disabled = true;
      // Пароль передаётся один раз и сразу стирается из поля: в памяти
      // страницы он живёт до перезаписи, в localStorage не попадает вовсе
      // (js/data/firebase-auth.js), а поле с набранным паролем осталось бы
      // видимым даже после успешного входа.
      ownerSignIn(String(email && email.value || ''), String(password && password.value || ''))
        .then(function (account) {
          if (password) password.value = '';
          renderOwnerSettings();
          showSyncStatus('Вход выполнен. UID: ' + account.uid);
        })
        .catch(function (e) {
          // Причина — со стены Firebase (INVALID_PASSWORD, EMAIL_NOT_FOUND):
          // её и показываем, свой текст ничего бы не объяснил. Пароль в текст
          // ошибки не попадает — там только message сервера.
          if (password) password.value = '';
          showErrorToast('Вход не удался: ' + ((e && e.message) || e));
          renderOwnerSettings();
        })
        .finally(function () {
          ownerSignInBtn.disabled = false;
        });
    });
  }

  const ownerSignOutBtn = document.getElementById('settings-owner-signout');
  if (ownerSignOutBtn) {
    ownerSignOutBtn.addEventListener('click', function () {
      ownerSignOut();
      renderOwnerSettings();
      showSyncStatus('Вы вышли: приложение работает локально, без токена');
    });
  }

  // Экспорт и импорт данных
  const exportButton = document.getElementById('settings-export');
  if (exportButton) exportButton.addEventListener('click', exportData);

  // Фон приложения: выбор файла, живой ползунок затемнения (сохранение на
  // change — на input только переставляем переменную), сброс с подтверждением
  const bgFile = document.getElementById('settings-bg-file');
  if (bgFile) bgFile.addEventListener('change', onBgFilePick);
  const bgDim = document.getElementById('settings-bg-dim');
  if (bgDim) {
    bgDim.addEventListener('input', onBgDimInput);
    bgDim.addEventListener('change', onBgDimChange);
  }
  const bgReset = document.getElementById('settings-bg-reset');
  if (bgReset) bgReset.addEventListener('click', onBgReset);

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

  // Переключатель «День / Неделя». Выбор запоминается на будущие запуски.
  // Память устройства, не данные: при переполненной квоте запись молча
  // пропускается — иначе setItem бросил бы исключение посреди обработчика
  // и renderMainView() не выполнился бы (экран завис в старом режиме)
  const switchBox = document.getElementById('main-view-switch');
  if (switchBox) {
    switchBox.addEventListener('click', function (event) {
      const btn = event.target.closest('.view-switch-btn');
      if (!btn) return;
      ui.mainView = btn.getAttribute('data-view');
      try {
        localStorage.setItem('youplanner.mainView', ui.mainView);
      } catch (e) { /* настройка-расходник: переживает отказ хранилища */ }
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
}
