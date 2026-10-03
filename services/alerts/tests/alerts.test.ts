import assert from "node:assert/strict";
import { test } from "node:test";
import type { Alert, Incident, Watch } from "@tempmhacks/shared";
import { haversineDistanceKm, matchConfirmedIncident } from "../src/matcher.js";
import { createAlertSender, formatAlertMessage } from "../src/sender.js";
import { MemoryAlertStore } from "../src/store.js";

const incident: Incident = {
  id: "incident-1", cameraId: "camera-1", type: "smoke_fire", status: "confirmed",
  confidence: 0.95, latitude: 0, longitude: 0, firstSeenAt: 1000, lastSeenAt: 2000, confirmedAt: 3000,
};
const watch = (id: string, latitude: number, radiusKm = 10, active = true): Watch => ({
  id, spaceId: `space-${id}`, senderId: `sender-${id}`, placeLabel: `Place ${id}`,
  latitude, longitude: 0, radiusKm, active, createdAt: 1000,
});

test("haversine returns zero for identical coordinates", () => {
  assert.equal(haversineDistanceKm(42, -83, 42, -83), 0);
});

test("confirmed incident creates alerts inside and exactly on radius, not outside or inactive", async () => {
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

test("candidate creates no alert and reprocessing confirmed incident is idempotent", async () => {
  const store = new MemoryAlertStore();
  store.watches.set("inside", watch("inside", 0));
  assert.equal(await matchConfirmedIncident({ ...incident, status: "candidate" }, store), 0);
  assert.equal(await matchConfirmedIncident(incident, store), 1);
  assert.equal(await matchConfirmedIncident(incident, store), 0);
  assert.equal(store.alerts.size, 1);
});

test("sender stores outbound ID and never sends an alert twice", async () => {
  const store = new MemoryAlertStore();
  const target = watch("inside", 0);
  store.watches.set(target.id, target);
  store.incidents.set(incident.id, incident);
  await store.createAlert(incident.id, target.id);
  const alert = store.alerts.get("incident-1:inside")!;
  const sends: { spaceId: string; text: string }[] = [];
  const sender = createAlertSender({
    store,
    publicAppUrl: "https://downwind.example/app/",
    now: () => 4000,
    messenger: { send: async (spaceId, text) => { sends.push({ spaceId, text }); return "photon-message-1"; } },
  });
  assert.equal(await sender(alert), "sent");
  assert.equal(await sender(alert), "skipped");
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.spaceId, target.spaceId);
  assert.match(sends[0]!.text, /https:\/\/downwind\.example\/app\/incident\/incident-1/);
  assert.deepEqual(store.alerts.get(alert.id), {
    ...alert, status: "sent", providerMessageId: "photon-message-1", sentAt: 4000,
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

test("alert facts and incident deep link are deterministic", () => {
  const text = formatAlertMessage(incident, watch("inside", 0), "https://downwind.example");
  assert.equal(text, [
    "Verified incident near Place inside.",
    "Type: smoke_fire",
    "Detected: 1970-01-01T00:00:02.000Z",
    "",
    "View live incident:",
    "https://downwind.example/incident/incident-1",
    "",
    "Community-generated alert — not an official emergency warning.",
    "Reply STATUS for details or STOP to unsubscribe.",
  ].join("\n"));
});
