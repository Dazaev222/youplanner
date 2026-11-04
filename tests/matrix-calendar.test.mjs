// ТЗ Воркера 2, пункты Б4 + Б6 + Б7 + Б8 «Транзакция листа и квадрант».
//
// Экран календаря проверяется в fake DOM (тот же приём, что у
// tests/matrix-ui.test.mjs Воркера 1): это настоящий код matrix-view.js, а не
// макет. Что fake НЕ доказывает: геометрию, стили, Tab-ловушку, visualViewport и
// настоящий клик по подложке — это tests/matrix-calendar.browser.mjs.
//
// Не подменяется моками: запись в хранилище (настоящий бросок
// QuotaExceededError), расчёт квадранта, sanitize и round-trip через loadTasks.
//
// Контракт разметки, который фиксируют тесты:
//   .matrix-schedule-endpoint[data-endpoint=start|end] — строки «Начать»/«Закончить»
//   input[type=time][data-endpoint=...]                — поля часов (шаг 1 минута)
//   .matrix-all-day-input + button[data-mode=...]      — «Весь день»/«Часы»
//   .matrix-reminder-row / .matrix-repeat-row          — строки напоминания и повтора
//   .matrix-duration / .matrix-schedule-error          — расчёт и ошибки у поля
//   .matrix-date-ready                                 — «Готово»

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

/* --- Fake DOM (локальное расширение, чужих тестов не трогает) ------------- */

function makeClassList(node) {
  const read = () => String(node.className).split(/\s+/).filter(Boolean);
  return {
    add(...names) {
      const list = read();
      for (const name of names) if (list.indexOf(name) < 0) list.push(name);
      node.className = list.join(' ');
    },
    remove(...names) {
      node.className = read().filter(item => names.indexOf(item) < 0).join(' ');
    },
    toggle(name, force) {
      const list = read();
      const has = list.indexOf(name) >= 0;
      const want = force === undefined ? !has : !!force;
      if (want && !has) list.push(name);
      if (!want && has) list.splice(list.indexOf(name), 1);
      node.className = list.join(' ');
      return want;
    },
    contains: (name) => read().indexOf(name) >= 0,
  };
}

