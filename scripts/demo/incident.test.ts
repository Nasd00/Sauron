import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDemoIncident } from "./incident.js";

test("demo incident targets the demo camera as a candidate within Ann Arbor", () => {
  const now = 1_700_000_000_000;
  const incident = buildDemoIncident(now);
  assert.equal(incident.cameraId, "demo-camera-001");
  assert.equal(incident.type, "smoke_fire");
  assert.equal(incident.status, "candidate");
  assert.equal(incident.latitude, 42.2808);
  assert.equal(incident.longitude, -83.743);
  assert.equal(incident.firstSeenAt, now);
  assert.equal(incident.lastSeenAt, now);
  assert.ok(incident.confidence > 0 && incident.confidence <= 1);
  assert.equal(incident.confirmedAt, undefined);
  assert.equal(incident.resolvedAt, undefined);
});

test("demo incidents get unique ids per build", () => {
  const a = buildDemoIncident();
  const b = buildDemoIncident();
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^incident-demo-/);
});
