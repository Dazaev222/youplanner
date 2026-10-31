// HTTP-клиент ассистента (вынесен из assistant-view.js, этап D.5).
//
// Один ход к OpenAI-совместимому эндпоинту neuraldeep.ru: успех — строка
// ответа, любая ошибка — отвергнутый промис с готовым текстом для пузыря
// чата. 401/403 помечены в тексте, чтобы ассистент поднял модалку ключа.
//
// Сборка payload (модель, системный промпт с данными трекера) и чтение
// ключа остаются в assistant-view.js: это состояние ассистента, клиенту
// они приходят аргументами.

import { handleNetworkError } from '../core/dom.js';

// OpenAI-совместимый эндпоинт neuraldeep.ru. Список моделей — каталог
// NeuralDeep (llms.txt); живёт в assistant-view.js рядом с модалкой настроек.
const ASSISTANT_API_URL = 'https://api.neuraldeep.ru/v1/chat/completions';
// 60 секунд: длинные ответы reasoning-моделей (qwen/gpt-oss думают вслух)
// не успевали в 30, и запрос рвался по таймауту на «Нет связи»
const REQUEST_TIMEOUT_MS = 60000;

function friendlyError(status) {  if (status === 401 || status === 403) {
    return 'Ключ не принят сервисом (ошибка ' + status
      + '). Проверьте ключ через шестерёнку в шапке.';
  }
  if (status === 429) {
    return 'Сервис отвечает «слишком много запросов» (429). Попробуйте через минуту.';
  }
  if (status >= 500) {
    return 'Сервис нейросети сейчас недоступен (ошибка ' + status + '). Попробуйте позже.';
  }
  return 'Сервис вернул неожиданный ответ (ошибка ' + status + ').';
}

// AbortSignal.timeout появился в Safari только в 15.4: на старых iPhone
// его вызов кидал TypeError, и каждый запрос мгновенно падал в «Нет связи».
// Ручной контроллер работает везде, поэтому подстраховываем им. Таймер
// возвращается вместе с сигналом: короткий ответ иначе оставлял бы его
// жить до истечения таймаута.
function timeoutGuard(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return { signal: AbortSignal.timeout(ms), cancel: function () {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  return {
    signal: controller.signal,
    cancel: function () { clearTimeout(timer); },
  };
}

// payload — готовое тело запроса { model, messages } из assistant-view.js;
// apiKey — сохранённый на устройстве ключ. Имя наружу не «requestAssistantReply»:
// под этим именем в assistant-view.js осталась тонкая обёртка, собирающая
// payload из состояния ассистента (её зовут тесты таймеров).
export async function postAssistantChat(payload, apiKey) {
  let response;
  const guard = timeoutGuard(REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(ASSISTANT_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: guard.signal,
    });
  } catch (e) {
    // Реальная причина — в консоль (helper), текст — в ленту: TypeError
    // (сеть/CORS/старый API) и TimeoutError/AbortError видны только так.
    const timedOut = e && e.name === 'TimeoutError';
    throw new Error(handleNetworkError(e, {
      context: '[assistant]',
      silent: true,
      message: timedOut
        ? 'Сервис не ответил за 60 секунд. Попробуйте ещё раз.'
        : 'Нет связи с сервисом нейросети. Подробности — в консоли браузера (F12).',
    }));
  } finally {
    // Таймер больше не нужен при любом исходе запроса
    guard.cancel();
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch (e) {
      // тело ошибки не прочиталось — статус уже показан ниже
    }
    console.error('[assistant] HTTP ' + response.status, ASSISTANT_API_URL, detail);
    throw new Error(friendlyError(response.status));
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error('Сервис вернул ответ не в формате JSON. Попробуйте позже.');
  }

  const reply = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error('Сервис ответил пустым сообщением. Попробуйте переформулировать вопрос.');
  }
  return reply.trim();
}
