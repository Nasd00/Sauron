import assert from "node:assert/strict";
import { test } from "node:test";
import { enrollPhone } from "../src/photon-client.js";

const request = { phone: "+15551234567", latitude: 42.28, longitude: -83.74, label: "Home", radiusKm: 5 };
const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("enrollPhone posts the picked point with the operator key", async () => {
  let sent: { url: string; auth: string | null; body: unknown } | undefined;
  const result = await enrollPhone("https://photon.example", "s3cret", request, async (url, init) => {
    sent = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ phone: "+15551234567" }), { status: 201 });
  });
  assert.deepEqual(result, { ok: true, phone: "+15551234567" });
  assert.deepEqual(sent, { url: "https://photon.example/admin/users", auth: "Bearer s3cret", body: request });
});

test("enrollPhone explains failures", async () => {
  assert.equal((await enrollPhone("https://p.example", "bad", request, respond(401, { error: "Unauthorized" }))).ok, false);
  assert.deepEqual(await enrollPhone("https://p.example", "k", request, respond(400, { error: "phone must be an E.164 number" })),
    { ok: false, reason: "rejected", message: "phone must be an E.164 number" });
  const down = await enrollPhone("https://p.example", "k", request, async () => { throw new TypeError("fetch failed"); });
  assert.equal(down.ok === false && down.reason, "unreachable");
});
