// 웹 뷰어 앱 껍데기만 캐시한다(설치형·빠른 시작). 메모·드라이브 요청은
// 절대 캐시하지 않는다 — 메모가 브라우저에 남지 않게.
const CACHE = 'clipmemo-viewer-v1';
const SHELL = ['./', './index.html', './app.js', './config.js', './manifest.webmanifest', '../logo.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 네트워크 먼저(새 버전 바로 반영), 안 되면 캐시.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
