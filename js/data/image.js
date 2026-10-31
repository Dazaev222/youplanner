// Общее сжатие изображений через Canvas (аудит 2026-10-31, план Vision §4.1):
// единственная реализация лестницы «WebP → JPEG по качеству до потолка
// размера», которую переиспользуют фон приложения (compressBgImage) и фото
// в чате ассистента. Слой данных без DOM-состояния: canvas создаётся на
// время сжатия и наружу не выходит.
//
// EXIF-поворот решается createImageBitmap('from-image'); старые Safari опцию
// не знают — повтор без неё (там bitmap-декодер разворачивает сам).

function canvasToBlob(canvas, type, quality) {
  return new Promise(function (resolve) {
    canvas.toBlob(resolve, type, quality);
  });
}

// Лестница по умолчанию: WebP заметно легче при том же качестве, но старые
// Safari молча отдают PNG вместо WebP — фактический тип и размер проверяются,
// при промахе спуск в JPEG с пошаговым качеством.
export const IMAGE_LADDER_DEFAULT = [
  { type: 'image/webp', quality: 0.8 },
  { type: 'image/jpeg', quality: 0.7 },
  { type: 'image/jpeg', quality: 0.55 },
];

// Потолок исходника для последнего шанса (см. compressImage): больше отдавать
// в base64 без сжатия нет смысла — payload раздуется выше всяких лимитов API.
const ORIGINAL_FILE_MAX_BYTES = 6 * 1024 * 1024;

// Декодирование картинки двумя путями: createImageBitmap (быстро, EXIF
// разворачивается опцией), а при отказе — классический <img> с objectURL:
// старые Safari не знают createImageBitmap или не декодируют им формат
// галереи iPhone (HEIC), зато <img> рисует всё, что умеет показывать WebKit
// (iOS-баг-репорт 2026-10-31: «фото не прикрепляется»).
async function decodeImageSource(file) {
  try {
    return { bitmap: await createImageBitmap(file, { imageOrientation: 'from-image' }) };
  } catch (e1) {
    try {
      return { bitmap: await createImageBitmap(file) };
    } catch (e2) {
      const objectUrl = URL.createObjectURL(file);
      try {
        const image = await new Promise(function (resolve, reject) {
          const element = new Image();
          element.onload = function () { resolve(element); };
          element.onerror = function () {
            reject(new Error('браузер не смог декодировать изображение'));
          };
          element.src = objectUrl;
        });
        return { image: image, objectUrl: objectUrl };
      } catch (e3) {
        URL.revokeObjectURL(objectUrl);
        // Причина, по которой оба пути не пошли, — в консоль вызывающего
        console.error('compressImage: декодирование не удалось',
          { createImageBitmap: String(e2), image: String(e3) });
        throw e3;
      }
    }
  }
}

// File → { blob, width, height } под потолки из opts:
//   maxSide  — потолок длинной стороны в пикселях (апскейл не делается);
//   maxBytes — потолок размера Blob;
//   attempts — своя лестница (по умолчанию IMAGE_LADDER_DEFAULT);
//   inspect  — callback с декодированным bitmap ДО его закрытия: фон снимает
//              среднюю яркость для подбора затемнения. bitmap после callback
//              закрывается здесь же — держать его снаружи нельзя.
// Кодирование: лестница attempts; WebP, который Safari не умеет кодировать,
// отсеивается сравнением фактического типа. Ни один шаг не дал Blob (iOS
// возвращает null при нехватке памяти) — последний шанс: PNG (кодируется
// везде), затем исходный файл без сжатия, если он в разумном потолке.
export async function compressImage(file, opts) {
  const options = opts || {};
  const maxSide = options.maxSide || 2048;
  const maxBytes = options.maxBytes || 800 * 1024;
  const attempts = options.attempts || IMAGE_LADDER_DEFAULT;

  const source = await decodeImageSource(file);
  const bitmap = source.bitmap || null;
  const image = source.image || null;

  let canvas = null;
  try {
    const srcWidth = bitmap ? bitmap.width : image.naturalWidth;
    const srcHeight = bitmap ? bitmap.height : image.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(srcWidth, srcHeight));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(srcWidth * scale));
    canvas.height = Math.max(1, Math.round(srcHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap || image, 0, 0, canvas.width, canvas.height);
    if ((bitmap || image) && typeof options.inspect === 'function') {
      options.inspect(bitmap || image);
    }
  } finally {
    if (bitmap) bitmap.close();
    if (source.objectUrl) URL.revokeObjectURL(source.objectUrl);
  }

  let blob = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const candidate = await canvasToBlob(canvas, a.type, a.quality);
    if (!candidate) continue;
    blob = candidate;
    if (candidate.size <= maxBytes && candidate.type === a.type) break;
  }
  if (!blob) {
    console.warn('compressImage: все форматы лестницы не закодировались — пробую PNG');
    blob = await canvasToBlob(canvas, 'image/png');
  }
  if (!blob && file.size <= ORIGINAL_FILE_MAX_BYTES) {
    console.warn('compressImage: canvas не закодировался — отдаю исходник ('
      + file.type + ', ' + file.size + ' Б) без сжатия');
    blob = file;
  }
  if (!blob) throw new Error('браузер не смог сжать изображение');
  return { blob: blob, width: canvas.width, height: canvas.height };
}
