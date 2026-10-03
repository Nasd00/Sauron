import assert from "node:assert/strict";
import { test } from "node:test";
import { NominatimGeocoder } from "../src/geocoder.js";

test("geocoder uses the top result, identifies the app, and caches normalized queries", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const geocoder = new NominatimGeocoder({
    userAgent: "Downwind/0.1 contact@example.test",
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify([
        { display_name: "Ann Arbor, Michigan", lat: "42.2808", lon: "-83.743" },
        { display_name: "Not selected", lat: "0", lon: "0" },
      ]));
    },
    now: () => 2000,
  });
  assert.deepEqual(await geocoder.geocode("Ann Arbor"), {
    label: "Ann Arbor, Michigan", latitude: 42.2808, longitude: -83.743,
  });
  assert.deepEqual(await geocoder.geocode("  ann arbor  "), {
    label: "Ann Arbor, Michigan", latitude: 42.2808, longitude: -83.743,
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /limit=1/);
  assert.equal((requests[0]!.init?.headers as Record<string, string>)["user-agent"], "Downwind/0.1 contact@example.test");
});
