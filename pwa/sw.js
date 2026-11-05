/* Service worker KOMA (1.0.27).
   Задача одна: после первого открытия приложение и модели работают без сети.
   Стратегия простая и предсказуемая:
     · index.html — сначала сеть, при её отсутствии кеш (чтобы обновления доезжали);
     · models/   — сначала кеш (модели по 4–8 МБ, качать их каждый раз незачем);
     · остальное — кеш, если есть, иначе сеть. */
const CACHE = 'koma-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isModels = url.pathname.includes('/models/');
  const isShell = url.pathname.endsWith('/') || url.pathname.endsWith('index.html');

  if (isModels) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }
  if (isShell) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
