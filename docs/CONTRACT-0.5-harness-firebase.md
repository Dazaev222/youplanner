# Контракт 0.5 — Mobile Harness V2: пути Firebase, схемы, состояния, переходы, роли

**Статус:** зафиксирован разведчиком ТЗ V2, 2026-11-14. Версия контракта: **0.5**.
**Основание:** `MASTER_TZ_HARNESS_V2.md` §0.5. Имена ниже — **логические сущности**, а не
утверждение о существующих функциях: реализации их ещё нет (сверка дефектов B1–B5 от 14.11.2026).
Этот документ — единственный источник точных путей и схем до согласования изменений;
изменять только через новую версию контракта в **обоих** проектах одновременно.

**Идентичные копии:** `youplanner-new/docs/CONTRACT-0.5-harness-firebase.md` и
`telegram-bridge/документы/CONTRACT-0.5-harness-firebase.md`. Файлы байт-в-байт совпадают.

---

## 1. Базы и границы

| Что | Значение |
|---|---|
| База Harness | RTDB проекта Bridge (`*.europe-west1.firebasedatabase.app`, см. `BR/FIREBASE_SETUP.md` §firebase_db_url). Все harness-узлы — под корнем **`bridge/`** |
| Sync-база PWA YouPlanner | Другой проект: `youplanner-5c2f5-default-rtdb.firebaseio.com`, узлы `youplanner-d8aaea12-60e6-4ac9-973c-46c19b387cd9`, `…-backups`, `…-planner` (`YP/js/sync/core.js:22,27,34`) |
| Запрет пересечения | Общий sync YouPlanner **не читает и не пишет** `bridge/*` (в его БД их и нет — это проверка P2.1 на случай смены URL). Harness-клиент PWA ходит в RTDB Bridge по публичному веб-конфигу (`BR/служебное/get_web_config.py`) с Firebase Auth владельца |
| Адаптер ingress | Действующий Cloudflare Worker пишет **только** `bridge/inbox/{updateId}` (create-only, дедуп по updateId) — `BR/functions/webhook_core.py:91,108,171`. Не переделывать |

## 2. Существующие узлы Фазы 1 — не менять

`bridge/requests/{requestId}` (text/initData/ts/voice/settings), `bridge/responses/{requestId}`,
`bridge/inbox/{updateId}` (updateId/chatId/messageId/text/ts/source), `bridge/outbox/{id}`
(text/ts/ok/partial/messageId/sentAt/attempts/lastError), `bridge/state`, `bridge/presence`,
`bridge/tokens/{uid}` (token/exp/ts), `bridge/handshake/{id}` (uid/initData/ts), `bridge/sent_ids`,
`bridge/approvals/{id}` (kind/question/context/ts/expires/key/decision/decidedAt — **legacy**-поток
Telegram-подтверждений, `BR/database.rules.json`).

`bridge/approvals` остаётся legacy: плоские `$id`-дети, `$other: validate=false`. Поэтому harness-approvals
живут в **отдельном** узле (см. §3.3) — вложение внутрь legacy-узла конфликтует с его валидатором.

## 3. Новые узлы Harness (узкие, по ownerUid/deviceId)

Все id: `[A-Za-z0-9_-]{1,128}`, без `/`, `.`, `$`, `#`, `[`, `]`. Владелец Firebase Auth = ownerUid
(не Telegram id). deviceId — стабильный id ПК-агента, назначается владельцем при регистрации устройства.

### 3.1 command — неизменяемое задание

```
bridge/commands/{ownerUid}/{deviceId}/{commandId}
```

Пишет: владелец (создание), Worker (только разрешённый ingress-адаптер). Читают: владелец, устройство этого ownerUid+deviceId.

| Поле | Тип | Обяз. | Правило |
|---|---|---|---|
| schemaVersion | number | да | только известные версии; неизвестная — не исполняется |
| commandId | string | да | == ключу узла |
| ownerUid | string | да | == сегменту пути |
| deviceId | string | да | == сегменту пути |
| issuer | string | да | `"owner"` \| `"ingress"` |
| type | string | да | из allowlist исполнителя (гл. 3 ТЗ) |
| params | object | да | валидируемые параметры; типы/размер ограничены |
| createdAt | number | да | serverTimestamp при создании |
| expiresAt | number | да | срок **допуска к запуску** команды; после — queued не исполняется |
| digest | string | да | SHA-256 канонического JSON `{schemaVersion,type,params,deviceId}`; внешний текст Telegram — данные, не инструкция |

