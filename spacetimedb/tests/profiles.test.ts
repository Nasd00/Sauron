import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationContext, UserAlertProfile } from "@tempmhacks/shared";
import { DEFAULT_FRESHNESS_MS, evaluateLocationFreshness } from "@tempmhacks/shared/geo";
import {
  requireLatitude, requireLongitude, validateConversationContext, validateUserAlertProfile,
} from "../src/rules.js";

const baseProfile: UserAlertProfile = {
  userId: "user-1", spaceId: "space-1", senderId: "sender-1",
  latitude: 42.28, longitude: -83.74, locationUpdatedAt: 1000,
  radiusKm: 10, alertsEnabled: true, createdAt: 1000, updatedAt: 1000,
};

test("coordinate bounds are enforced", () => {
  assert.throws(() => requireLatitude(91), /Latitude/);
  assert.throws(() => requireLatitude(-91), /Latitude/);
  assert.throws(() => requireLongitude(181), /Longitude/);
  assert.throws(() => requireLongitude(Number.NaN), /Longitude/);
  requireLatitude(90);
  requireLongitude(-180);
});

test("validateUserAlertProfile rejects invalid fields and accepts a valid profile", () => {
  assert.doesNotThrow(() => validateUserAlertProfile(baseProfile));
  assert.throws(() => validateUserAlertProfile({ ...baseProfile, radiusKm: 0 }), /radiusKm/);
  assert.throws(() => validateUserAlertProfile({ ...baseProfile, latitude: 200 }), /Latitude/);
  assert.throws(() => validateUserAlertProfile({ ...baseProfile, senderId: "  " }), /senderId/);
  assert.throws(() => validateUserAlertProfile({ ...baseProfile, accuracyMeters: -1 }), /accuracyMeters/);
  assert.throws(() => validateUserAlertProfile({ ...baseProfile, locationUpdatedAt: -1 }), /Timestamp/);
});

test("freshness: within window fresh, beyond window stale, future treated as fresh", () => {
  const now = 10_000_000;
  assert.deepEqual(evaluateLocationFreshness(now - 1000, now), { fresh: true, ageMs: 1000 });
  const boundary = evaluateLocationFreshness(now - DEFAULT_FRESHNESS_MS, now);
  assert.equal(boundary.fresh, true);
  assert.equal(evaluateLocationFreshness(now - DEFAULT_FRESHNESS_MS - 1, now).fresh, false);
  assert.deepEqual(evaluateLocationFreshness(now + 5000, now), { fresh: true, ageMs: 0 });
});

test("validateConversationContext accepts valid and rejects empty optional strings", () => {
  const context: ConversationContext = {
    spaceId: "space-1", activeIncidentId: "incident-1", updatedAt: 1000,
  };
  assert.doesNotThrow(() => validateConversationContext(context));
  assert.throws(() => validateConversationContext({ ...context, spaceId: " " }), /spaceId/);
  assert.throws(() => validateConversationContext({ ...context, activeIncidentId: " " }), /activeIncidentId/);
  assert.throws(() => validateConversationContext({ ...context, lastCameraId: " " }), /lastCameraId/);
  assert.throws(() => validateConversationContext({ ...context, alertedAt: -5 }), /Timestamp/);
});
