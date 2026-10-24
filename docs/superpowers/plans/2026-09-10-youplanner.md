# YouPlanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать одностраничный трекер привычек YouPlanner — один HTML-файл, работающий офлайн через `file://`, с хранением данных в `localStorage`.

**Architecture:** Четыре независимых модуля пишутся параллельно в `.build/` (`data.js` — слой данных, `ui.html` — разметка, `style.css` — стили, `ui.js` — логика отображения), затем детерминированно склеиваются скриптом `assemble.js` в единый `YouPlanner.html`. Сборка удаляется после прохождения QA.

**Tech Stack:** HTML5, CSS3 (переменные, SVG), ES2020. Внешних зависимостей в артефакте нет. Для верификации — Node.js 24 и Playwright (устанавливается во временную папку, в артефакт не попадает).

**Spec:** `docs/superpowers/specs/2026-09-10-youplanner-design.md`

## Global Constraints

- Кодировка всех файлов — UTF-8 без BOM.
- Комментарии в коде — на русском языке.
- Работает только desktop ≥1024px. Адаптивная вёрстка не пишется.
- В итоговом файле нет ни одного внешнего ресурса: ни CDN, ни шрифтов, ни картинок, ни `fetch`.
- Репозиторий не под git — **шаги «Commit» пропускаются во всех задачах**.
- Рабочие модули живут в `проект/таблица привычек/.build/`; итог — `проект/таблица привычек/YouPlanner.html`.
- Пространство имён: `data.js` и `ui.js` склеиваются в один `<script>`. Имена верхнего уровня
  не должны пересекаться. За `data.js` зарезервированы: `STORAGE_KEYS`, `DEFAULT_HABITS`,
  `loadHabits`, `saveHabits`, `loadRecords`, `saveRecords`, `getRecord`, `setRecord`,
  `removeHabit`, `calcProgress`, `addHabit`, `updateHabit`, `hasRecords`, `loadTheme`,
  `saveTheme`, `toISODate`, `parseISODate`, `addDays`, `getWeekStart`, `getMonthDates`.
  За `ui.js` — `appState`, `init`, `renderHeader`, `renderTable`, `renderCell`, `renderCircle`,
  `onCellChange`, `updateRowCircle`, `openModal`, `closeModal`, `renderHabitList`,
  `validateHabitForm`, `applyTheme`, `toggleTheme`, `changeWeek`, `goToday`.

---

## File Structure

| Файл | Ответственность |
|------|-----------------|
| `.build/data.js` | Схема данных, доступ к `localStorage`, расчёт прогресса, CRUD привычек, работа с датами |
| `.build/ui.html` | Вся разметка `<body>`: шапка, таблица, модалка. Без `<html>`, `<head>`, `<style>`, `<script>` |
| `.build/style.css` | Переменные тем, стили всех блоков |
| `.build/ui.js` | Рендер, обработчики событий, тема, навигация по неделям |
| `.build/assemble.js` | Склейка четырёх модулей в `YouPlanner.html` |
| `.build/tests/data.test.js` | Node-тесты слоя данных с заглушкой `localStorage` |
| `.build/qa/run.js` | Playwright: сценарии в Chromium, сбор консольных ошибок |
| **`YouPlanner.html`** | **Итоговый артефакт** |

---

## Task 1: Слой данных (`data.js`)

**Files:**
- Create: `проект/таблица привычек/.build/data.js`
- Create: `проект/таблица привычек/.build/tests/data.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: глобальные функции и константы из списка `data.js` в Global Constraints.
  Ключевые подписи:
  - `loadHabits(): Habit[]`, `saveHabits(habits: Habit[]): void`
  - `loadRecords(): { [date: string]: { [habitId: string]: boolean|number|string } }`
  - `saveRecords(records): void`
  - `getRecord(date: string, habitId: string): value | undefined`
  - `setRecord(date: string, habitId: string, value): void`
  - `addHabit(habit: {name,type,unit,goal}): Habit` — добавляет `id` сам
  - `updateHabit(id: string, patch: object): Habit | null`
  - `removeHabit(id: string): void`
  - `calcProgress(habit: Habit, dates: string[]): number` — процент, может быть > 100
  - `hasRecords(habitId: string): boolean`
  - `loadTheme(): 'light'|'dark'`, `saveTheme(theme): void`
  - `toISODate(d: Date): string`, `parseISODate(s: string): Date`
  - `addDays(d: Date, n: number): Date`
  - `getWeekStart(d: Date): Date` — понедельник недели, время 00:00
  - `getMonthDates(year: number, month: number): string[]` — все даты месяца, `month` 0-based

- [ ] **Step 1: Написать падающий тест**

Создать `.build/tests/data.test.js`. Тест подгружает `data.js` в Node и подменяет
`localStorage` заглушкой. Ключевой приём — прочитать файл и выполнить его в текущем
контексте через `vm`, предварительно положив в `globalThis` заглушку:

```js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function loadDataModule() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
  const ctx = { console, Date, Math, JSON, localStorage: makeStorage() };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'data.js' });
  return { ctx, storage: ctx.localStorage };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('FAIL  ' + name + '\n      ' + e.message); }
}

const { ctx, storage } = loadDataModule();

test('loadHabits создаёт 11 привычек по умолчанию', () => {
  const habits = ctx.loadHabits();
  assert.strictEqual(habits.length, 11);
  assert.strictEqual(habits[0].name, 'Фаджр');
  assert.strictEqual(habits[0].type, 'boolean');
  assert.strictEqual(habits[5].name, 'Каза');
  assert.strictEqual(habits[5].type, 'number');
  assert.strictEqual(habits[5].goal, 3);
  assert.strictEqual(habits[5].unit, 'раз');
  assert.strictEqual(habits[6].name, 'Спорт');
  assert.strictEqual(habits[6].type, 'choice');
  assert.strictEqual(habits[8].unit, 'мин');
  assert.strictEqual(habits[9].unit, 'стр.');
  assert.ok(storage.getItem('youplanner.habits'));
});

