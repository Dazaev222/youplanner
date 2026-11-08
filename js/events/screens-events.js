// YouPlanner — воркер 3 из 3: «Экраны и глобальные слои».
// Кусок bindEvents() из app.js: вход/возврат экранов (каза, ураза,
// расписание, ИИ-Ассистент, редактор расписания), вкладка Ассистента целиком,
// клавиатура/visualViewport, шторка уровня, модалки, visibilitychange и Escape.
// Код перенесён построчно из app.js (базовый коммит 56b7a94) без изменений.
// Идентификатор switchAppView объявлен и экспортирован в app.js —
// импортируется напрямую.

import { syncSheetToKeyboard } from '../core/dom.js';
import { SCHEDULE_TYPES } from '../data/schedule.js';
import {
  bindAssistantChatLongPress, closeAssistantDeletePopup, closeAssistantKeyModal,
  isAssistantDeletePopupOpen, onAssistantChipClick, onAssistantClear,
  onAssistantFormSubmit, onAssistantImageClear, onAssistantImagePick,
  onAssistantInputInput, onAssistantInputKeydown, onAssistantKeyCancel,
  onAssistantKeySave, onAssistantModelChange, onAssistantPdfClear,
  onAssistantPdfPick, onAssistantPersonaRangeInput, onAssistantSettingsTabClick,
  openAssistantKeyModal,
} from '../ui/assistant-view.js';
import { onFastAdd, onFastDone, onFastEdit, onFastInitCancel, onFastInitSave } from '../ui/fast-view.js';
import { closeModal } from '../ui/habits-edit.js';
import { closeLevelSheet, onLevelPick } from '../ui/level-sheet.js';
import { onQazaAddPick, onQazaAddSubmit, onQazaDone, onQazaStartChange, onQazaUndo } from '../ui/qaza-view.js';
import { onScheduleAddSubmit, onScheduleEditListClick, renderScheduleEditView, renderScheduleView } from '../ui/schedule-view.js';
import { flushPendingSleepSave } from '../ui/sleep-view.js';
import { handleMatrixEscape } from '../ui/matrix-view.js';
import { ui } from '../ui/state.js';
import { closeStatsMenu, isStatsMenuOpen } from '../ui/stats-view.js';
import { flushPendingSync, syncFromCloud } from '../sync/sync.js';
import { switchAppView } from '../app.js';