function makeNode(tag, doc) {
  const node = {
    tagName: tag,
    className: '',
    innerHTML: '',
    hidden: false,
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    _events: {},
    _parent: null,
    _doc: doc,
    addEventListener(type, fn) {
      (node._events[type] || (node._events[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = node._events[type];
      if (!list) return;
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    setAttribute(name, value) { node[name] = String(value); },
    getAttribute(name) { return node[name] === undefined ? null : String(node[name]); },
    hasAttribute(name) { return node[name] !== undefined; },
    removeAttribute(name) { delete node[name]; },
    appendChild(child) {
      if (!child) return child;
      child._parent = node;
      node.children.push(child);
      return child;
    },
    append(...list) { for (const child of list) if (child) node.appendChild(child); },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) { node.children.splice(at, 1); child._parent = null; }
      return child;
    },
    remove() { if (node._parent) node._parent.removeChild(node); },
    contains(other) {
      for (let cur = other; cur; cur = cur._parent) if (cur === node) return true;
      return false;
    },
    focus() { if (node._doc) node._doc.activeElement = node; },
    // Лист ловит Tab (trapTab в js/ui/matrix-view.js), поэтому обход внутри
    // узла нужен и здесь: без него production-код падал бы на тестовом DOM,
    // а не на собственном дефекте. Поддержка — ровно те селекторы, которые
    // использует ловушка: имена тегов и [атрибут].
    querySelectorAll(selector) {
      const parts = String(selector).split(',').map(part => part.trim()).filter(Boolean);
      const match = (candidate) => parts.some((part) => {
        if (part[0] === '[') return candidate.hasAttribute(part.slice(1, -1));
        return String(candidate.tagName).toLowerCase() === part.toLowerCase();
      });
      const found = [];
      const walk = (current) => {
        for (const child of current.children || []) {
          if (match(child)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 40, left: 0, right: 100, width: 100, height: 40 };
    },
    fire(type, event) {
      const detail = event || {};
      if (typeof detail.preventDefault !== 'function') detail.preventDefault = () => {};
      if (detail.target === undefined) detail.target = node;
      for (const fn of node._events[type] || []) fn(detail);
    },
  };
  node.childNodes = node.children;
  node.classList = makeClassList(node);
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => (node.children.length
      ? node.children.map(child => child.textContent).join('')
      : text),
    set: (value) => {
      text = value === null || value === undefined ? '' : String(value);
      if (text === '') {
        for (const child of node.children) child._parent = null;
        node.children.length = 0;
      }
    },
  });
  return node;
}

function installMatrixDom(app) {
  const byId = {};
  const doc = app.sandbox.document;
  doc.createElement = (tag) => makeNode(tag, doc);
  doc.getElementById = (id) => byId[id] || null;
  doc.querySelector = () => null;
  doc.querySelectorAll = () => [];
  doc.activeElement = null;

  const host = makeNode('section', doc);
  const screen = makeNode('div', doc);
  host.appendChild(screen);
  const toast = makeNode('div', doc);
  toast.hidden = true;
  byId['matrix-view'] = host;
  byId['matrix-screen'] = screen;
  byId.toast = toast;
  doc.body = makeNode('body', doc);
  return { host, screen, toast, doc };
}

function hasClass(node, name) {
  return String(node.className).split(/\s+/).indexOf(name) >= 0;
}

function findByClass(root, className) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (hasClass(child, className)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function oneByClass(root, className) {
  const found = findByClass(root, className);
  assert.equal(found.length, 1,
    'узел .' + className + ' должен быть ровно один, найдено ' + found.length);
  return found[0];
}

function findByData(root, key, value) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.dataset && child.dataset[key] === value) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function breakStorage(app) {
  app.sandbox.localStorage.setItem = () => {
    const error = new Error('QuotaExceededError');
    error.name = 'QuotaExceededError';
    throw error;
  };
}

/* --- Хелперы листа -------------------------------------------------------- */

function iso(offsetDays, from) {
  const base = from || new Date();
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (offsetDays || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}

function openComposer(app, dom, quadrant) {
  app.context.renderMatrixView();
  const card = findByClass(dom.screen, 'matrix-card')
    .filter(node => node.dataset.quadrant === quadrant)[0];
  assert.ok(card, 'карточка ' + quadrant + ' должна быть на экране');
  oneByClass(card, 'matrix-card-add').fire('click');
}

function dateSheets(dom) {
  return findByClass(dom.host, 'matrix-sheet').filter(n => hasClass(n, 'is-date'));
}

// Подложка и сам лист носят один и тот же признак слоя, поэтому «лист
// создания» считается по узлу с классом matrix-sheet, а не по is-composer.
function composerSheets(dom) {
  return findByClass(dom.host, 'matrix-sheet').filter(n => hasClass(n, 'is-composer'));
}

function openCalendar(app, dom) {
  const dueButton = findByClass(dom.host, 'matrix-attr')
    .filter(node => node.getAttribute('aria-label') === 'Срок исполнения')[0];
  assert.ok(dueButton, 'в строке листа обязана быть кнопка срока');
  dueButton.fire('click');
  assert.equal(dateSheets(dom).length, 1, 'лист календаря открылся одним слоем');
  return oneByClass(dom.host, 'is-date');
}

// День может лежать в следующем месяце — лист обязан туда перейти сам,
// иначе тест зависел бы от часов машины.
function clickDay(dom, isoDate) {
  for (let guard = 0; guard < 13; guard++) {
    const found = findByClass(dom.host, 'matrix-cal-day')
      .filter(node => node.getAttribute('aria-label') === isoDate);
    if (found.length === 1) {
      found[0].fire('click');
      return;
    }
    assert.equal(found.length, 0, 'день ' + isoDate + ' показан более одного раза');
    // курсор стоит на первом числе месяца: шагаем вперёд/назад по подписи
    const label = oneByClass(dom.host, 'matrix-cal-label').textContent;
    const targetMonth = Number(isoDate.slice(5, 7));
    const shownMonth = monthFromLabel(label);
    const next = findByClass(dom.host, 'matrix-cal-nav').filter(n => hasClass(n, 'is-next'))[0];
    const prev = findByClass(dom.host, 'matrix-cal-nav').filter(n => !hasClass(n, 'is-next'))[0];
    if (shownMonth !== null && shownMonth < targetMonth) next.fire('click');
    else if (shownMonth !== null && shownMonth > targetMonth) prev.fire('click');
    else assert.fail('не удалось дойти до месяца ' + isoDate);
  }
  assert.fail('месяц ' + isoDate + ' не появился за 13 шагов навигации');
}

const RU_MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август',
  'сентябр', 'октябр', 'ноябр', 'декабр'];

function monthFromLabel(label) {
  const text = String(label).toLowerCase();
  for (let i = 0; i < RU_MONTHS.length; i++) {
    if (text.indexOf(RU_MONTHS[i]) === 0) return i + 1;
  }
  return null;
}

function endpointButton(dom, which) {
  const found = findByData(dom.host, 'endpoint', which)
    .filter(node => hasClass(node, 'matrix-schedule-endpoint'));
  assert.equal(found.length, 1, 'строка-пилюля «' + which + '» должна быть одна');
  return found[0];
}

function timeInput(dom, which) {
  const found = findByData(dom.host, 'endpoint', which)
    .filter(node => String(node.tagName).toLowerCase() === 'input' && node.type === 'time');
  assert.equal(found.length, 1, 'поле часов для «' + which + '» должно быть одно');
  return found[0];
}

function setTime(dom, which, value) {
  const field = timeInput(dom, which);
  field.value = value;
  field.fire('input');
}

function switchMode(dom, mode) {
  const found = findByData(dom.host, 'mode', mode);
  assert.equal(found.length, 1, 'переключатель режима «' + mode + '» должен быть один');
  found[0].fire('click');
}

function ready(dom) {
  oneByClass(dom.host, 'matrix-date-ready').fire('click');
}

function draft(app) {
  return app.context.matrixDebugState().draft;
}

function errorText(dom) {
  return oneByClass(dom.host, 'matrix-schedule-error').textContent;
}

/* ========================================================================= */
/* Б4.1/Б4.2 — лист показывает все пять полей и длительность                 */
/* ========================================================================= */

test('Б4.2 лист «Дата и длительность» содержит все пять полей и длительность', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  const sheet = openCalendar(app, dom);

  assert.equal(sheet.getAttribute('role'), 'dialog', 'календарь — dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.match(oneByClass(dom.host, 'matrix-date-title').textContent, /Дата и длительность/);

  // Быстрые даты и месячная сетка сохранены (ТЗ Б1)
  assert.equal(findByClass(dom.host, 'matrix-chip').length, 3, 'Сегодня/Завтра/Через неделю');
  assert.ok(findByClass(dom.host, 'matrix-cal-day').length >= 28, 'сетка дней месяца');

  assert.equal(findByData(dom.host, 'endpoint', 'start').length > 0, true, '«Начать»');
  assert.equal(findByData(dom.host, 'endpoint', 'end').length > 0, true, '«Закончить»');
  assert.ok(allDayInput(dom), 'тумблер «Весь день»');
  assert.equal(String(allDayInput(dom).tagName).toLowerCase(), 'input', '«Весь день» — настоящий контрол');
  assert.ok(oneByClass(dom.host, 'matrix-reminder-row'), 'строка «Время для напоминания»');
  assert.ok(oneByClass(dom.host, 'matrix-repeat-row'), 'строка «Повтор»');
  assert.ok(oneByClass(dom.host, 'matrix-duration'), 'рассчитанная длительность выведена');
  assert.ok(oneByClass(dom.host, 'matrix-schedule-error'), 'блок ошибок у поля есть');
});

function allDayInput(dom) {
  return findByClass(dom.host, 'matrix-all-day-input')[0];
}

test('Б4.1 открытие листа ничего не пишет и не меняет черновик', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  const before = JSON.stringify(draft(app));

  openCalendar(app, dom);
  assert.equal(JSON.stringify(draft(app)), before, 'открытие листа не трогает draft');
  assert.equal(app.context.loadTasks().length, 0, 'и хранилище не тронуто');
});

/* ========================================================================= */
/* Б4.3 — выбор границ                                                        */
/* ========================================================================= */

test('Б4.3 пустой интервал: выбор дня заполняет обе границы', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  assert.equal(draft(app).due, null);
  openCalendar(app, dom);

  clickDay(dom, iso(5));
  ready(dom);

  const after = draft(app);
  assert.equal(after.schedule.startDate, iso(5), 'начало взяло выбранный день');
  assert.equal(after.schedule.endDate, iso(5), 'одна дата = интервал из одного дня');
  assert.equal(after.due, iso(5), 'верхнеуровневый due следует за endDate');
});