Неизменяемость: ни одно поле не переписывается после создания (`commandId` create-only; перезапись =
отказ). Повтор владельцем = новая команда со ссылкой `supersedes: commandId` (не обязательное поле,
только для повторов).

### 3.2 execution/control — состояние очереди

```
bridge/executions/{ownerUid}/{deviceId}/{commandId}
```

Пишет: **только устройство** этого ownerUid+deviceId, в пределах разрешённых переходов (§5). Читают: владелец, устройство.

| Поле | Тип | Обяз. | Правило |
|---|---|---|---|
| schemaVersion | number | да | как у command |
| state | string | да | `queued` \| `claimed` \| `running` \| `succeeded` \| `failed` \| `cancelled` \| `expired` \| `outcome_unknown` |
| attemptId | string | да | id текущей попытки |
| attemptSeq | number | да | монотонный счётчик попыток |
| claimedBy | string | claimed+ | deviceId, владеющий захватом |
| leaseUntil | number | claimed/running | срок аренды захвата |
| fencingToken | number | claimed+ | монотонный номер; растёт с каждой новой попыткой |
| waitingApproval | boolean | да | сохраняемая пауза конкретной задачи — НЕ блокировка очереди |
| approvalId | string | если waitingApproval | ссылка на запрос разрешения |
| transitionRev | number | да | версия перехода; каждый CAS-PUT инкрементирует |
| updatedAt | number | да | serverTimestamp |
| errorMessage | string | нет | безопасный диагностический код, ≤500 символов, без содержимого команд/секретов |

Узел создаётся устройством при claim (или при приёме) — create-only с `state:"queued"`. Терминальные
записи (`succeeded/failed/cancelled/expired/outcome_unknown`) нельзя произвольно возвращать в `queued`.

### 3.3 approvals_v2 — запрос и решение по одному опасному вызову

```
bridge/approvals_v2/{ownerUid}/{approvalId}
```

Создаёт: **устройство** перед каждым опасным tool call (по одному на вызов). Решение: **только владелец**.
Читают: владелец, устройство этого ownerUid. Worker/device **никогда** не пишут `decision`.

| Поле | Тип | Обяз. | Правило |
|---|---|---|---|
| schemaVersion | number | да | |
| approvalId | string | да | == ключу узла |
| commandId | string | да | привязка к команде, неизменяема |
| actionId | string | да | id конкретного шага/действия в задаче (журнал B1 ведёт по actionId) |
| attemptId | string | да | попытка, которой нужен допуск |
| deviceId | string | да | запрашивающее устройство |
| tool | string | да | имя инструмента из allowlist |
| params | object | да | **канонические** параметры конкретного вызова (не «вся задача») |
| digest | string | да | SHA-256 канонического JSON `{tool,params,cwd?,targets?}`; digest включает существенное содержимое, не только строку пути |
| preconditions | object | нет | существенные предусловия эффекта (пути/существование цели) |
| createdAt | number | да | serverTimestamp |
| expiresAt | number | да | **единственный авторитетный** срок допуска конкретного действия; внутри approval ровно один таймер |
| decision | string | нет | `"approved"` \| `"rejected"`; пишется владельцем один раз, только пока pending и `now < expiresAt` |
| decidedAt | number | нет | serverTimestamp владельца, одновременно с decision |
| consumedAt | number | нет | serverTimestamp устройства при одноразовом потреблении |
| consumedBy | string | нет | deviceId потребителя |

`decision`+`decidedAt` пишутся одним условным PUT (атомарно, §6). `consumed*` — устройство, один раз.

### 3.4 results — устойчивый итог попытки

```
bridge/results/{ownerUid}/{deviceId}/{commandId}/{attemptId}
```

