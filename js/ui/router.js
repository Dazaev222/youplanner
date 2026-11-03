/* Реестр экранов и механика переключения.
   Раньше switchAppView держал два десятка захардкоженных getElementById
   и условия подсветки вкладок; теперь экран описан одной строкой реестра:
   el — контейнер, tab — подсвечиваемая вкладка таб-бара, bodyClass —
   класс на body (гасит шапку действий). Рендеры при входе остаются в
   app.js (ROUTE_RENDER): реестр — только данные и механика, без ссылок
   на функции, поэтому циклов импортов не возникает.

   Вкладка отвечает на один вопрос: «из какой вкладки человек сюда зашёл».
   Панель статистики и её экраны открываются кнопкой на ГЛАВНОЙ, поэтому
   подсвечивают «Главную» — шестерёнка там не при чём, и подсветка «Настроек»
   на экране, куда не заходили из настроек, врёт о местоположении.
   «Редактирование привычек» и «Настройки молитв» — единственные вложенные
   экраны с честным входом из «Настроек», они свою вкладку и держат.
   У «Цикла сна» входа два (строка в Настройках и пункт меню на главной),
   поэтому у него tabFromSettings: подсветка следует за входом — см. tabFor. */

import { isMobileView } from './state.js';
import { setHidden } from '../core/dom.js';

export const SCREENS = {
  'main': { el: 'main', tab: 'main' },
  'settings': { el: 'settings-view', tab: 'settings', bodyClass: 'view-settings' },
  'edit-habits': { el: 'habits-edit-view', tab: 'settings', bodyClass: 'view-settings' },
  'qaza': { el: 'qaza-view', tab: 'qaza', bodyClass: 'view-qaza' },
  'prayer': { el: 'prayer-view', tab: 'qaza', bodyClass: 'view-prayer' },
  'prayer-settings': { el: 'prayer-settings-view', tab: 'settings', bodyClass: 'view-settings' },
  'fast': { el: 'fast-view', tab: 'qaza', bodyClass: 'view-fast' },
  'stats': { el: 'stats-view', tab: 'main', bodyClass: 'view-stats' },
  'stats-qaza': { el: 'stats-qaza-view', tab: 'main', bodyClass: 'view-stats' },
  'stats-habits': { el: 'stats-habits-view', tab: 'main', bodyClass: 'view-stats' },
  'stats-habit': { el: 'stats-habit-view', tab: 'main', bodyClass: 'view-stats' },
  'stats-fast': { el: 'stats-fast-view', tab: 'main', bodyClass: 'view-stats' },
  'stats-sleep': { el: 'stats-sleep-view', tab: 'main', bodyClass: 'view-stats' },
  'sleep': { el: 'sleep-view', tab: 'main', tabFromSettings: true, bodyClass: 'view-settings' },
  // Матрица открывается из того же «Меню», что и статистика: вкладка —
  // главная, шапка действий гасится своим классом (styles/habits-edit.css)
  'matrix': { el: 'matrix-view', tab: 'main', bodyClass: 'view-matrix' },
  'schedule': { el: 'schedule-view', tab: 'schedule' },
  // Редактирование расписания — тот же раздел, а не отдельная вкладка:
  // без подсветки таб-бар на этом экране не показывал бы активного раздела
  'schedule-edit': { el: 'schedule-edit-view', tab: 'schedule' },
  'assistant': { el: 'assistant-view', tab: 'assistant', bodyClass: 'view-assistant' },
};

// Вкладка для экрана. `from` — экран, с которого пришли (currentView до
// переключения): нужен только экранам с двумя входами, остальным он ни к чему.
export function tabFor(name, from) {
  const screen = SCREENS[name];
  if (!screen) return name;
  if (screen.tabFromSettings && from === 'settings') return 'settings';
  return screen.tab;
}

// Имена экранов реестра наружу: сам SCREENS — константа модуля, и из
// vm-песочницы тестов она не видна (видны только объявления функций).
export function screenNames() {
  return Object.keys(SCREENS);
}

// Механика переключения: видимость контейнеров, шапка и мобильные детали,
// подсветка вкладки, классы тела. Рендеры вызывает switchAppView в app.js.
export function applyScreen(name, from) {
  const isMain = name === 'main';

  for (const key of Object.keys(SCREENS)) {
    setHidden(SCREENS[key].el, key !== name);
  }

  // Шапка действий и навигация по неделям — принадлежность главной
  setHidden('week-nav', !isMain);
  setHidden('qaza-btn', !isMain);
  setHidden('schedule-btn', !isMain);
  setHidden('settings-btn', !isMain);
  setHidden('assistant-btn', !isMain);
  // Кнопка статистики открывает панель с экранами раздела: на других
  // экранах ей нечего делать
  setHidden('stats-menu-btn', !isMain);

  // Половины недели — только на главной и только на телефоне;
  // таб-бар — только на телефоне
  const mobile = isMobileView();
  setHidden('mobile-day-tabs', !isMain || !mobile);
  setHidden('tab-bar', !mobile);

  const tab = tabFor(name, from);
  document.querySelectorAll('#tab-bar .tab-item').forEach(function (item) {
    item.classList.toggle('is-active', item.getAttribute('data-view') === tab);
  });

  // Классы на body гасят шапку действий во вложенных экранах. У статистики
  // свой класс, а не view-settings: гасят они одно и то же, но имя
  // читается по экрану. Список ниже — единственный источник правды: экран с
  // bodyClass вне этого списка получал бы пустой <body> и шапку поверх себя.
  const classes = ['view-qaza', 'view-prayer', 'view-fast', 'view-settings',
    'view-stats', 'view-matrix', 'view-assistant'];
  const active = Object.prototype.hasOwnProperty.call(SCREENS, name)
    ? SCREENS[name].bodyClass
    : null;
  for (let i = 0; i < classes.length; i++) {
    document.body.classList.toggle(classes[i], classes[i] === active);
  }
}