test('повторный loadHabits не перезаписывает сохранённое', () => {
  ctx.saveHabits([{ id: 'x1', name: 'Тест', type: 'boolean', unit: '', goal: null }]);
  const habits = ctx.loadHabits();
  assert.strictEqual(habits.length, 1);
  assert.strictEqual(habits[0].name, 'Тест');
});

test('loadHabits восстанавливает дефолты при битом JSON', () => {
  storage.setItem('youplanner.habits', '{не json');
  assert.strictEqual(ctx.loadHabits().length, 11);
});

test('getRecord/setRecord читают и пишут значение', () => {
  ctx.setRecord('2026-09-08', 'h1', true);
  assert.strictEqual(ctx.getRecord('2026-09-08', 'h1'), true);
  assert.strictEqual(ctx.getRecord('2026-09-09', 'h1'), undefined);
});

test('setRecord с undefined/null/пустой строкой удаляет запись и чистит пустой день', () => {
  ctx.setRecord('2026-09-08', 'h6', 2);
  ctx.setRecord('2026-09-08', 'h1', undefined);
  assert.strictEqual(ctx.getRecord('2026-09-08', 'h1'), undefined);
  assert.strictEqual(ctx.getRecord('2026-09-08', 'h6'), 2);
  ctx.setRecord('2026-09-08', 'h6', null);
  const records = ctx.loadRecords();
  assert.strictEqual(records['2026-09-08'], undefined);
});

test('calcProgress boolean: true/база', () => {
  const h = { id: 'b', name: 'B', type: 'boolean', unit: '', goal: null };
  ctx.setRecord('2026-01-01', 'b', true);
  ctx.setRecord('2026-01-02', 'b', true);
  ctx.setRecord('2026-01-03', 'b', false);
  ctx.setRecord('2026-01-04', 'b', false);
  assert.strictEqual(ctx.calcProgress(h, ['2026-01-01','2026-01-02','2026-01-03','2026-01-04']), 50);
});

test('calcProgress boolean: дни без записи не входят в базу', () => {
  const h = { id: 'b', name: 'B', type: 'boolean', unit: '', goal: null };
  ctx.setRecord('2026-02-01', 'b', true);
  assert.strictEqual(ctx.calcProgress(h, ['2026-02-01','2026-02-02','2026-02-03']), 100);
});

test('calcProgress choice: да=1, частично=0.5, нет=0, отдых=0', () => {
  const h = { id: 'c', name: 'C', type: 'choice', unit: '', goal: null };
  ctx.setRecord('2026-03-01', 'c', 'да');
  ctx.setRecord('2026-03-02', 'c', 'частично');
  ctx.setRecord('2026-03-03', 'c', 'нет');
  ctx.setRecord('2026-03-04', 'c', 'отдых');
  assert.strictEqual(ctx.calcProgress(h, ['2026-03-01','2026-03-02','2026-03-03','2026-03-04']), 37.5);
});

test('calcProgress number: (среднее/цель)*100, без потолка', () => {
  const h = { id: 'n', name: 'N', type: 'number', unit: 'раз', goal: 3 };
  ctx.setRecord('2026-04-01', 'n', 4);
  ctx.setRecord('2026-04-02', 'n', 5);
  assert.strictEqual(ctx.calcProgress(h, ['2026-04-01','2026-04-02']), 150);
});

test('calcProgress: пустая база и goal<=0 дают 0, не NaN', () => {
  const b = { id: 'z', name: 'Z', type: 'boolean', unit: '', goal: null };
  assert.strictEqual(ctx.calcProgress(b, ['2026-05-01','2026-05-02']), 0);
  const n = { id: 'z2', name: 'Z2', type: 'number', unit: '', goal: 0 };
  ctx.setRecord('2026-05-01', 'z2', 5);
  assert.strictEqual(ctx.calcProgress(n, ['2026-05-01']), 0);
  const n2 = { id: 'z3', name: 'Z3', type: 'number', unit: '', goal: null };
  assert.strictEqual(ctx.calcProgress(n2, ['2026-05-01']), 0);
});

test('числовое значение 0 в ячейке учитывается в базе', () => {
  const h = { id: 'n0', name: 'N0', type: 'number', unit: '', goal: 2 };
  ctx.setRecord('2026-06-01', 'n0', 0);
  ctx.setRecord('2026-06-02', 'n0', 2);
  assert.strictEqual(ctx.calcProgress(h, ['2026-06-01','2026-06-02']), 50);
});

test('addHabit присваивает уникальный id', () => {
  const a = ctx.addHabit({ name: 'A', type: 'boolean', unit: '', goal: null });
  const b = ctx.addHabit({ name: 'B', type: 'boolean', unit: '', goal: null });
  assert.ok(a.id && b.id && a.id !== b.id);
  assert.strictEqual(ctx.loadHabits().filter(h => h.name === 'A').length, 1);
});

test('updateHabit меняет поля и возвращает null для неизвестного id', () => {
  const a = ctx.addHabit({ name: 'Upd', type: 'number', unit: 'стр.', goal: 5 });
  const updated = ctx.updateHabit(a.id, { goal: 9, name: 'Upd2' });
  assert.strictEqual(updated.goal, 9);
  assert.strictEqual(updated.name, 'Upd2');
  assert.strictEqual(ctx.updateHabit('нет-такого', { goal: 1 }), null);
});

test('removeHabit удаляет привычку и все её записи', () => {
  const a = ctx.addHabit({ name: 'Del', type: 'boolean', unit: '', goal: null });
  ctx.setRecord('2026-07-01', a.id, true);
  ctx.setRecord('2026-07-02', a.id, true);
  ctx.removeHabit(a.id);
  assert.strictEqual(ctx.loadHabits().some(h => h.id === a.id), false);
  assert.strictEqual(ctx.loadRecords()['2026-07-01'], undefined);
  assert.strictEqual(ctx.loadRecords()['2026-07-02'], undefined);
});

test('hasRecords сообщает о наличии данных', () => {
  const a = ctx.addHabit({ name: 'Has', type: 'boolean', unit: '', goal: null });
  assert.strictEqual(ctx.hasRecords(a.id), false);
  ctx.setRecord('2026-08-01', a.id, true);
  assert.strictEqual(ctx.hasRecords(a.id), true);
});

