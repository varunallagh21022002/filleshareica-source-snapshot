import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createContext, runInContext} from 'node:vm';

const origin = 'http://127.0.0.1:5180';
const cacheName = 'fil3shareica-shell-v4';
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const stylesheet = '/_next/static/css/index.12345678.css';
const javascript = '/_next/static/chunks/page-AbC12345.js';
function key(input: unknown) {
  return new URL(typeof input === 'string' ? input : (input as {url: string}).url, origin).href;
}
function response(body: string, type: string) {
  return new Response(body, {headers: {'Content-Type': type}});
}
class MemoryCache {
  entries = new Map<string, Response>();
  async match(input: unknown) {return this.entries.get(key(input))?.clone();}
  async put(input: unknown, value: Response) {this.entries.set(key(input), value.clone());}
  async delete(input: unknown) {return this.entries.delete(key(input));}
}
type Network = (input: unknown, init?: RequestInit) => Promise<Response>;
function worker(network: Network) {
  const handlers = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, MemoryCache>();
  let claimed = false;
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new MemoryCache());
      return stores.get(name)!;
    },
    async keys() {return [...stores.keys()];},
    async delete(name: string) {return stores.delete(name);},
  };
  const context = createContext({URL, Response, caches, fetch: network, self: {
    location: {origin},
    clients: {async claim() {claimed = true;}},
    addEventListener(name: string, callback: (event: unknown) => void) {handlers.set(name, callback);},
  }});
  runInContext(source, context, {filename: 'public/sw.js'});
  return {
    caches, stores, get claimed() {return claimed;},
    async dispatch(name: string) {
      let completion: Promise<unknown> | undefined;
      handlers.get(name)!({waitUntil(promise: Promise<unknown>) {completion = promise;}});
      await completion;
    },
    async fetch(path: string, mode = 'cors', method = 'GET') {
      let result: Promise<Response> | undefined;
      const request = {url: new URL(path, origin).href, method, mode};
      handlers.get('fetch')!({request, respondWith(promise: Promise<Response>) {result = promise;}});
      return result;
    },
  };
}

test('precache requests CSS as CSS and skips development modules and wrong MIME assets', async () => {
  const requests: {path: string; init?: RequestInit}[] = [];
  const sw = worker(async (input, init) => {
    const path = new URL(key(input)).pathname;
    requests.push({path, init});
    if (path === '/') return response(`<link href="${stylesheet}" rel="stylesheet"><script src="${javascript}"></script><link href="/app/globals.css" rel="stylesheet"><script src="/@vite/client"></script><script src="/node_modules/dev.js"></script><link href="/assets/bad.12345678.css" rel="stylesheet">`, 'text/html');
    if (path === stylesheet) return response('body{font-family:Arial}', 'text/css; charset=utf-8');
    return response('export default {}', 'text/javascript');
  });
  await sw.dispatch('install');
  const cssRequest = requests.find(request => request.path === stylesheet)!;
  assert.equal(new Headers(cssRequest.init?.headers).get('Accept'), 'text/css');
  assert.equal(cssRequest.init?.cache, 'reload');
  assert.equal(requests.some(request => request.path.startsWith('/app/') || request.path.startsWith('/@') || request.path.startsWith('/node_modules/')), false);
  const cache = await sw.caches.open(cacheName);
  assert.match(await (await cache.match(stylesheet))!.text(), /font-family:Arial/);
  assert.equal(await cache.match('/assets/bad.12345678.css'), undefined);
});

test('a previously poisoned stylesheet entry is deleted and replaced with actual CSS', async () => {
  let fetched = 0;
  const sw = worker(async () => {fetched++; return response('body{color:green}', 'text/css');});
  const cache = await sw.caches.open(cacheName);
  await cache.put(stylesheet, response('import "/@vite/client";', 'text/javascript'));
  const result = await sw.fetch(stylesheet);
  assert.equal(fetched, 1);
  assert.equal(result!.headers.get('Content-Type'), 'text/css');
  assert.equal(await result!.text(), 'body{color:green}');
  assert.equal((await cache.match(stylesheet))!.headers.get('Content-Type'), 'text/css');
});