test('Б4.3 выбор «Закончить» двигает только правую границу', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(2));
  ready(dom);
  assert.equal(draft(app).schedule.endDate, iso(2));

  openCalendar(app, dom);
  endpointButton(dom, 'end').fire('click');
  clickDay(dom, iso(4));
  ready(dom);

  assert.equal(draft(app).schedule.startDate, iso(2), 'начало осталось');
  assert.equal(draft(app).schedule.endDate, iso(4), 'сдвинулось только окончание');
});

test('Б4.3/Б8 нарушение порядка границ показывается ошибкой, а не молчаливой правкой', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(2));
  ready(dom);

  openCalendar(app, dom);
  endpointButton(dom, 'end').fire('click');
  clickDay(dom, iso(1));                     // окончание раньше начала
  ready(dom);

  assert.equal(dateSheets(dom).length, 1, 'лист остался открытым');
  assert.ok(errorText(dom).length > 0, 'ошибка названа');
  assert.equal(draft(app).schedule.startDate, iso(2), 'начало не переписано молча');
  assert.equal(draft(app).schedule.endDate, iso(2), 'и окончание не уехало без согласия');
});

/* ========================================================================= */
/* Б4.5/Б4.6 — «Весь день», часы, переход через полночь                      */
/* ========================================================================= */