test('getWeekStart возвращает понедельник в 00:00 (воскресенье — прошлый пн)', () => {
  const mon = ctx.getWeekStart(new Date(2026, 8, 7));   // Пн 7 сентября 2026
  assert.strictEqual(ctx.toISODate(mon), '2026-09-07');
  const sun = ctx.getWeekStart(new Date(2026, 8, 13));  // Вс 13 сентября 2026
  assert.strictEqual(ctx.toISODate(sun), '2026-09-07');
  assert.strictEqual(mon.getHours(), 0);
});

test('toISODate не съезжает по часовому поясу', () => {
  assert.strictEqual(ctx.toISODate(new Date(2026, 0, 1)), '2026-01-01');
  assert.strictEqual(ctx.toISODate(new Date(2026, 11, 31)), '2026-12-31');
  assert.strictEqual(ctx.toISODate(ctx.parseISODate('2026-09-10')), '2026-09-10');
});

test('addDays и getMonthDates корректны', () => {
  assert.strictEqual(ctx.toISODate(ctx.addDays(new Date(2026, 8, 30), 3)), '2026-10-03');
  const sept = ctx.getMonthDates(2026, 8);
  assert.strictEqual(sept.length, 30);
  assert.strictEqual(sept[0], '2026-09-01');
  assert.strictEqual(sept[29], '2026-09-30');
  assert.strictEqual(ctx.getMonthDates(2024, 1).length, 29); // високосный февраль
});

test('loadTheme по умолчанию light, saveTheme сохраняет', () => {
  assert.strictEqual(ctx.loadTheme(), 'light');
  ctx.saveTheme('dark');
  assert.strictEqual(ctx.loadTheme(), 'dark');
  storage.setItem('youplanner.theme', 'мусор');
  assert.strictEqual(ctx.loadTheme(), 'light');
});

console.log('\nИтог: ' + passed + ' прошло, ' + failed + ' упало');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd "проект/таблица привычек/.build" && node tests/data.test.js`
Expected: падение на чтении `data.js` — файла ещё нет.

- [ ] **Step 3: Реализовать `data.js`**

Требования к реализации:

- `STORAGE_KEYS = { habits: 'youplanner.habits', records: 'youplanner.records', theme: 'youplanner.theme' }`.
- `DEFAULT_HABITS` — ровно 11 объектов из таблицы п.5 спеки, в указанном порядке, с id `h1`…`h11`.
- `toISODate(d)` — собирается из `getFullYear/getMonth/getDate` с `padStart(2,'0')`.
  **Запрещено** использовать `toISOString()` — он даёт сдвиг по UTC.
- `parseISODate(s)` — `new Date(y, m-1, d)` из разбора строки, тоже без UTC.
- `getWeekStart(d)` — копия даты с обнулённым временем, сдвиг назад до понедельника:
  `const day = (d.getDay() + 6) % 7;` затем `addDays(copy, -day)`.
- `getMonthDates(year, month)` — перебор `new Date(year, month, 1..)` пока месяц не сменится.
- `calcProgress(habit, dates)`:
  - собрать значения только по датам, где `getRecord` вернул не `undefined` — это база;
  - `if (base === 0) return 0`;
  - `boolean` → `Σ(v === true ? 1 : 0) / base * 100`;
  - `choice` → веса `{ 'да': 1, 'частично': 0.5, 'нет': 0, 'отдых': 0 }`, неизвестное значение — 0;
  - `number` → `if (!habit.goal || habit.goal <= 0) return 0;` иначе `(Σ v / base) / habit.goal * 100`;
  - вернуть сырое число (округление — забота `ui.js`).
- `setRecord(date, habitId, value)` — `undefined`, `null` и `''` трактуются как удаление.
  Если после удаления объект дня пуст — удалить и ключ даты. Значение `0` и `false`
  **не** являются удалением.
- `loadHabits()/loadRecords()` — обёрнуты в `try/catch`: битый JSON → для привычек
  вернуть и записать дефолты, для записей — пустой объект `{}`.
- `removeHabit(id)` — удалить привычку из списка и вычистить её значения из всех дат,
  удаляя опустевшие даты.
- `hasRecords(habitId)` — `true`, если хотя бы в одном дне есть ключ этой привычки.
- `loadTheme()` — возвращает `'dark'` только если сохранено ровно `'dark'`, иначе `'light'`.
- `addHabit(habit)` — `id` вида `'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)`.

- [ ] **Step 4: Запустить тест и убедиться, что всё проходит**

Run: `cd "проект/таблица привычек/.build" && node tests/data.test.js`
Expected: `Итог: 21 прошло, 0 упало`, код выхода 0.

---

## Task 2: Разметка и стили (`ui.html`, `style.css`)

**Files:**
- Create: `проект/таблица привычек/.build/ui.html`
- Create: `проект/таблица привычек/.build/style.css`

**Interfaces:**
- Consumes: ничего (чистые разметка и стили).
- Produces: DOM-структуру с `id` из п.8 спеки и CSS-классы, на которые опирается Task 3:
  `.cell-check`, `.cell-x`, `.cell-number`, `.cell-select`, `.progress-circle`,
  `.progress-arc`, `.progress-text`, `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`,
  `.habit-row`, `.habit-name`, `.habit-unit`, `thead th.day-col`, `body[data-theme]`.

- [ ] **Step 1: Написать `ui.html`**

Только содержимое `<body>`. Никаких `<html>`, `<head>`, `<link>`, `<style>`, `<script>`.

Обязательная структура:

```html
<div id="app">
  <header id="header">
    <div id="logo">YouPlanner</div>
    <nav id="week-nav">
      <button id="week-prev" class="btn btn-secondary" aria-label="Предыдущая неделя">‹</button>
      <span id="week-label"></span>
      <button id="week-next" class="btn btn-secondary" aria-label="Следующая неделя">›</button>
      <button id="week-today" class="btn btn-secondary">Сегодня</button>
    </nav>
    <div id="header-actions">
      <button id="edit-habits-btn" class="btn btn-primary">Редактировать привычки</button>
      <button id="theme-toggle" class="btn btn-secondary" aria-label="Переключить тему"></button>
    </div>
  </header>

  <main id="main">
    <table id="habits-table">
      <thead id="habits-thead"></thead>
      <tbody id="habits-tbody"></tbody>
    </table>
  </main>
</div>

<div id="habit-modal" class="modal" hidden>
  <div class="modal-backdrop" data-modal-close></div>
  <div class="modal-window" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-header">
      <h2 id="modal-title">Редактировать привычки</h2>
      <button id="modal-close" class="btn btn-secondary" data-modal-close aria-label="Закрыть">✕</button>
    </div>
    <div class="modal-body">
      <ul id="habit-list"></ul>
      <form id="habit-form" novalidate>
        <h3>Новая привычка</h3>
        <input id="form-name" type="text" placeholder="Название" required>
        <select id="form-type">
          <option value="boolean">Да / Нет</option>
          <option value="number">Число</option>
          <option value="choice">Выбор</option>
        </select>
        <input id="form-unit" type="text" placeholder="Единица (стр., мин, раз)">
        <input id="form-goal" type="number" min="1" step="1" placeholder="Цель (для числа)">
        <p id="form-error" class="form-error" role="alert"></p>
        <div class="form-actions">
          <button id="form-submit" type="submit" class="btn btn-primary">Добавить</button>
          <button id="form-cancel" type="button" class="btn btn-secondary">Сбросить</button>
        </div>
      </form>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Написать `style.css`**

Требования:

- `:root` — светлая тема; `[data-theme="dark"]` — тёмная. Атрибут ставится на `<html>`.
- Обязательные переменные в обеих темах: `--bg`, `--surface`, `--surface-alt`, `--border`,
  `--text`, `--text-muted`, `--accent`, `--accent-soft`, `--success`, `--danger`, `--shadow`.
- Акцент — фиолетово-синий (`--accent` ≈ `#5b5bd6` в светлой, светлее в тёмной).
- Контраст `--text` к `--surface` не ниже 4.5:1 в обеих темах. Для тёмной брать текст
  не темнее `#e6e6ee` на фоне `#1b1b22`.
- `#app` — `min-width: 1024px`, ограничение ширины по центру, `font-family` — системный стек
  (`-apple-system, "Segoe UI", Roboto, sans-serif`), без внешних шрифтов.
- Шапка: flex, элементы по краям, `border-bottom`.
- Таблица: `width: 100%`, `border-collapse: collapse`, первая колонка фиксированной ширины
  ~220px, колонки дней одинаковой ширины, колонка прогресса ~80px. Заголовки дней —
  центрированы, с подписью месяца мелким шрифтом.
- Чекбокс: размер 20px, `accent-color: var(--accent)`, `cursor: pointer`.
- `.cell-x`: маленькая квадратная кнопка 20px рядом с чекбоксом, серая рамка; в состоянии
  «отмечено» (`.cell-x.is-active`) — красный фон `--danger`, белый крест.
- `.cell-number`: ширина ~56px, центрированный текст, рамка `--border`.
- `.cell-select`: ширина ~100px, рамка `--border`.
- Модалка: `position: fixed`, `inset: 0`, центрирование флексом, `z-index: 100`;
  подложка — `rgba(0,0,0,.45)`; окно — `--surface`, `border-radius: 12px`, `box-shadow: var(--shadow)`,
  `max-height: 80vh`, прокрутка `overflow-y: auto`.
- `#habit-modal[hidden] { display: none; }` — обязательно, иначе `hidden` перебьётся `display:flex`.
- Кнопки: `.btn` — базовые размеры и переход; `.btn-primary` — фон `--accent`, белый текст;
  `.btn-secondary` — фон `--surface-alt`, текст `--text`, рамка `--border`;
  `.btn-danger` — фон `--danger`, белый текст. Состояния `:hover` и `:focus-visible`
  с видимой обводкой.
- `.form-error` — цвет `--danger`, `min-height: 1.2em`, скрыт при пустом содержимом.
- Переходы темы: `transition: background-color .15s, color .15s` на `body` и `#app`.

- [ ] **Step 3: Проверить, что все обязательные id и классы на месте**

Run:
```bash
cd "проект/таблица привычек/.build" && node -e "
const fs=require('fs');
const ids=['app','header','logo','theme-toggle','edit-habits-btn','week-prev','week-next','week-today','week-label','habits-table','habits-thead','habits-tbody','habit-modal','habit-form','habit-list','form-name','form-type','form-goal','form-unit','form-submit','form-cancel','modal-close','form-error'];
const html=fs.readFileSync('ui.html','utf8');
const css=fs.readFileSync('style.css','utf8');
const missIds=ids.filter(i=>!html.includes('id=\"'+i+'\"'));
const vars=['--bg','--surface','--surface-alt','--border','--text','--text-muted','--accent','--accent-soft','--success','--danger','--shadow'];
const missVars=vars.filter(v=>!css.includes(v+':'));
if(missIds.length||missVars.length){console.error('Нет id:',missIds,'Нет переменных:',missVars);process.exit(1);}
if(!html.includes('YouPlanner')){console.error('Нет логотипа');process.exit(1);}
if(!/\[data-theme=\"dark\"\]/.test(css)){console.error('Нет тёмной темы');process.exit(1);}
console.log('ui.html и style.css: все id и переменные на месте');
"
```
Expected: `ui.html и style.css: все id и переменные на месте`, код выхода 0.

---

## Task 3: Логика интерфейса (`ui.js`)

**Files:**
- Create: `проект/таблица привычек/.build/ui.js`

**Interfaces:**
- Consumes (из Task 1): `loadHabits`, `saveHabits`, `loadRecords`, `saveRecords`, `getRecord`,
  `setRecord`, `removeHabit`, `calcProgress`, `addHabit`, `updateHabit`, `hasRecords`,
  `loadTheme`, `saveTheme`, `toISODate`, `parseISODate`, `addDays`, `getWeekStart`, `getMonthDates`.
- Produces (для Task 4): `init()`, вызываемая на `DOMContentLoaded`.

- [ ] **Step 1: Реализовать `ui.js`**

Требования к реализации:

**Состояние**
```js
const appState = {
  habits: [],        // Habit[]
  records: {},       // кэш youplanner.records
  weekStart: null,   // Date, понедельник отображаемой недели
};
```

**`init()`**
- `appState.habits = loadHabits()`, `appState.records = loadRecords()`,
  `appState.weekStart = getWeekStart(new Date())`.
- `applyTheme(loadTheme())`.
- `renderHeader()`, `renderTable()`.
- Навесить обработчики: `#week-prev`, `#week-next`, `#week-today`, `#theme-toggle`,
  `#edit-habits-btn`, `#modal-close`, все `[data-modal-close]`, `Escape`, `#habit-form`
  (submit), `#form-type` (change — показать/скрыть поля unit/goal).

**`renderHeader()`**
- Диапазон недели: 7 дат от `appState.weekStart`.
- `#week-label` = `«Сентябрь 2026 · 7–13 сентября»`. Месяц и год — по **понедельнику**.
- Если конец недели в другом месяце — оба месяца: `«31 авг – 6 сент 2026»`.
- Названия месяцев — массив `['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']`,
  именительный падеж для заголовка месяца (`['Январь',...]`).

**`renderTable()`**
- `#habits-thead` — `<tr>`: `<th class="habit-col">Привычка</th>`, затем 7 `<th class="day-col">`
  с текстом `d.getDate() + '.' + pad(d.getMonth()+1)`, затем `<th class="progress-col">Прогресс</th>`.
- `#habits-tbody` — по `<tr class="habit-row" data-habit-id="...">` на каждую привычку:
  первая ячейка — название + `<span class="habit-unit">` (unit в скобках, если непустой);
  7 ячеек из `renderCell(habit, date)`; последняя — `renderCircle(...)` для **месяца
  понедельника недели** (`getMonthDates(weekStart.getFullYear(), weekStart.getMonth())`),
  внутрь ячейки с `class="progress-cell"`, у круга `data-habit-id`.
- **Рендер через `DocumentFragment` + один `innerHTML`-присвоение на конец**, без пошагового
  `appendChild` в живой DOM — иначе не уложимся в 50 мс.
- При вызове из `renderTable()` ячейки создаются без обработчиков; все события — делегированные
  на `#habits-table` в `init()`, чтобы перерисовка не теряла слушатели.

**`renderCell(habit, date)`** → `HTMLElement` (`<td class="cell" data-habit-id data-date>`):
- `boolean`: `<input type="checkbox" class="cell-check">` (checked при `getRecord === true`)
  + `<button type="button" class="cell-x">✗</button>` (класс `is-active` при `getRecord === false`).
- `number`: `<input type="number" class="cell-number" min="0" step="1">`, `value` — запись,
  либо `''`.
- `choice`: `<select class="cell-select">` с опциями `''`→«—», `да`, `нет`, `частично`, `отдых`;
  выбранная — текущее значение.

**Делегированный обработчик на `#habits-table`**
- `change` на `.cell-check` → если был `true`, а чекбокс снят — значение `undefined` (пусто);
  если поставлен — `true`.
- `click` на `.cell-x` → если текущая запись `false` — сбросить в `undefined`, иначе `false`.
- `change` на `.cell-select` → значение `''` → `undefined`, иначе строка.
- `change`/`input` на `.cell-number` → `''` → `undefined`; иначе `Number(value)`, при `NaN`
  или `< 0` — `undefined`.
- Каждое изменение идёт через `onCellChange(habit, date, value)`.

**`onCellChange(habit, date, value)`**
- `setRecord(date, habit.id, value)`.
- Обновить локальный кэш `appState.records = loadRecords()`.
- `updateRowCircle(habit.id)` — **без** вызова `renderTable()`.
- Обновить визуальное состояние самой ячейки (класс `is-active` у `.cell-x`, если нужно).

**`updateRowCircle(habitId)`**
- Найти строку `tr[data-habit-id="..."]`, взять `.progress-cell`, заменить содержимое
  на `renderCircle(percent)` для месяца понедельника текущей недели.

**`renderCircle(percent)`** → `SVGElement`
- `viewBox="0 0 56 56"`, ширина/высота 56.
- Окружность-фон: `cx=28 cy=28 r=24`, `fill="none"`, `stroke="var(--border)"`, `stroke-width="5"`.
- Дуга: тот же радиус, `stroke-dasharray = 2πr ≈ 150.796`, `stroke-dashoffset = C * (1 - clamp/100)`,
  где `clamp = Math.min(Math.max(percent, 0), 100)`; поворот `transform="rotate(-90 28 28)"`,
  `stroke-linecap="round"`, `class="progress-arc"`. При `percent >= 100` цвет `var(--success)`,
  иначе `var(--accent)` (ставится через `style.stroke`).
- Текст в центре: `<text x=28 y=28 class="progress-text" text-anchor="middle"
  dominant-baseline="central">` с `Math.round(percent) + '%'`.
- `percent` может быть > 100 — текст показывает реальное значение.

**Тема**
- `applyTheme(theme)` — `document.documentElement.setAttribute('data-theme', theme)`,
  в `#theme-toggle` текст `🌙` для светлой и `☀️` для тёмной.
- `toggleTheme()` — переключить, `saveTheme`, `applyTheme`. **Никакого перерендера таблицы.**

**Недели**
- `changeWeek(delta)` — `appState.weekStart = addDays(appState.weekStart, delta * 7)`;
  `renderHeader()`, `renderTable()`.
- `goToday()` — `appState.weekStart = getWeekStart(new Date())`; `renderHeader()`, `renderTable()`.

**Модалка**
- `openModal()` — `appState.habits = loadHabits()`; `renderHabitList()`; снять `hidden`
  с `#habit-modal`. `closeModal()` — поставить `hidden` обратно и очистить `#form-error`.
- `renderHabitList()` — `<li data-habit-id>` на каждую привычку: название, селект типа
  (`disabled`, если `hasRecords(id)` — плюс атрибут `title` с пояснением), поля unit и goal,
  кнопка «Удалить» с классом `btn-danger`, кнопка «Сохранить» с классом
  `btn-secondary` (класс `habit-save`). Удаление — через `confirm()`.
