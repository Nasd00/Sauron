/**
 * Precompute every route the Ann Arbor demo can request (with and without each library closure)
 * from the live Valhalla router, and write them to the committed seed cache. Re-run after changing
 * scenario coordinates or closures.
 */
import { fileURLToPath } from "node:url";
import { RouteCache, ValhallaRouter, routeCacheKey, type RouteRequest } from "../src/sources/routing.js";
import { annArborScenario } from "../src/scenario/ann-arbor.js";

const seedPath = fileURLToPath(new URL("../fixtures/route-cache.json", import.meta.url));
const cache = new RouteCache({ writePath: seedPath });
const router = new ValhallaRouter({ cache });
const scenario = annArborScenario();
const closureSets = [[], ...scenario.closureLibrary.map(closure => [closure])];

const requests: RouteRequest[] = [];
for (const household of scenario.households) {
  for (const avoid of closureSets) {
    for (const shelter of scenario.shelters) requests.push({ from: household.location, to: shelter.location, avoid });
    for (const helper of scenario.helpers) requests.push({ from: helper.home, to: household.location, avoid });
  }
}

let fetched = 0;
for (const request of requests) {
  const key = routeCacheKey(request);
  if (cache.get(key)) continue;
  const route = await router.route(request);
  if (route.provider === "estimate") throw new Error(`Routing failed for ${key}; not caching an estimate`);
  fetched += 1;
  console.log(`${route.provider.padEnd(8)} ${route.distanceKm.toFixed(2)} km ${route.durationMin.toFixed(1)} min  ${key}`);
  await new Promise(resolve => setTimeout(resolve, 400)); // be polite to the public router
}
console.log(`${requests.length} routes in cache (${fetched} fetched) -> ${seedPath}`);
