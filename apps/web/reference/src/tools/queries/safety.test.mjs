import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeCatalog, coreTools, toolsForSurface } from '../index.js';

const danger = { id: 'manual-1', what: 'Gas leak (gas leak)', insideDangerZone: true, dangerRadiusKm: 2, latitude: 1, longitude: 2 };

function catalog() {
  return composeCatalog({ tools: coreTools, services: {} });
}

test('safety tools are voice-only', () => {
  const voice = toolsForSurface(coreTools, 'voice').map((tool) => tool.name);
  const mcp = toolsForSurface(coreTools, 'mcp').map((tool) => tool.name);
  for (const name of ['get_active_dangers', 'get_escape_route']) {
    assert.ok(voice.includes(name));
    assert.ok(!mcp.includes(name));
  }
});

test('safety tools report unavailable without the host bridge', async () => {
  delete globalThis.__sauronSafety;
  await assert.rejects(catalog().call('get_active_dangers', {}), (error) => error.code === 'unavailable');
});

test('get_active_dangers and get_escape_route read the host bridge', async () => {
  const asked = [];
  globalThis.__sauronSafety = {
    position: async (spoken) => { asked.push(spoken); return { position: spoken ?? { latitude: 0, longitude: 0 }, source: spoken ? 'spoken' : 'device' }; },
    dangers: () => [danger],
    escape: () => ({ danger, head: 'south', safePoint: { latitude: 0.9, longitude: 2 }, kmToSafety: 3, drawn: true }),
  };
  try {
    const dangers = await catalog().call('get_active_dangers', {});
    assert.match(dangers.summary, /1 active danger; the person is INSIDE the zone of Gas leak/);
    assert.equal(dangers.data.position_source, 'device');
    const escape = await catalog().call('get_escape_route', { latitude: 1, longitude: 2 });
    assert.match(escape.summary, /^Inside Gas leak \(gas leak\): head south, 3 km/);
    assert.equal(escape.data.drawn_on_map, true);
    assert.deepEqual(asked, [undefined, { latitude: 1, longitude: 2 }]);
  } finally {
    delete globalThis.__sauronSafety;
  }
});
