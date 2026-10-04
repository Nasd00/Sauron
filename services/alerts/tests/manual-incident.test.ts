import assert from "node:assert/strict";
import { test } from "node:test";
import type { Alert, Incident, IncidentView, UserAlertProfile, Watch } from "@tempmhacks/shared";
import { matchConfirmedIncident, matchConfirmedIncidentToProfiles, withinAlertRange } from "../src/matcher.js";
import { startAlertPipeline } from "../src/pipeline.js";
import { createAllClearSender, formatAlertMessage, formatAllClearMessage } from "../src/sender.js";
import { MemoryAlertStore, profileTarget, watchTarget } from "../src/store.js";

const KM_PER_DEG = 6371.0088 * Math.PI / 180;
const manual: IncidentView = {
  id: "manual-1", cameraId: "manual", type: "gas_leak", status: "confirmed", confidence: 1,
  latitude: 0, longitude: 0, firstSeenAt: 1000, lastSeenAt: 1000, confirmedAt: 1000,
  report: {
    incidentId: "manual-1", title: "Gas leak on Main St", description: "Strong smell near the school",
    radiusKm: 5, reportedBy: "web operator", reportedAt: 1000,
  },
};
const watch = (id: string, km: number, radiusKm = 2): Watch => ({
  id, spaceId: `space-${id}`, senderId: `sender-${id}`, placeLabel: `Place ${id}`,
  latitude: km / KM_PER_DEG, longitude: 0, radiusKm, active: true, createdAt: 1000,
});
const profile = (id: string, km: number): UserAlertProfile => ({
  userId: id, spaceId: `space-${id}`, senderId: `sender-${id}`, latitude: km / KM_PER_DEG, longitude: 0,
  locationUpdatedAt: 99_000, radiusKm: 2, alertsEnabled: true, createdAt: 0, updatedAt: 0,
});

test("a manual danger zone alerts anyone whose area overlaps it", async () => {
  assert.ok(withinAlertRange(manual, { latitude: 6.9 / KM_PER_DEG, longitude: 0, radiusKm: 2 }), "5 km zone + 2 km watch");
  assert.ok(!withinAlertRange(manual, { latitude: 7.1 / KM_PER_DEG, longitude: 0, radiusKm: 2 }));
  assert.ok(!withinAlertRange({ ...manual, report: undefined }, { latitude: 3 / KM_PER_DEG, longitude: 0, radiusKm: 2 }),
    "camera incidents keep the point rule");

  const store = new MemoryAlertStore();
  for (const item of [watch("in-zone", 1), watch("overlap", 6.5), watch("far", 9)]) store.watches.set(item.id, item);
  for (const item of [profile("p-near", 4), profile("p-far", 8)]) store.profiles.set(item.userId, item);
  assert.equal(await matchConfirmedIncident(manual, store), 2);
  assert.equal(await matchConfirmedIncidentToProfiles(manual, store, { now: 100_000 }), 1);
  assert.deepEqual([...store.alerts.keys()].sort(),
    ["manual-1:in-zone", "manual-1:overlap", "manual-1:profile:p-near"]);
});

test("manual alert text leads with the operator's report and says when you're inside the zone", () => {
  const inside = formatAlertMessage(manual, profileTarget(profile("p", 1)), "https://app.example");
  assert.match(inside, /^DANGER: Gas leak on Main St reported where you are\.\nYou are inside the danger zone\. Leave the area now/);
  assert.match(inside, /Type: gas leak/);
  assert.match(inside, /Danger zone: 3\.1 mi around the reported spot/);
  assert.match(inside, /Details: Strong smell near the school/);
  assert.match(inside, /call 911/);
  assert.match(inside, /https:\/\/app\.example\/incident\/manual-1/);
  assert.doesNotMatch(inside, /Spotted by/);

  const outside = formatAlertMessage(manual, profileTarget(profile("p", 6)), "https://app.example");
  assert.match(outside, /^DANGER: Gas leak on Main St reported about 3\.7 mi from your shared location\./);
  assert.doesNotMatch(outside, /inside the danger zone/);
  assert.match(formatAlertMessage(manual, watchTarget(watch("w", 1)), "https://app.example"), /^DANGER: .* reported near Place w\./);
});

test("resolving an incident texts all clear once to each conversation that was alerted", async () => {
  const store = new MemoryAlertStore();
  const resolved: IncidentView = { ...manual, status: "resolved", resolvedAt: 2000 };
  store.incidents.set(resolved.id, resolved);
  for (const item of [watch("a", 1), watch("b", 1)]) store.watches.set(item.id, item);
  const alerts: Alert[] = [
    { id: "manual-1:a", incidentId: "manual-1", watchId: "a", status: "sent", createdAt: 1 },
    { id: "manual-1:b", incidentId: "manual-1", watchId: "b", status: "failed", createdAt: 1 },
  ];
  for (const alert of alerts) store.alerts.set(alert.id, alert);
  const sent: { spaceId: string; text: string }[] = [];
  const allClear = createAllClearSender({ store, messenger: { send: async (spaceId, text) => { sent.push({ spaceId, text }); return "m"; } } });

  // Drive it through the pipeline: the same resolution arriving twice texts once.
  let listener: ((incident: Incident) => void) | undefined;
  const db = {
    incidents: {
      subscribe: (cb: (incident: Incident) => void) => { listener = cb; return () => undefined; },
      listConfirmed: () => [], view: (id: string) => store.incidents.get(id), get: (id: string) => store.incidents.get(id),
    },
    alerts: { subscribe: () => () => undefined },
  } as unknown as Parameters<typeof startAlertPipeline>[0]["db"];
  startAlertPipeline({ db, store, sendAlert: async () => undefined, sendAllClear: allClear });
  listener!(resolved);
  listener!(resolved);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{ spaceId: "space-a", text: formatAllClearMessage(resolved) }]);
  assert.match(sent[0]!.text, /^All clear: the Gas leak on Main St you were alerted about has been marked resolved/);
});
