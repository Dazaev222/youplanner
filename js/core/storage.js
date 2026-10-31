import { bus } from './bus.js';
// Безопасная запись в localStorage: при переполнении квоты setItem бросает
// QuotaExceededError — ловим его, показываем тост и возвращаем false,
// чтобы вызывающий код знал, что данные не сохранены.
export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    bus.emit('storage:error');
    return false;
  }
}
// Откат уже записанных ключей после сбоя записи посреди применения снимка
// (трёхфазные apply: applyCloudData и applyMergedFromCloud в js/sync/sync.js,
// applyBackup в js/data/backup.js). Живёт в core: оба слоя — data и sync —
// импортируют core, а sync-слой data не импортирует.
// Порядок важен: сначала стираются новые ключи (которых раньше не было) —
// так освобождается место, из-за нехватки которого всё началось; только
// потом восстанавливаются прежние значения. Каждый ключ откатывается под
// своим try: сбой одного не должен оставить неоткаченными остальные.
// Если откатить не удалось — console.error с перечнем ключей: данные
// в хранилище целее всего, о смешанном состоянии надо хотя бы крикнуть.
export function rollbackStagedKeys(appliedLog, source) {
  const failed = [];
  for (let i = 0; i < appliedLog.length; i++) {
    const entry = appliedLog[i];
    if (!entry.written || entry.had) continue;
    try {
      localStorage.removeItem(entry.key);
    } catch (e) {
      failed.push(entry.key);
    }
  }
  for (let i = 0; i < appliedLog.length; i++) {
    const entry = appliedLog[i];
    if (!entry.written || !entry.had) continue;
    try {
      localStorage.setItem(entry.key, entry.previous);
    } catch (e) {
      failed.push(entry.key);
    }
  }
  if (failed.length > 0) {
    console.error(source + ': откат не удался, ключи в смешанном состоянии:',
      failed.join(', '));
  }
}

// --- IndexedDB --------------------------------------------------------------
// Бинарные настройки устройства, которым не место в localStorage: фон
// приложения (сжатая копия фото, сотни килобайт). localStorage держит
// максимум ~5 МБ на всё и принимает только строки — base64 раздул бы
// картинку ещё на треть и заморозил бы UI синхронными JSON.parse мегабайтных
// строк. IDB хранит Blob как есть, асинхронно и с запасом квоты.
//
// Обёртка предельно узкая: одна база, один объектный store 'prefs',
// доступ по ключу. Поддержка IDB проверяется на каждом входе — в тестовой
// песочнице node:vm глобала indexedDB нет, и модуль должен тихо
// отказывать, а не ронять загрузку приложения. Жило отдельным файлом
// (js/core/db.js), потребителем был только js/data/background.js — слито
// сюда (этап Y3).

const DB_NAME = 'youplanner';
const DB_VERSION = 1;
const STORE = 'prefs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function () {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () {
      dbPromise = null;   // следующий вызов попробует снова
      reject(request.error || new Error('IndexedDB недоступна'));
    };
  });
  return dbPromise;
}

function withStore(mode, run) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = function () { resolve(request && request.result); };
      tx.onerror = function () { reject(tx.error || new Error('Ошибка IndexedDB')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB: транзакция прервана')); };
    });
  });
}

// Значение ключа | undefined. Нет IDB — undefined: фон просто не восстановится
export async function idbGet(key) {
  if (typeof indexedDB === 'undefined') return undefined;
  try {
    return await withStore('readonly', function (store) { return store.get(key); });
  } catch (e) {
    return undefined;
  }
}

// true при успехе; false — хранилище недоступно или запись не прошла
export async function idbPut(key, value) {
  if (typeof indexedDB === 'undefined') return false;
  try {
    await withStore('readwrite', function (store) { return store.put(value, key); });
    return true;
  } catch (e) {
    return false;
  }
}

export async function idbDelete(key) {
  if (typeof indexedDB === 'undefined') return false;
  try {
    await withStore('readwrite', function (store) { return store.delete(key); });
    return true;
  } catch (e) {
    return false;
  }
}
