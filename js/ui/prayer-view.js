import { escapeHtml, pad2, setHidden, showToast } from '../core/dom.js';
import { PRAYER_LABELS, PRAYER_MADHHABS, PRAYER_MADHHAB_LABELS, PRAYER_METHODS, PRAYER_METHOD_DEFAULT, PRAYER_METHOD_LABELS, PRAYER_ORDER, PRAYER_SHADOW, PRAYER_WINDOWS, loadPrayer, prayerDateISO, prayerMinutes, prayerRound, prayerTimes, savePrayer } from '../data/prayer.js';
// Раскрыт ли полный список. Живёт только в интерфейсе и сбрасывается при
// входе на вкладку: «Показать все» — разовый взгляд, а не настройка.
export let prayerShowAll = false;
// Сутки, на которые нарисован экран. Смена значения — сигнал пересобрать
// день целиком, а не только счётчик.
export let prayerRenderedDay = null;
export let prayerTimer = null;
// Намаз, окно которого идёт сейчас. Восход окна не имеет — он не намаз,
// а граница утреннего.
export function prayerCurrent(times, nowMin) {
  for (let i = 0; i < PRAYER_WINDOWS.length; i++) {
    const from = times[PRAYER_WINDOWS[i][0]];
    const endKey = PRAYER_WINDOWS[i][1];
    const to = endKey ? times[endKey] : 1440;
    if (from === null || from === undefined) continue;
    if (to === null || to === undefined) continue;
    if (nowMin >= from && nowMin < to) return PRAYER_WINDOWS[i][0];
  }
  return null;
}
// Ближайшее событие: сперва сегодняшние, потом завтрашний Фаджр. Минуты
// завтрашних идут со сдвигом на сутки — так разница до них берётся вычитанием,
// а не отдельной веткой.
export function prayerNext(times, tomorrow, nowMin) {
  for (let i = 0; i < PRAYER_ORDER.length; i++) {
    const min = times[PRAYER_ORDER[i]];
    if (min === null || min === undefined) continue;
    if (min > nowMin) return { key: PRAYER_ORDER[i], min: min, tomorrow: false };
  }

  const fajr = tomorrow ? tomorrow.fajr : null;
  if (fajr === null || fajr === undefined) return null;
  return { key: 'fajr', min: fajr + 1440, tomorrow: true };
}
// Событие после следующего — вторая строка свёрнутого списка
export function prayerAfter(times, tomorrow, next) {
  if (!next) return null;

  if (next.tomorrow) {
    const sunrise = tomorrow ? tomorrow.sunrise : null;
    if (sunrise === null || sunrise === undefined) return null;
    return { key: 'sunrise', min: sunrise + 1440, tomorrow: true };
  }

  const key = PRAYER_ORDER[PRAYER_ORDER.indexOf(next.key) + 1];
  if (!key || times[key] === null || times[key] === undefined) return null;
  return { key: key, min: times[key], tomorrow: false };
}
// Всё, что нужно экрану: времена сегодня и завтра, текущий намаз, следующий
// и строки свёрнутого списка. Завтрашние времена нужны не для красоты:
// после Иши следующее событие наступает уже завтра, и круг обязан его показать.
export function prayerViewState() {
  const saved = loadPrayer();
  if (!saved) return null;

  const now = new Date();
  const times = prayerTimes(prayerDateISO(now), saved.lat, saved.lng,
    saved.madhhab, saved.method);
  if (!times) return null;

  const tomorrow = prayerTimes(
    prayerDateISO(new Date(now.getTime() + 86400000)),
    saved.lat, saved.lng, saved.madhhab, saved.method) || {};

  const nowMin = prayerMinutes(now);
  const current = prayerCurrent(times, nowMin);
  const next = prayerNext(times, tomorrow, nowMin);
  const after = prayerAfter(times, tomorrow, next);

  // Идёт окно намаза — показываем текущий и следующий; окна нет (например,
  // между Восходом и Зухром) — следующий и после следующего.
  const shown = [];
  if (current) {
    shown.push({ key: current, min: times[current], tomorrow: false });
    if (next) shown.push(next);
  } else {
    if (next) shown.push(next);
    if (after) shown.push(after);
  }

  return { times: times, now: nowMin, current: current, next: next, shown: shown };
}
// Минуты → «ЧЧ:ММ». Завтрашние минуты приходят со сдвигом на сутки.
export function prayerClock(minutes) {
  if (minutes === null || minutes === undefined || !isFinite(minutes)) return '--:--';
  const total = Math.round(minutes) % 1440;
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}
// Счётчик до начала намаза
export function prayerCountdown(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) return 'через ' + hours + ' ч ' + mins + ' мин';
  if (hours) return 'через ' + hours + ' ч';
  return 'через ' + mins + ' мин';
}
// Строки списка: свёрнуто — две, развёрнуто — все шесть по порядку
export function prayerRows(view) {
  if (!prayerShowAll) return view.shown;

  const rows = [];
  PRAYER_ORDER.forEach(function (key) {
    const min = view.times[key];
    if (min === null || min === undefined) return;
    rows.push({ key: key, min: min, tomorrow: false });
  });
  return rows;
}
export function renderPrayerList(view) {
  const list = document.getElementById('prayer-list');
  if (!list) return;

  list.innerHTML = prayerRows(view).map(function (entry) {
    const classes = ['prayer-row'];
    if (entry.key === 'sunrise') classes.push('is-sunrise');

    const isCurrent = view.current === entry.key && !entry.tomorrow;
    if (isCurrent) classes.push('is-current');

    // Счётчик стоит у следующего намаза и только у него: у текущего он
    // читался бы как «до конца намаза», а это неправда
    const isNext = !!view.next && view.next.key === entry.key &&
      view.next.tomorrow === entry.tomorrow && !isCurrent;
    const countdown = isNext
      ? '<span class="prayer-countdown">' +
        escapeHtml(prayerCountdown(view.next.min - view.now)) + '</span>'
      : '';

    return '<div class="' + classes.join(' ') + '" data-prayer="' +
      escapeHtml(entry.key) + '">' +
      '<span class="prayer-row-name">' + escapeHtml(PRAYER_LABELS[entry.key]) + '</span>' +
      '<span class="prayer-row-right">' + countdown +
      '<span class="prayer-row-time">' + escapeHtml(prayerClock(entry.min)) +
      '</span></span></div>';
  }).join('');
}
// Кольцо показывает долю пути от прошлого события до следующего: по ней
// видно, много ли осталось, не заводя второй шкалы.
export function renderPrayerRing(view) {
  const ring = document.getElementById('prayer-ring-progress');
  if (!ring) return;

  const length = 2 * Math.PI * 88;
  ring.setAttribute('stroke-dasharray', String(length));

  if (!view.next) {
    ring.setAttribute('stroke-dashoffset', String(length));
    return;
  }

  let from = 0;
  PRAYER_ORDER.forEach(function (key) {
    const min = view.times[key];
    if (min !== null && min !== undefined && min <= view.now) {
      from = Math.max(from, min);
    }
  });

  const span = view.next.min - from;
  const done = span > 0 ? Math.min(1, Math.max(0, (view.now - from) / span)) : 0;
  ring.setAttribute('stroke-dashoffset', String(length * (1 - done)));
}
export function renderPrayerTimes() {
  const view = prayerViewState();
  if (!view) return;

  const name = document.getElementById('prayer-next-name');
  const time = document.getElementById('prayer-next-time');
  if (name) name.textContent = view.next ? PRAYER_LABELS[view.next.key] : '';
  if (time) time.textContent = view.next ? prayerClock(view.next.min) : '--:--';
  setHidden('prayer-next-hint', !(view.next && view.next.tomorrow));

  renderPrayerRing(view);
  renderPrayerList(view);

  const showAll = document.getElementById('prayer-show-all');
  if (showAll) showAll.textContent = prayerShowAll ? 'Свернуть' : 'Показать все';
}
// Пока координат нет, вместо времён показывается приветственный экран
export function renderPrayerView() {
  const saved = loadPrayer();
  setHidden('prayer-welcome', !!saved);
  setHidden('prayer-times', !saved);

  prayerRenderedDay = prayerDateISO(new Date());
  if (!saved) return;

  renderPrayerTimes();
}
export function renderPrayerSettings() {
  const saved = loadPrayer();

  const coords = document.getElementById('prayer-coords');
  if (coords) {
    coords.textContent = saved
      ? 'Широта ' + saved.lat + ' · Долгота ' + saved.lng
      : 'Координат нет — времена намазов не считаются.';
  }

  renderPrayerMadhhab(saved ? saved.madhhab : 'shafi');
  renderPrayerMethod(saved ? saved.method : PRAYER_METHOD_DEFAULT);
}
export function renderPrayerMethod(method) {
  const box = document.getElementById('prayer-method');
  if (!box) return;

  box.innerHTML = PRAYER_METHODS.map(function (key) {
    const active = key === method;
    return '<label class="prayer-method-option' + (active ? ' is-active' : '') + '">' +
      '<input type="radio" class="prayer-method-radio" name="prayer-method" value="' +
      escapeHtml(key) + '"' + (active ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(PRAYER_METHOD_LABELS[key]) + '</span></label>';
  }).join('');
}
export function markPrayerMethod(method) {
  document.querySelectorAll('#prayer-method .prayer-method-option')
    .forEach(function (option) {
      const input = option.querySelector('input');
      option.classList.toggle('is-active', !!input && input.value === method);
    });
}
export function renderPrayerMadhhab(madhhab) {
  const box = document.getElementById('prayer-madhhab');
  if (!box) return;

  box.innerHTML = PRAYER_MADHHABS.map(function (key) {
    const active = key === madhhab;
    return '<label class="prayer-madhhab-option' + (active ? ' is-active' : '') + '">' +
      '<input type="radio" class="prayer-madhhab-radio" name="prayer-madhhab" value="' +
      escapeHtml(key) + '"' + (active ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(PRAYER_MADHHAB_LABELS[key]) + '</span></label>';
  }).join('');
}
// Подсветка выбранной пилюли без пересборки разметки: пересборка внутри
// события change уносит элемент, по которому только что нажали
export function markPrayerMadhhab(madhhab) {
  document.querySelectorAll('#prayer-madhhab .prayer-madhhab-option')
    .forEach(function (option) {
      const input = option.querySelector('input');
      option.classList.toggle('is-active', !!input && input.value === madhhab);
    });
}
// Раз в минуту: счётчик до следующего намаза и смена суток. В полночь
// пересобирается весь день — времена-то у него свои. Вкладка скрыта — тик
// пропускается: расчёт двух дней и перерисовка ленты вслепую ничего не дают,
// а вход на вкладку всё равно собирает экран заново через ROUTE_RENDER.
export function prayerTick() {
  const view = document.getElementById('prayer-view');
  if (!view || view.hidden) return;
  if (prayerDateISO(new Date()) !== prayerRenderedDay) {
    renderPrayerView();
    return;
  }
  renderPrayerTimes();
}
// После смены координат или мазхаба перерисовываются оба экрана: они читают
// один и тот же ключ
export function afterPrayerChange() {
  renderPrayerView();
  renderPrayerSettings();
}
// Разбор координаты. Запятая вместо точки — обычная опечатка мобильной
// клавиатуры, поэтому принимается наравне с точкой.
export function prayerParseCoord(value, limit) {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = raw.trim().replace(',', '.');
  if (!text) return null;

  const num = Number(text);
  if (!isFinite(num) || num < -limit || num > limit) return null;
  return prayerRound(num);
}
// Геолокация — единственный способ, который может отказать не по вине
// пользователя, поэтому отказ объясняется словами, а не молчанием.
// Экран без своей строки для пояснений (настройки) говорит тостом.
export function requestPrayerLocation(noteId, onDone) {
  const note = noteId ? document.getElementById(noteId) : null;
  const say = function (message) {
    if (note) { note.textContent = message; return; }
    if (message) showToast(message);
  };

  if (!navigator.geolocation) {
    say('Геолокация недоступна. Введите координаты вручную.');
    return;
  }

  say('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(function (position) {
    say('');
    onDone(prayerRound(position.coords.latitude),
      prayerRound(position.coords.longitude));
  }, function () {
    say('Не удалось определить местоположение. Введите координаты вручную.');
  }, { timeout: 10000, maximumAge: 600000 });
}
// Сохраняет координаты, не трогая выбранные мазхаб и метод расчёта.
// Возвращает boolean результата записи: перерисовка — забота вызывающих.
export function applyPrayerCoords(lat, lng) {
  const saved = loadPrayer();
  // savePrayer при невалидных координатах возвращает undefined — приводим
  // результат к строгому boolean, как у успешной/неуспешной записи.
  return savePrayer({
    lat: lat,
    lng: lng,
    madhhab: saved ? saved.madhhab : 'shafi',
    method: saved ? saved.method : PRAYER_METHOD_DEFAULT,
  }) === true;
}
export function onPrayerGeo() {
  requestPrayerLocation('prayer-welcome-note', function (lat, lng) {
    if (!applyPrayerCoords(lat, lng)) return;
    afterPrayerChange();
  });
}
export function onPrayerRefresh() {
  requestPrayerLocation(null, function (lat, lng) {
    if (!applyPrayerCoords(lat, lng)) return;
    afterPrayerChange();
    showToast('Координаты обновлены');
  });
}
export function onPrayerManualSave() {
  const latEl = document.getElementById('prayer-lat');
  const lngEl = document.getElementById('prayer-lng');
  const note = document.getElementById('prayer-welcome-note');

  // Широта — тот же порог, что у prayerTimes (89.8). Иначе ввод
  // 89.9 принимался бы полем и молча отбрасывался savePrayer
  // (§11aa, B4).
  const lat = prayerParseCoord(latEl ? latEl.value : '', 89.8);
  const lng = prayerParseCoord(lngEl ? lngEl.value : '', 180);

  if (lat === null || lng === null) {
    if (note) note.textContent = 'Широта — число от −89.8 до 89.8, долгота — от −180 до 180.';
    return;
  }

  if (note) note.textContent = '';
  if (!applyPrayerCoords(lat, lng)) return;
  afterPrayerChange();
}
export function onPrayerMadhhabChange(event) {
  const value = event.target && event.target.value;
  if (!PRAYER_SHADOW[value]) return;

  const saved = loadPrayer();
  if (!saved) return;
  if (!savePrayer({ lat: saved.lat, lng: saved.lng, madhhab: value, method: saved.method })) return;

  // Настройки не пересобираются целиком — только подсветка: экран молитв
  // мог быть открыт, и он перерисовывается под новый мазхаб
  markPrayerMadhhab(value);
  renderPrayerView();
}
export function onPrayerMethodChange(event) {
  const value = event.target && event.target.value;
  if (PRAYER_METHODS.indexOf(value) < 0) return;

  const saved = loadPrayer();
  if (!saved) return;
  if (!savePrayer({ lat: saved.lat, lng: saved.lng, madhhab: saved.madhhab, method: value })) return;

  markPrayerMethod(value);
  renderPrayerView();
}
export function onPrayerShowAll() {
  prayerShowAll = !prayerShowAll;
  renderPrayerTimes();
}

// Единственный таймер экрана молитв: раз в минуту обновляются счётчик и
// окно намаза, в полночь экран пересобирается целиком. Перезапуск таймера
// живёт здесь: переприсваивать импортированный let из app.js нельзя.
export function startPrayerClock() {
  if (prayerTimer) clearInterval(prayerTimer);
  prayerTimer = setInterval(prayerTick, 60000);
}

// Вход на вкладку из switchAppView: список времён открывается свёрнутым,
// «Показать все» — разовый взгляд, а не настройка
export function resetPrayerShowAll() {
  prayerShowAll = false;
}
