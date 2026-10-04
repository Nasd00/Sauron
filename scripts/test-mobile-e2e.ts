import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connectDb } from "@tempmhacks/shared/db";
import { matchConfirmedIncidentToProfiles } from "../services/alerts/src/matcher.js";
import { createAlertServiceStore } from "../services/alerts/src/store.js";
import { createMobileApi, createMobileHttpHandler, createMobileStore } from "../services/photon/src/mobile.js";
import { createCommandRouter, STOP_REPLY, TRACKING_RESUMED_REPLY } from "../services/photon/src/router.js";
import { createMessagingStore } from "../services/photon/src/store.js";

// End-to-end check of the iPhone companion backend against a published local module:
// WATCH ME → pair → movement uploads → alert match → STOP → WATCH ME → revoke.
// It sends the same HTTP requests as the iOS app. No Spectrum credentials are used.
const uri = process.env.SPACETIMEDB_URI || "http://127.0.0.1:3000";
const database = process.env.SPACETIMEDB_DATABASE || "tempmhacks-local";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname), "Mobile e2e requires a local server");

const { db, disconnect } = await connectDb({ uri, database, token: process.env.SPACETIMEDB_TOKEN });
const suffix = randomUUID().slice(0, 8);
const senderId = `e2e-sender-${suffix}`;
const spaceId = `e2e-space-${suffix}`;
const adminSecret = "e2e-admin";
const noopLogger = { info: () => {}, error: () => {} };

async function eventually<T>(read: () => T | undefined, check: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value !== undefined && check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const server = createServer();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const store = createMessagingStore(db);
const route = createCommandRouter({
  store, geocoder: { geocode: async () => null }, radiusKm: 10, publicAppUrl: "https://downwind.example",
  mobilePairingBaseUrl: base,
});
const handler = createMobileHttpHandler({
  api: createMobileApi({ store: createMobileStore(db), radiusKm: 10 }),
  publicBaseUrl: base, adminSecret, bundleId: "com.tempmhacks.sauron", logger: noopLogger,
});
server.on("request", (request, response) => {
  void handler(request, response).then(handled => { if (!handled) response.writeHead(404).end(); });
});

const text = (value: string) => route({
  messageId: randomUUID(), spaceId, senderId, receivedAt: new Date().toISOString(), content: { type: "text", text: value },
});
async function call(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) as Record<string, unknown> };
}
const upload = (token: string, latitude: number, longitude = -83.743) =>
  call("POST", "/api/mobile/location", { latitude, longitude, accuracyMeters: 37, capturedAt: Date.now() }, token);