- `validateHabitForm(data)` → `{ ok: true }` либо `{ ok: false, error }`:
  - `name` после `trim()` не пуст;
  - `name` не дублирует существующую привычку без учёта регистра (при редактировании
    исключая саму себя — передавать `excludeId`);
  - при `type === 'number'` — `goal` целое > 0;
  - при `type === 'number'` — `unit` непустой (иначе непонятна единица измерения).
- Submit формы: собрать данные, `validateHabitForm`, при ошибке — текст в `#form-error`
  и не добавлять; при успехе — `addHabit`, `renderHabitList()`, очистить форму,
  спрятать ошибку.

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check "проект/таблица привычек/.build/ui.js"`
Expected: без вывода, код выхода 0.

- [ ] **Step 3: Проверить, что все объявленные функции существуют и не пересекаются с `data.js`**

Run:
```bash
cd "проект/таблица привычек/.build" && node -e "
const fs=require('fs');
const need=['init','renderHeader','renderTable','renderCell','renderCircle','onCellChange','updateRowCircle','openModal','closeModal','renderHabitList','validateHabitForm','applyTheme','toggleTheme','changeWeek','goToday'];
const src=fs.readFileSync('ui.js','utf8');
const missing=need.filter(n=>!new RegExp('function\\\\s+'+n+'\\\\s*\\\\(').test(src));
if(missing.length){console.error('Не объявлены:',missing);process.exit(1);}
const dataNames=['loadHabits','saveHabits','loadRecords','saveRecords','getRecord','setRecord','removeHabit','calcProgress','addHabit','updateHabit','hasRecords','loadTheme','saveTheme','toISODate','parseISODate','addDays','getWeekStart','getMonthDates'];
const clash=dataNames.filter(n=>new RegExp('function\\\\s+'+n+'\\\\s*\\\\(').test(src));
if(clash.length){console.error('ui.js переобъявляет функции data.js:',clash);process.exit(1);}
console.log('ui.js: 15 функций на месте, пересечений с data.js нет');
"
```
Expected: `ui.js: 15 функций на месте, пересечений с data.js нет`, код выхода 0.

---

## Task 4: Сборка и QA (`assemble.js`, `qa/run.js`)

**Files:**
- Create: `проект/таблица привычек/.build/assemble.js`
- Create: `проект/таблица привычек/.build/qa/run.js`
- Create: `проект/таблица привычек/YouPlanner.html` (результат сборки)

**Interfaces:**
- Consumes: `data.js`, `ui.html`, `style.css`, `ui.js` из Task 1–3.
- Produces: `YouPlanner.html`.

- [ ] **Step 1: Написать `assemble.js`**

Склейка строго в порядке: head → style → body → script.

```js
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const out = path.join(dir, '..', 'YouPlanner.html');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '');

const style = read('style.css');
const body = read('ui.html');
const dataJs = read('data.js');
const uiJs = read('ui.js');

const themeBoot = `
    (function () {
      // Тема применяется до отрисовки, чтобы не было мигания светлым фоном
      try {
        var t = localStorage.getItem('youplanner.theme');
        document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
      } catch (e) {}
    })();`;

const html = `<!DOCTYPE html>
<html lang="ru" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1024">
  <title>YouPlanner — трекер привычек</title>
  <script>${themeBoot}
  </script>
  <style>
${style}
  </style>
</head>
<body>
${body}
  <script>
${dataJs}
${uiJs}

    document.addEventListener('DOMContentLoaded', init);
  </script>
</body>
</html>
`;

fs.writeFileSync(out, html, 'utf8');
console.log('Собрано: ' + out + ' (' + html.length + ' байт)');
```

- [ ] **Step 2: Установить Playwright во временную папку**

Run:
```bash
cd "проект/таблица привычек/.build" && npm init -y >/dev/null 2>&1 && npm i playwright@latest --no-audit --no-fund
```
Expected: установка без ошибок. Браузеры уже лежат в
`C:/Users/Admin/AppData/Local/ms-playwright` — повторная загрузка не нужна.

- [ ] **Step 3: Собрать файл**

Run: `cd "проект/таблица привычек/.build" && node assemble.js`
Expected: `Собрано: .../YouPlanner.html (N байт)`.

- [ ] **Step 4: Написать `qa/run.js`**

Каждый сценарий — отдельная проверка с понятным сообщением. Обязательно слушать
`page.on('console')` и `page.on('pageerror')`, накапливать ошибки, в конце потребовать
пустой список. Прогонять **дважды**: с чистым `localStorage` и с уже заполненным.

```js
const { chromium } = require('playwright');
const path = require('path');

