const CACHE='zaabos-shell-r19-v1';
const SHELL=['/offline','/static/style.css','/static/i18n.js','/static/favicon-64.png','/static/zaabos-icon-192.png','/static/zaabos-icon-512.png','/static/manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('zaabos-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);if(r.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;if(r.mode==='navigate'){e.respondWith(fetch(r).catch(()=>caches.match('/offline')));return;}if(u.pathname.startsWith('/static/'))e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(resp=>{if(resp.ok){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(r,copy));}return resp;})));});