try {
  // 1. WATCH ME over iMessage issues a pairing link; the page deep-links into the app.
  const link = /(http:\/\/\S+\/pair\/(\S+))/.exec((await text("WATCH ME"))?.text ?? "");
  assert.ok(link, "WATCH ME reply contains a pairing link");
  const page = await fetch(link[1]!).then(response => response.text());
  assert.match(page, new RegExp(`sauron://pair\\?token=${link[2]}&amp;api=`));

  // 2. The app redeems the token once.
  const paired = await call("POST", "/api/mobile/pair", { pairingToken: link[2] });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  const deviceToken = paired.body.deviceToken as string;
  assert.equal((await call("POST", "/api/mobile/pair", { pairingToken: link[2] })).body.error, "pairing_used");
  const device = await eventually(() => db.mobile.getActiveDeviceForSender(senderId), d => d.trackingActive, "device row");
  assert.equal(device.spaceId, spaceId, "pairing resolved to the right Spectrum conversation");

  // 3. Uploads move one location-backed profile; no watches are created.
  assert.equal((await upload(deviceToken, 42.2808)).status, 200);
  await eventually(() => db.profiles.getForSender(senderId), p => p.latitude === 42.2808, "first location");
  assert.equal((await upload(deviceToken, 42.2808 + 0.0095)).status, 200); // ~1.05 km north
  const moved = await eventually(() => db.profiles.getForSender(senderId), p => p.latitude === 42.2808 + 0.0095, "moved location");
  assert.equal(moved.alertsEnabled, true);
  assert.equal(db.profiles.list().filter(p => p.senderId === senderId).length, 1);
  assert.equal(db.watches.listActive().filter(w => w.senderId === senderId).length, 0);
  assert.equal((await upload(deviceToken, 42.29, -83.743)).status, 200);
  const coarse = await call("POST", "/api/mobile/location", { latitude: 42.3, longitude: -83.7, accuracyMeters: 900, capturedAt: Date.now() }, deviceToken);
  assert.equal(coarse.status, 422);

  // 4. A confirmed incident near the updated location creates exactly one profile alert.
  // Scope matching to this run: earlier runs leave fresh profiles at the same coordinates.
  const serviceStore = createAlertServiceStore(db);
  const alerts = {
    ...serviceStore,
    listProfiles: async () => (await serviceStore.listProfiles()).filter(p => p.senderId === senderId),
  };
  const cameraId = `e2e-camera-${suffix}`;
  await db.cameras.register({ id: cameraId, name: "E2E camera", latitude: 42.291, longitude: -83.743, sourceType: "replay", status: "online" });
  const incident = async (id: string) => {
    const now = Date.now();
    await db.incidents.create({
      id, cameraId, type: "smoke_fire", status: "candidate", confidence: 0.9,
      latitude: 42.291, longitude: -83.743, firstSeenAt: now, lastSeenAt: now,
    });
    await db.incidents.confirm(id);
    return eventually(() => db.incidents.get(id), i => i.status === "confirmed", "confirmed incident");
  };
  const first = await incident(`e2e-incident-${suffix}`);
  assert.equal(await matchConfirmedIncidentToProfiles(first, alerts, { now: Date.now() }), 1);
  assert.equal(await matchConfirmedIncidentToProfiles(first, alerts, { now: Date.now() }), 0, "no duplicate alert");
  await eventually(() => db.alerts.listPending().find(a => a.incidentId === first.id), a => a.watchId === `profile:${moved.userId}`, "pending alert");

  // 5. STOP rejects further uploads and removes the user from matching.
  assert.equal((await text("STOP"))?.text, STOP_REPLY);
  await eventually(() => db.mobile.getActiveDeviceForSender(senderId), d => !d.trackingActive, "tracking stopped");
  const stopped = await upload(deviceToken, 42.4);
  assert.equal(stopped.status, 403);
  assert.equal(stopped.body.error, "tracking_stopped");
  assert.equal(db.profiles.getForSender(senderId)?.latitude, 42.29);
  const second = await incident(`e2e-incident-2-${suffix}`);
  assert.equal(await matchConfirmedIncidentToProfiles(second, alerts, { now: Date.now() }), 0);
  const statusAfterStop = await call("GET", "/api/mobile/status", undefined, deviceToken);
  assert.equal(statusAfterStop.body?.trackingActive, false, JSON.stringify(statusAfterStop));

  // 6. WATCH ME reuses the pairing; uploads are accepted again.
  assert.equal((await text("WATCH ME"))?.text, TRACKING_RESUMED_REPLY);
  await eventually(() => db.mobile.getActiveDeviceForSender(senderId), d => d.trackingActive, "tracking resumed");
  assert.equal((await upload(deviceToken, 42.291)).status, 200);
  await eventually(() => db.profiles.getForSender(senderId), p => p.latitude === 42.291 && p.alertsEnabled, "resumed location");

  // 7. Server-side revocation.
  assert.equal((await call("POST", "/admin/mobile/revoke", { deviceId: device.deviceId })).status, 401, "admin secret required");
  const revoke = await fetch(`${base}/admin/mobile/revoke`, {
    method: "POST", headers: { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: device.deviceId }),
  });
  assert.equal(revoke.status, 200);
  await eventually(() => db.mobile.getDevice(device.deviceId), d => d.revoked, "revoked device");
  assert.equal((await upload(deviceToken, 42.292)).status, 401);

  console.log(`mobile e2e passed (sender ${senderId})`);
} finally {
  server.close();
  disconnect();
}
