// Фон приложения: сжатие пользовательского фото и настройки затемнения.
// Слой данных без DOM: compressBgImage превращает File в Blob под размер
// экрана, load/save хранят Blob в IndexedDB (js/core/db.js), уровень
// затемнения — числом в localStorage. Применение к странице — в app.js.
//
// Ключи сознательно не входят в STORAGE_KEYS: фон — локальная косметика
// устройства (как API-ключ ассистента), в Firebase и файлы копий она
// не попадает.

import { idbDelete, idbGet, idbPut } from '../core/db.js';

export const BG_IMAGE_KEY = 'app-background-image';   // ключ записи в IDB
export const BG_PREFS_KEY = 'youplanner.app_bg';     // localStorage: {dim}
export const BG_DIM_DEFAULT = 80;                    // % — стартовое затемнение
const BG_BLOB_MAX = 800 * 1024;                      // потолок сжатой копии

// --- Затемнение -------------------------------------------------------------

export function loadBgDim() {
  try {
    const raw = localStorage.getItem(BG_PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.dim === 'number'
      && parsed.dim >= 0 && parsed.dim <= 100) {
      return Math.round(parsed.dim);
    }
  } catch (e) {
    // битый JSON читается как «нет настройки»
  }
  return BG_DIM_DEFAULT;
}

export function saveBgDim(dim) {
  try {
    localStorage.setItem(BG_PREFS_KEY, JSON.stringify({ dim: Math.round(dim) }));
    return true;
  } catch (e) {
    return false;   // затемнение — расходник: survives без записи
  }
}

function clearBgDim() {
  try { localStorage.removeItem(BG_PREFS_KEY); } catch (e) { /* пусто */ }
}

// Средняя яркость картинки: замер по крошечному canvas 16×16 — drawImage
// сам усредняет пиксели при уменьшении. 0 — чёрное, 1 — белое.
function averageLuma(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 1;
  ctx.drawImage(bitmap, 0, 0, 16, 16);
  const data = ctx.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return (sum / (data.length / 4)) / 255;
}

// База для ползунка: чем темнее фото, тем плотнее белый скрим нужен
// тёмному тексту приложения. Диапазон 55–95%: ниже 55% светлый текст
// таблицы теряет контраст на пёстрой картинке, выше 95% фото перестаёт
// быть видно вовсе.
export function autoDimForBitmap(bitmap) {
  const luma = averageLuma(bitmap);
  return Math.round(Math.min(95, Math.max(55, 55 + (1 - luma) * 40)));
}

// --- Сжатие -----------------------------------------------------------------

function canvasToBlob(canvas, type, quality) {
  return new Promise(function (resolve) {
    canvas.toBlob(resolve, type, quality);
  });
}

// Потолок длинной стороны сжатой копии: длинная сторона экрана
// в физических пикселях (retina), в разумных пределах. Апскейл меньших
// картинок не делается — качества не добавит, вес вырастет: фактический
// масштаб считается в compressBgImage как min(1, target/исходная).
function targetSide() {
  const screen = typeof window !== 'undefined' && window.screen;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const longSide = screen ? Math.max(screen.width, screen.height)
    : Math.max(window.innerWidth, window.innerHeight);
  return Math.min(2048, Math.max(1136, Math.round(longSide * dpr)));
}

// File → Blob под размер экрана. Пробуем WebP (заметно легче при том же
// качестве), но Safari старых версий молча отдаёт PNG вместо WebP —
// проверяем фактический тип и размер, при промахе уходим в JPEG
// с пошаговым качеством до потолка 800 КБ.
export async function compressBgImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    // старые Safari не знают опцию — повтор без неё (EXIF у них
    // разворачивает сам bitmap-декодер)
    bitmap = await createImageBitmap(file);
  }
  const side = targetSide();
  const maxSide = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, side / maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dim = autoDimForBitmap(bitmap);
  bitmap.close();

  const attempts = [
    { type: 'image/webp', quality: 0.8 },
    { type: 'image/jpeg', quality: 0.7 },
    { type: 'image/jpeg', quality: 0.55 },
  ];
  let blob = null;
  for (const a of attempts) {
    const candidate = await canvasToBlob(canvas, a.type, a.quality);
    if (!candidate) continue;
    blob = candidate;
    if (candidate.size <= BG_BLOB_MAX && candidate.type === a.type) break;
  }
  if (!blob) throw new Error('браузер не смог сжать изображение');
  return { blob: blob, dim: dim };
}

// --- Хранение ---------------------------------------------------------------

export async function loadBgBlob() {
  const value = await idbGet(BG_IMAGE_KEY);
  return value instanceof Blob ? value : null;
}

export async function saveBgBlob(blob) {
  return await idbPut(BG_IMAGE_KEY, blob);
}

// Полный сброс: и картинка, и затемнение. Возвращает true, когда данных
// точно больше нет (удаление отсутствующей записи — тоже успех).
export async function resetBg() {
  const ok = await idbDelete(BG_IMAGE_KEY);
  clearBgDim();
  return ok;
}
