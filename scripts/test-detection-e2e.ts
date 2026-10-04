import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Camera, UserAlertProfile } from "@tempmhacks/shared";
import { connectDb } from "@tempmhacks/shared/db";
import { startAlertPipeline } from "../services/alerts/src/pipeline.js";
import { createAlertSender } from "../services/alerts/src/sender.js";
import { createAlertServiceStore } from "../services/alerts/src/store.js";
import { createDetectionStore, createFrameHandler } from "../services/cv/src/worker.js";

// End-to-end check that smoke detection reaches people, against a published local module:
// frames → detector → candidate → confirmed incident → profile match → alert sent.
// The detector is scripted and the messenger records instead of texting, so no Gemini or
// Spectrum credentials are used.
const uri = process.env.SPACETIMEDB_URI || "http://127.0.0.1:3000";
const database = process.env.SPACETIMEDB_DATABASE || "tempmhacks-local";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname), "Detection e2e requires a local server");

const { db, disconnect } = await connectDb({ uri, database, token: process.env.SPACETIMEDB_TOKEN });
const suffix = randomUUID().slice(0, 8);

async function eventually<T>(read: () => T | undefined, check: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value !== undefined && check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// A fresh spot each run, so open incidents from earlier runs aren't near these profiles.
const camera: Camera = {
  id: `e2e-camera-${suffix}`, name: `E2E ridge camera ${suffix}`,
  latitude: -60 + Math.random() * 120, longitude: -170 + Math.random() * 340,
  sourceType: "live", streamUrl: "https://cam.example/live.jpg", status: "online",
};
await db.cameras.register(camera);
await eventually(() => db.cameras.get(camera.id), () => true, "camera registration");

const now = Date.now();
function profile(name: string, latitude: number): UserAlertProfile {
  return {
    userId: `e2e-user-${name}-${suffix}`, spaceId: `e2e-space-${name}-${suffix}`, senderId: `e2e-sender-${name}-${suffix}`,
    latitude, longitude: camera.longitude, locationUpdatedAt: now, radiusKm: 5, alertsEnabled: true,
    createdAt: now, updatedAt: now,
  };
}
const near = profile("near", camera.latitude + 0.01); // ~1 km away
const far = profile("far", camera.latitude + 1); // ~110 km away
for (const item of [near, far]) await db.profiles.upsert(item);
await eventually(() => db.profiles.get(far.userId), () => true, "profiles");

const sent: { spaceId: string; text: string }[] = [];
const alertStore = createAlertServiceStore(db);
const stopAlerts = startAlertPipeline({
  db, store: alertStore,
  sendAlert: createAlertSender({
    store: alertStore, publicAppUrl: "https://downwind.example",
    messenger: { send: async (spaceId, text) => { sent.push({ spaceId, text }); return `msg-${sent.length}`; } },
  }),
});

const confidences = [0.1, 0.8, 0.9, 0.85, 0.9, 0.9];
const handleFrame = createFrameHandler({
  camera, store: createDetectionStore(db), log: () => {},
  detector: { detect: async () => ({ confidence: confidences.shift() ?? 0, description: "scripted" }) },
});
const frame = (i: number) => ({ cameraId: camera.id, capturedAt: now + i * 30_000, image: new Uint8Array() });

try {
  for (let i = 0; i < 3; i += 1) await handleFrame(frame(i));
  const candidate = await eventually(
    () => db.incidents.list().find(incident => incident.cameraId === camera.id), () => true, "candidate incident");
  assert.equal(candidate.status, "candidate");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(sent.length, 0, "a candidate must not alert anyone");

  await handleFrame(frame(3));
  await eventually(() => db.incidents.get(candidate.id), incident => incident.status === "confirmed", "confirmation");
  // Long alerts go out as several texts; the link is in a follow-up chunk.
  const delivered = await eventually(
    () => sent.filter(message => message.spaceId === near.spaceId).map(message => message.text).join("\n"),
    text => text.includes("/incident/"), "alert to the nearby profile");
  assert.match(delivered, /^Verified incident about [\d.]+ mi from your shared location\./);
  assert.match(delivered, new RegExp(`Spotted by: ${camera.name}`));
  assert.match(delivered, new RegExp(`https://downwind\\.example/incident/${candidate.id}`));

  // Further sightings keep the incident fresh without re-alerting anyone.
  for (let i = 4; i < 6; i += 1) await handleFrame(frame(i));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(sent.every(message => message.spaceId === near.spaceId), "the far profile is never alerted");
  assert.equal(sent.filter(message => message.text.startsWith("Verified incident")).length, 1, "alerted exactly once");
  console.log(JSON.stringify({ status: "detection_e2e_passed", incidentId: candidate.id, alerted: near.userId }));
} finally {
  stopAlerts();
  for (const incident of db.incidents.list()) {
    if (incident.cameraId !== camera.id) continue;
    if (incident.status === "confirmed") await db.incidents.resolve(incident.id).catch(() => undefined);
    if (incident.status === "candidate") await db.incidents.dismiss(incident.id).catch(() => undefined);
  }
  disconnect();
}
