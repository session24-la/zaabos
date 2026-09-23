const CACHE='zaabos-shell-r42-roundB2';
const SHELL=['/offline','/static/style.css','/static/icons.css','/static/theme.css','/static/app.js','/static/i18n.js','/static/favicon-64.png','/static/zaabos-icon-192.png','/static/zaabos-icon-512.png','/static/manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('zaabos-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 const r=e.request,u=new URL(r.url); if(r.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
 if(r.mode==='navigate'){
   e.respondWith(fetch(r).then(resp=>{if(resp.ok&&u.pathname==='/'){const cp=resp.clone();caches.open(CACHE).then(c=>c.put('/',cp));}return resp;}).catch(async()=>await caches.match('/')||await caches.match('/offline'))); return;
 }
 if(u.pathname.startsWith('/static/')){
   e.respondWith(fetch(r).then(resp=>{if(resp.ok){const cp=resp.clone();caches.open(CACHE).then(c=>c.put(r,cp));}return resp;}).catch(()=>caches.match(r))); }
});
