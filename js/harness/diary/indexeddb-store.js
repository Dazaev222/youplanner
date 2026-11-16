/* Локальное хранилище IndexedDB (ТЗ §5, §9).
   Пространство ключей содержит uid и journalId. Миграции только добавляют
   недостающие хранилища; история при ошибке открытия не очищается. */

import { fail, ok, sanitizeMessage } from './errors.js';

export const DB_NAME = 'youplanner-diary';
export const DB_VERSION = 1;

const STORE_DEFS = {
  records: { keyPath: ['uid', 'journalId', 'kind', 'id'], index: 'byUidJournal' },
  outbox: { keyPath: ['uid', 'journalId', 'operationId'], index: 'byUidJournal' },
  receipts: { keyPath: ['uid', 'journalId', 'path'], index: 'byUidJournal' },
  importSessions: { keyPath: ['uid', 'journalId', 'sessionId'], index: 'byUidJournal' },
  analysisDrafts: { keyPath: ['uid', 'journalId', 'draftId'], index: 'byUidJournal' },
  cache: { keyPath: ['uid', 'journalId', 'key'], index: 'byUidJournal' },
  leases: { keyPath: ['uid', 'journalId'], index: 'byUidJournal' },
};

const OUTBOX_STATUSES = new Set(['pending', 'sending', 'unknown', 'acknowledged', 'blocked']);

export function mapStorageError(error) {
  const name = error && error.name;
  if (name === 'QuotaExceededError') {
    return fail('STORAGE_FULL', 'Локальное хранилище заполнено', {
      reason: 'quota-exceeded',
    }, false);
  }
  return fail('INVALID_DATA', sanitizeMessage(error && error.message), {
    reason: name ? String(name) : 'storage-error',
  }, false);
}

function ensureStores(db) {
  for (const [name, def] of Object.entries(STORE_DEFS)) {
    if (db.objectStoreNames.contains(name)) continue;
    const store = db.createObjectStore(name, { keyPath: def.keyPath });
    store.createIndex(def.index, ['uid', 'journalId'], { unique: false });
  }
}

