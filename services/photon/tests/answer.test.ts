import assert from "node:assert/strict";
import { test } from "node:test";
import type { Camera, Incident, Observation, UserAlertProfile } from "@tempmhacks/shared";
import { answerFollowUp, classifyFollowUp, type GroundedContext } from "../src/answer.js";

const incident: Incident = {
  id: "incident-1", cameraId: "camera-1", type: "smoke_fire", status: "confirmed",
  confidence: 0.9, latitude: 42.28, longitude: -83.74, firstSeenAt: 1000, lastSeenAt: 2000, confirmedAt: 1500,
};
const camera: Camera = {
  id: "camera-1", name: "Ann Arbor North", latitude: 42.29, longitude: -83.74,
  sourceType: "live", status: "online", streamUrl: "https://cam.example/live.jpg",
};
const observation: Observation = {
  id: "obs-1", cameraId: "camera-1", type: "smoke_fire", confidence: 0.9,
  timestamp: 2000, evidenceUrl: "https://cam.example/frame-2000.jpg",
};
const profile: UserAlertProfile = {
  userId: "user-1", spaceId: "space-1", senderId: "sender-1",
  latitude: 42.30, longitude: -83.74, locationUpdatedAt: 100_000,
  radiusKm: 10, alertsEnabled: true, createdAt: 1, updatedAt: 100_000,
};
const context = (overrides: Partial<GroundedContext> = {}): GroundedContext => ({
  incident, camera, latestObservation: observation, otherNearbyCameraCount: 2,
  profile, baseUrl: "https://downwind.example", now: 100_500, ...overrides,
});

test("intent classification covers the priority follow-ups", () => {
  assert.equal(classifyFollowUp("what happened?"), "what_happened");
  assert.equal(classifyFollowUp("where is it"), "where");
  assert.equal(classifyFollowUp("how far is it from me"), "how_far");
  assert.equal(classifyFollowUp("is it still active?"), "is_active");
  assert.equal(classifyFollowUp("when was it first seen"), "when");
  assert.equal(classifyFollowUp("which camera saw it"), "which_camera");
  assert.equal(classifyFollowUp("show me"), "show_me");
  assert.equal(classifyFollowUp("are there other cameras nearby"), "other_cameras");
  assert.equal(classifyFollowUp("what changed"), "what_changed");
  assert.equal(classifyFollowUp("hello there"), undefined);
});

test("what_happened reports type, camera, grounded distance, and link only from state", () => {
  const answer = answerFollowUp("what_happened", context());
  assert.match(answer.text, /possible smoke\/fire/);
  assert.match(answer.text, /active and verified/);
  assert.match(answer.text, /Ann Arbor North/);
  assert.match(answer.text, /from your location/);
  assert.match(answer.text, /https:\/\/downwind\.example\/incident\/incident-1/);
  assert.equal(answer.sendEvidence, false);
});

test("how_far uses the fresh profile, and warns when stale", () => {
  const fresh = answerFollowUp("how_far", context());
  assert.match(fresh.text, /from your location/);
  const stale = answerFollowUp("how_far", context({ now: 100_000 + 60 * 60 * 1000 }));
  assert.match(stale.text, /last shared location/);
  const noProfile = answerFollowUp("how_far", context({ profile: undefined }));
  assert.match(noProfile.text, /don’t have your location/);
});

test("show_me returns evidence when available and the camera id for continuity", () => {
  const withEvidence = answerFollowUp("show_me", context());
  assert.equal(withEvidence.sendEvidence, true);
  assert.equal(withEvidence.evidenceUrl, observation.evidenceUrl);
  assert.equal(withEvidence.cameraId, "camera-1");

  const noEvidence = answerFollowUp("show_me", context({
    latestObservation: undefined,
    camera: { ...camera, streamUrl: undefined },
  }));
  assert.equal(noEvidence.sendEvidence, false);
  assert.match(noEvidence.text, /Watch live/);
});

test("is_active and when report incident lifecycle timestamps", () => {
  assert.match(answerFollowUp("is_active", context()).text, /active and verified/);
  const resolved = answerFollowUp("is_active", context({ incident: { ...incident, status: "resolved" } }));
  assert.match(resolved.text, /resolved/);
  assert.match(answerFollowUp("when", context()).text, /First seen/);
});

test("other_cameras reflects the nearby count", () => {
  assert.match(answerFollowUp("other_cameras", context()).text, /2 other nearby cameras/);
  assert.match(answerFollowUp("other_cameras", context({ otherNearbyCameraCount: 0 })).text, /don’t see other/);
});
