// Каркас вкладки «ИИ-Ассистент»: чат с заглушкой вместо настоящего ответа.
// Реального запроса к API здесь ещё нет — по замыслу сначала проверяется
// каркас интерфейса, клавиша ключа и история на устройстве, а ход к
// neuraldeep.ru подключается следующим заходом.
//
// Ключ хранится в localStorage устройства (youplanner.api_key) и сознательно
// не входит в STORAGE_KEYS из js/data/storage.js: тот реестр — разделы данных
// для синхронизации и файла копии, а ключ так жизни не должен получать.
// В коде ключа нет — его вводит пользователь в модалке.

import { showToast } from '../core/dom.js';

// Ключ = доступ ассистента к neuraldeep.ru. Имя ключа — часть каркаса:
// следующему заходу менять его нельзя без миграции.
export const ASSISTANT_API_KEY = 'youplanner.api_key';

// Сколько мс держать пузырь «печатает…» перед заглушкой. Чистая косметика:
// имитирует ход к сети, чтобы каркас выглядел живым.
const MOCK_DELAY_MS = 500;

export function readAssistantApiKey() {
  try {
    return localStorage.getItem(ASSISTANT_API_KEY);
  } catch (e) {
    return null;
  }
}

// Вход на вкладку — и есть проверка ключа: ключа нет — открывается модалка
// ввода, ключ есть — модалка погашена и чат готов. Подпись под шапкой
// отражает то же состояние. Обновляется на входе и после сохранения ключа.
export function renderAssistantView() {
  const hint = document.getElementById('assistant-hint');
  const hasKey = Boolean(readAssistantApiKey());
  if (hint) {
    hint.textContent = hasKey
      ? 'Ключ сохранён на устройстве. Пока в тестовом режиме: ответы — заглушка.'
      : 'Ключ не задан: введите его, чтобы задавать вопросы. Ответы пока — заглушка.';
  }
  if (hasKey) {
    closeAssistantKeyModal();
  } else {
    openAssistantKeyModal();
  }
}

export function openAssistantKeyModal() {
  const modal = document.getElementById('assistant-key-modal');
  const input = document.getElementById('assistant-key-input');
  const error = document.getElementById('assistant-key-error');
  if (!modal) return;
  if (error) error.textContent = '';
  if (input) {
    input.value = readAssistantApiKey() || '';
  }
  modal.hidden = false;
  if (input) input.focus();
}

export function closeAssistantKeyModal() {
  const modal = document.getElementById('assistant-key-modal');
  if (modal) modal.hidden = true;
}

// Сохранение ключа: пустая строка ключом не считается — это «ключа нет»,
// как и у уразы, где ноль и отсутствие счётчика различаются сознательно.
export function onAssistantKeySave() {
  const input = document.getElementById('assistant-key-input');
  const error = document.getElementById('assistant-key-error');
  const value = input ? input.value.trim() : '';
  if (!value) {
    if (error) error.textContent = 'Введите ключ или закройте окно кнопкой «Отмена».';
    return;
  }
  try {
    localStorage.setItem(ASSISTANT_API_KEY, value);
  } catch (e) {
    if (error) error.textContent = 'Браузер не дал сохранить ключ: память недоступна.';
    return;
  }
  closeAssistantKeyModal();
  renderAssistantView();
  showToast('Ключ сохранён на устройстве');
}

export function onAssistantKeyCancel() {
  closeAssistantKeyModal();
}

// Пузырь в ленте. Текст кладётся через textContent: реплики пользователя
// и заглушки не должны превращаться в разметку.
function appendMessage(kind, text) {
  const chat = document.getElementById('assistant-chat');
  if (!chat) return null;
  const msg = document.createElement('div');
  msg.className = 'assistant-msg assistant-msg-' + kind;
  msg.textContent = text;
  chat.appendChild(msg);
  msg.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return msg;
}

function appendUserMessage(text) {
  return appendMessage('user', text);
}

// Заглушка «печатает…» заменяется тестовым ответом. Если пользователь
// ушёл с вкладки, пузырь всё равно дорисуется в скрытом контейнере —
// при возврате он будет на месте, ничего не теряется.
function appendMockReply() {
  const typing = appendMessage('bot', 'Печатает…');
  if (typing) typing.classList.add('is-typing');
  setTimeout(function () {
    if (typing) {
      typing.classList.remove('is-typing');
      typing.textContent = 'Это тестовый ответ';
    }
  }, MOCK_DELAY_MS);
}

// Точка входа и для формы, и для чипов: у чипа текст сообщения лежит
// в data-chip, у формы — в поле ввода.
export function onAssistantSubmit(text) {
  const message = String(text || '').trim();
  if (!message) return;
  appendUserMessage(message);
  if (!readAssistantApiKey()) {
    openAssistantKeyModal();
    return;
  }
  appendMockReply();
}

// Обработчик формы: гасит перезагрузку и чистит поле.
export function onAssistantFormSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('assistant-input');
  if (!input) return;
  onAssistantSubmit(input.value);
  input.value = '';
}

// Чипы делегированы по контейнеру: текст команды — в data-chip.
export function onAssistantChipClick(event) {
  const chip = event.target.closest('.assistant-chip');
  if (!chip) return;
  onAssistantSubmit(chip.getAttribute('data-chip'));
}
