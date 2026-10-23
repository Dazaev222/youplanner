const CACHE = 'youplanner-v3';
const ASSETS = ['./', './index.html', './manifest.json', './icon-180.png', './icon.svg',
  './styles/tokens.css', './styles/layout.css', './styles/buttons.css',
  './styles/table.css', './styles/cells.css', './styles/progress-circle.css',
  './styles/modal.css', './styles/qaza.css', './styles/day-view.css',
  './styles/schedule.css', './styles/sheets.css', './styles/prayer.css',
  './styles/toast.css', './styles/settings.css', './styles/stats.css',
  './styles/habits-edit.css', './styles/mobile.css', './styles/effects.css'];

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
  const url = e.request.url;
  // Синхронизация с Firebase не кэшируется и не задерживается на caches.match
  if (url.indexOf('firebaseio.com') !== -1 || url.indexOf('firebase.google.com') !== -1) return;
  // HTML — network-first: свежая версия с GitHub важнее кэша
  if (url.endsWith('.html') || url.endsWith('/')) {
    e.respondWith(
      fetch(e.request).then(function (resp) {
        // При 404/500 в кэш мусор не кладём: офлайн покажется прежняя рабочая версия
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return resp;
      }).catch(function () { return caches.match(e.request); })
    );
  } else {
    e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
  }
});
