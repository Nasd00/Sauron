import assert from "node:assert/strict";
import { test } from "node:test";
import type { Incident, UserAlertProfile, Watch } from "@tempmhacks/shared";
import {
  haversineDistanceKm, matchConfirmedIncident, matchConfirmedIncidentToProfiles,
} from "../src/matcher.js";
import { createAlertSender, formatAlertMessage } from "../src/sender.js";
import { MemoryAlertStore, profileTarget, watchTarget } from "../src/store.js";

const incident: Incident = {
  id: "incident-1", cameraId: "camera-1", type: "smoke_fire", status: "confirmed",
  confidence: 0.95, latitude: 0, longitude: 0, firstSeenAt: 1000, lastSeenAt: 2000, confirmedAt: 3000,
};
const watch = (id: string, latitude: number, radiusKm = 10, active = true): Watch => ({
  id, spaceId: `space-${id}`, senderId: `sender-${id}`, placeLabel: `Place ${id}`,
  latitude, longitude: 0, radiusKm, active, createdAt: 1000,
});
const profile = (
  id: string, latitude: number,
  overrides: Partial<UserAlertProfile> = {},
): UserAlertProfile => ({
  userId: id, spaceId: `space-${id}`, senderId: `sender-${id}`,
  latitude, longitude: 0, locationUpdatedAt: 1000, radiusKm: 10, alertsEnabled: true,
  createdAt: 1000, updatedAt: 1000, ...overrides,
});

test("haversine returns zero for identical coordinates", () => {
  assert.equal(haversineDistanceKm(42, -83, 42, -83), 0);
});

test("confirmed incident creates watch alerts inside and exactly on radius, not outside or inactive", async () => {
  const store = new MemoryAlertStore();
  const boundaryLatitude = 10 / 6371.0088 * 180 / Math.PI;
  for (const item of [
    watch("inside", 0.05),
    watch("boundary", boundaryLatitude),
    watch("outside", boundaryLatitude + 0.001),
    watch("inactive", 0, 10, false),
  ]) store.watches.set(item.id, item);
  assert.equal(await matchConfirmedIncident(incident, store), 2);
  assert.deepEqual(Array.from(store.alerts.keys()).sort(), ["incident-1:boundary", "incident-1:inside"]);
});

test("profile matching respects radius, alertsEnabled, and freshness", async () => {
  const store = new MemoryAlertStore();
  const now = 100_000;
  for (const item of [
    profile("fresh-inside", 0.05, { locationUpdatedAt: now - 1000 }),
    profile("stale", 0.05, { locationUpdatedAt: now - 60 * 60 * 1000 }),
    profile("disabled", 0.05, { alertsEnabled: false, locationUpdatedAt: now - 1000 }),
    profile("far", 5, { locationUpdatedAt: now - 1000 }),
  ]) store.profiles.set(item.userId, item);
  const created = await matchConfirmedIncidentToProfiles(incident, store, { now });
  assert.equal(created, 1);
  assert.deepEqual(Array.from(store.alerts.keys()), ["incident-1:profile:fresh-inside"]);
});

test("profile matching is idempotent and candidate incidents create nothing", async () => {
  const store = new MemoryAlertStore();
  const now = 100_000;
  store.profiles.set("p", profile("p", 0, { locationUpdatedAt: now }));
  assert.equal(await matchConfirmedIncidentToProfiles({ ...incident, status: "candidate" }, store, { now }), 0);
  assert.equal(await matchConfirmedIncidentToProfiles(incident, store, { now }), 1);
  assert.equal(await matchConfirmedIncidentToProfiles(incident, store, { now }), 0);
  assert.equal(store.alerts.size, 1);
});

test("sender delivers a profile alert, records context, and never sends twice", async () => {
  const store = new MemoryAlertStore();
  const target = profile("inside", 0);
  store.profiles.set(target.userId, target);
  store.incidents.set(incident.id, incident);
  await store.createProfileAlert(incident.id, target.userId);
  const alert = store.alerts.get("incident-1:profile:inside")!;
  const sends: { spaceId: string; text: string }[] = [];
  const sender = createAlertSender({
    store,
    publicAppUrl: "https://downwind.example/app/",
    now: () => 4000,
    messenger: { send: async (spaceId, text) => { sends.push({ spaceId, text }); return "photon-message-1"; } },
  });
  assert.equal(await sender(alert), "sent");
  const sentCount = sends.length;
  assert.equal(await sender(alert), "skipped");
  assert.equal(sends.length, sentCount); // nothing re-sent
  assert.ok(sentCount >= 2, "long alert is split into multiple messages");
  assert.ok(sends.every(send => send.spaceId === target.spaceId));
  assert.ok(sends.every(send => send.text.length <= 200));
  const combined = sends.map(send => send.text).join("\n\n");
  assert.match(sends[0]!.text, /from your shared location/);
  assert.match(combined, /https:\/\/downwind\.example\/app\/incident\/incident-1/);
  // Conversation context is anchored to the alerted incident for grounded follow-ups.
  assert.deepEqual(store.contexts.get(target.spaceId), {
    spaceId: target.spaceId, activeIncidentId: incident.id, alertedAt: 4000,
  });
});

test("sender marks a failed delivery once and does not retry implicitly", async () => {
  const store = new MemoryAlertStore();
  const target = watch("inside", 0);
  store.watches.set(target.id, target);
  store.incidents.set(incident.id, incident);
  await store.createAlert(incident.id, target.id);
  const alert = store.alerts.get("incident-1:inside")!;
  let attempts = 0;
  const sender = createAlertSender({
    store,
    publicAppUrl: "https://downwind.example",
    messenger: { send: async () => { attempts += 1; throw new Error("provider unavailable"); } },
  });
  assert.equal(await sender(alert), "failed");
  assert.equal(await sender(alert), "skipped");
  assert.equal(attempts, 1);
  assert.equal(store.alerts.get(alert.id)?.status, "failed");
  assert.equal(store.alerts.get(alert.id)?.error, "provider unavailable");
});

test("watch alerts say near the place; profile alerts say near your location", () => {
  const watchText = formatAlertMessage(incident, watchTarget(watch("inside", 0)), "https://downwind.example");
  assert.match(watchText, /^Verified incident near Place inside\./);
  assert.match(watchText, /Type: smoke_fire/);
  assert.match(watchText, /https:\/\/downwind\.example\/incident\/incident-1/);

  const profileText = formatAlertMessage(incident, profileTarget(profile("p", 0.05)), "https://downwind.example");
  assert.match(profileText, /^Verified incident about [\d.]+ mi from your shared location\./);
});