export function openDiaryDb({ indexedDB, name = DB_NAME, version = DB_VERSION } = {}) {
  const factory = indexedDB || (typeof globalThis !== 'undefined' ? globalThis.indexedDB : null);
  if (!factory) {
    return Promise.resolve(fail('INVALID_DATA', 'IndexedDB недоступен в этом окружении'));
  }
  return new Promise((resolve) => {
    let request;
    try {
      request = factory.open(name, version);
    } catch (error) {
      resolve(mapStorageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      ensureStores(request.result);
    };
    request.onsuccess = () => resolve(ok(request.result));
    request.onerror = () => resolve(mapStorageError(request.error));
    request.onblocked = () => resolve(fail('INVALID_DATA', 'IndexedDB заблокирована другой вкладкой'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function idsOf(scope) {
  const { uid, journalId } = scope || {};
  if (typeof uid !== 'string' || !uid || typeof journalId !== 'string' || !journalId) {
    return null;
  }
  return { uid, journalId };
}

export function createDiaryStore({
  indexedDB,
  name = DB_NAME,
  version = DB_VERSION,
  clock = { now: () => Date.now() },
} = {}) {
  let db = null;
  let closed = false;

  async function open() {
    if (db) return ok(db);
    const opened = await openDiaryDb({ indexedDB, name, version });
    if (!opened.ok) return opened;
    db = opened.value;
    // Перезапуск: незавершённая отправка становится unknown до проверки сервера.
    try {
      const tx = db.transaction('outbox', 'readwrite');
      const store = tx.objectStore('outbox');
      const all = store.getAll();
      all.onsuccess = () => {
        for (const item of all.result || []) {
          if (item.status === 'sending') {
            store.put({ ...item, status: 'unknown', updatedAtMs: clock.now() });
          }
        }
      };
      await txDone(tx);
    } catch (error) {
      return mapStorageError(error);
    }
    closed = false;
    return ok(db);
  }

  async function close() {
    if (db && typeof db.close === 'function') db.close();
    db = null;
    closed = true;
  }

  function requireDb() {
    if (!db) throw new Error('IndexedDB не открыта: вызовите open()');
    return db;
  }

  async function getAll(storeName, scope) {
    const ids = idsOf(scope);
    if (!ids) return [];
    const store = requireDb().transaction(storeName, 'readonly').objectStore(storeName);
    const all = await requestResult(store.index('byUidJournal').getAll([ids.uid, ids.journalId]));
    return all || [];
  }

  async function commitLocalCreate({ uid, journalId, records = [], outbox = [] } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids) return fail('INVALID_DATA', 'uid и journalId обязательны', { path: 'scope' });
    if (!Array.isArray(records) || !Array.isArray(outbox)) {
      return fail('INVALID_DATA', 'records и outbox должны быть массивами');
    }
    for (const entry of outbox) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.operationId !== 'string') {
        return fail('INVALID_DATA', 'outbox: path и operationId обязательны');
      }
    }

    let tx;
    let done = null;
    try {
      tx = requireDb().transaction(['records', 'outbox'], 'readwrite');
      done = txDone(tx);
      done.catch(() => {});
      const recordsStore = tx.objectStore('records');
      const outboxStore = tx.objectStore('outbox');

      for (const record of records) {
        recordsStore.put({
          uid,
          journalId,
          kind: record.kind,
          id: record.id,
          payload: record.payload,
          ...(record.entityKey ? { entityKey: record.entityKey } : {}),
          ...(record.slot ? { slot: record.slot } : {}),
          savedAtMs: clock.now(),
        });
      }
      for (const entry of outbox) {
        outboxStore.put({
          uid,
          journalId,
          path: entry.path,
          operationId: entry.operationId,
          payload: entry.payload,
          dependencies: Array.isArray(entry.dependencies) ? entry.dependencies : [],
          entityKey: entry.entityKey || null,
          kind: entry.kind || null,
          status: entry.status || 'pending',
          attempts: Number.isInteger(entry.attempts) ? entry.attempts : 0,
          error: null,
          createdAtMs: clock.now(),
          updatedAtMs: clock.now(),
        });
      }
      await done;
      return ok({ records: records.length, outbox: outbox.length });
    } catch (error) {
      try { if (tx) tx.abort(); } catch { /* уже завершена */ }
      return mapStorageError(error);
    }
  }

  async function readSnapshot(scope) {
    const ids = idsOf(scope);
    if (!ids) return fail('INVALID_DATA', 'uid и journalId обязательны', { path: 'scope' });
    try {
      const [records, outbox, receipts] = await Promise.all([
        getAll('records', ids),
        getAll('outbox', ids),
        getAll('receipts', ids),
      ]);
      const snapshot = {
        initialization: null,
        events: {},
        triggerCreations: {},
        mutations: {},
        analyses: {},
        outbox: outbox.sort((a, b) => a.createdAtMs - b.createdAtMs),
        receipts,
      };
      for (const record of records) {
        if (record.kind === 'initialization') {
          snapshot.initialization = record.payload;
        } else if (record.kind === 'event') {
          snapshot.events[record.id] = record.payload;
        } else if (record.kind === 'trigger') {
          snapshot.triggerCreations[record.id] = record.payload;
        } else if (record.kind === 'analysis') {
          snapshot.analyses[record.id] = record.payload;
        } else if (record.kind === 'mutation') {
          const entityKey = record.entityKey || record.payload.entityKey;
          const slot = record.slot || record.payload.predecessorOperationId;
          if (!snapshot.mutations[entityKey]) snapshot.mutations[entityKey] = {};
          snapshot.mutations[entityKey][slot] = record.payload;
        }
      }
      return snapshot;
    } catch (error) {
      const mapped = mapStorageError(error);
      const err = new Error(mapped.error.message);
      err.code = mapped.error.code;
      err.details = mapped.error.details;
      throw err;
    }
  }

  async function updateOutbox({ uid, journalId, operationId, status, error, attempts } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof operationId !== 'string' || !OUTBOX_STATUSES.has(status)) {
      return fail('INVALID_DATA', 'updateOutbox: некорректные параметры');
    }
    try {
      const tx = requireDb().transaction('outbox', 'readwrite');
      const done = txDone(tx);
      done.catch(() => {});
      const store = tx.objectStore('outbox');
      const current = await requestResult(store.get([uid, journalId, operationId]));
      if (!current) {
        tx.abort();
        return fail('INVALID_DATA', 'outbox-запись не найдена');
      }
      store.put({
        ...current,
        status,
        error: error === undefined ? current.error : error,
        attempts: Number.isInteger(attempts) ? attempts : current.attempts,
        updatedAtMs: clock.now(),
      });
      await done;
      return ok(true);
    } catch (err) {
      return mapStorageError(err);
    }
  }

  async function saveReceipt({
    uid, journalId, path, status, operationId, payloadHash, acceptedAtMs, error,
  } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof path !== 'string' || !OUTBOX_STATUSES.has(status)) {
      return fail('INVALID_DATA', 'saveReceipt: некорректные параметры');
    }
    try {
      const tx = requireDb().transaction('receipts', 'readwrite');
      const done = txDone(tx);
      tx.objectStore('receipts').put({
        uid,
        journalId,
        path,
        status,
        operationId: operationId || null,
        payloadHash: payloadHash || null,
        acceptedAtMs: acceptedAtMs === undefined ? null : acceptedAtMs,
        error: error || null,
        updatedAtMs: clock.now(),
      });
      await done;
      return ok(true);
    } catch (err) {
      return mapStorageError(err);
    }
  }

  async function acquireSyncLease({
    uid, journalId, ownerId, ttlMs = 15000, nowMs,
  } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof ownerId !== 'string' || !ownerId) {
      return fail('INVALID_DATA', 'acquireSyncLease: нужен ownerId');
    }
    const at = Number.isFinite(nowMs) ? nowMs : clock.now();
    try {
      const tx = requireDb().transaction('leases', 'readwrite');
      const done = txDone(tx);
      done.catch(() => {});
      const store = tx.objectStore('leases');
      const lease = await requestResult(store.get([uid, journalId]));
      const active = lease && lease.expiresAtMs > at && lease.holder !== ownerId;
      if (active) {
        tx.abort();
        return ok({ acquired: false, holder: lease.holder, expiresAtMs: lease.expiresAtMs });
      }
      store.put({ uid, journalId, holder: ownerId, expiresAtMs: at + ttlMs, updatedAtMs: at });
      await done;
      return ok({ acquired: true, holder: ownerId, expiresAtMs: at + ttlMs });
    } catch (err) {
      return mapStorageError(err);
    }
  }

  async function releaseSyncLease({ uid, journalId, ownerId } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids) return fail('INVALID_DATA', 'uid и journalId обязательны');
    try {
      const tx = requireDb().transaction('leases', 'readwrite');
      const done = txDone(tx);
      done.catch(() => {});
      const store = tx.objectStore('leases');
      const lease = await requestResult(store.get([uid, journalId]));
      if (lease && lease.holder === ownerId) store.delete([uid, journalId]);
      await done;
      return ok(true);
    } catch (err) {
      return mapStorageError(err);
    }
  }

  async function saveImportProgress({ uid, journalId, sessionId, progress } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof sessionId !== 'string' || !sessionId) {
      return fail('INVALID_DATA', 'saveImportProgress: нужен sessionId');
    }
    try {
      const tx = requireDb().transaction('importSessions', 'readwrite');
      const done = txDone(tx);
      tx.objectStore('importSessions').put({
        uid, journalId, sessionId, progress, updatedAtMs: clock.now(),
      });
      await done;
      return ok(true);
    } catch (err) {
      return mapStorageError(err);
    }
  }

  async function readImportProgress({ uid, journalId, sessionId } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof sessionId !== 'string') return null;
    const store = requireDb().transaction('importSessions', 'readonly').objectStore('importSessions');
    const item = await requestResult(store.get([uid, journalId, sessionId]));
    return item ? item.progress : null;
  }

  async function saveAnalysisDraft({ uid, journalId, draftId, payload } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof draftId !== 'string' || !draftId) {
      return fail('INVALID_DATA', 'saveAnalysisDraft: нужен draftId');
    }
    try {
      const tx = requireDb().transaction('analysisDrafts', 'readwrite');
      const done = txDone(tx);
      tx.objectStore('analysisDrafts').put({
        uid, journalId, draftId, payload, updatedAtMs: clock.now(),
      });
      await done;
      return ok(true);
    } catch (err) {
      return mapStorageError(err);
    }
  }

  async function readAnalysisDrafts({ uid, journalId } = {}) {
    const items = await getAll('analysisDrafts', { uid, journalId });
    return items.map((item) => item.payload);
  }

  async function saveCache({ uid, journalId, key, payload } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof key !== 'string') return fail('INVALID_DATA', 'saveCache: нужен key');
    const tx = requireDb().transaction('cache', 'readwrite');
    const done = txDone(tx);
    tx.objectStore('cache').put({ uid, journalId, key, payload, updatedAtMs: clock.now() });
    await done;
    return ok(true);
  }

  async function readCache({ uid, journalId, key } = {}) {
    const ids = idsOf({ uid, journalId });
    if (!ids || typeof key !== 'string') return null;
    const store = requireDb().transaction('cache', 'readonly').objectStore('cache');
    const item = await requestResult(store.get([uid, journalId, key]));
    return item ? item.payload : null;
  }

  return {
    open,
    close,
    isOpen: () => Boolean(db) && !closed,
    readSnapshot,
    commitLocalCreate,
    updateOutbox,
    saveReceipt,
    acquireSyncLease,
    releaseSyncLease,
    saveImportProgress,
    readImportProgress,
    saveAnalysisDraft,
    readAnalysisDrafts,
    saveCache,
    readCache,
  };
}
