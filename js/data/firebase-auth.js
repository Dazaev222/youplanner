// Аутентификация Firebase через REST identitytoolkit: двух режимов.
// Firebase SDK в проекте запрещён (ни одной сторонней библиотеки), поэтому
// протокол говорим напрямую POST-запросами.
//
// 1. Анонимный (режим по умолчанию): знакомому устройству — обмен
//    refresh-токена на свежий idToken, новому — signUp, который заводит
//    анонимный аккаунт. У анонимного аккаунта UID свой на каждое устройство,
//    поэтому он годится только пока база публична.
// 2. Постоянный аккаунт владельца: вход по email/паролю
//    (accounts:signInWithPassword). Все устройства хозяина входят в один и
//    тот же аккаунт, его uid — единственный, который database.rules.json
//    пишет в .read/.write. С этого момента анонимный signUp запрещён:
//    молча заведённый анонимный аккаунт дал бы токен с чужим uid, правила
//    ответили бы PERMISSION_DENIED, и синхронизация пропала бы без причины.
//
// Токен прикладывается к запросам синхронизации параметром ?auth=
// централизованно, в единственной обёртке fetchWithTimeout (js/sync/sync.js).
//
// Контракт: getAuthToken() разрешается строкой idToken либо null. null —
// «аутентификации нет, работаем локально»: синк обязан продолжаться без
// токена и владеть умением различить 403 (см. sync:denied там же).
// Любая причина — пустой ключ, офлайн, отказ сервера, битый ответ, нет
// сессии владельца — даёт null и не бросает исключений: auth здесь расходник,
// а не условие работы приложения. ownerSignIn() — единственное место, где
// неудача бросается наружу: её показывает человек, нажавший «Войти».

// Web API Key web-приложения Firebase. Владелец вписывает ключ из Firebase
// Console (Project settings → General): ключ web-приложений не секрет —
// он идентифицирует проект, а не пользователя, и свободно живёт в клиентском
// коде. Пустая строка = аутентификация выключена целиком, сеть не дёргается.
// let, а не const: setFirebaseApiKey() ниже переписывает ключ из тестов,
// не редактируя исходник.
export let FIREBASE_WEB_API_KEY = 'AIzaSyDux6B8kQ7jmZ_txjxlb2KRHhURawuivTk';

// Refresh-токен устройства. Сознательно НЕ в STORAGE_KEYS (js/data/storage.js):
// как api_key ассистента, это локальная механика устройства, а не данные
// пользователя — в синхронизацию, копии и экспорт он не входит.
export const AUTH_REFRESH_KEY = 'youplanner.fb.refresh';

// Запись постоянного аккаунта владельца: {"email":"…","uid":"…"}. По ней
// приложение узнаёт режим владельца, и по ней же человек читает UID, который
// нужно вшить в database.rules.json (uid выдаёт Firebase, в коде его нет).
// Пароль тут не хранится намеренно: только refresh-токен, как у анонимного
// режима. Ключ также НЕ в STORAGE_KEYS — по тем же причинам.
export const AUTH_OWNER_KEY = 'youplanner.fb.owner';

// Пауза после неудачи аутентификации. Синк зовёт getAuthToken() перед каждым
// обменом (до пяти раз за отправку): офлайн не должен платить сетевой
// попыткой каждый раз, поэтому после первой же неудачи 5 минут отвечаем
// null сразу, не выходя в сеть.
const AUTH_PAUSE_MS = 5 * 60 * 1000;

// Свой таймаут auth-запросов, короче синкового (там 20 с): токен — расходник,
// и долгий висяк аутентификации откладывал бы каждый обмен данными.
const AUTH_TIMEOUT_MS = 5000;

