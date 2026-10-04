import assert from "node:assert/strict";
import { test } from "node:test";
import { MANUAL_CAMERA_ID as SHARED_MANUAL_ID, REPORTABLE_HAZARDS as SHARED_HAZARDS } from "@tempmhacks/shared";
import { MANUAL_CAMERA_ID, newManualIncident, REPORTABLE_HAZARDS, type ManualReportInput } from "../src/rules.js";

const input: ManualReportInput = {
  id: "manual-1", type: "gas_leak", latitude: 42.28, longitude: -83.74, radiusKm: 2,
  title: "  Gas   leak on Main St ", description: " Strong smell ", reportedBy: "web operator",
};

test("module constants mirror the shared contract", () => {
  assert.equal(MANUAL_CAMERA_ID, SHARED_MANUAL_ID);
  assert.deepEqual([...REPORTABLE_HAZARDS], [...SHARED_HAZARDS]);
});

test("a manual report becomes a confirmed incident plus its report", () => {
  const { incident, report } = newManualIncident(input, 5000);
  assert.deepEqual(incident, {
    id: "manual-1", cameraId: "manual", type: "gas_leak", status: "confirmed", confidence: 1,
    latitude: 42.28, longitude: -83.74, firstSeenAt: 5000, lastSeenAt: 5000, confirmedAt: 5000,
  });
  assert.deepEqual(report, {
    incidentId: "manual-1", title: "Gas leak on Main St", description: "Strong smell",
    radiusKm: 2, reportedBy: "web operator", reportedAt: 5000,
  });
});

test("manual reports reject bad hazards, coordinates, radii, and titles", () => {
  assert.throws(() => newManualIncident({ ...input, type: "aliens" }, 1), /Hazard/);
  assert.throws(() => newManualIncident({ ...input, latitude: 91 }, 1), /coordinates/);
  assert.throws(() => newManualIncident({ ...input, radiusKm: 0 }, 1), /radiusKm/);
  assert.throws(() => newManualIncident({ ...input, radiusKm: 500 }, 1), /radiusKm/);
  assert.throws(() => newManualIncident({ ...input, title: "  " }, 1), /title/);
  assert.throws(() => newManualIncident({ ...input, description: "x".repeat(1001) }, 1), /description/);
  assert.equal(newManualIncident({ ...input, reportedBy: " " }, 1).report.reportedBy, "operator");
});
