import assert from "node:assert/strict";
import { test } from "node:test";
import type { Alert, Camera, Incident, IncidentStatus, InboundReceipt, Observation, Watch } from "@tempmhacks/shared";
import {
  cameraStatusUpdate, requireConfidence, requireTimestamp, validateCamera,
  validateObservation, validateNewIncident, updateDetection,
  confirmIncident, dismissIncident, resolveIncident, validateWatch,
  claimAlert, markAlertSent, markAlertFailed,
  claimInbound, validateInboundReceipt,
} from "../src/rules.js";

const candidate: Incident = {
  id: "incident-1", cameraId: "camera-1", type: "smoke_fire", status: "candidate",
  confidence: 0.8, latitude: 42, longitude: -83, firstSeenAt: 1000, lastSeenAt: 2000,
};
const statuses: IncidentStatus[] = ["candidate", "confirmed", "dismissed", "resolved"];

test("camera status update preserves every other field and input", () => {
  const camera: Camera = {
    id: "camera-1", name: "Replay", latitude: 42, longitude: -83,
    sourceType: "replay", streamUrl: "https://example.test/replay", status: "online", lastSeenAt: 1000,
  };
  const updated = cameraStatusUpdate(camera, "offline", 2000);
  assert.deepEqual(updated, { ...camera, status: "offline", lastSeenAt: 2000 });
  assert.equal(camera.status, "online");
  assert.equal(camera.lastSeenAt, 1000);
  assert.throws(() => cameraStatusUpdate(camera, "invalid" as Camera["status"], 2000));
  assert.throws(() => validateCamera({ ...camera, sourceType: "invalid" as Camera["sourceType"] }));
});

test("confidence accepts inclusive bounds and rejects nonfinite/outside values", () => {
  for (const value of [0, 0.5, 1]) requireConfidence(value);
  for (const value of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
    assert.throws(() => requireConfidence(value), /Confidence/);
  }
});

test("timestamps use safe integer Unix milliseconds", () => {
  requireTimestamp(0);
  requireTimestamp(Date.now());
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requireTimestamp(value), /Timestamp/);
  }
});

test("watch validation activates and normalizes a positive-radius watch", () => {
  const watch: Watch = {
    id: "watch-1", spaceId: "space-1", senderId: "sender-1", placeLabel: "  City   Hall ",
    latitude: 42, longitude: -83, radiusKm: 10, active: false, createdAt: 1000,
  };
  assert.deepEqual(validateWatch(watch), { ...watch, active: true, placeLabel: "City Hall" });
  assert.throws(() => validateWatch({ ...watch, radiusKm: 0 }), /radiusKm/);
  assert.throws(() => validateWatch({ ...watch, placeLabel: "   " }), /placeLabel/);
});

test("alerts can leave pending exactly once", () => {
  const alert: Alert = {
    id: "alert-1", incidentId: "incident-1", watchId: "watch-1", status: "pending", createdAt: 1000,
  };
  const claimed = claimAlert(alert);
  assert.equal(claimed.status, "sending");
  assert.throws(() => claimAlert(claimed), /Cannot claim sending/);
  const sent = markAlertSent(claimed, "provider-1", 2000);
  assert.deepEqual(sent, { ...alert, status: "sent", providerMessageId: "provider-1", sentAt: 2000 });
  assert.throws(() => markAlertSent(sent, "provider-2", 3000), /Cannot mark sent/);
  const failed = markAlertFailed(claimed, "provider unavailable");
  assert.deepEqual(failed, { ...alert, status: "failed", error: "provider unavailable" });
  assert.throws(() => markAlertFailed(failed, "retry"), /Cannot mark failed/);
});

test("observation accepts only smoke_fire without mutating input", () => {
  const observation: Observation = {
    id: "observation-1", cameraId: "camera-1", type: "smoke_fire", confidence: 0.9, timestamp: 2000,
  };
  validateObservation(observation);
  assert.throws(() => validateObservation({ ...observation, type: "flood" as Observation["type"] }), /smoke_fire/);
});

test("new incidents start only as candidates without lifecycle timestamps", () => {
  validateNewIncident(candidate);
  for (const status of statuses.filter(status => status !== "candidate")) {
    assert.throws(() => validateNewIncident({ ...candidate, status }), /candidate/);
  }
  assert.throws(() => validateNewIncident({ ...candidate, confirmedAt: 3000 }));
  assert.throws(() => validateNewIncident({ ...candidate, resolvedAt: 4000 }));
});

for (const status of statuses) {
  test(`all transition guards from ${status}`, () => {
    const incident = { ...candidate, status };
    const transitions = [
      { action: () => confirmIncident(incident, 3000), allowed: status === "candidate", target: "confirmed" },
      { action: () => dismissIncident(incident), allowed: status === "candidate", target: "dismissed" },
      { action: () => resolveIncident(incident, 4000), allowed: status === "confirmed", target: "resolved" },
    ];
    for (const transition of transitions) {
      if (transition.allowed) assert.equal(transition.action().status, transition.target);
      else assert.throws(transition.action, /Cannot/);
    }
    if (status === "candidate" || status === "confirmed") {
      assert.deepEqual(updateDetection(incident, 0.95, 2500), { ...incident, confidence: 0.95, lastSeenAt: 2500 });
    } else {
      assert.throws(() => updateDetection(incident, 0.95, 2500), /Cannot update/);
    }
    assert.deepEqual(incident, { ...candidate, status });
  });
}

test("confirmation and resolution timestamps cannot be overwritten", () => {
  const confirmed = confirmIncident(candidate, 3000);
  assert.equal(confirmed.confirmedAt, 3000);
  assert.throws(() => confirmIncident(confirmed, 3500));
  const updated = updateDetection(confirmed, 0.99, 3500);
  assert.equal(updated.confirmedAt, 3000);
  const resolved = resolveIncident(updated, 4000);
  assert.equal(resolved.confirmedAt, 3000);
  assert.equal(resolved.resolvedAt, 4000);
  assert.throws(() => resolveIncident(resolved, 5000));
});

test("inbound claim is atomic: first delivery wins, duplicate is rejected", () => {
  const receipt: InboundReceipt = {
    messageId: "spc-msg-1", spaceId: "any;-;+15551234567", senderId: "+15551234567",
    receivedAt: 1_700_000_000_000, contentType: "text",
  };
  // First delivery: nothing claimed yet, so the claim succeeds (no throw).
  assert.doesNotThrow(() => claimInbound(receipt, false));
  // Racing/duplicate delivery: the row already exists, so this one loses.
  assert.throws(() => claimInbound(receipt, true), /already claimed/);
});

test("inbound claim validates identity and metadata before claiming", () => {
  const base: InboundReceipt = {
    messageId: "spc-msg-2", spaceId: "space-2", senderId: "sender-2",
    receivedAt: 1_700_000_000_000, contentType: "text",
  };
  // Valid receipt passes validation.
  assert.doesNotThrow(() => validateInboundReceipt(base));
  // Empty identity fields are rejected.
  for (const field of ["messageId", "spaceId", "senderId"] as const) {
    assert.throws(() => validateInboundReceipt({ ...base, [field]: "   " }), /identity fields/);
  }
  // Empty content type is rejected.
  assert.throws(() => validateInboundReceipt({ ...base, contentType: "" }), /contentType/);
  // Invalid timestamp is rejected.
  assert.throws(() => validateInboundReceipt({ ...base, receivedAt: -1 }), /Timestamp/);
});
