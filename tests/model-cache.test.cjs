const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const workerSource = fs.readFileSync(path.join(__dirname, '../dist/imgly-model-worker.js'), 'utf8')
  .replace("await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm')",
           "await __import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm')");
const base = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';
const files = [base + 'resources.json', base + 'abc1', base + 'abc2'];

function makeCacheStore() {
  const stored = new Map();
  return {
    stored,
    open: async () => ({
      match: async request => stored.get(request.url)?.clone(),
      put: async (request, response) => {
        // Delayed disk writes: the worker must not report "result" too early.
        await new Promise(resolve => setTimeout(resolve, 8));
        stored.set(request.url, response.clone());
      }
    })
  };
}

function makeWorker(cacheStore, net) {
  const messages = [];
  const self = {
    caches: cacheStore,
    postMessage: message => messages.push(message),
    fetch: async request => {
      net.requests++;
      return new Response('payload-for-' + (typeof request === 'string' ? request : request.url), {status: 200});
    }
  };
  const load = async () => ({
    removeBackground: async blob => {
      for (const url of files) {
        const response = await self.fetch(url);
        assert.equal(response.ok, true);
        await response.text();
      }
      self.postMessage({type: 'progress', key: 'fetch:model', current: 100, total: 100});
      return blob;
    }
  });
  vm.runInNewContext(workerSource, {self, Request, Response, Blob, URL, __import:load, console});
  return {
    self, messages,
    async run() {
      await self.onmessage({data:{blob: new Blob(['image']), model:'isnet_fp16', device:'cpu'}});
      return messages.at(-1);
    }
  };
}

test('download once and reuse model chunks after the worker is recreated', async () => {
  const cache = makeCacheStore();
  const network = {requests:0};
  const first = await makeWorker(cache, network).run();
  assert.equal(first.type, 'result');
  assert.equal(first.cacheStats.networkFetches, 2);
  assert.equal(first.cacheStats.cacheHits, 0);
  assert.equal(network.requests, 3);
  assert.equal(cache.stored.size, 3, 'all writes must finish before result');

  const second = await makeWorker(cache, network).run();
  assert.equal(second.type, 'result');
  assert.equal(second.cacheStats.networkFetches, 0);
  assert.equal(second.cacheStats.cacheHits, 2);
  assert.equal(network.requests, 3, 'no network requests on repeat visit');
});

test('failed storage gracefully falls back to network', async () => {
  const failingCache = {open: async () => {throw new Error('storage disabled')}};
  const network = {requests:0};
  const result = await makeWorker(failingCache, network).run();
  assert.equal(result.type, 'result');
  assert.equal(network.requests, 3);
});

test('HTML inline script and worker are syntactically valid', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(script, 'inline module found');
  assert.doesNotThrow(() => new vm.Script(script[1], {filename:'index-module.js'}));
  assert.ok(html.includes("new URL('./imgly-model-worker.js',location.href)"));
});

