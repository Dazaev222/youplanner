# АДР: Mobile Harness — гибридная архитектура удалённого управления агентами

**Дата:** 2026-11-08. **Статус:** утверждена владельцем. **Автор:** Оркестратор Фабрики.
**Основание:** Архитектурный аудит YouPlanner PWA + Telegram Bridge Bot, последующее проектирование системы «Mobile Harness».

---

## 1. Контекст

Необходимо организовать дистанционное управление автономными ИИ-агентами (OpenCode), работающими на слабом ПК (Celeron N5105, без GPU, без тяжёлых локальных моделей), с мобильного интерфейса владельца из России.

### Ограничения
| Параметр | Значение |
|----------|----------|
| Геолокация | Россия (Telegram ограничен/заблокирован в ряде сетей) |
| Железо ПК | Celeron N5105 (4 ядра / 4 потока, до 2.9 ГГц), нет GPU |
| Бюджет | Free tiers (Firebase, OpenCode) |
| Текущий стек | Node.js / JS, Python, Firebase |

### Выявленные дефекты (read-only аудит)
- **YouPlanner:** гонка токенов при sign-in владельца (`firebase-auth.js` строки 241–254), ID-токен в URL (`sync.js` `?auth=...`, строки 74–82), молчаливое завершение CAS-retry (строки 383–409).
- **Telegram Bridge:** риск serial WebSocket broadcast delay (`server.py` строки 236–238).

---

## 2. Решение

Гибридная система из трёх слоёв с Firebase Realtime Database как единым источником истины (SSOT).

```
┌──────────────┐      Firebase RTDB      ┌──────────────────┐
│   Telegram    │ ◄── polling/state ───► │      PC Agent     │
│    Bot (Pager)│ ──► task queue ──────► │   (Executor)      │
│  approve/deny │ ◄── results ──────────┤  isolated env    │
└──────────────┘                         └──────────────────┘
       ▲
       │ Web Push (PWA, backup)
       ▼
┌──────────────────────┐
│   PWA Dashboard      │
│  (logs / config / rpt)│
└──────────────────────┘
```

### Компоненты

#### A. Telegram Bot — Pager
- Основной канал push-уведомлений на телефон.
- Работает даже когда Telegram закрыт (системные push).
- Клавиатурные кнопки `approve` / `deny` / `status`.
- Вызовы Telegram API → через HTTP(S) proxy.

#### B. PWA — Control Dashboard
- Веб-интерфейс для логов, конфигурации, отчётов.
- Web Push как резервный канал (ненадёжен на iOS без Apple Developer account).
- Не требует установки native приложения.

#### C. PC Agent — Executor
- Изолированная среда (WSL или контейнер).
- Пуллинг очереди задач из Firebase.
- Запуск автономных сессий OpenCode.
- Отправка результатов обратно.

### Состояния задачи (Firebase state machine)

```
pending → approved → running → completed
         ├─ denied
         └─ expired (stale > TTL)
```

Состояние атомарно обновляется по операции записи. Любой интерфейс может менять статус.

### Токеномика
- Агент не тратит токены LLM пока ожидает одобрения.
- Checkpoint-pause между шагами: агент сохраняет состояние, освобождает ресурсы, ждёт нового пулла.
- Только после `approved` — продолжение выполнения.

### Сетевой routing
| Канал | Прокси? | Обоснование |
|-------|---------|-------------|
| Telegram API | Да | заблокирован в РФ |
| LLM API | Нет | прямой доступ; экономия latency и стабильность |
| Firebase | Нет | работает напрямую |
| Web Push | Нет | нативный браузерный протокол |

**Важно:** разделение на уровне процесса, а не системного VPN-тюна.代理 включается только для Telegram-процесса.

### iOS Push Problem
- Web Push на iOS без Apple Developer Account ненадёжен, особенно когда приложение закрыто.
- Telegram — первичный канал (pager).
- Web Push — резервный канал (не единичный).

### Pushover (альтернативная оценка)
- Цена: $4.99 platform one-time, 10k сообщений/месяц бесплатно.
- Доступность из РФ и способ оплаты требуют отдельной проверки.
- Сохранён как deferred option.

### ntfy.sh (альтернативная оценка)
- Бесплатный push-сервис, самохостящийся.
- Требует self-hosting или private topic auth для приватности.
- Сохранён как deferred option.

---

## 3. Преимущества принятого решения

| Критерий | Оценка |
|----------|--------|
| Работоспособность из РФ | ✅ Telegram обходит блокировку через proxy; LLM напрямую |
| Экономия токенов | ✅ Паузы без расхода; проверка статуса без запросов к LLM |
| iOS совместимость | ✅ Push через Telegram (не依赖 Web Push) |
| Масштабируемость | ✅ Firebase handles concurrent access; separate processes |
| Стоимость | ✅ Free tier Firebase; free Telegram bot API |
| Безопасность | ✅ Task isolation; no credentials in shared state |

---

## 4. Альтернативы, которые были отклонены

| Альтернатива | Причина отклонения |
|-------------|-------------------|
| Pure PWA (Web Push only) | ❌ Ненадёжно на iOS с закрытым app |
| Pure Telegram Mini App | ❌ Нет полноценного UX для логов/конфигов |
| Системный VPN на PC | ❌ Ломает LLM latency; нужен granularity per-process |
| Pushover as primary | ❌ Требуется upfront payment ($4.99); need availability check from RU |
| ntfy.sh without self-host | ❌ Privacy concern for private tasks |

---

## 5. Deferred / Backlog

- [ ] Verify real-world iOS Web Push delivery on actual hardware
- [ ] Test Telegram push delivery with app closed from Russia network
- [ ] Run full Telegram Bridge test suite (`pytest`) to establish green baseline
- [ ] Evaluate Pushover availability and payment methods from Russia
- [ ] Set up self-hosted ntfy.sh instance for backup push
- [ ] Implement Firebase task queue schema
- [ ] Implement approval state machine
- [ ] Build Telegram keyboard workflow (Mini App or inline buttons)
- [ ] Design PC executor agent loop
- [ ] Define isolation boundary (WSL vs container)

---

## 6. Связанные артефакты

- Аудит YouPlanner: `js/data/firebase-auth.js`, `js/sync/sync.js`
- Аудит Telegram Bridge: `дашборд/server.py`
- Firebase rules: `database.rules.json`, `firebase.json`
- Вердикт о гибридной архитектуре: этот документ