test('Б4.5 timed→all-day убирает время из сохраняемого значения и скрывает поля часов', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(1));
  switchMode(dom, 'timed');
  setTime(dom, 'start', '09:00');
  setTime(dom, 'end', '10:00');
  ready(dom);
  assert.equal(draft(app).schedule.startTime, '09:00');

  openCalendar(app, dom);
  switchMode(dom, 'all-day');
  assert.equal(findByData(dom.host, 'endpoint', 'start')
    .filter(n => String(n.tagName).toLowerCase() === 'input' && n.type === 'time').length, 0,
    'в all-day поля часов не показываются');
  ready(dom);

  const after = draft(app);
  assert.equal(after.schedule.allDay, true, 'тумблер переключился');
  assert.equal(after.schedule.startTime, null, 'в модели времени нет');
  assert.equal(after.schedule.endTime, null);
  assert.equal(after.schedule.startDate, iso(1), 'даты сохранены');
});

test('Б8 all-day→timed восстанавливает часы 09:00–10:00 на выбранных датах', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(3));
  ready(dom);
  assert.equal(draft(app).schedule.allDay, true);

  openCalendar(app, dom);
  switchMode(dom, 'timed');
  ready(dom);

  const after = draft(app);
  assert.equal(after.schedule.startTime, '09:00', 'дефолт начала');
  assert.equal(after.schedule.endTime, '10:00', 'дефолт окончания');
  assert.equal(after.schedule.allDay, false);
  assert.equal(after.schedule.startDate, iso(3), 'дата при переключении не потерялась');
});

test('Б4.6 timed: 23:30 сегодня → 00:15 завтра = 45 минут', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));
  switchMode(dom, 'timed');
  setTime(dom, 'start', '23:30');
  setTime(dom, 'end', '00:15');
  endpointButton(dom, 'end').fire('click');
  clickDay(dom, iso(1));

  assert.match(oneByClass(dom.host, 'matrix-duration').textContent, /45 мин/,
    'длительность пересчитана через полночь');
  ready(dom);

  const after = draft(app);
  assert.equal(after.schedule.startTime, '23:30');
  assert.equal(after.schedule.endTime, '00:15');
  assert.equal(after.schedule.endDate, iso(1));
});

test('Б4.6 timed: 23:30 → 00:15 того же дня отклоняется, «завтра» само не назначается', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));
  ready(dom);
  assert.equal(draft(app).schedule.endDate, iso(0), 'сегодня применено');

  openCalendar(app, dom);
  switchMode(dom, 'timed');
  setTime(dom, 'start', '23:30');
  setTime(dom, 'end', '00:15');
  ready(dom);

  assert.equal(dateSheets(dom).length, 1, 'невалидная форма не применяется');
  assert.equal(draft(app).schedule.endDate, iso(0), 'дата не уехала на «завтра» молча');
  assert.equal(endpointButton(dom, 'end').dataset.date, iso(0),
    'и в самом листе окончание осталось сегодняшним');
  assert.ok(errorText(dom).length > 0, 'причина показана');
});

/* ========================================================================= */
/* Б4.4 — быстрые даты                                                        */
/* ========================================================================= */

test('Б4.4 «Через неделю» переносит весь интервал, сохраняя длину и часы', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));
  switchMode(dom, 'timed');
  setTime(dom, 'start', '09:00');
  setTime(dom, 'end', '12:00');
  endpointButton(dom, 'end').fire('click');
  clickDay(dom, iso(1));
  ready(dom);
  assert.equal(draft(app).schedule.endDate, iso(1));

  openCalendar(app, dom);
  findByClass(dom.host, 'matrix-chip').filter(c => c.textContent === 'Через неделю')[0].fire('click');
  ready(dom);

  const after = draft(app);
  assert.equal(after.schedule.startDate, iso(7), 'начало стало выбранной быстрой датой');
  assert.equal(after.schedule.endDate, iso(8), 'календарная длина сохранена');
  assert.equal(after.schedule.startTime, '09:00', 'часы начала сохранены');
  assert.equal(after.schedule.endTime, '12:00', 'часы окончания сохранены');
});