// Память модуля, не localStorage: кэш токена { token, expiresAt } и метка,
// до которой сеть не дёргаем. Перезагрузка страницы их теряет — refresh-токен
// в localStorage переживает её без повторного signUp'а.
let authCache = null;
let authPausedUntil = 0;
// Копия записи владельца. Нужна на случай недоступного хранилища (приватный
// режим Safari, квота): сессия, введённая в этой вкладке, не должна
// соскальзывать в анонимный режим — он запрещён ровно тем фактом входа.
let ownerAccount = null;

// Точка конфигурации и тестов: владелец правит константу выше в файле,
// песочница и тесты подставляют ключ этой функцией, исходник не трогая.
export function setFirebaseApiKey(key) {
  FIREBASE_WEB_API_KEY = String(key || '');
}

// Сброс памяти модуля между кейсами: кэш и пауза стираются, localStorage
// не трогается — персистентность refresh-токена проверяется поверх него.
export function resetAuthForTests() {
  authCache = null;
  authPausedUntil = 0;
  ownerAccount = null;
}

// Тот же маленький guard, что timeoutGuard в js/ui/assistant-view.js и
// syncGuard в js/sync/sync.js: AbortSignal.timeout появился в Safari только
// в 15.4, и вызов на старых iPhone кидал TypeError. Локальная копия,
// а не импорт: оба оригинала живут в своих слоях (ui и sync), и тянуть
// auth-механику к ним — неверное направление зависимостей.
function authTimeoutGuard(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return { signal: AbortSignal.timeout(ms), cancel: function () {} };
  }
  // Песочницы без Abort API (юнит-тесты, старые движки) ходят без сигнала:
  // отсутствие таймаута лучше падения каждого запроса
  if (typeof AbortController === 'undefined') {
    return { signal: undefined, cancel: function () {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  return {
    signal: controller.signal,
    cancel: function () { clearTimeout(timer); },
  };
}

// POST к одному из двух auth-доменов. Обычный fetch, НЕ fetchWithTimeout
// синка: та единственная обёртка — для данных, и она сама зовёт
// getAuthToken(), отсюда вышло бы зацикливание.
function authPost(url, body) {
  const guard = authTimeoutGuard(AUTH_TIMEOUT_MS);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: guard.signal,
  }).finally(guard.cancel);
}

// Ответы обоих эндпоинтов сводятся к трём полям. signUp зовёт их
// idToken/refreshToken/expiresIn, обмен refresh-токена (securetoken) —
// id_token/refresh_token/expires_in: единая форма экономит ветвление выше.
function parseAuthResponse(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    idToken: data.idToken || data.id_token || '',
    refreshToken: data.refreshToken || data.refresh_token || '',
    expiresIn: Number(data.expiresIn || data.expires_in) || 0,
  };
}

// Refresh-токен — расходник: не сохранился (квота, приватный режим) —
// в следующий раз просто заведём аккаунт заново, данные это не затрагивает.
function saveRefreshToken(refreshToken) {
  if (!refreshToken) return;
  try {
    localStorage.setItem(AUTH_REFRESH_KEY, refreshToken);
  } catch (e) {
    // сознательно глотаем: неудача сохранения не влияет на выдачу токена
  }
}

/* ---------- Постоянный аккаунт владельца ---------------------------------- */

// Запись владельца: сначала память модуля, потом localStorage. битый JSON или
// запись без uid — то же самое, что «владельца нет»: молчаливый возврат к
// анонимному режиму здесь безопаснее, чем падение каждого обмена.
function readOwnerRecord() {
  if (ownerAccount) return ownerAccount;
  let raw = null;
  try {
    raw = localStorage.getItem(AUTH_OWNER_KEY);
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.uid) return null;
  ownerAccount = { email: String(parsed.email || ''), uid: String(parsed.uid) };
  return ownerAccount;
}

// Кому показывать UID: Настройки пишут эту строку после входа, чтобы владелец
// мог перенести её в database.rules.json. null = приложение работает анонимно.
export function getOwnerAccount() {
  return readOwnerRecord();
}

