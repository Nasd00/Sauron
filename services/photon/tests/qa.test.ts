import assert from "node:assert/strict";
import { test } from "node:test";
import type { Camera, ConversationContext, Incident, Observation } from "@tempmhacks/shared";
import { createCommandRouter } from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";
import type { Geocoder, InboundMessage } from "../src/types.js";

const geocoder: Geocoder = { geocode: async () => null };
const publicAppUrl = "https://downwind.example";

const message = (text: string, messageId: string): InboundMessage => ({
  messageId, spaceId: "space-1", senderId: "sender-1",
  receivedAt: "2026-10-03T18:00:00.000Z", content: { type: "text", text },
});

function groundedStore(): MemoryMessagingStore {
  const store = new MemoryMessagingStore();
  const incident: Incident = {
    id: "incident-9", cameraId: "camera-1", type: "smoke_fire", status: "confirmed",
    confidence: 0.9, latitude: 42.28, longitude: -83.74, firstSeenAt: 1000, lastSeenAt: 2000, confirmedAt: 1500,
  };
  const camera: Camera = {
    id: "camera-1", name: "North Cam", latitude: 42.29, longitude: -83.74,
    sourceType: "live", status: "online", streamUrl: "https://cam.example/live.jpg",
  };
  const observation: Observation = {
    id: "obs-1", cameraId: "camera-1", type: "smoke_fire", confidence: 0.9,
    timestamp: 2000, evidenceUrl: "https://cam.example/frame.jpg",
  };
  const context: ConversationContext = {
    spaceId: "space-1", activeIncidentId: "incident-9", alertedAt: 2000, updatedAt: 2000,
  };
  store.incidents.set(incident.id, incident);
  store.cameras.set(camera.id, camera);
  store.observations.push(observation);
  store.contexts.set(context.spaceId, context);
  return store;
}

test("grounded follow-ups resolve the active incident from conversation context", async () => {
  const store = groundedStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 10, publicAppUrl, now: () => 3000 });
  const whatHappened = await route(message("what happened?", "m1"));
  assert.match(whatHappened?.text ?? "", /possible smoke\/fire/);
  assert.match(whatHappened?.text ?? "", /North Cam/);
  // lastIntent is persisted for continuity.
  assert.equal(store.contexts.get("space-1")?.lastIntent, "what_happened");
});

test("show me returns an evidence attachment and records the camera", async () => {
  const store = groundedStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 10, publicAppUrl, now: () => 3000 });
  const reply = await route(message("show me", "m2"));
  assert.equal(reply?.sendEvidence, true);
  assert.equal(reply?.evidenceUrl, "https://cam.example/frame.jpg");
  assert.equal(store.contexts.get("space-1")?.lastCameraId, "camera-1");
});

test("a follow-up with no active incident falls back without inventing facts", async () => {
  const store = new MemoryMessagingStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 10, publicAppUrl, now: () => 3000 });
  const reply = await route(message("what happened?", "m3"));
  assert.match(reply?.text ?? "", /don’t have an active incident/);
});
