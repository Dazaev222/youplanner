// Координаты и мазхаб живут одним ключом и ходят на сервер одним разделом,
// как каза. Ключа нет — координаты не заданы: это и есть первый
// запуск, по нему показывается приветственный экран.
const PRAYER_KEY = 'youplanner.prayer';
// Часовой пояс расчёта. Расписание ДУМ ЧР публикуется по московскому времени,
// перевода часов в России нет, поэтому пояс задан числом и от настроек
// устройства не зависит: иначе у телефона в другом поясе времена уехали бы.
const PRAYER_TZ = 3;
// Мазхаб влияет только на Аср: во сколько раз тень предмета должна превысить
// его высоту. Ханафитский — ×2, шафиитский — ×1, как в методе ДУМ ЧР (§11q).
const PRAYER_SHADOW = { shafi: 1, hanafi: 2 };
const PRAYER_MADHHABS = ['shafi', 'hanafi'];
const PRAYER_MADHHAB_LABELS = { shafi: 'Шафиитский', hanafi: 'Ханафитский' };
// Метод расчёта. Отличаются только Зухром: ДУМ ЧР закрепляет его на 12:30
// круглый год, астрономический берёт истинный солнечный полдень.
const PRAYER_METHODS = ['dum-chr', 'astro'];
const PRAYER_METHOD_LABELS = { 'dum-chr': 'ДУМ ЧР', astro: 'Астрономический' };
const PRAYER_METHOD_DEFAULT = 'dum-chr';
// Порядок времён в списке. Восход — не намаз, но он строка списка и участвует
// в «следующем»: пользователь видит его время и ждёт его появления.
const PRAYER_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const PRAYER_LABELS = {
  fajr: 'Фаджр', sunrise: 'Восход', dhuhr: 'Зухр',
  asr: 'Аср', maghrib: 'Магриб', isha: 'Иша',
};
// Окна намазов: [начало, конец). Восход окна не имеет — это не намаз, а
// граница утреннего. Иша тянется до полуночи: её продолжение после 00:00
// принадлежит уже следующему дню, и экран за него не отвечает.
const PRAYER_WINDOWS = [
  ['fajr', 'sunrise'], ['dhuhr', 'asr'], ['asr', 'maghrib'],
  ['maghrib', 'isha'], ['isha', null],
];
// Углы метода ДУМ ЧР: Фаджр — 16° под горизонтом, Иша — 15°.
const PRAYER_FAJR_ANGLE = 16;
const PRAYER_ISHA_ANGLE = 15;
// Восход и закат: 0,833° — высота с учётом рефракции и радиуса диска
const PRAYER_HORIZON_ANGLE = 0.833;
// Зухр метода ДУМ ЧР: закреплён на 12:30 круглый год, а не солнечный полдень.
// Постоянных правок в минутах нет и не нужно: чистый расчёт с этими углами
// и тенью ×1 совпадает с эталоном ДУМ ЧР на весь сентябрь 2026 в пределах
// минуты (§11q, §13).
const PRAYER_DHUHR_FIXED = 12 * 60 + 30;

