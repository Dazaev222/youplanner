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
