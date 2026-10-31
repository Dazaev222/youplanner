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

// File → { blob, width, height } под потолки из opts:
//   maxSide  — потолок длинной стороны в пикселях (апскейл не делается);
//   maxBytes — потолок размера Blob;
//   attempts — своя лестница (по умолчанию IMAGE_LADDER_DEFAULT);
//   inspect  — callback с декодированным bitmap ДО его закрытия: фон снимает
//              среднюю яркость для подбора затемнения. bitmap после callback
//              закрывается здесь же — держать его снаружи нельзя.
export async function compressImage(file, opts) {
  const options = opts || {};
  const maxSide = options.maxSide || 2048;
  const maxBytes = options.maxBytes || 800 * 1024;
  const attempts = options.attempts || IMAGE_LADDER_DEFAULT;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    bitmap = await createImageBitmap(file);
  }

  let canvas = null;
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof options.inspect === 'function') options.inspect(bitmap);
  } finally {
    bitmap.close();
  }

  let blob = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const candidate = await canvasToBlob(canvas, a.type, a.quality);
    if (!candidate) continue;
    blob = candidate;
    if (candidate.size <= maxBytes && candidate.type === a.type) break;
  }
  if (!blob) throw new Error('браузер не смог сжать изображение');
  return { blob: blob, width: canvas.width, height: canvas.height };
}