// Вход постоянного аккаунта. Бросает Error с причиной — единственный вызов
// модуля, где неудача уходит наружу: её зовёт человек, нажавший «Войти».
// Пароль живёт только время этого вызова: ни в localStorage, ни в текст
// ошибки, ни в console.log он не попадает.
export async function ownerSignIn(email, password) {
  const login = String(email || '').trim();
  const secret = String(password || '');
  if (!login) throw new Error('Нужен email аккаунта владельца');
  if (!secret) throw new Error('Нужен пароль аккаунта владельца');
  if (!FIREBASE_WEB_API_KEY) {
    // Пустой ключ = «аутентификации нет». Причина для человека бывает две:
    // ключ правда не вписан в исходник (локальная копия) или браузер держит
    // СТАРУЮ версию этого модуля из кэша service worker — вход тогда падает
    // ровно с этой надписью при целом исходнике. Оба выхода названы, иначе
    // человек правит файл, который и так правильный.
    throw new Error('Ключ Firebase-проекта не задан. Обновите страницу (Ctrl+Shift+R) — ' +
      'старая версия модуля в кэше. Если не поможет, ключ вписывают в js/data/firebase-auth.js');
  }

  const response = await authPost(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(FIREBASE_WEB_API_KEY),
    { email: login, password: secret, returnSecureToken: true },
  );

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    data = null;
  }
  const parsed = parseAuthResponse(data);
  // localId — UID аккаунта, он же то, что вшивается в правила. Ответ
  // signInWithPassword обязан его содержать: без него нечего сказать
  // владельцу про database.rules.json, поэтому битый ответ — отказ входа,
  // а не половина настроенной сессии.
  //
  // refreshToken обязателен по той же причине, но хитрее: без него в
  // AUTH_REFRESH_KEY остался бы СТАРЫЙ анонимный ключ, обмен ходил бы по нему,
  // а правила по uid отвечали бы 403 вечно — при видимом «входе выполнен».
  const uid = data && data.localId ? String(data.localId) : '';
  if (!response.ok || !parsed || !parsed.idToken || !parsed.refreshToken ||
      parsed.expiresIn <= 0 || !uid) {
    const reason = (data && data.error && data.error.message)
      ? data.error.message
      : 'ответ без idToken, refresh-токена или uid (HTTP ' + response.status + ')';
    throw new Error('Вход не принят: ' + reason);
  }

  ownerAccount = { email: login, uid: uid };
  try {
    localStorage.setItem(AUTH_OWNER_KEY, JSON.stringify(ownerAccount));
  } catch (e) {
    // Хранилище недоступно: до перезагрузки страницы запись живёт в памяти
    // модуля, после — приложение станет анонимным, и вход нужно повторить.
  }
  // Refresh-токен владельца приходит в ответе входа: с этой минуты устройство
  // перезаписывает анонимный ключ в AUTH_REFRESH_KEY и живёт по новому.
  saveRefreshToken(parsed.refreshToken);
  authCache = {
    token: parsed.idToken,
    expiresAt: Date.now() + (parsed.expiresIn - 300) * 1000,
  };
  // Пауза после прошлой неудачи не должна глушить только что купленный токен
  authPausedUntil = 0;
  return ownerAccount;
}

// Выход: снимается и запись владельца, и refresh-токен. Оставить токен —
// значит оставить устройство ходить в базу чужим (владельческим) uid после
// того, как человек нажал «Выйти».
export function ownerSignOut() {
  ownerAccount = null;
  authCache = null;
  authPausedUntil = 0;
  try {
    localStorage.removeItem(AUTH_OWNER_KEY);
    localStorage.removeItem(AUTH_REFRESH_KEY);
  } catch (e) {
    // глотаем: недоступное хранилище — то же самое, что стёртое
  }
}

// Знакомому устройству — обмен refresh-токена, новому — signUp. Отдельная
// функция: повтор после отказа обмена зовёт её же, URL не дублируется.
function signUpPost() {  return authPost(
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(FIREBASE_WEB_API_KEY),
    { returnSecureToken: true },
  );
}

