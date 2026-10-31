// Vision: фото в чате ассистента (вынесено из assistant-view.js, этап D.5).
//
// Картинки живут в переменной модуля по образцу pdfContext: не в localStorage
// (base64 раздул бы хранилище), перезагрузка страницы их сбрасывает. В историю
// диалога попадает только текст вопроса с маркером [фото: имя]; в payload
// последний user-реплики разворачивается в OpenAI-vision content-массив.
//
// Обработчики кнопки и чипа (onAssistantImagePick / onAssistantImageClear)
// остаются в assistant-view.js: там делегированные события, каталог моделей
// и updateAssistantControls, который передаётся сюда колбэком.

import { showErrorToast, showToast } from '../core/dom.js';
import { compressImage } from '../data/image.js';

const ASSISTANT_IMAGE_MAX = 3;        // картинок в одном вопросе
const IMAGE_MAX_SIDE = 1568;          // рабочий диапазон vision-энкодеров Qwen
const IMAGE_MAX_BYTES = 400 * 1024;   // base64 раздует в ~1.37× — до ~550 КБ

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

function blobToDataURL(blob) {
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
  if (refreshControls) refreshControls();
  setImageIndicator('Сжимаю…');
  const added = [];
  let limitSkipped = 0;
  try {
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
        // файл слишком велик даже для последнего шанса
        console.error('[vision] фото не прикрепилось — сжатие не удалось ('
          + file.name + '):', e);
        showErrorToast('Не удалось сжать «' + file.name + '» — подробности в консоли');
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
