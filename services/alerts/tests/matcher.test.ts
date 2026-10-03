import assert from "node:assert/strict";
import { test } from "node:test";
import type { Incident, Watch } from "@tempmhacks/shared";
import { haversineDistanceKm, matchConfirmedIncident } from "../src/matcher.js";

const incident: Incident = {
  id: "incident-1", cameraId: "camera-1", type: "smoke_fire", status: "confirmed",
  confidence: 0.9, latitude: 0, longitude: 0, firstSeenAt: 1000, lastSeenAt: 1000,
  confirmedAt: 1001,
};

function watch(radiusKm: number, active = true): Watch {
  return {
    id: `watch-${radiusKm}-${active}`, userHandle: "user-1", placeLabel: "Origin",
    latitude: 0, longitude: 0.1, radiusKm, active, createdAt: 1000,
  };
}

test("haversine distance is deterministic for fixed coordinates", () => {
  assert.equal(haversineDistanceKm(0, 0, 0, 0), 0);
  assert.ok(Math.abs(haversineDistanceKm(0, 0, 0, 0.1) - 11.1195) < 0.01);
});

test("confirmed incident matches an active watch inside its radius", async () => {
  const alerts: string[] = [];
  const created = await matchConfirmedIncident(incident, [watch(12)], (incidentId, watchId) => {
    alerts.push(`${incidentId}:${watchId}`);
  });
  assert.equal(created, 1);
  assert.deepEqual(alerts, ["incident-1:watch-12-true"]);
});

test("confirmed incident matches exactly at the radius boundary", async () => {
  const boundary = haversineDistanceKm(incident.latitude, incident.longitude, 0, 0.1);
  let created = 0;
  await matchConfirmedIncident(incident, [watch(boundary)], () => { created += 1; });
  assert.equal(created, 1);
});

test("out-of-radius and inactive watches do not match", async () => {
  let created = 0;
  await matchConfirmedIncident(incident, [watch(11), watch(12, false)], () => { created += 1; });
  assert.equal(created, 0);
});

test("existing incident-watch pairs are skipped", async () => {
  let created = 0;
  const key = "incident-1:watch-12-true";
  await matchConfirmedIncident(incident, [watch(12)], () => { created += 1; }, new Set([key]));
  assert.equal(created, 0);
});

test("non-confirmed incidents create no alerts", async () => {
  for (const status of ["candidate", "dismissed", "resolved"] as const) {
    let created = 0;
    await matchConfirmedIncident({ ...incident, status }, [watch(12)], () => { created += 1; });
    assert.equal(created, 0);
  }
});
