const CACHE = 'youplanner-v26';
// Иконки — все из manifest.json: отсутствующая в кэше иконка ломала бы
// офлайн-установку PWA (аудит 2026-10-31: icon-512.png не кэшировался)
const ASSETS = ['./', './index.html', './manifest.json', './icon-180.png', './icon-512.png', './icon.svg',
  './styles/tokens.css', './styles/layout.css', './styles/buttons.css',
  './styles/table.css', './styles/cells.css', './styles/progress-circle.css',
  './styles/modal.css', './styles/qaza.css', './styles/day-view.css',
  './styles/schedule.css', './styles/sheets.css', './styles/prayer.css',
  './styles/toast.css', './styles/settings.css', './styles/stats.css',
  './styles/habits-edit.css', './styles/assistant.css', './styles/background.css',
  './styles/mobile.css',
  // pdf.js для чтения PDF в ассистенте: локальные копии вместо CDN —
  // офлайн-PWA разбирает файлы без сети
  './js/vendor/pdf.min.mjs', './js/vendor/pdf.worker.min.mjs',
  './js/sync/sync.js',
  './js/ui/state.js',
  './js/ui/assistant-view.js',
  './js/ui/prayer-view.js',
  './js/ui/fast-view.js',
  './js/ui/sleep-view.js',
  './js/ui/qaza-view.js',
  './js/ui/schedule-view.js',
  './js/ui/stats-helpers.js',
  './js/ui/router.js',
  './js/ui/main-table.js',
  './js/ui/level-sheet.js',
  './js/ui/habits-edit.js',
  './js/ui/stats-view.js',
  './js/app.js',
  './js/core/bus.js', './js/core/dates.js', './js/core/db.js',
  './js/core/storage.js', './js/core/dom.js',
  './js/data/storage.js', './js/data/schedule.js', './js/data/habits.js',
  './js/data/migrations.js', './js/data/records.js', './js/data/qaza.js',
  './js/data/prayer.js', './js/data/fast.js', './js/data/sleep.js',
  './js/data/stats.js', './js/data/backup.js', './js/data/background.js',
  './js/data/ui.js',
  './js/data/sync.js',
  './js/sync/state.js', './js/sync/validators.js'];

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
  // Успешный ответ кладётся в кэш и работает офлайн; при офлайне или ошибке
  // 404/500 в кэш мусор не кладём — отдаётся прежняя рабочая версия.
  if (url.endsWith('.html') || url.endsWith('/') ||
      url.endsWith('.js') || url.endsWith('.css')) {
    e.respondWith(
      fetch(e.request).then(function (resp) {
        if (resp && resp.ok) {
          const copy = resp.clone();
          // Запись в кэш — побочный эффект мимо respondWith: без waitUntil
          // SW может уснуть до её завершения, и офлайн-копия не обновится
          e.waitUntil(caches.open(CACHE).then(function (c) { c.put(e.request, copy); }));
        }
        return resp;
      }).catch(function () { return caches.match(e.request); })
    );
  } else {
    e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
  }
});
