import assert from "node:assert/strict";
import { test } from "node:test";
import type { Incident } from "@tempmhacks/shared";
import { LiveState } from "../src/live-state.js";

const incident = (id: string, status: Incident["status"], lastSeenAt: number): Incident => ({
  id, status, cameraId: "camera", type: "smoke_fire", confidence: .8,
  latitude: 30, longitude: -97, firstSeenAt: 1, lastSeenAt,
});
test("realtime state ranks confirmed incidents and removes terminal/deleted records", () => {
  const state = new LiveState();
  state.update("incidents", incident("candidate", "candidate", 30));
  state.update("incidents", incident("confirmed", "confirmed", 20));
  assert.deepEqual(state.activeIncidents().map(row => row.id), ["confirmed", "candidate"]);
  state.update("incidents", incident("confirmed", "resolved", 40));
  assert.deepEqual(state.activeIncidents().map(row => row.id), ["candidate"]);
  state.update("incidents", incident("candidate", "candidate", 30), true);
  assert.equal(state.incidents.size, 1);
  assert.deepEqual(state.activeIncidents(), []);
});
test("evidence selects the newest saved frame for the requested camera", () => {
  const state = new LiveState();
  for (const [id, cameraId, timestamp, evidenceUrl] of [
    ["old", "camera", 10, "https://example.com/old.jpg"],
    ["new", "camera", 20, "https://example.com/new.jpg"],
    ["no-image", "camera", 30, undefined],
    ["other", "other", 40, "https://example.com/other.jpg"],
  ] as const) state.update("observations", { id, cameraId, timestamp, evidenceUrl, type: "smoke_fire", confidence: .8 });
  assert.equal(state.latestEvidence("camera")?.id, "new");
});
test("unsubscribe prevents later database changes from notifying detached UI", () => {
  const state = new LiveState(); let calls = 0;
  const stop = state.subscribe(() => { calls++; });
  state.update("incidents", incident("a", "candidate", 1));
  stop(); state.update("incidents", incident("a", "confirmed", 2));
  assert.equal(calls, 1);
});
