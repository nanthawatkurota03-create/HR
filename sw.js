const CACHE = 'leave-app-v4';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

// ===== แจ้งเตือนบนมือถือ (Firebase Cloud Messaging) =====
// ใส่ค่าชุดเดียวกับ FIREBASE_CFG ใน index.html
const FIREBASE_CFG = { apiKey: '', authDomain: '', projectId: '', messagingSenderId: '', appId: '' };
const FB_VER = '10.12.2';

try {
  if (FIREBASE_CFG.apiKey) {
    importScripts(
      'https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-messaging-compat.js'
    );
    firebase.initializeApp(FIREBASE_CFG);
    const messaging = firebase.messaging();
    // ข้อความจากเซิร์ฟเวอร์เป็นแบบ data-only: แสดงแจ้งเตือนเองตรงนี้
    messaging.onBackgroundMessage(p => {
      const d = p.data || {};
      return self.registration.showNotification(d.title || 'ขอใบลา', {
        body: d.body || '',
        data: { view: d.view || '' }
      });
    });
  }
} catch (e) { /* โหลด Firebase ไม่ได้ (เช่นออฟไลน์ตอนติดตั้ง) แอปยังใช้งานได้ตามปกติ */ }

// กดแจ้งเตือน: ถ้าแอปเปิดอยู่ให้โฟกัสแล้วสลับหน้า ถ้าไม่เปิดให้เปิดแอปที่หน้านั้น
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const view = (e.notification.data && e.notification.data.view) || '';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.postMessage({ view: view }); return c.focus(); }
      }
      return self.clients.openWindow(self.registration.scope + (view ? '#' + view : ''));
    })
  );
});

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // เรียก API (Apps Script / Firebase) ไม่ต้อง cache
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (url.hostname.endsWith('googleapis.com') && url.hostname !== 'fonts.googleapis.com') return;

  // ไฟล์ของแอป: network first, ถ้าออฟไลน์ใช้ cache
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // ฟอนต์/สคริปต์ภายนอก: cache first
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => r))
  );
});