// Свежий токен из сети: обмен сохранённого refresh-токена либо заведение
// анонимного аккаунта signUp'ом. Бросает при любой неудаче — глотает
// getAuthToken() ниже.
async function requestFreshToken() {
  const owner = readOwnerRecord();
  let refreshToken = null;
  try {
    refreshToken = localStorage.getItem(AUTH_REFRESH_KEY);
  } catch (e) {
    refreshToken = null;
  }

  let response;
  if (refreshToken) {
    response = await authPost(
      'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(FIREBASE_WEB_API_KEY),
      { grant_type: 'refresh_token', refresh_token: refreshToken },
    );
    if (!response.ok) {
      // Сервер отклонил обмен (400 INVALID_REFRESH_TOKEN): токен протух или
      // отозван, и хранить его дальше значило бы умирать вечно — синк без
      // токена не поднимался бы никогда. Ключ стирается, запрос повторяется
      // один раз свежим signUp'ом: заводится новый анонимный аккаунт, данные
      // это не затрагивает. Сетевой сбой сюда не попадает: бросок await выше
      // уходит в getAuthToken() до этой ветки, живой токен не стирается.
      // Стирать ключ вправе только 4xx — отказ САМОГО обмена: временный
      // сбой сервера (5xx) не доказывает смерть токена, и стирать живой
      // ключ после него нельзя — иначе минута серверной 503 заводила бы
      // устройству новый анонимный аккаунт (аудит 2026-10-31).
      if (response.status < 400 || response.status >= 500) {
        throw new Error('auth-сервер ответил ' + response.status);
      }
      try {
        localStorage.removeItem(AUTH_REFRESH_KEY);
      } catch (e) {
        // глотаем: недоступное хранилище не мешает signUp-повтору
      }
      // В режиме владельца повторный signUp запрещён: новый анонимный uid
      // правила по auth.uid отвергли бы, и синхронизация пропала бы с видом
      // «работает, но пусто». Человек узнаёт о потере сессии из Настроек.
      if (owner) {
        throw new Error('Сессия владельца потеряна — нужно войти заново');
      }
      response = await signUpPost();
    }
  } else {
    if (owner) {
      throw new Error('Нет сессии владельца — нужно войти в Настройках');
    }
    response = await signUpPost();
  }
  if (!response.ok) throw new Error('auth-сервер ответил ' + response.status);
  const parsed = parseAuthResponse(await response.json());
  if (!parsed || !parsed.idToken || parsed.expiresIn <= 0) {
    throw new Error('битый ответ: нет idToken или expiresIn');
  }
  saveRefreshToken(parsed.refreshToken);
  return parsed;
}

// Единственная точка добычи токена. Сеть платится раз в час жизни токена;
// всё остальное — кэш, пауза или пустой ключ, без единого запроса.
export async function getAuthToken() {
  if (!FIREBASE_WEB_API_KEY) {
    // Ключ не вписан: аутентификация выключена целиком, без сети
    return null;
  }
  if (authCache && Date.now() < authCache.expiresAt) {
    return authCache.token;
  }
  if (Date.now() < authPausedUntil) {
    // Недавно неудачно: сеть не дёргаем до конца паузы
    return null;
  }
  try {
    const parsed = await requestFreshToken();
    authCache = {
      token: parsed.idToken,
      // Запас 5 минут до заявленного истечения: токен обязан дожить до
      // прикладывания к запросу данных, а не истечь в пути
      expiresAt: Date.now() + (parsed.expiresIn - 300) * 1000,
    };
    return authCache.token;
  } catch (e) {
    // Причина — в консоль (в стиле [assistant]/[сеть]): наверх уходит только
    // null, синк сам продолжает без токена
    console.error('[firebase-auth] токен не получен:', e);
    authPausedUntil = Date.now() + AUTH_PAUSE_MS;
    return null;
  }
}