test('wrong network MIME never enters or escapes the stylesheet cache, including offline poison', async () => {
  let offline = false;
  const sw = worker(async () => {
    if (offline) throw new TypeError('offline');
    return response('export default "not CSS"', 'text/javascript');
  });
  const cache = await sw.caches.open(cacheName);
  assert.equal((await sw.fetch(stylesheet))!.status, 503);
  assert.equal(await cache.match(stylesheet), undefined);
  await cache.put(stylesheet, response('export default "old poison"', 'text/javascript'));
  offline = true;
  const result = await sw.fetch(stylesheet);
  assert.equal(result!.status, 503);
  assert.doesNotMatch(await result!.text(), /export default/);
  assert.equal(await cache.match(stylesheet), undefined);
});

test('the production shell and verified assets remain available offline', async () => {
  let offline = false;
  const sw = worker(async input => {
    if (offline) throw new TypeError('offline');
    const path = new URL(key(input)).pathname;
    if (path === '/') return response(`<h1>fil3shareica</h1><link href="${stylesheet}" rel="stylesheet"><script src="${javascript}"></script><link href="/favicon.svg" rel="icon">`, 'text/html');
    if (path === stylesheet) return response('body{color:green}', 'text/css');
    if (path === javascript) return response('console.log("app")', 'text/javascript');
    return response('<svg/>', 'image/svg+xml');
  });
  await sw.dispatch('install');
  offline = true;
  assert.match(await (await sw.fetch('/', 'navigate'))!.text(), /fil3shareica/);
  assert.match(await (await sw.fetch('/abc123', 'navigate'))!.text(), /fil3shareica/);
  assert.equal((await sw.fetch(stylesheet))!.headers.get('Content-Type'), 'text/css');
  assert.equal((await sw.fetch(javascript))!.headers.get('Content-Type'), 'text/javascript');
  assert.equal(await (await sw.fetch('/favicon.svg'))!.text(), '<svg/>');
});

test('only versioned production assets use cache first; unversioned assets revalidate', async () => {
  const requested: {path: string; cache?: RequestCache}[] = [];
  const sw = worker(async (input, init) => {
    const path = new URL(key(input)).pathname;
    requested.push({path, cache: init?.cache});
    return response('body{color:blue}', 'text/css');
  });
  const cache = await sw.caches.open(cacheName);
  await cache.put(stylesheet, response('body{color:green}', 'text/css'));
  await cache.put('/assets/site.css', response('body{color:old}', 'text/css'));
  assert.equal(await (await sw.fetch(stylesheet))!.text(), 'body{color:green}');
  assert.deepEqual(requested, []);
  assert.equal(await (await sw.fetch('/assets/site.css'))!.text(), 'body{color:blue}');
  assert.deepEqual(requested, [{path: '/assets/site.css', cache: 'no-cache'}]);
  assert.equal(await (await cache.match('/assets/site.css'))!.text(), 'body{color:blue}');
});

test('development code, private routes, API requests and cross-origin traffic bypass the worker cache', async () => {
  const sw = worker(async () => {throw new Error('No network request expected');});
  for (const path of ['/app/globals.css', '/@vite/client', '/lib/hash.worker.js', '/node_modules/dependency.js', '/api/market/profile.css', '/account/profile.css', '/plans', '/login', '/payment/return', '/ads/prompt.js', '/assets/site.css?direct', 'https://other.example/assets/site.css']) {
    assert.equal(await sw.fetch(path), undefined, path);
  }
  assert.equal(await sw.fetch(stylesheet, 'cors', 'POST'), undefined);
  assert.deepEqual(await sw.caches.keys(), []);
});

test('activation replaces old shell caches while preserving unrelated storage', async () => {
  const sw = worker(async () => response('', 'text/html'));
  for (const name of ['fil3shareica-shell-v3', 'fileshare-shell-v1', cacheName, 'another-app-cache']) await sw.caches.open(name);
  await sw.dispatch('activate');
  assert.deepEqual(await sw.caches.keys(), [cacheName, 'another-app-cache']);
  assert.equal(sw.claimed, true);
});