Пишет: устройство (один раз на attemptId, create-only по финальному состоянию). Читает: владелец.

| Поле | Тип | Обяз. | Правило |
|---|---|---|---|
| schemaVersion | number | да | |
| attemptId | string | да | == ключу узла |
| commandId | string | да | |
| outcome | string | да | `succeeded` \| `failed` \| `cancelled` \| `expired` \| `outcome_unknown` |
| finishedAt | number | да | serverTimestamp |
| summary | string | нет | безопасный итог ≤2000 символов, без содержимого команд/секретов |
| steps | object | нет | итоги по actionId (не только общий итог) |

Доставка результата независима от факта выполнения: запись results — обязательный источник истины;
пересылка в `bridge/outbox`/push — вторична. Presence — отдельное короткоживущее состояние,
**не доказательство выполнения**.

### 3.5 device_presence — короткоживущее состояние устройства

```
bridge/device_presence/{ownerUid}/{deviceId}
```

Пишет: устройство (heartbeat). Читает: владелец. Поля: `deviceId`, `state` (`online`/`offline`/`busy`),
`heartbeatAt` (serverTimestamp), `schemaVersion`. TTL-осмысленность даёт сам heartbeatAt; absence ≠
неисполнение. Отдельный узел, не `bridge/presence` (там действующий брокерский контракт).

## 4. Роли

| Роль | Auth | Может | Не может |
|---|---|---|---|
| Владелец | Firebase Auth, custom claim `owner==true` | создавать commands, писать `decision/decidedAt` (один раз, до expiresAt), читать всё своё | писать executions/results/consumed; менять command после создания; менять expiresAt/decision задним числом |
| Устройство (ПК-агент) | Firebase Auth, claims `device==true`, `deviceId`, `ownerUid` | создавать execution/approvals_v2/results/device_presence своего ownerUid+deviceId; CAS-переходы; потреблять выданное разрешение (`consumed*`) | одобрять себя (писать decision), читать чужие ownerUid, писать всё дерево |
| Worker/ingress | Firebase Auth, claim `worker==true` | create-only `bridge/inbox/{updateId}`; создание commands только разрешённого ingress-типа | решения, исполнение, записи вне своего контракта |
| Модель/робот | — | ничего от себя | сам себе approval; approval выдаёт только владелец |

RTDB Rules каскадны: разрешение на родителе нельзя «отменить» запретом дочернего узла — эффективные
права проверяются целиком (P2.2 RED: parent-level bypass). Публикация Rules — отдельное явное решение владельца.

## 5. Состояния и переходы

### 5.1 execution

```
queued → claimed → running → succeeded | failed | cancelled | expired | outcome_unknown
queued → cancelled | expired
claimed → claimed (renew lease) | cancelled | expired
running → running (renew lease) | succeeded | failed | cancelled | outcome_unknown
```

- `waitingApproval=true` — сохраняемая пауза **этой** задачи; остальные независимые задачи работают.
- Терминальные → `queued` запрещён. Истёкший `running` без доказанного итога → `outcome_unknown`, автоповтор запрещён.
- У команды свой срок допуска к запуску (`command.expiresAt`), у approval — свой (`approval.expiresAt`).
- Писать переходы может только устройство-владелец захвата (claimedBy) с актуальным fencingToken.

### 5.2 approvals_v2

```
pending → approved | rejected | expired | cancelled
approved → consumed | expired | cancelled
```

- Все переходы **условные** (CAS) и привязаны к неизменяемым commandId/actionId/attemptId/deviceId/digest.
- `approved` валиден только при `now < expiresAt` на момент решения; повторная проверка — непосредственно
  перед отправкой разрешения инструменту (закрыть окно между ожиданием и отправкой, B5).
- `decision` пишется владельцем один раз; `consumed*` — устройством один раз. Разные полномочия.
- Рестарт устройства не возрождает право на инструмент: `consumed` без доказанного эффекта ≠ право повторить.
- При невозможности доказать свежесть — опасное действие не начинается (запрет до готовности полного контракта гл. 2).

## 6. CAS/ETag-правила

