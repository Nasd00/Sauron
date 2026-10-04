import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationContext, Incident, Watch } from "@tempmhacks/shared";
import { createCommandRouter } from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";
import type { Geocoder, InboundMessage } from "../src/types.js";

const geocoder: Geocoder = { geocode: async () => null };
const publicAppUrl = "https://downwind.example";
const message = (text: string, messageId = "m1"): InboundMessage => ({
  messageId, spaceId: "space-1", senderId: "sender-1",
  receivedAt: "2026-10-03T18:00:00.000Z", content: { type: "text", text },
});

function enrolledStore(): MemoryMessagingStore {
  const store = new MemoryMessagingStore();
  // An enrolled user with an active watch and an anchored incident conversation.
  store.profiles.push({
    userId: "sender-1", spaceId: "space-1", senderId: "sender-1",
    latitude: 42.28, longitude: -83.74, locationUpdatedAt: 1_000_000,
    radiusKm: 16, alertsEnabled: true, createdAt: 1_000_000, updatedAt: 1_000_000,
  });
  const watch: Watch = {
    id: "w1", spaceId: "space-1", senderId: "sender-1", placeLabel: "Ann Arbor",
    latitude: 42.28, longitude: -83.74, radiusKm: 16, active: true, createdAt: 1_000_000,
  };
  store.watches.push(watch);
  const context: ConversationContext = {
    spaceId: "space-1", activeIncidentId: "incident-9", alertedAt: 1_000_000, updatedAt: 1_000_000,
  };
  store.contexts.set("space-1", context);
  const incident: Incident = {
    id: "incident-9", cameraId: "camera-1", type: "smoke_fire", status: "confirmed",
    confidence: 0.9, latitude: 42.28, longitude: -83.74, firstSeenAt: 1000, lastSeenAt: 2000, confirmedAt: 1500,
  };
  store.incidents.set(incident.id, incident);
  return store;
}

test("STOP fully un-enrolls: watches off, alerts off, conversation anchor cleared", async () => {
  const store = enrolledStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 16, publicAppUrl, now: () => 2_000_000 });
  const reply = await route(message("STOP"));
  assert.match(reply?.text ?? "", /unsubscribed/i);
  assert.equal(store.watches.every(w => !w.active), true);
  assert.equal(store.profiles[0]?.alertsEnabled, false);
  // Active incident anchor is gone, so follow-ups cannot resolve a pre-STOP incident.
  assert.equal(store.contexts.get("space-1")?.activeIncidentId, undefined);
});

test("after STOP, a grounded follow-up finds no active incident (no continuity leak)", async () => {
  const store = enrolledStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 16, publicAppUrl, now: () => 2_000_000 });
  await route(message("STOP"));
  const reply = await route(message("what happened?", "m2"));
  assert.match(reply?.text ?? "", /don’t have an active incident/);
});

test("first message after STOP prompts re-enrollment (paused profile)", async () => {
  const store = enrolledStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 16, publicAppUrl, now: () => 2_000_000 });
  await route(message("STOP"));
  const reply = await route(message("hi", "m3"));
  assert.match(reply?.text ?? "", /currently unsubscribed/i);
});

test("sharing location after STOP cleanly re-enrolls everything", async () => {
  const store = enrolledStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 16, publicAppUrl, now: () => 2_000_000 });
  await route(message("STOP"));
  const reply = await route(message("LOC 42.30,-83.70", "m4"));
  assert.match(reply?.text ?? "", /^✅ Location received\..*alerts are back on/s);
  const p = store.profiles[0]!;
  assert.equal(p.alertsEnabled, true); // re-enabled
  assert.equal(p.latitude, 42.30); // refreshed
  assert.equal(p.locationUpdatedAt, 2_000_000); // fresh
  assert.equal(p.createdAt, 1_000_000); // identity preserved
  // Re-enroll also clears any stale incident anchor.
  assert.equal(store.contexts.get("space-1")?.activeIncidentId, undefined);
});
