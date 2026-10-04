import assert from "node:assert/strict";
import { test } from "node:test";
import type { MobileDevice, UserAlertProfile } from "@tempmhacks/shared";
import {
  DEFAULT_FRESHNESS_MS, LIVE_TRACKING_FRESHNESS_MS, evaluateProfileFreshness, isLiveTracked,
} from "@tempmhacks/shared/geo";
import {
  MOBILE_PAIRING_TTL_MS, applyMobileLocation, newMobilePairing, requireRedeemablePairing,
  requireTokenHash, requireUploadingDevice, validateMobileLocation,
} from "../src/rules.js";

const hash = "a".repeat(64);
const now = 1_791_090_000_000;
const device: MobileDevice = {
  deviceId: "d1", userId: "user-1", spaceId: "space-1", senderId: "sender-1",
  trackingActive: true, sharingEnabled: false, revoked: false, pairedAt: now - 1000, updatedAt: now - 1000,
};
const location = { latitude: 42.2808, longitude: -83.743, accuracyMeters: 37, capturedAt: now - 1000 };

test("token hashes must be SHA-256 hex", () => {
  requireTokenHash(hash);
  assert.throws(() => requireTokenHash("raw-token"), /token_invalid/);
  assert.throws(() => requireTokenHash("A".repeat(64)), /token_invalid/);
});

test("pairings expire after ten minutes and are single-use", () => {
  const pairing = newMobilePairing({ tokenHash: hash, userId: "u", spaceId: "s", senderId: "x" }, now);
  assert.equal(pairing.expiresAt, now + MOBILE_PAIRING_TTL_MS);
  assert.equal(MOBILE_PAIRING_TTL_MS, 10 * 60 * 1000);
  assert.equal(requireRedeemablePairing(pairing, now + MOBILE_PAIRING_TTL_MS), pairing);
  assert.throws(() => requireRedeemablePairing(pairing, now + MOBILE_PAIRING_TTL_MS + 1), /pairing_expired/);
  assert.throws(() => requireRedeemablePairing({ ...pairing, usedAt: now }, now), /pairing_used/);
  assert.throws(() => requireRedeemablePairing(undefined, now), /pairing_invalid/);
  assert.throws(() => newMobilePairing({ tokenHash: hash, userId: "u", spaceId: " ", senderId: "x" }, now), /spaceId/);
});

test("location uploads reject low accuracy, bad coordinates, and bad timestamps", () => {
  validateMobileLocation(location, now);
  validateMobileLocation({ ...location, accuracyMeters: 500 }, now);
  assert.throws(() => validateMobileLocation({ ...location, accuracyMeters: 501 }, now), /location_invalid.*accuracy/);
  assert.throws(() => validateMobileLocation({ ...location, latitude: 91 }, now), /location_invalid.*Latitude/);
  assert.throws(() => validateMobileLocation({ ...location, capturedAt: now + 10 * 60_000 }, now), /future/);
  assert.throws(() => validateMobileLocation({ ...location, capturedAt: now - 2 * 3_600_000 }, now), /too old/);
  assert.throws(() => validateMobileLocation({ ...location, capturedAt: 1.5 }, now), /location_invalid/);
});

test("only paired devices with active tracking may upload", () => {
  requireUploadingDevice(device);
  assert.throws(() => requireUploadingDevice(undefined), /device_unauthorized/);
  assert.throws(() => requireUploadingDevice({ ...device, revoked: true }), /device_unauthorized/);
  assert.throws(() => requireUploadingDevice({ ...device, trackingActive: false }), /tracking_stopped/);
});

test("first upload after pairing creates the location-backed profile", () => {
  const result = applyMobileLocation(device, undefined, location, 10, now);
  assert.ok(result);
  assert.deepEqual(result.profile, {
    userId: "user-1", spaceId: "space-1", senderId: "sender-1", latitude: 42.2808, longitude: -83.743,
    accuracyMeters: 37, locationUpdatedAt: location.capturedAt, radiusKm: 10, alertsEnabled: true,
    createdAt: now, updatedAt: now,
  });
  assert.equal(result.device.sharingEnabled, true);
  assert.equal(result.device.lastLocationAt, location.capturedAt);
  assert.equal(result.device.lastAccuracyMeters, 37);
});

test("later uploads move the same profile, keeping radius and createdAt", () => {
  const existing: UserAlertProfile = {
    userId: "user-1", spaceId: "space-1", senderId: "sender-1", latitude: 1, longitude: 1,
    locationUpdatedAt: 5, radiusKm: 16, alertsEnabled: false, createdAt: 5, updatedAt: 5,
  };
  const moved = { ...location, latitude: 42.3 };
  const result = applyMobileLocation({ ...device, lastLocationAt: now - 5000 }, existing, moved, 10, now);
  assert.equal(result?.profile.userId, "user-1");
  assert.equal(result?.profile.latitude, 42.3);
  assert.equal(result?.profile.radiusKm, 16);
  assert.equal(result?.profile.createdAt, 5);
  assert.equal(result?.profile.alertsEnabled, true);
});

test("out-of-order uploads are ignored; stopped tracking is rejected", () => {
  assert.equal(applyMobileLocation({ ...device, lastLocationAt: location.capturedAt }, undefined, location, 10, now), undefined);
  assert.throws(() => applyMobileLocation({ ...device, trackingActive: false }, undefined, location, 10, now), /tracking_stopped/);
});

test("live-tracked profiles use the longer freshness window", () => {
  const live = { ...device, sharingEnabled: true, lastLocationAt: now };
  assert.equal(isLiveTracked("sender-1", [live]), true);
  assert.equal(isLiveTracked("sender-1", [{ ...live, trackingActive: false }]), false);
  assert.equal(isLiveTracked("sender-1", [{ ...live, sharingEnabled: false }]), false);
  assert.equal(isLiveTracked("sender-1", [{ ...live, revoked: true }]), false);
  assert.equal(isLiveTracked("sender-1", [{ ...live, lastLocationAt: undefined }]), false);
  assert.equal(isLiveTracked("other", [live]), false);
  const profile = { locationUpdatedAt: now - DEFAULT_FRESHNESS_MS - 1 };
  assert.equal(evaluateProfileFreshness(profile, false, now).fresh, false);
  assert.equal(evaluateProfileFreshness(profile, true, now).fresh, true);
  assert.equal(evaluateProfileFreshness({ locationUpdatedAt: now - LIVE_TRACKING_FRESHNESS_MS - 1 }, true, now).fresh, false);
});
