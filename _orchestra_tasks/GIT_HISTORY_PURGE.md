# Очистка Git-истории youplanner от дампов — команды для владельца

Дата: 2026-11-04. Я **ничего не запускал** из шагов 4–7: force push переписывает
историю на GitHub, это ваше решение и ваш запуск. Шаги 0–1 (только чтение)
выполнены, цифры ниже — живые проверки этого дня.

## 0. Что и где лежит (проверено живыми запросами 2026-11-04)

| Факт | Значение |
|---|---|
| Репозиторий | `https://github.com/Dazaev222/youplanner` (публичный, форков 0, размер API 3020 КБ) |
| Refs на origin | `main`, `arena/871a15e8…`, `arena/9b3c5f8a…`, `arena/c4a0b3df…`, `arena/dd0d6f3c…`, тег `pre-split` |
| Коммитов в main | 167 |
| Пути в истории | `analyze-data.html`, `dump-localstorage.html` (коммит `c65d6ac`, 2026-10-24) → `_tools/analyze-data.html`, `_tools/dump-localstorage.html` (коммит `eb43a11`, 2026-11-04) |
| Блоб дампа | `0a8b454d5a463d7b52854c2990ff9767aa1a4d7c` — 3464 байта, **личные данные** (records 28.09—23.10.2026: намазы, сон, привычки) |
| Блоб инструмента | `c3a6016f9883d3c6b03b00aae135e1b6d08342e0` — 4356 байт, код страницы выгрузки, данных внутри нет |
| Pages | `…/youplanner/analyze-data.html`, `…/_tools/analyze-data.html`, `…/_tools/dump-localstorage.html` → **404** (Jekyll не раздаёт каталоги с подчёркиванием, поэтому перенос в `_tools/` закрыт именно сайт) |
| Сырьё репозитория | `raw.githubusercontent.com/Dazaev222/youplanner/main/_tools/analyze-data.html` → **200 с данными**; `api.github.com/…/git/blobs/0a8b454d…` → **200**; `github.com/…/raw/eb43a11/_tools/analyze-data.html` → 302 → данные |

**Вывод, и он важнее формулировки задачи:** утечка не «осталась в истории» —
она открыта **прямо сейчас** в HEAD. Файл лежит в текущем коммите, и любой
человек с ссылкой на raw или на blob-SHA читает ваши records. Поэтому
одного «вычистить историю» мало: нужен force push, после которого файла нет
ни в HEAD, ни в одном предке.

Других секретов в истории не найдено: `service_account`, `config.json`,
`.env`, `refresh_token` — нигде (проверено `git grep` по всем коммитам);
крупнейшие блобы — `js/vendor/pdf.worker.min.mjs` (1,3 МБ) и версии `Spec.md`.
Web API Key (`AIza…`) в клиентском коде остаётся: для web-приложений Firebase
он не секрет, а идентификатор проекта.

## 1. Инструменты

```bash
git --version                       # 2.55.0.windows.5 — есть
python --version                    # 3.15.0 — есть
python -m pip --version             # 26.2.1 — есть
git filter-repo --version           # «не распознана» → ставить
java -version                       # нет → BFG Repo-Cleaner недоступен
```

