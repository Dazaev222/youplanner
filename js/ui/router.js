/* Реестр экранов и механика переключения.
   Раньше switchAppView держал два десятка захардкоженных getElementById
   и условия подсветки вкладок; теперь экран описан одной строкой реестра:
   el — контейнер, tab — подсвечиваемая вкладка таб-бара, bodyClass —
   класс на body (гасит шапку действий). Рендеры при входе остаются в
   app.js (ROUTE_RENDER): реестр — только данные и механика, без ссылок
   на функции, поэтому циклов импортов не возникает.

   Вложенные экраны подсвечивают вкладку, из которой открыты: «Привычки»,
   настройки молитв, статистика и «Цикл сна» — «Настройки», «Молитвы»
   и «Ураза» — «Каза». У schedule-edit своей вкладки нет. */

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
  'stats': { el: 'stats-view', tab: 'settings', bodyClass: 'view-stats' },
  'stats-qaza': { el: 'stats-qaza-view', tab: 'settings', bodyClass: 'view-stats' },
  'stats-habits': { el: 'stats-habits-view', tab: 'settings', bodyClass: 'view-stats' },
  'stats-habit': { el: 'stats-habit-view', tab: 'settings', bodyClass: 'view-stats' },
  'stats-fast': { el: 'stats-fast-view', tab: 'settings', bodyClass: 'view-stats' },
  'stats-sleep': { el: 'stats-sleep-view', tab: 'settings', bodyClass: 'view-stats' },
  'sleep': { el: 'sleep-view', tab: 'settings', bodyClass: 'view-settings' },
  'schedule': { el: 'schedule-view', tab: 'schedule' },
  'schedule-edit': { el: 'schedule-edit-view', tab: 'schedule-edit' },
  'assistant': { el: 'assistant-view', tab: 'assistant', bodyClass: 'view-assistant' },
};

// Механика переключения: видимость контейнеров, шапка и мобильные детали,
// подсветка вкладки, классы тела. Рендеры вызывает switchAppView в app.js.
export function applyScreen(name) {
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

  const tab = Object.prototype.hasOwnProperty.call(SCREENS, name)
    ? SCREENS[name].tab
    : name;
  document.querySelectorAll('#tab-bar .tab-item').forEach(function (item) {
    item.classList.toggle('is-active', item.getAttribute('data-view') === tab);
  });

  // Классы на body гасят шапку действий во вложенных экранах. У статистики
  // свой класс, а не view-settings: гасят они одно и то же, но имя
  // читается по экрану
  const classes = ['view-qaza', 'view-prayer', 'view-fast', 'view-settings', 'view-stats', 'view-assistant'];
  const active = Object.prototype.hasOwnProperty.call(SCREENS, name)
    ? SCREENS[name].bodyClass
    : null;
  for (let i = 0; i < classes.length; i++) {
    document.body.classList.toggle(classes[i], classes[i] === active);
  }
}
