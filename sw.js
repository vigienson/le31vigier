// LE 31 — service worker (fonctionnement hors ligne + mises à jour automatiques)
// À CHAQUE LIVRAISON : changer VERSION pour que les téléphones prennent la nouvelle version.
const VERSION = 'le31-v1.3';
const FICHIERS = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Fichiers de l'appli : réseau d'abord (toujours la dernière version), sinon copie locale (hors ligne)
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then(r => {
        if (r.ok) { const copie = r.clone(); caches.open(VERSION).then(c => c.put(req, copie)); }
        return r;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
    );
    return;
  }
  // Polices Google : copie locale d'abord
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(rr => {
      const copie = rr.clone(); caches.open(VERSION).then(c => c.put(req, copie)); return rr;
    })));
  }
  // Le reste (serveur Google Apps Script) passe directement
});
