

// Правка, случившаяся до первой сверки: отправку не теряем, а откладываем
// до ответа сервера — иначе PUT ушёл бы раньше, чем мы узнали серверное.
// Флаг же говорит и обратное: пока он взведён, серверный снимок локальному
// не указ (см. cloudSnapshotWins).
let syncPending = false;
function markSyncPending() { syncPending = true; }
function clearSyncPending() { syncPending = false; }
// Чтение приводит данные в порядок и пишет их обратно: дефолты привычек,
// миграция версии каза, обрезка истории, курсор. Это не правка пользователя,
// поэтому приоритета локальному состоянию такая запись не даёт и syncPending
// не взводит — иначе флаг стоял бы на каждом старте и снимок с сервера
// не применялся бы никогда.
let normalizing = false;
// Единственный вход для записей при чтении: saveNormalized(() => saveX(...))
function saveNormalized(write) {
  normalizing = true;
  try {
    return write();
  } finally {
    normalizing = false;
  }
}
// Время последней известной версии данных. Больше — свежее.
function syncTs() {
  return Number(localStorage.getItem(SYNC_TS_KEY)) || 0;
}