test('Б4.4 быстрая дата при пустом интервале задаёт один all-day день', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  findByClass(dom.host, 'matrix-chip').filter(c => c.textContent === 'Завтра')[0].fire('click');
  ready(dom);
  assert.equal(draft(app).schedule.startDate, iso(1));
  assert.equal(draft(app).schedule.endDate, iso(1));
  assert.equal(draft(app).schedule.allDay, true);
});

/* ========================================================================= */
/* Б4.7 — очистка отменяема до «Готово»                                       */
/* ========================================================================= */

test('Б4.7 «Очистить» внутри листа отменяется закрытием, «Готово» — применяет сброс', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(2));
  ready(dom);
  const saved = draft(app).schedule.startDate;

  openCalendar(app, dom);
  oneByClass(dom.host, 'matrix-clear').fire('click');
  // закрытие крестиком = отмена всего листа
  const closeX = findByClass(dom.host, 'is-date')
    .map(sheet => findByClass(sheet, 'matrix-sheet-x'))
    .filter(list => list.length)[0][0];
  closeX.fire('click');
  assert.equal(draft(app).schedule.startDate, saved, 'отмена возвращает исходные настройки');

  openCalendar(app, dom);
  oneByClass(dom.host, 'matrix-clear').fire('click');
  ready(dom);
  const cleared = draft(app);
  assert.equal(cleared.schedule.startDate, null);
  assert.equal(cleared.schedule.endDate, null);
  assert.equal(cleared.due, null, 'срок снят целиком');
});

/* ========================================================================= */
/* Б4.9/Б4.10 — стек слоёв и повторное открытие                               */
/* ========================================================================= */

test('Б4.9 Escape снимает только календарь, лист создания и текст остаются', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Не потеряться';
  title.fire('input');

  openCalendar(app, dom);
  assert.equal(app.context.handleMatrixEscape(), true, 'Escape съеден календарём');
  assert.equal(dateSheets(dom).length, 0, 'календарь закрыт');
  assert.equal(composerSheets(dom).length, 1, 'лист создания жив');
  assert.equal(draft(app).title, 'Не потеряться', 'и набранный текст тоже');
});

test('Б4.10 повторное открытие показывает ранее применённые значения', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(4));
  ready(dom);

  openCalendar(app, dom);
  const selected = findByClass(dom.host, 'matrix-cal-day').filter(n => hasClass(n, 'is-selected'));
  assert.equal(selected.length, 1, 'выбранный день помечен');
  assert.equal(selected[0].getAttribute('aria-label'), iso(4));
  assert.equal(selected[0].getAttribute('aria-pressed'), 'true');
});

/* ========================================================================= */
/* Б4.8 + Б6.2 — «Готово» обновляет плашку и реальный квадрант                */
/* ========================================================================= */

test('Б8 q2 «+» и срок сегодня → плашка q1, задача ложится в q1 без переписывания даты', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));
  ready(dom);

  assert.ok(String(oneByClass(dom.host, 'matrix-quad-pill').className).indexOf('q-q1') >= 0,
    'плашка показывает реальный квадрант расписания');

  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Сегодня и важно';
  title.fire('input');
  oneByClass(dom.host, 'matrix-composer').fire('submit');

  const stored = app.context.loadTasks();
  assert.equal(stored.length, 1, 'задача создана ровно один раз');
  assert.equal(app.context.quadrantOf(stored[0], new Date()), 'q1');
  assert.equal(stored[0].due, iso(0), 'дата при сохранении не переписана');
});

test('Б8 «Готово» меняет только черновик: запись происходит при submit', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q3');
  openCalendar(app, dom);
  clickDay(dom, iso(1));
  ready(dom);

  assert.equal(app.context.loadTasks().length, 0, 'в хранилище ещё ничего нет');
  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Одна задача';
  title.fire('input');
  oneByClass(dom.host, 'matrix-composer').fire('submit');
  assert.equal(app.context.loadTasks().length, 1);

  // Успешный submit закрывает лист, поэтому «второй Enter» физически не может
  // создать вторую задачу: ни черновика, ни формы уже нет.
  assert.equal(composerSheets(dom).length, 0, 'после успеха лист закрыт');
  assert.equal(app.context.loadTasks().length, 1, 'дубликата нет');
});