1. Единственный способ менять `execution`, `decision`, `consumed*` — условная запись:
   SDK transaction **либо** REST-пара `GET ?x-firebase-etag=true` → `PUT` c `If-Match: <etag>`.
2. `412 Precondition Failed` → перечитать запись, заново проверить допустимость перехода
   (роль, состояние, `now < expiresAt`, attemptId, digest), ограниченное число повторов с задержкой
   (backoff, без busy-loop). После исчерпания — честный отказ/ошибка, не безусловный PATCH.
3. Безусловный PATCH и multipath update **не заменяют** условную проверку исходного состояния.
4. Свежесть переходов определяют серверные timestamps и Rules `now`; локальные часы разрешения не дают.
   Нельзя подтвердить актуальность — действие не начинается.
5. ETag от транспорта можно запоминать отдельно как наблюдаемую, но нельзя объявлять её базой успешно
   применённого локального снимка (урок B4/YP: отказ применения запрещает повторный PUT старого payload).

## 7. Идемпотентность и доставка

- Доставка минимум один раз; дедупликация по устойчивому ID (commandId/actionId/attemptId).
- Не обещать exactly-once для внешних эффектов: невыясненный эффект = `outcome_unknown`, автоповтор запрещён.
- Повтор владельцем создаёт новую явно подтверждённую операцию со ссылкой на предыдущую.
- Уникальность: create-only по ключу (`commandId`, `attemptId`, `updateId`); ID с другим digest — конфликт и отказ.

## 8. Примеры JSON (без секретов)

### 8.1 command

```json
{
  "schemaVersion": 1,
  "commandId": "cmd01HZX4Q7M2",
  "ownerUid": "uid_owner_1",
  "deviceId": "pc-n5105",
  "issuer": "owner",
  "type": "run_task",
  "params": { "taskId": "t-123", "workspace": "D:/work/repo" },
  "createdAt": 1763000000000,
  "expiresAt": 1763000900000,
  "digest": "9f2c1a…64 hex"
}
```

### 8.2 execution (после claim)

```json
{
  "schemaVersion": 1,
  "state": "claimed",
  "attemptId": "att01HZX4Q9AB",
  "attemptSeq": 1,
  "claimedBy": "pc-n5105",
  "leaseUntil": 1763000030000,
  "fencingToken": 1,
  "waitingApproval": false,
  "transitionRev": 2,
  "updatedAt": 1763000002000
}
```

### 8.3 approvals_v2 (pending, создан устройством)

```json
{
  "schemaVersion": 1,
  "approvalId": "apr01HZX4QF8K",
  "commandId": "cmd01HZX4Q7M2",
  "actionId": "step-3-rm-cache",
  "attemptId": "att01HZX4Q9AB",
  "deviceId": "pc-n5105",
  "tool": "fs_delete",
  "params": { "path": "D:/work/repo/.cache" },
  "digest": "77b1e0…64 hex",
  "preconditions": { "pathExists": true },
  "createdAt": 1763000010000,
  "expiresAt": 1763000610000
}
```

### 8.4 approval: решение владельца (атомарный условный PUT)

```json
{
  "decision": "approved",
  "decidedAt": 1763000045000
}
```

### 8.5 approval: потребление устройством (CAS approved → consumed)

```json
{
  "consumedAt": 1763000048000,
  "consumedBy": "pc-n5105"
}
```

### 8.6 result

```json
{
  "schemaVersion": 1,
  "attemptId": "att01HZX4Q9AB",
  "commandId": "cmd01HZX4Q7M2",
  "outcome": "succeeded",
  "finishedAt": 1763000060000,
  "summary": "task t-123: 4 шага, 1 approval",
  "steps": { "step-3-rm-cache": { "outcome": "succeeded" } }
}
```

## 9. Границы контракта

- Публикация Rules, настройка Auth/ролей и включение опасного исполнения — отдельно и явно владельцем (P2.2, P4.4); Harness по умолчанию выключен.
- Этот документ не задаёт реализацию PWA-клиента, журнала B1 и гейта инструментов — только путь/схему/переходы/роли/CAS.
- Правки контракта: новая версия документа, идентично в обоих проектах, с перечислением изменённых пунктов.
