// Анонимная аутентификация Firebase через REST identitytoolkit.
// Firebase SDK в проекте запрещён (ни одной сторонней библиотеки), поэтому
// протокол говорим напрямую двумя POST-запросами: знакомому устройству —
// обмен refresh-токена на свежий idToken, новому — signUp (анонимный
// аккаунт). Токен прикладывается к запросам синхронизации параметром ?auth=
// централизованно, в единственной обёртке fetchWithTimeout (js/sync/sync.js):
// правило базы auth != null закрывает все узлы сразу (database.rules.json).
//
// Контракт: getAuthToken() разрешается строкой idToken либо null. null —
// «аутентификация недоступна, работаем как раньше»: синк обязан продолжаться
// без токена (до публикации правил база публична — это рабочий режим).
// Любая причина — пустой ключ, офлайн, отказ сервера, битый ответ — даёт
// null и не бросает исключений: auth здесь расходник, а не условие работы
// приложения.

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

// Знакомому устройству — обмен refresh-токена, новому — signUp. Отдельная
// функция: повтор после отказа обмена зовёт её же, URL не дублируется.
function signUpPost() {
  return authPost(
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(FIREBASE_WEB_API_KEY),
    { returnSecureToken: true },
  );
}

// Свежий токен из сети: обмен сохранённого refresh-токена либо заведение
// анонимного аккаунта signUp'ом. Бросает при любой неудаче — глотает
// getAuthToken() ниже.
async function requestFreshToken() {
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
      try {
        localStorage.removeItem(AUTH_REFRESH_KEY);
      } catch (e) {
        // глотаем: недоступное хранилище не мешает signUp-повтору
      }
      response = await signUpPost();
    }
  } else {
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