test('Б8 ошибка записи сохраняет весь schedule в открытой форме', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(2));
  switchMode(dom, 'timed');
  setTime(dom, 'start', '09:00');
  setTime(dom, 'end', '10:00');
  ready(dom);
  const wanted = JSON.stringify(draft(app).schedule);

  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Не терять расписание';
  title.fire('input');
  breakStorage(app);
  oneByClass(dom.host, 'matrix-composer').fire('submit');

  assert.equal(JSON.stringify(draft(app).schedule), wanted, 'расписание целиком осталось в черновике');
  assert.equal(draft(app).title, 'Не терять расписание');
  assert.equal(composerSheets(dom).length, 1, 'лист не закрыт при отказе');
  assert.match(dom.toast.textContent, /Не удалось сохранить/);
});

/* ========================================================================= */
/* Б4.10 — редактирование существующей задачи                                 */
/* ========================================================================= */

test('Б4.10 «Изменить дату и время» у существующей задачи пишет только после успеха', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  const created = app.context.addTask('q2', { title: 'Встреча', notes: '', priority: 2 });
  app.context.renderMatrixView();
  assert.ok(created);

  const edit = findByClass(dom.screen, 'matrix-task-schedule')[0];
  assert.ok(edit, 'в списке есть явное действие «Изменить дату и время»');
  assert.match(edit.getAttribute('aria-label'), /Встреча/);
  edit.fire('click');

  assert.equal(dateSheets(dom).length, 1, 'открылся лист расписания');
  clickDay(dom, iso(1));
  ready(dom);

  const after = app.context.loadTasks()[0];
  assert.equal(after.id, created.id, 'та же задача, не новая');
  assert.equal(after.due, iso(1), 'срок обновлён после успешной записи');

  findByClass(dom.screen, 'matrix-task-schedule')[0].fire('click');
  clickDay(dom, iso(9));
  app.context.handleMatrixEscape();
  assert.equal(app.context.loadTasks()[0].due, iso(1), 'отмена ничего не записала');
});

/* ========================================================================= */
/* Б6.4 — перенос назначенного интервала через preview                        */
/* ========================================================================= */

test('Б8 перенос timed-интервала в q1 спрашивает подтверждение и пишет только после согласия', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  const created = app.context.createTask({
    title: 'Двухдневное',
    priority: 2,
    schedule: {
      allDay: false, startDate: iso(6), endDate: iso(7),
      startTime: '09:00', endTime: '10:00',
    },
  });
  app.context.saveTasks([created]);
  app.context.renderMatrixView();

  findByClass(dom.screen, 'matrix-task-move')[0].fire('click');
  const target = findByClass(dom.host, 'matrix-sheet-item').filter(i => i.dataset.quadrant === 'q1')[0];
  assert.ok(target, 'лист переноса предлагает q1');
  target.fire('click');

  const preview = findByClass(dom.host, 'matrix-move-preview');
  assert.equal(preview.length, 1, 'конфликтный перенос спрашивает подтверждение');
  assert.equal(app.context.loadTasks()[0].schedule.endDate, iso(7), 'до согласия ничего не записано');

  findByClass(preview[0], 'matrix-move-confirm')[0].fire('click');
  const moved = app.context.loadTasks()[0];
  assert.equal(moved.schedule.endDate, iso(0), 'окончание сдвинуто на сегодня');
  assert.equal(moved.schedule.startTime, '09:00', 'часы сохранены');
  assert.equal(moved.schedule.endTime, '10:00');
  assert.equal(app.context.quadrantOf(moved, new Date()), 'q1', 'факт совпадает с целью');
});

test('Б8 отмена preview оставляет расписание в покое', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  const created = app.context.createTask({
    title: 'Назначенное',
    priority: 2,
    schedule: { allDay: true, startDate: iso(5), endDate: iso(6) },
  });
  app.context.saveTasks([created]);
  app.context.renderMatrixView();

  findByClass(dom.screen, 'matrix-task-move')[0].fire('click');
  findByClass(dom.host, 'matrix-sheet-item').filter(i => i.dataset.quadrant === 'q3')[0].fire('click');
  findByClass(dom.host, 'matrix-move-cancel')[0].fire('click');

  const stored = app.context.loadTasks()[0];
  assert.deepEqual([stored.schedule.startDate, stored.schedule.endDate], [iso(5), iso(6)],
    'отмена ничего не сдвинула');
  assert.equal(app.context.quadrantOf(stored, new Date()), 'q2');
});

