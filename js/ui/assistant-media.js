// Медиа-подсистемы ассистента: HTTP-клиент и фото/сжатие vision-вложений.
// Оба модуля выносились из assistant-view.js на этапе D.5 (assistant-api.js
// и assistant-vision.js), потребителей у них двое — assistant-view.js и
// assistant-pdf.js, — поэтому слиты в один файл (этап Y1).
//
// --- HTTP-клиент -------------------------------------------------------------
//
// Один ход к OpenAI-совместимому эндпоинту neuraldeep.ru: успех — строка
// ответа, любая ошибка — отвергнутый промис с готовым текстом для пузыря
// чата. 401/403 помечены в тексте, чтобы ассистент поднял модалку ключа.
//
// Сборка payload (модель, системный промпт с данными трекера) и чтение
// ключа остаются в assistant-view.js: это состояние ассистента, клиенту
// они приходят аргументами.
//
// --- Фото в чате (Vision) ----------------------------------------------------
//
// Картинки живут в переменной модуля по образцу pdfContext: не в localStorage
// (base64 раздул бы хранилище), перезагрузка страницы их сбрасывает. В историю
// диалога попадает только текст вопроса с маркером [фото: имя]; в payload
// последний user-реплики разворачивается в OpenAI-vision content-массив.
//
// Обработчики кнопки и чипа (onAssistantImagePick / onAssistantImageClear)
// остаются в assistant-view.js: там делегированные события, каталог моделей
// и updateAssistantControls, который передаётся сюда колбэком.

import { handleNetworkError, showErrorToast, showToast } from '../core/dom.js';
import { compressImage } from '../data/image.js';

// --- HTTP-клиент -------------------------------------------------------------

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
// жить до истечения таймаута. timedOut() различает истёкший таймаут:
// в ручной ветке fetch отвергается AbortError (не TimeoutError), и без
// этого флага таймаут на старых Safari выдавался за «нет связи».
function timeoutGuard(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return {
      signal: AbortSignal.timeout(ms),
      cancel: function () {},
      timedOut: function () { return false; },
    };
  }
  let fired = false;
  const controller = new AbortController();
  const timer = setTimeout(function () {
    fired = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    cancel: function () { clearTimeout(timer); },
    timedOut: function () { return fired; },
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
    // timedOut() ловит ручную ветку: там abort даёт AbortError.
    const timedOut = (e && e.name === 'TimeoutError') || guard.timedOut();
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
    // Обрыв сети посреди чтения тела fetch роняет TypeError'ом (спека fetch:
    // network error при прерывании потока), невалидный JSON — SyntaxError.
    // Раньше оба случая маскировались под «не в формате JSON».
    if (e && e.name === 'TypeError') {
      throw new Error(handleNetworkError(e, {
        context: '[assistant]',
        silent: true,
        message: 'Связь прервалась посреди ответа. Попробуйте ещё раз.',
      }));
    }
    throw new Error('Сервис вернул ответ не в формате JSON. Попробуйте позже.');
  }

  const reply = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error('Сервис ответил пустым сообщением. Попробуйте переформулировать вопрос.');
  }
  return reply.trim();
}

// --- Фото в чате (Vision) ----------------------------------------------------

const ASSISTANT_IMAGE_MAX = 3;        // картинок в одном вопросе
// Размер и потолок экспортируются: те же правила сжатия использует фолбэк
// PDF-сканов (js/ui/assistant-pdf.js) — страницы скана идут к модели на
// равных с фото и должны попадать в тот же рабочий диапазон энкодера.
export const IMAGE_MAX_SIDE = 1568;          // рабочий диапазон vision-энкодеров Qwen
export const IMAGE_MAX_BYTES = 400 * 1024;   // base64 раздует в ~1.37× — до ~550 КБ

let imageContext = null;   // [{ dataUrl, name, bytes }] | null
let imageCompressing = false;

// Состояние читает ассистент-оркестратор (assistant-view.js): payload
// собирается с приложенными снимками, отправка гаснет на время сжатия.
export function getImageContext() {
  return imageContext;
}

export function isImageCompressing() {
  return imageCompressing;
}

// Чистая функция: базовые сообщения + [{dataUrl}] → последний user-реплике
// добавляются image_url-части. Системный промпт и чужие реплики не трогаются;
// user-реплики нет — массив возвращается как был. Проверяется тестами
// (в assistant-view.js реэкспортируется под прежним именем withVisionAttachments).
export function assistantWithVisionAttachments(messages, images) {
  if (!images || !images.length) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') { idx = i; break; }
  }
  if (idx === -1) return messages;
  const base = messages[idx];
  const content = [{
    type: 'text',
    text: base && typeof base.content === 'string' ? base.content : '',
  }];
  for (let i = 0; i < images.length; i++) {
    if (images[i] && images[i].dataUrl) {
      content.push({ type: 'image_url', image_url: { url: images[i].dataUrl } });
    }
  }
  const merged = messages.slice();
  merged[idx] = { role: 'user', content: content };
  return merged;
}

