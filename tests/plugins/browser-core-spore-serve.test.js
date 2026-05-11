const test = require('node:test');
const assert = require('node:assert/strict');

const BrowserTool = require('../../plugins/browser-core/lib/tool');
const { getBlockedUrlError } = require('../../plugins/browser-core/lib/url-block');

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test('browser dispatcher rewrites Spore serve localhost URLs to an allowed authenticated local app request', async () => {
  const calls = [];
  const pluginManager = {
    getBrowserBackends() {
      return [
        {
          name: 'zendriver',
          available: true,
          factory() {
            return {
              isRunning() { return false; },
              async execute(input) {
                calls.push({ backend: 'zendriver', input });
                return { status: 'launched', url: input.url };
              },
            };
          },
        },
        {
          name: 'playwright',
          available: true,
          factory() {
            return {
              isRunning() { return false; },
              async execute(input) {
                calls.push({ backend: 'playwright', input });
                return { status: 'launched', url: input.url };
              },
            };
          },
        },
      ];
    },
  };
  const tool = new BrowserTool({
    log: logger(),
    broadcast() {},
    config: { webPort: 18803 },
    pluginManager,
  });

  const result = await tool.execute(
    { action: 'launch', url: 'http://localhost:18803/serve/hello-world/', width: 1280 },
    { sessionToken: 'sess-webapp', sessionCookieName: 'spore_webapp' },
  );

  assert.equal(result.backend, 'playwright');
  assert.equal(result.url, 'http://127.0.0.1:18803/serve/hello-world/');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].backend, 'playwright');
  assert.equal(calls[0].input.allowLocalSpore, true);
  assert.equal(calls[0].input.sporeServedApp, true);
  assert.deepEqual(calls[0].input.cookies, [{
    name: 'spore_webapp',
    value: 'sess-webapp',
    url: 'http://127.0.0.1:18803/',
    path: '/',
  }]);
});

test('browser dispatcher accepts relative Spore serve paths', async () => {
  const calls = [];
  let running = false;
  const pluginManager = {
    getBrowserBackends() {
      return [{
        name: 'playwright',
        available: true,
        factory() {
          return {
            isRunning() { return running; },
            async execute(input) {
              running = true;
              calls.push(input);
              return { status: 'navigated', url: input.url };
            },
          };
        },
      }];
    },
  };
  const tool = new BrowserTool({
    log: logger(),
    broadcast() {},
    config: { webPort: 18803 },
    pluginManager,
  });

  const result = await tool.execute(
    { action: 'navigate', url: '/serve/hello-world/' },
    { sessionToken: 'sess-webapp', sessionCookieName: 'spore_webapp' },
  );

  assert.equal(result.url, 'http://127.0.0.1:18803/serve/hello-world/');
  assert.equal(calls.at(-1).allowLocalSpore, true);
});

test('URL block still rejects localhost unless explicitly marked as a Spore serve URL', () => {
  assert.match(getBlockedUrlError('http://localhost:18803/serve/hello-world/'), /Blocked/);
  assert.equal(getBlockedUrlError('http://127.0.0.1:18803/serve/hello-world/', {
    allowLocalSpore: true,
    webPort: 18803,
  }), null);
  assert.match(getBlockedUrlError('http://127.0.0.1:18803/api/private', {
    allowLocalSpore: true,
    webPort: 18803,
  }), /Blocked/);
});