/* ========================================================================= */
/* Б7 — повтор из экрана                                                      */
/* ========================================================================= */

test('Б7 выбор повтора сохраняет правило в черновике и в задаче', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));

  oneByClass(dom.host, 'matrix-repeat-row').fire('click');
  const daily = findByClass(dom.host, 'matrix-repeat-option').filter(o => o.dataset.unit === 'day')[0];
  assert.ok(daily, 'в списке повторов есть «Каждый день»');
  daily.fire('click');
  ready(dom);

  assert.ok(draft(app).schedule.repeat, 'черновик получил правило');
  assert.equal(draft(app).schedule.repeat.unit, 'day');

  const title = oneByClass(dom.host, 'matrix-composer-title');
  title.value = 'Каждый день';
  title.fire('input');
  oneByClass(dom.host, 'matrix-composer').fire('submit');

  const stored = app.context.loadTasks();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].schedule.repeat.unit, 'day', 'правило дожило до хранилища');
  assert.ok(stored[0].schedule.series, 'series создана при включении повтора');
});

// Обязательные по ТЗ Б7 варианты «N-й/последний день недели месяца» и «по
// выбранным датам» живут в блоке «Настроить». Лист обязан донести их до
// черновика целиком — иначе это была бы текстовая плашка, а не повтор.
test('Б7 «Настроить»: режим месяца N-й день недели доходит до черновика', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));

  oneByClass(dom.host, 'matrix-repeat-row').fire('click');
  const unit = oneByClass(dom.host, 'matrix-repeat-unit');
  unit.value = 'month';
  unit.fire('change');
  const mode = oneByClass(dom.host, 'matrix-repeat-month-mode');
  mode.value = 'nthWeekday';
  mode.fire('change');
  const nth = oneByClass(dom.host, 'matrix-repeat-nth');
  nth.value = '-1';
  nth.fire('change');
  const weekday = oneByClass(dom.host, 'matrix-repeat-weekday-pick');
  weekday.value = '1';
  weekday.fire('change');
  oneByClass(dom.host, 'matrix-repeat-apply').fire('click');
  ready(dom);

  const repeat = draft(app).schedule.repeat;
  assert.equal(repeat.unit, 'month');
  assert.equal(repeat.monthMode, 'nthWeekday', 'режим месяца выбран');
  assert.equal(repeat.nth, -1, 'последний');
  assert.equal(repeat.weekday, 1, 'понедельник');
});

test('Б7 «Настроить»: свои даты становятся правилом unit=dates', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));

  oneByClass(dom.host, 'matrix-repeat-row').fire('click');
  const unit = oneByClass(dom.host, 'matrix-repeat-unit');
  unit.value = 'dates';
  unit.fire('change');

  const field = () => oneByClass(dom.host, 'matrix-repeat-date-input');
  const addBtn = () => oneByClass(dom.host, 'matrix-repeat-date-add');
  for (const day of [iso(9), iso(3), iso(9)]) {
    // Перезапрос узлов обязателен: после каждого «Добавить дату» лист
    // пересобирает DOM, и старый узел был бы слепым — как в тесте, так и в
    // браузере, если поле не хранит введанную дату.
    field().value = day;
    field().fire('change');
    addBtn().fire('click');
  }
  assert.equal(findByClass(dom.host, 'matrix-repeat-date').length, 2,
    'одна и та же дата не добавляется дважды');
  assert.equal(field().value, iso(9),
    'перерисовка не выбрасывает введанную дату');
  oneByClass(dom.host, 'matrix-repeat-apply').fire('click');
  ready(dom);

  const repeat = draft(app).schedule.repeat;
  assert.equal(repeat.unit, 'dates');
  // Array.from обязателен: массив создан внутри vm-контекста, и
  // deepStrictEqual сравнивает прототипы — чужой Array не совпадает никогда
  // (тот же мотив, что у isDateLike в js/data/matrix.js).
  assert.deepEqual(Array.from(repeat.dates), [iso(3), iso(9)], 'даты отсортированы');
  assert.equal(repeat.interval, 1, 'у списка дат интервала нет');
  assert.equal(draft(app).schedule.startDate, iso(3),
    'срок встал на первую дату — иначе правило невалидно');

  // Снятие одной даты из правила — тоже правка, а не украшение
  openCalendar(app, dom);
  oneByClass(dom.host, 'matrix-repeat-row').fire('click');
  findByClass(dom.host, 'matrix-repeat-date-drop')[0].fire('click');
  oneByClass(dom.host, 'matrix-repeat-apply').fire('click');
  ready(dom);
  assert.deepEqual(Array.from(draft(app).schedule.repeat.dates), [iso(9)], 'дата снята');
});