// Blob → dataURL. Экспортируется: тот же путь к base64 использует фолбэк
// PDF-сканов (assistant-pdf.js) — vision-вложение всегда dataURL, где бы
// Blob ни был получен.
export function blobToDataURL(blob) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result)); };
    reader.onerror = function () {
      reject(reader.error || new Error('чтение файла не удалось'));
    };
    reader.readAsDataURL(blob);
  });
}

function setImageIndicator(text) {
  const el = document.getElementById('assistant-image-indicator');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

export function updateImageIndicator() {
  if (!imageContext || !imageContext.length) {
    setImageIndicator('');
    return;
  }
  const parts = [];
  for (let i = 0; i < imageContext.length; i++) {
    parts.push(imageContext[i].name + ' · '
      + Math.max(1, Math.round(imageContext[i].bytes / 1024)) + ' КБ');
  }
  setImageIndicator('✕ ' + parts.join(' | ') + ' — нажмите, чтобы убрать');
}

// Убрать снимки из чата. true — убраны (чип погашен), false — убирать
// нечего. Вызывается из обработчика чипа в assistant-view.js.
export function clearImageContext() {
  if (!imageContext || !imageContext.length) return false;
  imageContext = null;
  setImageIndicator('');
  return true;
}

// Сжатие выбранных файлов и прикрепление к чату. refreshControls — колбэк
// ассистента (updateAssistantControls): на время сжатия гасится отправка.
export async function compressChatImages(fileList, refreshControls) {
  const room = ASSISTANT_IMAGE_MAX - (imageContext ? imageContext.length : 0);
  if (room <= 0) {
    console.warn('[vision] лимит ' + ASSISTANT_IMAGE_MAX
      + ' фото исчерпан — новые не прикрепляются');
    showErrorToast('Не больше ' + ASSISTANT_IMAGE_MAX
      + ' фото — уберите лишние по чипу над полем ввода');
    return;
  }
  imageCompressing = true;
  // Всё — включая refreshControls и индикатор — под try: finally ниже
  // единственное место снятия флага. Иначе исключение до входа в try
  // (например, брошенный колбэк контролов) оставляло imageCompressing
  // = true навсегда: выбор фото и отправка блокировались до перезагрузки.
  try {
    if (refreshControls) refreshControls();
    setImageIndicator('Сжимаю…');
    const added = [];
    let limitSkipped = 0;
    for (let i = 0; i < fileList.length; i++) {
      if (added.length >= room) {
        limitSkipped = fileList.length - i;
        break;
      }
      const file = fileList[i];
      try {
        const compressed = await compressImage(file, {
          maxSide: IMAGE_MAX_SIDE,
          maxBytes: IMAGE_MAX_BYTES,
        });
        console.log('[vision] сжато: ' + file.name + ' (' + file.size
          + ' Б) → ' + compressed.blob.type + ' ' + compressed.blob.size
          + ' Б, ' + compressed.width + '×' + compressed.height);
        added.push({
          dataUrl: await blobToDataURL(compressed.blob),
          name: file.name,
          bytes: compressed.blob.size,
        });
      } catch (e) {
        // Причина видна в консоли: не декодировано, canvas/toBlob отказал,
        // файл слишком велик даже для последнего шанса. Текст — понятная
        // причина без отсылки к консоли (баг 2, iPhone-тест Vision).
        console.error('[vision] фото не прикрепилось — сжатие не удалось ('
          + file.name + '):', e);
        showErrorToast('Не удалось обработать «' + file.name
          + '» — файл слишком большой или это не изображение');
      }
    }
    if (added.length) {
      imageContext = (imageContext || []).concat(added);
      updateImageIndicator();
      showToast('Фото прикреплено к чату'
        + (added.length > 1 ? ' (' + added.length + ' шт.)' : ''));
      if (limitSkipped > 0) {
        showErrorToast('Взяты первые ' + added.length + ' — не больше '
          + ASSISTANT_IMAGE_MAX + ' фото за раз');
      }
    } else {
      setImageIndicator('');
    }
  } finally {
    imageCompressing = false;
    if (refreshControls) refreshControls();
    if (!imageContext || !imageContext.length) setImageIndicator('');
  }
}
