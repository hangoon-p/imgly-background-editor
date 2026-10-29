// Separate worker keeps IMG.LY inference isolated while persisting model assets across visits.
const CACHE_NAME = 'imgly-editor-imgly-model-assets-1.7.0-v1';
const rawFetch = self.fetch.bind(self);
const pendingWrites = [];
let cachePromise;
let cacheHits = 0;
let networkFetches = 0;
let cacheWriteErrors = 0;

function modelAssetRequest(input, init) {
  try {
    const request = new Request(input, init);
    if (request.method !== 'GET') return null;
    const url = new URL(request.url);
    if (url.hostname !== 'staticimgly.com' ||
        !url.pathname.includes('/@imgly/background-removal-data/1.7.0/dist/')) return null;
    return request;
  } catch {
    return null;
  }
}

function getCache() {
  if (cachePromise === undefined) {
    cachePromise = ('caches' in self)
      ? self.caches.open(CACHE_NAME).catch(() => null)
      : Promise.resolve(null);
  }
  return cachePromise;
}

// CacheStorage belongs to the site's origin and survives closing this worker or tab.
// Only IMG.LY's version-pinned model/wasm assets are intercepted; no arbitrary fetches.
self.fetch = async (input, init) => {
  const request = modelAssetRequest(input, init);
  if (!request) return rawFetch(input, init);

  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        if (!request.url.endsWith('/resources.json')) {
          cacheHits++;
          self.postMessage({ type: 'asset', source: 'cache' });
        }
        return hit;
      }
    } catch { /* If the cache cannot be read, use the network. */ }
  }

  const response = await rawFetch(input, init);
  if (response.ok) {
    if (!request.url.endsWith('/resources.json')) {
      networkFetches++;
      self.postMessage({ type: 'asset', source: 'network' });
    }
    if (cache) {
      // Await all cache writes before terminating the worker: large models can take
      // noticeably longer to save than the network fetch itself.
      pendingWrites.push(
        cache.put(request, response.clone()).catch(() => { cacheWriteErrors++; })
      );
    }
  }
  return response;
};

self.onmessage = async (event) => {
  try {
    const { blob, model, device } = event.data;
    const mod = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
    const removeBackground = mod.removeBackground || mod.default;
    if (typeof removeBackground !== 'function') throw new Error('IMG.LY 모듈을 불러오지 못했습니다.');
    const result = await removeBackground(blob, {
      device, model, proxyToWorker: false,
      output: { format: 'image/png', quality: 1, type: 'foreground' },
      progress: (key, current, total) => self.postMessage({ type: 'progress', key, current, total })
    });
    await Promise.allSettled(pendingWrites);
    self.postMessage({
      type: 'result', blob: result,
      cacheStats: { cacheHits, networkFetches, cacheWriteErrors }
    });
  } catch (error) {
    await Promise.allSettled(pendingWrites);
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