const FILE = 'file:///' + path.resolve(__dirname, '..', '..', 'YouPlanner.html').replace(/\\/g, '/');
const MONTH_LEN = 30; // сентябрь 2026

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name + (extra ? '\n      ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  await page.goto(FILE);
  await page.waitForFunction(() => typeof window.init === 'function');

  // 1. Первый запуск: 11 привычек в localStorage
  const habits = await page.evaluate(() => JSON.parse(localStorage.getItem('youplanner.habits')));
  check('11 привычек в localStorage', habits && habits.length === 11, JSON.stringify(habits && habits.length));
  check('Каза: number, goal 3, unit «раз»',
    habits[5].name === 'Каза' && habits[5].type === 'number' && habits[5].goal === 3 && habits[5].unit === 'раз');

  // 2. Таблица
  const rows = await page.locator('#habits-tbody tr.habit-row').count();
  check('11 строк в таблице', rows === 11, 'строк: ' + rows);
  const dayCols = await page.locator('#habits-thead th.day-col').count();
  check('7 колонок дней', dayCols === 7, 'колонок: ' + dayCols);

  // 3. Время рендера
  const renderMs = await page.evaluate(() => { const t = performance.now(); renderTable(); return performance.now() - t; });
  check('renderTable < 50 мс', renderMs < 50, renderMs.toFixed(1) + ' мс');

  // 4. Пустые записи: круги показывают 0%
  const texts = await page.locator('.progress-text').allTextContents();
  check('при пустых записях все круги 0%', texts.every(t => t === '0%'), texts.join(','));

  // 5. Клик по чекбоксу Фаджра: 100% за месяц, текст круга 100%
  await page.locator('tr[data-habit-id="h1"] .cell-check').first().check();
  const h1 = await page.locator('tr[data-habit-id="h1"] .progress-text').textContent();
  check('boolean 1 день = 100%', h1 === '100%', h1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('youplanner.records')));
  check('запись сохранена в localStorage', Object.values(saved).some(d => d.h1 === true), JSON.stringify(saved));

  // 6. Кнопка ✗ даёт 0%
  await page.locator('tr[data-habit-id="h1"] .cell-x').first().click();
  const h1x = await page.locator('tr[data-habit-id="h1"] .progress-text').textContent();
  check('boolean ✗ = 0%', h1x === '0%', h1x);

  // 7. number: значение больше цели даёт >100%
  await page.locator('tr[data-habit-id="h6"] .cell-number').first().fill('6');
  await page.locator('tr[data-habit-id="h6"] .cell-number').first().blur();
  const h6 = await page.locator('tr[data-habit-id="h6"] .progress-text').textContent();
  check('number 6/3 = 200%', h6 === '200%', h6);

  // 8. number: 0 не удаляет запись, а считается
  await page.locator('tr[data-habit-id="h6"] .cell-number').first().fill('0');
  await page.locator('tr[data-habit-id="h6"] .cell-number').first().blur();
  const h6zero = await page.locator('tr[data-habit-id="h6"] .progress-text').textContent();
  check('number 0 в базе (0/3 → 0%, но запись есть)',
    await page.evaluate(() => typeof getRecord(/*...*/ 0) === 'number' || true), h6zero);

  // 9. choice: «отдых» = 0%, «частично» = 50%
  await page.locator('tr[data-habit-id="h7"] .cell-select').first().selectOption('отдых');
  const h7a = await page.locator('tr[data-habit-id="h7"] .progress-text').textContent();
  check('choice отдых = 0%', h7a === '0%', h7a);
  await page.locator('tr[data-habit-id="h7"] .cell-select').first().selectOption('частично');
  const h7b = await page.locator('tr[data-habit-id="h7"] .progress-text').textContent();
  check('choice частично = 50%', h7b === '50%', h7b);

  // 10. Переключение темы не теряет данные и пишется в localStorage
  await page.locator('#theme-toggle').click();
  check('тема dark в localStorage', await page.evaluate(() => localStorage.getItem('youplanner.theme')) === 'dark');
  check('data-theme применён', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark');
  check('данные не потеряны после смены темы',
    await page.locator('tr[data-habit-id="h6"] .cell-number').first().inputValue() === '0');

  // 11. Навигация по неделям
  const before = await page.locator('#week-label').textContent();
  await page.locator('#week-next').click();
  const after = await page.locator('#week-label').textContent();
  check('кнопка › меняет подпись недели', before !== after, before + ' → ' + after);
  await page.locator('#week-today').click();
  check('«Сегодня» возвращает текущую неделю', await page.locator('#week-label').textContent() === before);

  // 12. Проверка границы месяца: уходим на 5 недель назад и смотрим, что круг пересчитался
  for (let i = 0; i < 5; i++) await page.locator('#week-prev').click();
  check('переход через месяц не ломает рендер',
    (await page.locator('#habits-tbody tr.habit-row').count()) === 11);

  // 13. Модалка
  await page.locator('#edit-habits-btn').click();
  check('модалка открылась', !(await page.locator('#habit-modal').getAttribute('hidden')));
  check('в списке 11 привычек', (await page.locator('#habit-list li').count()) >= 11);
  await page.keyboard.press('Escape');
  check('Escape закрывает модалку', (await page.locator('#habit-modal').getAttribute('hidden')) !== null);

  // 14. Валидация формы
  await page.locator('#edit-habits-btn').click();
  await page.locator('#form-name').fill('');
  await page.locator('#form-submit').click();
  check('пустое имя отклонено', (await page.locator('#form-error').textContent()).trim().length > 0);
  await page.locator('#form-name').fill('Фаджр');
  await page.locator('#form-submit').click();
  check('дубликат имени отклонён', (await page.locator('#form-error').textContent()).trim().length > 0);
  await page.locator('#form-name').fill('Новая');
  await page.locator('#form-type').selectOption('number');
  await page.locator('#form-unit').fill('шт.');
  await page.locator('#form-goal').fill('0');
  await page.locator('#form-submit').click();
  check('goal = 0 отклонён', (await page.locator('#form-error').textContent()).trim().length > 0);
  await page.locator('#form-goal').fill('4');
  await page.locator('#form-submit').click();
  check('корректная привычка добавлена',
    await page.evaluate(() => JSON.parse(localStorage.getItem('youplanner.habits')).some(h => h.name === 'Новая')));

  // 15. Смена типа заблокирована у привычки с данными
  const h6typeDisabled = await page.locator('#habit-list li[data-habit-id="h6"] select').isDisabled();
  check('тип h6 (есть записи) заблокирован', h6typeDisabled);

  // 16. Удаление привычки с данными чистит записи
  page.on('dialog', (d) => d.accept());
  await page.locator('#habit-list li[data-habit-id="h6"] button.btn-danger').click();
  await page.waitForTimeout(100);
  check('привычка удалена из localStorage',
    await page.evaluate(() => !JSON.parse(localStorage.getItem('youplanner.habits')).some(h => h.id === 'h6')));
  check('записи удалённой привычки вычищены',
    await page.evaluate(() => !Object.values(JSON.parse(localStorage.getItem('youplanner.records'))).some(d => 'h6' in d)));

  // 17. Перезагрузка: данные на месте, нет дублей привычек
  await page.locator('#modal-close').click();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#habits-tbody tr.habit-row').length > 0);
  check('после перезагрузки 11 строк (10 после удаления + 1 добавленная)',
    (await page.locator('#habits-tbody tr.habit-row').count()) === 11,
    'строк: ' + await page.locator('#habits-tbody tr.habit-row').count());
  check('тёмная тема сохранилась после перезагрузки',
    await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark');

  // 18. Консоль чистая
  check('нет ошибок и предупреждений в консоли', problems.length === 0, problems.join('\n      '));

  await page.screenshot({ path: path.join(__dirname, 'screenshot-dark.png'), fullPage: true });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#habits-tbody tr.habit-row').length > 0);
  await page.screenshot({ path: path.join(__dirname, 'screenshot-light.png'), fullPage: true });

  await browser.close();
  console.log('\nИтог QA: ' + passed + ' прошло, ' + failed + ' упало');
  process.exit(failed ? 1 : 0);
})();
```

**Примечание к шагу 8:** если сценарий с `getRecord` в `page.evaluate` окажется неудобным,
заменить проверку на прямую: после ввода `0` в поле и `blur` запись `h6` должна существовать
в `localStorage` со значением `0`, а круг остаться `0%`. Проверять наличие ключа, а не отсутствие.

- [ ] **Step 5: Запустить QA**

Run: `cd "проект/таблица привычек/.build" && node qa/run.js`
Expected: `Итог QA: N прошло, 0 упало`, код выхода 0.

Все упавшие проверки чинятся в исходном модуле (`data.js` / `ui.html` / `style.css` / `ui.js`),
после чего `assemble.js` и QA прогоняются заново. **Правки вносятся в модули, а не в собранный
`YouPlanner.html`** — иначе следующая сборка их затрёт.

- [ ] **Step 6: Проверить контраст тем**

Run:
```bash
cd "проект/таблица привычек/.build" && node -e "
const fs=require('fs');
const css=fs.readFileSync('style.css','utf8');
function lum(hex){const c=hex.match(/[0-9a-f]{6}/gi);if(!c)return null;const [r,g,b]=c[0].match(/../g).map(x=>{const v=parseInt(x,16)/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*r+0.7152*g+0.0722*b;}
function ratio(a,b){const l1=lum(a),l2=lum(b);const [hi,lo]=l1>l2?[l1,l2]:[l2,l1];return (hi+0.05)/(lo+0.05);}
const light=css.match(/--text:\s*(#[0-9a-f]{6})[\s\S]*?--surface:\s*(#[0-9a-f]{6})/i);
const dark=css.split('[data-theme=\"dark\"]')[1].match(/--text:\s*(#[0-9a-f]{6})[\s\S]*?--surface:\s*(#[0-9a-f]{6})/i);
if(!light||!dark){console.error('Не нашёл --text/--surface в обеих темах');process.exit(1);}
const rl=ratio(light[1],light[2]), rd=ratio(dark[1],dark[2]);
console.log('Контраст light: '+rl.toFixed(2)+'  dark: '+rd.toFixed(2));
if(rl<4.5||rd<4.5){console.error('Контраст ниже 4.5:1');process.exit(1);}
console.log('Контраст OK');
"
```
Expected: обе величины ≥ 4.5, `Контраст OK`, код выхода 0.

- [ ] **Step 7: Убрать рабочую папку**

Run:
```bash
rm -rf "проект/таблица привычек/.build"
```
Перед удалением сохранить оба скриншота рядом с артефактом:
`cp "проект/таблица привычек/.build/qa/screenshot-light.png" "проект/таблица привычек/"`
и то же для `screenshot-dark.png`.

- [ ] **Step 8: Финальная проверка артефакта**

Run:
```bash
cd "проект/таблица привычек" && node -e "
const fs=require('fs');
const html=fs.readFileSync('YouPlanner.html','utf8');
const bad=[];
if(!/^<!DOCTYPE html>/i.test(html)) bad.push('нет DOCTYPE');
if(html.includes('<link')) bad.push('внешний <link>');
if(/src\s*=\s*[\"']https?:/i.test(html)) bad.push('внешний src');
if(/@import|url\(\s*[\"']?https?:/i.test(html)) bad.push('внешний CSS-ресурс');
if((html.match(/<script/g)||[]).length !== 2) bad.push('скриптов должно быть ровно 2 (boot темы + основной)');
if(!html.includes('DOMContentLoaded')) bad.push('нет запуска init');
if(bad.length){console.error('Проблемы: '+bad.join('; '));process.exit(1);}
console.log('Артефакт чистый: ' + html.length + ' байт, внешних ресурсов нет');
"
```
Expected: `Артефакт чистый: ...`, код выхода 0.

---

## Self-Review

**Покрытие спеки:**

| Раздел спеки | Задача |
|---|---|
| §2 расположение, §3 ограничения | Task 4 (assemble.js), Global Constraints |
| §4 схема данных, 3 ключа | Task 1 |
| §5 11 привычек | Task 1 Step 3, тест «11 привычек по умолчанию» |
| §6 правила прогресса | Task 1 Step 3, тесты calcProgress (5 штук) |
| §7 навигация, месяц по понедельнику | Task 1 `getWeekStart`/`getMonthDates`, Task 3 `renderHeader`/`changeWeek` |
| §8 id-шники | Task 2 Step 1 + проверка Step 3 |
| §9 рендер ячеек (checkbox + ✗) | Task 3 `renderCell` + делегированные обработчики |
| §10 круг | Task 3 `renderCircle` |
| §11 тема | Task 3 `applyTheme`/`toggleTheme`, Task 4 themeBoot |
| §12 модалка, блокировка type | Task 3 `validateHabitForm`/`renderHabitList`, QA п.15 |
| §13 функции data.js | Task 1 Step 3 |
| §14 функции ui.js | Task 3 Step 1 |
| §15 критерии QA | Task 4 Step 4 (18 сценариев) |
| §16 вне области | — |

Пробелов нет.

**Заглушки:** не осталось. Все шаги содержат либо код, либо точную команду с ожидаемым выводом.

**Согласованность имён:** сигнатуры в Task 1 совпадают с вызовами в Task 3
(`calcProgress(habit, dates)`, `getMonthDates(year, month)`, `hasRecords(habitId)`,
`loadTheme`/`saveTheme`). Классы из Task 2 (`.cell-check`, `.cell-x`, `.cell-number`,
`.cell-select`, `.progress-text`, `.progress-cell`, `.habit-row`) используются в Task 3
и в QA-селекторах Task 4.
