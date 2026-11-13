// v59 (v58 -> v59): аудит 2026-11-13 — Low-фиксы и дедупликация (YP-08).
// Дедупликация: четыре предиката «plain object» и две проверки ISO-даты
// сведены в новый общий модуль js/core/struct.js (добавлен в ASSETS).
// Низкие находки правили код: js/app.js, js/data/matrix-schedule.js,
// js/data/matrix.js, js/data/records.js, js/data/sleep.js,
// js/data/storage.js, js/sync/apply-engine.js, js/sync/merge.js,
// js/sync/sections.js, js/sync/sync.js, js/ui/assistant-analysis.js,
// js/ui/assistant-view.js, js/ui/matrix-view.js, sw.js и тесты
// tests/assistant-analysis.test.mjs, tests/assistant.test.mjs,
// tests/e2e/user-crash.e2e.mjs, tests/matrix-calendar.test.mjs,
// tests/planner-sync.test.mjs, tests/qaza-clean-device.test.mjs,
// tests/sync-retry.test.mjs, tests/sync.test.mjs.
// v58 (v57 -> v58): дескрипторная sync-архитектура (АДР 2026-11-08) —
// applyCloudData/applyMergedFromCloud/mergeCloudIntoLocal разложены на
// таблицу CLOUD_SECTIONS (js/sync/sections.js) и два движка:
// js/sync/apply-engine.js (writeStaged — единственная атомарная запись
// «все или ничего» + generic-луп снимка) и js/sync/merge-engine.js
// (ключи и метки из дескрипторов); js/sync/merge.js — луп по таблице
// (mergeSectionKey удалён), js/sync/sync.js ужат до транспорта и гейтов
// новизны, js/sync/core.js — флаг syncing + setSyncing; три модуля
// добавлены в ASSETS. Новый постоянный гейт гонки двух устройств на
// честном моке Firebase (ETag/If-Match/412): tests/e2e/sync-race.e2e.mjs
// (tests/helpers/sources.mjs, tests/smoke.test.mjs).
// v57 (v56 -> v57): bindEvents (832 строки, 124 слушателя) вынесен из
// js/app.js в три модуля-обработчика — таблица/список, навигация, хаб
// статистики, периоды, правка привычек, таб-бар (js/events/nav-events.js);
// синк, владелец, экспорт/импорт, фон, форма привычки
// (js/events/sync-data-events.js); ассистент, каза, ураза, расписание,
// клавиатура/шторки (js/events/screens-events.js) — три файла добавлены
// в ASSETS, тесты-стражи лонг-пресса перепривязаны на новый модуль
// (tests/assistant-delete.test.mjs, tests/assistant-longpress.test.mjs).
// Под v57 кэша ушли и аудит-фиксы между бампами: адопция серверных
// привычек не отменяет непогашенное удаление всех привычек (js/sync/sync.js),
// импорт копии — records через validCloudRecords, лимит file.size 5 МБ
// (js/app.js, js/data/backup.js).
// v56 (v55 -> v56): краш-тесты ПК — аккордеон «Редактирования привычек»
// раскрывается на ПК (styles/habits-edit.css), Матрица Эйзенхауэра
// доступна на ПК (index.html, js/app.js, js/ui/matrix-view.js,
// styles/mobile.css, tests/e2e/user-crash.e2e.mjs); low-замечания ревью —
// четвёртая копия pluralDays, boolean-контракт saveStatsPeriod/saveQazaLog,
// устаревший комментарий (js/data/matrix-schedule.js, js/data/qaza.js,
// js/data/stats.js, js/sync/sync.js, tests/planner-sync.test.mjs).
// v55 (v54 -> v55): набор гипотез Г1–Г5 (аудит сети и дубликатов).
// Г1: контрольный GET перед корневым PUT убран — гонку B.2 закрывает
// условная запись (If-Match → 412 → перечитывание → слияние → повтор),
// корневой PUT несёт X-Firebase-ETag, lastCloudEtag обновляется и от
// ответа успешного PUT. Г2: бэкап-снимок не чаще раза за
// BACKUP_MIN_INTERVAL_MS = 5 минут (метка — только после успешного PUT
// списка копий). Г3: дубли выведены в общие функции — pluralDays
// (core/dates.js), midnightArcMinutes (records.js), timeoutGuard
// (core/dom.js, таймауты слоёв прежние: 20/30/60 с). Г4: магические числа
// в именованные константы (DAY_MS, PROGRESS_CACHE_LIMIT, MOBILE_MAX_WIDTH_PX,
// геометрия капли таб-бара; для минут суток переиспользован существующий
// MINUTES_PER_DAY из matrix-schedule.js).
// Г5: boolean-контракт save-функций (prayer/fast/sleep — ранние выходы
// возвращают false), св-гард same-origin в network-first кэше (чужие
// origin-ответы в офлайн-копию не кладутся), 'online' → scheduleSync —
// при возвращении сети pending-правки уходят сразу. Состав ASSETS
// не менялся — только содержимое перечисленных файлов.
// v54 (v53 -> v54): КОРЕНЬ 401 найден живым E2E — RTDB REST отвечает
// 401 «Unauthorized request.» на Authorization: Bearer с Firebase ID-токеном
// (валидность доказана успешным securetoken-обменом), ID-токен он признаёт
// только легаси-параметром ?auth=. Транспорт возвращён на ?auth= (компромисс:
// токен в URL оседает в логах; компенсация — App Check, «Предложено»).
// Лечение 401 (текст тела, беззаголовочная пауза, refreshAuthToken) сохранено.
// (js/sync/sync.js, js/data/firebase-auth.js). Состав ASSETS не менялся.
// v53 (v52 -> v53): финальный фикс 401 — лечение токеном в двух случаях:
// (а) ходили С токеном, и тело 401 говорит «протух» — тело читается ТЕКСТОМ
// (не JSON: прокси/нестандартный сервер отвечают текстом, прежний
// probe.json() кидал исключение и лечение не запускалось); (б) ходили БЕЗ
// токена (пауза getAuthToken после разового сбоя) — при живом
// refresh-токене в хранилище беззаголовочный 401 лечится обменом, пауза
// снимается. Отказ правил «Permission denied» обменом не лечится.
// refreshAuthToken — владельческое имя обмена, auth-таймаут 30 с
// (js/data/firebase-auth.js, js/sync/sync.js). Состав ASSETS не менялся —
// правило прежнее: любой изменившийся в main файл из ASSETS обязан уйти
// в новое имя кэша.
// v52 (v51 -> v52): календарь Матрицы — при СОЗДАНИИ задачи прошедшие дни
// закрыты: клик по вчерашнему и раньше не меняет черновик, показывает тост
// «Нельзя создать задачу в прошлом», дни в сетке серые и некликабельны
// (is-past, aria-disabled), остаются видимыми. Режим листа — по цели
// открытия (mode 'draft'/'task'), не по наличию startDate: второй показ
// листа у черновика с уже выбранной датой — всё ещё создание
// (js/ui/matrix-view.js, styles/matrix.css). Состав ASSETS не менялся —
// правило прежнее: любой изменившийся в main файл из ASSETS обязан уйти
// в новое имя кэша.
// v51 (v50 -> v51): правки марафона-4 — auth-таймаут поднят с 5 с до 30 с,
// ДЛИННЕЕ синкового 20 с: securetoken-обмен на медленной сети обрывался
// «Fetch is aborted» раньше ответа, refresh срывался (js/data/firebase-auth.js).
// Мердж релога: закрыт путь воскрешения удалённой привычки после релога —
// чистка устаревшего локального кэша перед слиянием и PUT
// (js/sync/sync.js, js/sync/merge.js). Null-дни (битый день вместо объекта)
// в loadRecords отбрасываются (js/data/records.js). Восстановимый qazaLog:
// журнал не сбрасывается при битом поле, since восстанавливается по самой
// ранней валидной записи; qazaState перечитывается по storage-событиям,
// кросс-вкладка (js/data/qaza.js). Marked-проход: один проход по парам
// {date, value, marked} в renderStatsHabitView вместо четырёх
// (js/ui/stats-view.js). Даты недели/месяца собираются из цикла
// renderTable: 13 -> 2 сборок (js/ui/main-table.js). Проводка жеста
// долгого нажатия ленты чата (js/app.js). Состав ASSETS не менялся —
// правки легли в уже кэшируемые файлы, обновилось только имя кэша.
// Правило прежнее: любой изменившийся в main файл из ASSETS обязан уйти
// в новое имя кэша, иначе устройство крутит старые байты.
// v50: синхронизация — авто-refresh id-токена: 401 INVALID_ID_TOKEN -> ровно
// один securetoken-обмен -> повтор запроса с новыми токенами; битый
// refresh-токен -> полный разлогин (js/data/firebase-auth.js, js/sync/sync.js);
// токен теперь в заголовке Authorization: Bearer вместо ?auth= в URL.
// Чат ИИ: шторка удаления заменена компактным попапом у пузыря — долгое
// нажатие, позиционирование от getBoundingClientRect (js/ui/assistant-view.js,
// index.html, styles/assistant.css). CSP: frame-ancestors 'none' в мете и в
// заголовке хостинга (index.html, firebase.json). Правило прежнее: любой
// изменившийся в main файл из ASSETS обязан уйти в новое имя кэша, иначе
// устройство крутит старые байты.
// (v49: синхронизация — plannerV1 уехал из корневого снимка на выделенный
// узел -planner (js/sync/core.js, js/sync/sync.js: свой CAS-контур с If-Match
// и миграция legacy-данных; корневой PUT старого клиента больше не может
// стереть Матрицу), четыре раздела qaza/prayer/fast/schedule завернуты в
// LWW-конверты {v, ts} (js/sync/sync.js, js/sync/merge.js, js/data/storage.js
// и сами разделы). Безопасность: CSP-мета в index.html. Чат ИИ: крестик «✕»
// заменён долгим нажатием на пузырь (450 мс) с листом «Удалить/Отмена»
// (js/ui/assistant-view.js, js/app.js, index.html, styles/assistant.css).
// Превью «Далее» в листе даты считает остаток серии от series.index задачи
// (js/ui/matrix-view.js). Правило прежнее: любой изменившийся в main файл из
// ASSETS обязан уйти в новое имя кэша, иначе устройство крутит старые байты.
// (v48: чистка мёртвого кода — четыре микро-CSS-файла слиты в соседние по
// смыслу (buttons.css → layout.css, cells.css и progress-circle.css →
// table.css, sparkline.css → stats.css, background.css → settings.css),
// ui/constants.js слит в ui/state.js; правила перенесены дословно, порядок
// каскада сохранён.)
// (v47: эмодзи вместо SVG-трендов в пунктах меню статистики (index.html,
// js/ui/stats-view.js, styles/mobile.css, стили спарклайнов — теперь в
// styles/stats.css) и стили календаря/матрицы по замеру TickTick — серые
// поля вместо синих рамок, iOS-тумблер «Весь день», радиусы/зазоры/паддинги,
// без грипа листов (js/ui/matrix-view.js, styles/matrix.css).)
// (v46 — правка текстовая (в комментарии js/data/matrix.js:771 перепутались
// алфавиты), v45 — четыре файла после v44, v44 — восемь файлов аудита,
// v43 — транспорт plannerV1, v42 — пересобранная вёрстка Матрицы.)
const CACHE = 'youplanner-v59';
// Иконки — все из manifest.json: отсутствующая в кэше иконка ломала бы
// офлайн-установку PWA (аудит 2026-10-31: icon-512.png не кэшировался)
const ASSETS = ['./', './index.html', './manifest.json', './icon-180.png', './icon-512.png', './icon.svg',
  './styles/tokens.css', './styles/layout.css',
  './styles/table.css',
  './styles/modal.css', './styles/qaza.css', './styles/day-view.css',
  './styles/schedule.css', './styles/sheets.css', './styles/prayer.css',
  './styles/toast.css', './styles/settings.css', './styles/stats.css',
  './styles/habits-edit.css', './styles/assistant.css',
  './styles/mobile.css', './styles/matrix.css',
  // pdf.js для чтения PDF в ассистенте: локальные копии вместо CDN —
  // офлайн-PWA разбирает файлы без сети
  './js/vendor/pdf.min.mjs', './js/vendor/pdf.worker.min.mjs',
  './js/data/firebase-auth.js',
  // Общие примитивы структуры значений (аудит 2026-11-13, YP-08)
  './js/core/struct.js',
  './js/sync/sync.js',
  // Движки применения облачного снимка (АДР 2026-11-08): дескрипторная
  // таблица + путь снимка + путь гонки
  './js/sync/sections.js',
  './js/sync/apply-engine.js',
  './js/sync/merge-engine.js',
  './js/ui/state.js',
  './js/ui/assistant-view.js',
  // Подсистемы ассистента, вынесенные из assistant-view.js (этап D.5;
  // vision и API-клиент слиты в assistant-media.js, этап Y1)
  './js/ui/assistant-pdf.js',
  './js/ui/assistant-media.js',
  // Кнопка «Анализ привычек»: снимок статистики в реплику чата
  './js/ui/assistant-analysis.js',
  './js/ui/prayer-view.js',
  './js/ui/fast-view.js',
  './js/ui/sleep-view.js',
  './js/ui/qaza-view.js',
  './js/ui/schedule-view.js',
  './js/ui/router.js',
  './js/ui/main-table.js',
  './js/ui/level-sheet.js',
  './js/ui/habits-edit.js',
  './js/ui/stats-view.js',
  './js/app.js',
  // Обработчики bindEvents, вынесенные из app.js (пилот Фабрики 2026-11-08)
  './js/events/nav-events.js',
  './js/events/sync-data-events.js',
  './js/events/screens-events.js',
  './js/core/bus.js', './js/core/dates.js',
  './js/core/storage.js', './js/core/dom.js',
  './js/data/storage.js', './js/data/schedule.js', './js/data/habits.js',
  './js/data/migrations.js', './js/data/records.js', './js/data/qaza.js',
  './js/data/prayer.js', './js/data/fast.js', './js/data/sleep.js',
  './js/data/stats.js', './js/data/backup.js', './js/data/background.js',
  './js/data/archive.js', './js/data/image.js',
  // Матрица Эйзенхауэра и спарклайны в статистике
  './js/data/matrix.js',
  // Интервал, повтор и локальные напоминания Матрицы (ТЗ Воркера 2)
  './js/data/matrix-schedule.js',
  './js/core/matrix-reminders.js',
  './js/ui/matrix-notices.js',
  './js/ui/matrix-view.js',
  './js/ui/sparkline.js',
  './js/sync/core.js', './js/sync/merge.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  // Не-GET (POST к api.neuraldeep.ru, запись в Firebase) кэшировать нельзя:
  // уходим в сеть без caches.match и respondWith.
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // Синхронизация с Firebase не кэшируется и не задерживается на caches.match
  if (url.indexOf('firebaseio.com') !== -1 || url.indexOf('firebase.google.com') !== -1) return;
  // HTML, JS и CSS — network-first: свежий index.html + свежие модули важнее
  // кэша. До Фазы 3.2 не-HTML отдавался cache-first, и обновление деплоя
  // давало version-skew: новый HTML подключал старые скрипты из кэша.
  // Успешный ответ кладётся в кэш и работает офлайн; при офлайне ИЛИ битом
  // HTTP-ответе (404 неатомарного деплоя, 500 на бэкенде) в кэш мусор не
  // кладём — отдаётся прежняя рабочая версия из кэша, а не сломанный ответ.
  if (url.endsWith('.html') || url.endsWith('/') ||
      url.endsWith('.js') || url.endsWith('.css')) {
    e.respondWith(
      fetch(e.request).then(function (resp) {
        // Кэш — офлайн-копия собственного деплоя, чужие ответы в него не
        // кладём: cross-origin скрипты/стили (CDN, счётчики) прошли бы resp.ok
        // и распухали бы кэш чужими байтами. Firebase-домены отфильтрованы
        // выше по URL; здесь гард по origin запроса.
        if (resp && resp.ok && new URL(url).origin === self.location.origin) {
          const copy = resp.clone();
          // Запись в кэш — побочный эффект мимо respondWith: без waitUntil
          // SW может уснуть до её завершения, и офлайн-копия не обновится
          e.waitUntil(caches.open(CACHE).then(function (c) { c.put(e.request, copy); }));
          return resp;
        }
        // Битый HTTP-ответ — НЕ ответ пользователю: в кэше лежит целая версия,
        // и именно её просит браузер. Проверка resp.ok, а не отклонения
        // промиса: fetch разрешается и на 500, поэтому прежний .catch() такую
        // ошибку вообще не видел. Копии в кэше нет — отдаём как есть:
        // выдуманная заглушка притворялась бы целой страницей.
        return caches.match(e.request).then(function (cached) { return cached || resp; });
      }).catch(function () { return caches.match(e.request); })
    );
  } else {
    e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
  }
});