BFG — это Java-приложение; без Java он не запустится, поэтому путь один:
`git-filter-repo` (чистый Python, ставится pip'ом).

```bash
python -m pip install git-filter-repo     # ⚠️ уже выполнено мной 2026-11-04
git filter-repo --version                 # a40bce548d2c — доступно как git filter-repo
```

Установка осталась на машине (она нужна для шага 4); удалить, если раздумаете:
`python -m pip uninstall -y git-filter-repo`.

## 2. Сначала — мои незакоммиченные правки

В рабочем репозитории `проекты/youplanner-new` сейчас лежат изменения
ЗАДАЧИ 2 (firebase-auth, правила, Настройки, тесты) и они **не закоммичены**.
Переписывать историю поверх незакоммиченной работы нельзя. Выберите одно:

```bash
cd "C:/Users/Admin/Desktop/проекты/youplanner-new"
git status
git add -A && git commit -m "firebase: постоянный аккаунт владельца + пин правил по uid"   # или
git stash -u                                                                                # и вернуть после
```

## 3. Резервная копия (обязательно, до любого rewrite)

```bash
cd "C:/Users/Admin/Desktop/проекты"
git -C youplanner-new bundle create youplanner-before-purge.bundle --all
ls -la youplanner-before-purge.bundle          # читается: git bundle list-heads youplanner-before-purge.bundle
```

`--all` берёт все локальные ветки и теги. Это единственный шаг, который
возвращает всё назад, если переписывание пойдёт не так.

## 4. Работа в зеркальном клоне, а не в рабочем репозитории

```bash
cd "C:/Users/Admin/Desktop/проекты"
git clone --mirror https://github.com/Dazaev222/youplanner.git youplanner-purge
cd youplanner-purge
git filter-repo --invert-paths \
  --path analyze-data.html \
  --path dump-localstorage.html \
  --path _tools/analyze-data.html \
  --path _tools/dump-localstorage.html \
  --force
```

Что здесь зачем:

- `--invert-paths` = «удалить перечисленные пути» (а не «оставить только их»).
- Все четыре пути, а не два: файлы переезжали из корня в `_tools/`, и в
  истории живут оба имени. `--path` совпадает побитово, поэтому нужен каждый.
- `--force` — фильтр отказывается трогать клон, который не «свежий»; для
  `--mirror` это штатный случай.
- Зеркальный клон берёт **все** refs, включая `arena/*` и тег `pre-split`:
  блоб дампа reachable и оттуда, и чистка только `main` не закрыла бы
  доступ по SHA.

## 4.5 Репетиция на локальном зеркале — прогнана, цифры настоящие

Я прогнал шаги 4–5 на зеркальном клоне **локального** репозитория (без сети и
без пуша), чтобы инструкция не была теоретической:

| Метрика | До | После |
|---|---|---|
| упоминаний путей в `git log --all` | 4 | **0** |
| ссылок на блобы `0a8b454d…` / `c3a6016f…` | 2 | **0** |
| `size-pack` | 2.01 MiB | 1.73 MiB |
| коммитов в main | 167 | 167 (история не схлопнута) |
| файлов в дереве main | 130 | 128 — ровно два `_tools/*.html` |
| refs | 8 (с remote-tracking) | 6: main, 4 × `arena/*`, тег `pre-split` |

Что репетиция выявила дополнительно:

1. **filter-repo убирает remote `origin`** (пишет «in the manual if you want to
   push back there») — шаг 6 с `git remote add origin` нужен, а не «на всякий
   случай».
2. `refs/remotes/*` из зеркала после переписывания исчезают — это нормально:
   на сервере таких refs нет, `--mirror`-пуш ничего не удалит.
3. `--path` сработал по всем четырём именам; если бы в списке было только два
   корневых имени, `_tools/…` остались бы в истории.

После репетиции: `python -m pip install git-filter-repo` уже выполнено на этой
машине (git-filter-repo доступен как `git filter-repo`, версия a40bce548d2c),
шаг 1 можно пропустить.

## 5. Проверка ДО пуша

```bash
# ни одного упоминания путей
git log --all --format= --name-only | grep -Ei 'analyze-data|dump-localstorage' || echo "ПУСТО: путей нет"

# ни одного из двух блобов
git rev-list --objects --all | grep -E '0a8b454d5a463d7b52854c2990ff9767aa1a4d7c|c3a6016f9883d3c6b03b00aae135e1b6d08342e0' \
  || echo "ПУСТО: блобов нет"

# размер должен упасть (было ~2 МиБ in-pack)
git count-objects -vH | grep -E 'size-pack|in-pack'

# выбросить старые объекты окончательно
git reflog expire --expire=now --all
git gc --prune=now
git count-objects -vH | grep size-pack
```

Только если оба «ПУСТО» — идём дальше. Если grep что-то печатает — стоп,
значит путь в истории назван иначе; найдите его `git log --all --name-only |
grep -i analyze` и добавьте в `--path`.

## 6. Force push

```bash
cd "C:/Users/Admin/Desktop/проекты/youplanner-purge"
git remote -v        # filter-repo мог убрать origin — тогда:
git remote add origin https://github.com/Dazaev222/youplanner.git 2>/dev/null || true

git push --force --mirror origin
```

- `--mirror` толкает все refs целиком (ветки, теги) — ровно то, что нужно
  после переписывания всех refs.
- Если GitHub ответит `rejected: updating refs is not allowed` — на `main`
  включена защита ветки: Settings → Branches → временно разрешить force push
  (или снять правило), потом вернуть.
- Pages пересоберётся сам; `_tools/` он не раздавал и раньше.

## 7. После пуша: сброс рабочих копий

Все существующие клоны теперь «позади» переписанной истории. `git pull` их не
починит (появится ощущение, что история разошлась на тысячи коммитов).

```bash
cd "C:/Users/Admin/Desktop/проекты/youplanner-new"
git fetch origin
git reset --hard origin/main        # ⚠️ затирает незакоммиченное — сначала шаг 2
git clean -fd _tools                # удалить файлы дампа и с диска
```

Если где-то остались worktree'ы или клоны агентов (`arena/*`) — пересоздать из
переписанного репозитория, не пуллить.

## 8. И последнее: GitHub кэширует объекты

После force push URL вида `…/raw/<старый-коммит>/_tools/analyze-data.html` и
`api.github.com/…/git/blobs/<SHA>` могут продолжать отдавать содержимое:
GitHub держит старые объекты в кэше и удаляет их по своему графику (обычно
несколько часов, иногда нужно обращение в поддержку).

1. Проверить:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://raw.githubusercontent.com/Dazaev222/youplanner/main/_tools/analyze-data.html
curl -s -o /dev/null -w "%{http_code}\n" https://github.com/Dazaev222/youplanner/raw/eb43a11e8561adbffe257ea2e3e549d2e012be1a/_tools/analyze-data.html
curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/Dazaev222/youplanner/git/blobs/0a8b454d5a463d7b52854c2990ff9767aa1a4d7c
```

   Нужно: все три — 404. Первый (`main`) станет 404 сразу после шага 6.

2. Если старые ссылки живут дольше суток — обращение в поддержку
   (`https://support.github.com/contact`), текст по образцу:

   > Repository `Dazaev222/youplanner`. I rewrote history with `git filter-repo`
   > to remove a file containing my personal data (`_tools/analyze-data.html`,
   > blob `0a8b454d5a463d7b52854c2990ff9767aa1a4d7c`, last reachable from commits
   > `c65d6ac5464404b0c221b3ffeddd1a0eb95d8c74` and
   > `eb43a11e8561adbffe257ea2e3e549d2e012be1a`). Old commit and blob URLs still
   > return content. Please invalidate the cached objects and run `git gc` on the
   > repository.

3. Сторонних копий нет: форков 0 (проверено API), артефакты Actions анонимно
   не отдаются (401, проверено ранее), Pages файл не раздавал.

## 9. Чего я не делал и почему

- Не запускал шаги 4–8: переписывание истории и force push — необратимые
  действия на общем сервере, вы прямо просили дать только команды.
- Не удалял `_tools/*.html` из рабочего дерева: это ваши файлы, и до force
  push их удаление — просто обычный коммит, который историю не чистит.
- Не трогал `telegram-bridge`: там дампов нет, и репозиторий приватный.