export function bindScreensEvents() {

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
  if (assistantSettings) {
    // Без обёртки: openAssistantKeyModal принимает аргументом стартовую
    // вкладку, а клик прислал бы сюда объект события
    assistantSettings.addEventListener('click', function () { openAssistantKeyModal(); });
  }

  const assistantClear = document.getElementById('assistant-clear');
  if (assistantClear) assistantClear.addEventListener('click', onAssistantClear);

  const assistantForm = document.getElementById('assistant-form');
  if (assistantForm) assistantForm.addEventListener('submit', onAssistantFormSubmit);

  // Поле ввода ассистента — textarea: Enter отправляет (нативный Enter
  // textarea вставлял бы перенос, поэтому отправка живёт в keydown),
  // Shift+Enter — перенос по тумблеру персонализации; input растит высоту
  // поля до ~5 строк. Оба обработчика живут в assistant-view.js.
  const assistantInput = document.getElementById('assistant-input');
  if (assistantInput) {
    assistantInput.addEventListener('keydown', onAssistantInputKeydown);
    assistantInput.addEventListener('input', onAssistantInputInput);
  }

  const assistantChips = document.getElementById('assistant-chips');
  if (assistantChips) assistantChips.addEventListener('click', onAssistantChipClick);

  // Удаление одной реплики (задача 3.1): долгое нажатие на пузырь открывает
  // компактный попап возле пузыря (смена 2026-11-07: шторка выезжала красной
  // полосой на весь низ и перекрывала таб-бар). Жест делегирован ленте — один
  // слушатель на контейнер, а не по обработчику на каждом пузыре (лента
  // перерисовывается целиком на каждое изменение истории). Кнопку «Удалить»
  // и подложку подключает сам попап при создании: app.js о нём больше ничего
  // не знает, кроме close/is-функций для Escape и смены экрана
  const assistantChat = document.getElementById('assistant-chat');
  if (assistantChat) bindAssistantChatLongPress(assistantChat);

  const assistantKeySave = document.getElementById('assistant-key-save');
  if (assistantKeySave) assistantKeySave.addEventListener('click', onAssistantKeySave);

  const assistantKeyCancel = document.getElementById('assistant-key-cancel');
  if (assistantKeyCancel) assistantKeyCancel.addEventListener('click', onAssistantKeyCancel);

  const assistantKeyClose = document.getElementById('assistant-key-close');
  if (assistantKeyClose) assistantKeyClose.addEventListener('click', closeAssistantKeyModal);

  const assistantKeyBackdrop = document.querySelector('.modal-backdrop[data-assistant-key-close]');
  if (assistantKeyBackdrop) assistantKeyBackdrop.addEventListener('click', closeAssistantKeyModal);

  // Табы «Настройки ассистента»: переключение панелей — чистый DOM, обработчик
  // в assistant-view.js (делегирование по контейнеру, как у schedule-switch)
  const assistantSettingsSwitch = document.getElementById('assistant-settings-switch');
  if (assistantSettingsSwitch) {
    assistantSettingsSwitch.addEventListener('click', onAssistantSettingsTabClick);
  }

  // Живые подписи значений слайдеров персонализации. Сохранение — кнопкой
  // «Сохранить», здесь только подпись рядом с ползунком
  ['assistant-context-days', 'assistant-temperature', 'assistant-max-tokens']
    .forEach(function (id) {
      const field = document.getElementById(id);
      if (field) field.addEventListener('input', onAssistantPersonaRangeInput);
    });

  // Выбор модели в настройках ассистента: сохраняется сразу, кнопка
  // «Сохранить» относится к ключу и персонализации
  const assistantModelSelect = document.getElementById('assistant-model-select');
  if (assistantModelSelect) {
    assistantModelSelect.addEventListener('change', onAssistantModelChange);
  }

  // PDF: скрепка открывает выбор файла, плашка с именем файла — сброс
  const assistantPdfInput = document.getElementById('assistant-pdf-input');
  if (assistantPdfInput) {
    assistantPdfInput.addEventListener('change', onAssistantPdfPick);
  }
  const assistantPdfIndicator = document.getElementById('assistant-pdf-indicator');
  if (assistantPdfIndicator) {
    assistantPdfIndicator.addEventListener('click', onAssistantPdfClear);
  }

  // Фото (Vision): камера открывает выбор файлов, плашка с именами — сброс
  const assistantImageInput = document.getElementById('assistant-image-input');
  if (assistantImageInput) {
    assistantImageInput.addEventListener('change', onAssistantImagePick);
  }
  const assistantImageIndicator = document.getElementById('assistant-image-indicator');
  if (assistantImageIndicator) {
    assistantImageIndicator.addEventListener('click', onAssistantImageClear);
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
      // Отложенная запись сна — та же история: страница могут закрыть раньше
      // 500-мс таймера ввода (js/ui/sleep-view.js)
      flushPendingSleepSave();
      return;
    }
    syncFromCloud();
  });

  // Escape разбирает окна строго по слоям, ОДНО окно на нажатие: попап
  // удаления реплики, панель статистики, модалка ключа ассистента, модалка
  // привычки, шторка уровня — в порядке «верхнее первым». Раньше модалка
  // привычки закрывалась без return, и одно нажатие снимало и её, и шторку
  // уровня под ней, а модалка ключа ассистента жила своим обработчиком и
  // закрывалась параллельно с остальными. Теперь порядок единый: каждое
  // нажатие гасит ровно верхний слой.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    // Листы Матрицы — модальные слои своего экрана и верхние по определению:
    // подтверждение, затем лист создания, затем меню. handleMatrixEscape гасит
    // ровно один слой и одним нажатием, поэтому проверять его надо раньше
    // остального — иначе Escape снял бы и лист, и панель под ним разом.
    if (handleMatrixEscape()) return;

    // Попап удаления реплики ассистента — верхний слой (выше шторок):
    // гасится первым, как и положено верхнему окну
    if (isAssistantDeletePopupOpen()) {
      closeAssistantDeletePopup();
      return;
    }

    // Панель статистики — верхний слой и в цепочке проверяется первой:
    // она висит поверх таб-бара, и Escape обязан снять сначала её
    if (isStatsMenuOpen()) {
      closeStatsMenu();
      return;
    }

    const keyModal = document.getElementById('assistant-key-modal');
    if (keyModal && !keyModal.hidden) {
      closeAssistantKeyModal();
      return;
    }

    const modal = document.getElementById('habit-modal');
    if (modal && !modal.hidden) {
      closeModal();
      return;
    }

    // Попап уровня открывается из таблицы, но снимается
    // тем же правилом: Escape гасит верхнюю шторку за раз
    const levelSheet = document.getElementById('level-sheet');
    if (levelSheet && !levelSheet.hidden) {
      closeLevelSheet();
      return;
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