test('Б7.6 выполнение повторяющейся задачи даёт completed + next одним действием', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  const created = app.context.startSeries(app.context.createTask({
    title: 'Полоскать',
    priority: 1,
    schedule: {
      allDay: true, startDate: iso(0), endDate: iso(0),
      repeat: { unit: 'day', interval: 1 },
    },
  }), new Date());
  app.context.saveTasks([created]);
  app.context.renderMatrixView();

  findByClass(dom.screen, 'matrix-check')[0].fire('click');
  const stored = app.context.loadTasks();
  assert.equal(stored.length, 2, 'записаны ровно два экземпляра');
  assert.equal(stored.filter(x => x.done).length, 1);
  const next = stored.filter(x => !x.done)[0];
  assert.equal(next.schedule.series.index, 2);
  assert.equal(next.schedule.startDate, iso(1), 'следующий — завтра');
});

test('Б7 карточка показывает признаки повтора и напоминания', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  const created = app.context.startSeries(app.context.createTask({
    title: 'С напоминанием',
    priority: 2,
    schedule: {
      allDay: false, startDate: iso(0), endDate: iso(0),
      startTime: '09:00', endTime: '10:00',
      reminders: [{ id: 'r1', anchor: 'start', offsetMinutes: 15 }],
      repeat: { unit: 'week', interval: 1, weekdays: [1, 3] },
    },
  }), new Date());
  app.context.saveTasks([created]);
  app.context.renderMatrixView();

  assert.equal(findByClass(dom.screen, 'matrix-repeat-mark').length, 1, 'метка повтора');
  assert.equal(findByClass(dom.screen, 'matrix-reminder-mark').length, 1, 'метка напоминания');
  assert.match(findByClass(dom.screen, 'matrix-due')[0].textContent, /9:00|09:00/,
    'timed-карточка называет время начала');
});

/* ========================================================================= */
/* Б5 — напоминания из листа                                                   */
/* ========================================================================= */

test('Б5 выбор напоминания пишет relative-правило и не создаёт дублей', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(0));
  // Минутные опережения в all-day меню не показываются (ТЗ Б5), поэтому
  // интервал делается timed: именно на нём обязано быть «За 15 минут».
  switchMode(dom, 'timed');

  oneByClass(dom.host, 'matrix-reminder-row').fire('click');
  const choices = findByClass(dom.host, 'matrix-reminder-option');
  assert.ok(choices.length >= 7, 'меню напоминания перечисляет варианты ТЗ Б5');
  choices.filter(c => c.dataset.offset === '15')[0].fire('click');
  ready(dom);

  const reminders = draft(app).schedule.reminders;
  assert.equal(reminders.length, 1);
  assert.deepEqual([reminders[0].anchor, reminders[0].offsetMinutes], ['start', 15]);

  openCalendar(app, dom);
  oneByClass(dom.host, 'matrix-reminder-row').fire('click');
  findByClass(dom.host, 'matrix-reminder-option').filter(c => c.dataset.offset === '15')[0].fire('click');
  ready(dom);
  assert.equal(draft(app).schedule.reminders.length, 1,
    'повторный выбор того же правила не дублирует напоминание');
});

test('Б4.7 без даты напоминание недоступно с пояснением', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  assert.equal(draft(app).due, null, 'q2 открывается без срока');
  openCalendar(app, dom);

  oneByClass(dom.host, 'matrix-reminder-row').fire('click');
  assert.match(oneByClass(dom.host, 'matrix-schedule-hint').textContent, /Сначала выберите дату/);
  assert.equal(findByClass(dom.host, 'matrix-reminder-option').length, 0,
    'без даты меню правил не открывается');
});

/* ========================================================================= */
/* Б3.7 — debug-состояние не отдаёт live draft                                */
/* ========================================================================= */

test('Б3.7 matrixDebugState отдаёт глубокую копию расписания черновика', (t) => {
  const app = loadApp();
  const dom = installMatrixDom(app);
  openComposer(app, dom, 'q2');
  openCalendar(app, dom);
  clickDay(dom, iso(1));
  ready(dom);

  const first = draft(app);
  first.schedule.startDate = '1999-01-01';
  first.schedule.reminders.push({ id: 'подделка', anchor: 'start', offsetMinutes: 5 });
  const second = draft(app);
  assert.equal(second.schedule.startDate, iso(1), 'правка копии не протыкает живой черновик');
  assert.equal(second.schedule.reminders.length, 0);
});
