/* Generic app shell only. No account, checkout, signaling or ad responses. */
const CACHE = 'fil3shareica-shell-v4';
const ASSET = /\.(?:js|css|svg|png|webp|woff2?)$/i;
const SHELL = /^\/(?:[a-f0-9]{6}|s\/[^/]+)?$/;
const DEVELOPMENT_PATH = /^\/(?:@|app\/|components\/|hooks\/|lib\/|src\/|vendor\/|node_modules\/)/;
const PRODUCTION_CODE = /^\/(?:_next\/static|assets)\//;
const VERSIONED_ASSET = /[.-][a-zA-Z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2?)$/;

function assetType(path) {
  return path.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
}
function canCacheAsset(path) {
  if (!ASSET.test(path) || DEVELOPMENT_PATH.test(path)) return false;
  return !/\.(?:css|js)$/i.test(path) || PRODUCTION_CODE.test(path);
}
function validAsset(response, path) {
  if (!response?.ok || response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  switch (assetType(path)) {
    case 'css': return mime === 'text/css';
    case 'js': return /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$/.test(mime);
    case 'svg': return mime === 'image/svg+xml';
    case 'png': return mime === 'image/png';
    case 'webp': return mime === 'image/webp';
    case 'woff': return /^(?:font\/woff|application\/(?:font-woff|x-font-woff))$/.test(mime);
    case 'woff2': return mime === 'font/woff2';
    default: return false;
  }
}
function assetAccept(path) {
  return assetType(path) === 'css' ? 'text/css' : assetType(path) === 'js' ? 'text/javascript, application/javascript' : '*/*';
}
async function readAsset(cache, request, path) {
  const previous = await cache.match(request);
  if (previous && !validAsset(previous, path)) {
    await cache.delete(request);
    return undefined;
  }
  return previous;
}
function unavailableAsset() {
  return new Response('This asset is unavailable. Reconnect and reload the page.', {status: 503, headers: {'Content-Type': 'text/plain'}});
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/', {credentials: 'omit', cache: 'reload'});
    if (response.ok) {
      const html = await response.clone().text();
      await cache.put('/', response);
      const assets = new Set();
      for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const url = new URL(match[1], self.location.origin);
        if (url.origin === self.location.origin && !url.search && canCacheAsset(url.pathname)) assets.add(url.pathname);
      }
      await Promise.all([...assets].slice(0, 64).map(async path => {
        try {
          // Vite treats a CSS fetch with Accept: */* as a JavaScript module.
          // Only production code paths are eligible, and MIME checks prevent
          // an old worker or an HTML fallback from poisoning the shell cache.
          const asset = await fetch(path, {credentials: 'omit', cache: 'reload', headers: {Accept: assetAccept(path)}});
          if (validAsset(asset, path)) await cache.put(path, asset);
        } catch { /* Readiness is verified by an offline reload. */ }
      }));
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if ((key.startsWith('fileshare-shell-') || key.startsWith('fil3shareica-shell-')) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request; const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.search || /\/(?:account|login|plans|payment|ads)(?:\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate' && SHELL.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        // Refresh only the generic home shell, never account or room responses.
        if (url.pathname === '/' && response.ok) await cache.put('/', response.clone());
        return response;
      } catch {
        return (await cache.match('/')) || new Response('Open this app online once before using its offline shell.', {status: 503, headers: {'Content-Type': 'text/plain'}});
      }
    })());
  } else if (canCacheAsset(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const previous = await readAsset(cache, request, url.pathname);
      if (previous && VERSIONED_ASSET.test(url.pathname)) return previous;
      try {
        // Unversioned public assets are revalidated instead of staying stale.
        const response = await fetch(request, {cache: 'no-cache'});
        if (!validAsset(response, url.pathname)) return previous || unavailableAsset();
        await cache.put(request, response.clone());
        return response;
      } catch {return previous || unavailableAsset();}
    })());
  }
});
