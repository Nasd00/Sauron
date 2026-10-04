import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { build, createServer, preview } from 'vite';
import { localProviderPlugins } from '../../server/providers/local.js';
import { apiNotFoundPlugin } from '../../server/standalone/api-not-found.js';
import { makeFixtureRoot } from './fixtureRoot.mjs';

test('data providers have both hooks; credential editing stays development-only', () => {
  const plugins = localProviderPlugins();
  assert.ok(plugins.some(({ name }) => name === 'fire-perimeters'));
  for (const plugin of plugins) {
    if (plugin.name === 'iris-key-setup') {
      assert.equal(plugin.configurePreviewServer, undefined);
      assert.equal(
        plugin.apply({}, { command: 'serve', isPreview: true }),
        false,
      );
      assert.equal(
        plugin.apply({}, { command: 'serve', isPreview: false }),
        true,
      );
      continue;
    }
    assert.equal(typeof plugin.configureServer, 'function', plugin.name);
    assert.equal(typeof plugin.configurePreviewServer, 'function', plugin.name);
  }
});

test('real dev and built-preview servers serve provider JSON and terminate unknown APIs', async (t) => {
  // Physical path: Vite's root and the files written under it must agree on one
  // spelling, and macOS reaches the temp directory through a symlink.
  const root = await makeFixtureRoot('iris-preview-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><title>Preview fixture</title><p>Built application</p>',
  );
  for (const [name, value] of Object.entries({
    AISSTREAM_API_KEY: '',
    FIRMS_MAP_KEY: '',
    FIRMS_API_KEY: '',
    TOMTOM_API_KEY: '',
    GOOGLE_MAPS_API_KEY: '',
    GOOGLE_MAPS_SERVER_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: '',
    OPENSKY_CLIENT_SECRET: '',
    CCTV_FORCE_AUSTIN: '0',
    CCTV_SOURCES_FILE: path.join(root, 'absent.json'),
    CCTV_SOURCES_JSON: JSON.stringify([
      { id: 'fixture', lat: 30.27, lon: -97.74 },
    ]),
  })) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (raw, options) => {
    const url = new URL(raw);
    if (url.hostname === '127.0.0.1') return nativeFetch(raw, options);
    assert.ok(
      ['opensky-network.org', 'api.adsb.lol'].includes(url.hostname),
      url.origin,
    );
    return Response.json({
      time: Math.floor(Date.now() / 1000),
      states: [],
      ac: [],
    });
  });
  const base = {
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
  };
  const photon = createHttpServer(async (request, response) => {
    if (request.url === '/api/mobile/status') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'device_unauthorized' }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      route: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    }));
  });
  await new Promise(resolve => photon.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => photon.close(resolve)));
  const photonOrigin = `http://127.0.0.1:${photon.address().port}`;
  const proxy = { '/api/mobile/': { target: photonOrigin, changeOrigin: true } };
  await build(base);
  for (const isPreview of [false, true]) {
    const config = {
      ...base,
      plugins: [...localProviderPlugins(), apiNotFoundPlugin({ passthroughPaths: ['/mobile/'] })],
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy },
      preview: { host: '127.0.0.1', port: 0, proxy },
    };
    const server = isPreview
      ? await preview(config)
      : await createServer(config);
    if (!isPreview) await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    try {
      for (const [route, status] of [
        ['/api/opensky', 200],
        ['/api/adsblol/mil', 200],
        ['/api/adsbdb/type/invalid', 400],
        ['/api/firms/status', 200],
        ['/api/fire-perimeters/inciweb/publication/invalid', 400],
        ['/api/terrain/heights?points=invalid', 400],
        ['/api/overpass', 405],
        ['/api/overpass/status', 200],
        ['/api/cctv/sources', 200],
        ['/api/gbfs/', 400],
        ['/api/tomtom/status', 200],
        ['/api/radio/unknown', 404],
        ['/api/setup/status', isPreview ? 404 : 200],
        ['/api/setup/update', 404],
        ['/api/does-not-exist', 404],
        ['/api', 404],
      ]) {
        const response = await fetch(origin + route);
        assert.equal(
          response.status,
          status,
          `${isPreview ? 'preview' : 'dev'} ${route}`,
        );
        assert.match(
          response.headers.get('content-type'),
          /application\/json/,
          route,
        );
        const body = await response.json();
        if (route === '/api/cctv/sources')
          assert.equal(body.sources[0].id, 'fixture');
        if (
          route === '/api/does-not-exist' ||
          (isPreview && route.startsWith('/api/setup'))
        ) {
          assert.deepEqual(body, { error: 'Unknown API route' });
          assert.equal(response.headers.get('cache-control'), 'no-store');
        }
      }
      const tle = await fetch(origin + '/api/celestrak/invalid!');
      assert.equal(tle.status, 400);
      assert.equal(await tle.text(), 'invalid group');
      const status = await fetch(origin + '/api/mobile/status');
      assert.equal(status.status, 401);
      assert.deepEqual(await status.json(), { error: 'device_unauthorized' });
      const upload = await fetch(origin + '/api/mobile/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-device' },
        body: JSON.stringify({ latitude: 42.28, longitude: -83.74 }),
      });
      assert.equal(upload.status, 200);
      assert.deepEqual(await upload.json(), {
        route: '/api/mobile/location',
        authorization: 'Bearer fixture-device',
        body: JSON.stringify({ latitude: 42.28, longitude: -83.74 }),
      });
      if (isPreview) {
        const write = await fetch(origin + '/api/setup/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ GOOGLE_MAPS_API_KEY: 'must-not-save' }),
        });
        assert.equal(write.status, 404);
        assert.deepEqual(await write.json(), { error: 'Unknown API route' });
      }
      for (const route of ['/', '/application-route', '/apiary']) {
        const response = await fetch(origin + route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(await response.text(), /Built application/);
      }
    } finally {
      await server.close();
    }
  }
});