function prayerRad(deg) { return deg * Math.PI / 180; }
function prayerDeg(rad) { return rad * 180 / Math.PI; }
// Угол в [0, 360)
function prayerFixAngle(a) { return a - 360 * Math.floor(a / 360); }
// Час в [0, 24)
function prayerFixHour(a) { return a - 24 * Math.floor(a / 24); }
// Юлианский день на 00:00 UTC указанной даты
function prayerJulian(iso) {
  const parts = String(iso).split('-');
  let year = Number(parts[0]);
  let month = Number(parts[1]);
  const day = Number(parts[2]);
  if (month <= 2) { year -= 1; month += 12; }
  const a = Math.floor(year / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) +
    day + b - 1524.5;
}
// Склонение Солнца (градусы) и уравнение времени (часы) — стандартные ряды
function prayerSun(jd) {
  const d = jd - 2451545.0;
  const g = prayerFixAngle(357.529 + 0.98560028 * d);
  const q = prayerFixAngle(280.459 + 0.98564736 * d);
  const l = prayerFixAngle(q + 1.915 * Math.sin(prayerRad(g)) +
    0.020 * Math.sin(prayerRad(2 * g)));
  const e = 23.439 - 0.00000036 * d;
  const ra = prayerFixHour(prayerDeg(Math.atan2(
    Math.cos(prayerRad(e)) * Math.sin(prayerRad(l)),
    Math.cos(prayerRad(l)))) / 15);
  return {
    declination: prayerDeg(Math.asin(Math.sin(prayerRad(e)) * Math.sin(prayerRad(l)))),
    equation: q / 15 - ra,
  };
}
// Времена намазов на дату — минуты от полуночи UTC+3 (§11q). null означает, что
// время в этот день не наступает: за полярным кругом Солнце не опускается на 16°
// под горизонт, и выдумывать вместо этого нечего.
// method — метод расчёта; неизвестный читается как метод по умолчанию, чтобы
// старый ключ без поля не ронял экран.
function prayerTimes(iso, lat, lng, madhhab, method) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -89.8 || lat > 89.8 || lng < -180 || lng > 180) return null;

  const factor = PRAYER_SHADOW[madhhab];
  if (!factor) return null;

  const mode = PRAYER_METHODS.indexOf(method) >= 0 ? method : PRAYER_METHOD_DEFAULT;

  // Солнце приходит в зенит не по часам пояса, а по своему положению, поэтому
  // долгота сдвигает и точку отсчёта, и поправку к часам
  const jDate = prayerJulian(iso) - lng / (15 * 24);
  const zone = PRAYER_TZ - lng / 15;

  const declination = function (hours) {
    return prayerSun(jDate + hours / 24).declination;
  };
  const noon = function (hours) {
    return prayerFixHour(12 - prayerSun(jDate + hours / 24).equation);
  };
  // Часовой угол для высоты angle (градусы) — в часах от полудня
  const angleTime = function (angle, hours) {
    const decl = declination(hours);
    const cosH = (-Math.sin(prayerRad(angle)) -
      Math.sin(prayerRad(decl)) * Math.sin(prayerRad(lat))) /
      (Math.cos(prayerRad(decl)) * Math.cos(prayerRad(lat)));
    if (cosH < -1 || cosH > 1) return null;
    return prayerDeg(Math.acos(cosH)) / 15;
  };
  // Аср: тень предмета сравнивается с его высотой. Угол выходит отрицательным
  // — это высота, отсчитанная вниз, как и у остальных времён
  const asrAngle = function (hours) {
    const decl = declination(hours);
    return -prayerDeg(Math.atan(1 / (factor +
      Math.tan(Math.abs(prayerRad(lat - decl))))));
  };

  // Часовое смещение от полудня → время суток. Фаджр и Восход отсчитываются
  // назад, остальные вперёд; null остаётся null — время не наступает.
  const at = function (offset, hours, direction) {
    if (offset === null) return null;
    return noon(hours) + direction * offset;
  };

  // Два прогона: первый берёт приблизительные времена, второй уточняет по ним
  // положение Солнца
  let hours = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, maghrib: 18, isha: 19 };
  let computed = null;

  for (let pass = 0; pass < 2; pass++) {
    const before = hours;
    computed = {
      fajr: at(angleTime(PRAYER_FAJR_ANGLE, before.fajr), before.fajr, -1),
      sunrise: at(angleTime(PRAYER_HORIZON_ANGLE, before.sunrise), before.sunrise, -1),
      dhuhr: noon(before.dhuhr),
      asr: at(angleTime(asrAngle(before.asr), before.asr), before.asr, 1),
      maghrib: at(angleTime(PRAYER_HORIZON_ANGLE, before.maghrib), before.maghrib, 1),
      // Иша считается по своему положению Солнца, а не промежутком от Магриба:
      // 15° под горизонтом — угол метода ДУМ ЧР
      isha: at(angleTime(PRAYER_ISHA_ANGLE, before.maghrib), before.maghrib, 1),
    };
    hours = computed;
  }

  const result = {};
  PRAYER_ORDER.forEach(function (key) {
    const value = computed[key];
    result[key] = value === null || value === undefined ? null : (value + zone) * 60;
  });

  // Зухр берётся из метода: у ДУМ ЧР это закреплённые 12:30, у астрономического
  // остаётся посчитанный выше истинный полдень
  if (mode === PRAYER_METHOD_DEFAULT) result.dhuhr = PRAYER_DHUHR_FIXED;

  return result;
}
// Дата по UTC+3 в формате 'YYYY-MM-DD'. Именно пояс расчёта, а не пояс
// устройства: времена намазов не должны зависеть от того, где сейчас телефон.
function prayerDateISO(date) {
  return new Date(date.getTime() + PRAYER_TZ * 3600000).toISOString().slice(0, 10);
}
// Минуты от полуночи UTC+3
function prayerMinutes(date) {
  const shifted = new Date(date.getTime() + PRAYER_TZ * 3600000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes() +
    shifted.getUTCSeconds() / 60 + shifted.getUTCMilliseconds() / 60000;
}
// Пять знаков после запятой — столько же даёт геолокация
function prayerRound(value) {
  return Math.round(value * 100000) / 100000;
}
// Чтение с проверкой: битый ключ читается как «координат нет», а не роняет
// расчёт. Мазхаб вне списка — шафиитский.
function loadPrayer() {
  try {
    const raw = localStorage.getItem(PRAYER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const lat = Number(parsed.lat);
    const lng = Number(parsed.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    // Широта ограничена тем же порогом, что у prayerTimes (89.8):
    // иначе координата в полосе (89.8; 90] проходит валидацию,
    // приветственный экран скрывается, а расчёт отдаёт null — экран
    // времён остаётся пустым без объяснения (§11aa, B4).
    if (lat < -89.8 || lat > 89.8 || lng < -180 || lng > 180) return null;

    return {
      lat: lat,
      lng: lng,
      madhhab: PRAYER_SHADOW[parsed.madhhab] ? parsed.madhhab : 'shafi',
      // Ключ без поля — состояние до §11q: читается как метод ДУМ ЧР
      method: PRAYER_METHODS.indexOf(parsed.method) >= 0 ? parsed.method : PRAYER_METHOD_DEFAULT,
    };
  } catch (e) {
    return null;
  }
}
// Раздел уходит наверх тем же отложенным PUT, что привычки и каза
function savePrayer(prayer) {
  const lat = Number(prayer && prayer.lat);
  const lng = Number(prayer && prayer.lng);
  if (!isFinite(lat) || !isFinite(lng)) return;
  if (lat < -89.8 || lat > 89.8 || lng < -180 || lng > 180) return;

  if (!safeSetItem(PRAYER_KEY, JSON.stringify({
    lat: lat,
    lng: lng,
    madhhab: PRAYER_SHADOW[prayer.madhhab] ? prayer.madhhab : 'shafi',
    method: PRAYER_METHODS.indexOf(prayer.method) >= 0 ? prayer.method : PRAYER_METHOD_DEFAULT,
  }))) return false;
  bus.emit('data:changed');
  return true;
}
