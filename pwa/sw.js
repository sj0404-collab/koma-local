/* Service worker KOMA (1.0.28).
   Задача одна: после первого открытия приложение и модели работают без сети.
   Стратегия простая и предсказуемая:
     · index.html — ВСЕГДА из сети мимо кеша, при её отсутствии кеш;
     · version.json — всегда из сети мимо кеша (это проверка обновлений);
     · models/   — сначала кеш (модели по 4–8 МБ, качать их каждый раз незачем);
     · остальное — кеш, если есть, иначе сеть.

   1.0.28 (06.11): на телефоне «обнови страницу» не приносило новую сборку —
   человек видел тот же старый баг и не мог понять, обновился он или нет.
   Причина: кеш назывался koma-v1 и жил вечно, а оболочка бралась из кеша.
   Теперь имя кеша содержит версию, оболочка берётся из сети с no-store, а
   старые кеши удаляются при активации новой версии. */
const CACHE = 'koma-v1.0.39';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e && e.data === 'koma:drop') {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isModels = url.pathname.includes('/models/');
  const isShell = url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  const isVersion = url.pathname.endsWith('version.json');

  // Проверка обновлений не имеет права попасть в кеш: иначе приложение будет
  // вечно считать, что версия та же.
  if (isVersion) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }
  if (isModels) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }
  if (isShell) {
    // no-store: мимо HTTP-кеша браузера. Раньше обновление «не доезжало»,
    // потому что страница отдавалась из кеша, хотя сеть была.
    e.respondWith(fetch(req, { cache: 'no-store' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
