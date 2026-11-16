# MASTER_TZ_HARNESS — Мастерское техническое задание на Mobile Harness

Дата: 2026-11-08. Статус: формируется (фаза ТЗ). Автор: Оркестратор Фабрики.
Основание: [ADR-hybrid-harness-architecture.md](ADR-hybrid-harness-architecture.md).

## 1. Предпосылки

- **Цель:** дистанционное управление автономными ИИ-агентами (OpenCode), работающими на
  слабом ПК (Celeron N5105, нет GPU, нет тяжёлых локальных моделей), из мобильного
  интерфейса владельца.
- **Ограничения:** геолокация владельца — Россия (Telegram в ряде сетей недоступен без
  прокси/VPN-aware routing); бюджет — free tiers (Firebase, OpenCode); текущий стек —
  Node.js/JS, Python, Firebase.
- **Инфраструктура:** Telegram Bridge (`C:\Users\Admin\Desktop\telegram-bridge`),
  YouPlanner PWA (`C:\Users\Admin\Desktop\youplanner-new`).

## 2. Решение в двух словах

Гибрид трёхслойной системы с Firebase Realtime Database как единого источника истины
(SSOT):

1. **Telegram Bot** — «pager»: push-уведомления, approve/deny кнопки.
2. **PWA** — «HQ»: логи / конфигурация / отчёты, Web Push — резерв.
3. **PC Agent** — изолированный executor: опрос очереди задач, checkpoint-pause.

Полное решение и отступления: [ADR-hybrid-harness-architecture.md](ADR-hybrid-harness-architecture.md).

## 3. Требования к ТЗ

1. **iOS push:** Telegram — первичный канал (надежный при закрытом приложении);
   Web Push — резерв, ненадёжен без Apple Developer Program.
2. **Сеть:** Telegram API → HTTP(S) proxy; LLM API → прямое подключение; Firebase → прямое.
   Разделение на уровне процесса, не системный VPN.
3. **Токен-экономика:** агент не тратит LLM-токены на ожидание подтверждения;
   checkpoint-pause между шагами; проверка статуса не трогает LLM.
4. **State machine задачи:** `pending → approved → running → completed`,
   `denied | expired` на ветках.

## 4. Свободные LLM — найдено (исследование 2026-11-08)

- **OpenCode:** встроенный каталог провайдеров (models.dev); поддержка custom
  OpenAI-compatible провайдеров (конкретный пример: DeepSeek через `baseURL
  https://api.deepseek.com`, формат OpenAI; также Anthropic-совместимый `https://api.deepseek.com/anthropic`);
  локальные рантаймы — Ollama (`qwen3:8b`), LM Studio, vLLM; подписка OpenCode Go — $10/мес
  (платная).
- **DeepSeek:** API совместим с OpenAI/Anthropic; модель `deepseek-flash` (обслуживается
  как DeepSeek-V4.1-Flash), legacy-имена принимаются; `deepseek-v4-pro`; интеграция с
  OpenCode — DeepSeek Harness (developer preview); ключ API — platform.deepseek.com.
- **Вывод для ТЗ:** основной «бесплатный/дешёвый» backend агента — DeepSeek Flash через
  OpenCode (OpenAI- или Anthropic-формат); в стеке уже есть альтернативы — GLM Flash,
  DeepSeek Flash, Qoder Lite, платная Qwen 3.8 Flash (allowlist).

## 5. Задачи и бэклог Mobile Harness

1. Firebase task queue schema.
2. Approval state machine.
3. Telegram keyboard workflow (bot / Mini App).
4. PC executor agent loop.
5. Isolation boundary (WSL / container).
6. iOS push verification (реальное железо).
7. Network routing verification (Russia).
8. Pushover / ntfy evaluation (backup).

## 6. Открытые вопросы

- Доступность Pushover из РФ и способ оплаты ($4.99/platform).
- Self-host ntfy.sh для приватных топиков.
- Реальная доставка Telegram push с закрытым приложением на iOS.
- Полный зелёный baseline тестов Telegram Bridge (venv + `python -B *_test.py`).

## 7. Связанные документы

- ADR: [ADR-hybrid-harness-architecture.md](ADR-hybrid-harness-architecture.md)
- Проект Telegram Bridge: `C:\Users\Admin\Desktop\telegram-bridge`
- Проект YouPlanner: `C:\Users\Admin\Desktop\youplanner-new`
