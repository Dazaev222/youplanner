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
