import assert from "node:assert/strict";
import { test } from "node:test";
import type { MobileDevice } from "@tempmhacks/shared";
import {
  applyMobileLocation, newMobilePairing, requireRedeemablePairing, requireTokenHash, requireUploadingDevice,
  type MobilePairing,
} from "../../../spacetimedb/src/rules.js";
import {
  createMobileApi, errorResponse, hashToken, pairPage, pairingUrl, type MobileStore,
} from "../src/mobile.js";
import { createCommandRouter, HELP_REPLY, MOBILE_UNAVAILABLE_REPLY, STOP_REPLY, TRACKING_RESUMED_REPLY } from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";
import type { InboundMessage } from "../src/types.js";

/**
 * In-memory stand-in for the SpacetimeDB reducers, built on the same pure rules the
 * module runs, so pairing → upload → STOP → WATCH ME is exercised end to end.
 */
class FakeBackend extends MemoryMessagingStore implements MobileStore {
  readonly pairingRows: MobilePairing[] = [];
  readonly credentials = new Map<string, { deviceId: string; revoked: boolean }>();
  clock = 1_791_090_000_000;

  override async createMobilePairing(input: { tokenHash: string; userId: string; spaceId: string; senderId: string }) {
    this.pairingRows.push(newMobilePairing(input, this.clock));
  }
  async createPairing(input: { tokenHash: string; userId: string; spaceId: string; senderId: string }) {
    await this.createMobilePairing(input);
  }
  async redeemPairing(input: { pairingTokenHash: string; credentialTokenHash: string; deviceId: string }) {
    requireTokenHash(input.pairingTokenHash);
    const pairing = requireRedeemablePairing(this.pairingRows.find(p => p.tokenHash === input.pairingTokenHash), this.clock);
    pairing.usedAt = this.clock;
    for (const device of this.devices) {
      if (device.senderId === pairing.senderId && !device.revoked) Object.assign(device, { revoked: true, trackingActive: false });
    }
    this.devices.push({
      deviceId: input.deviceId, userId: pairing.userId, spaceId: pairing.spaceId, senderId: pairing.senderId,
      trackingActive: true, sharingEnabled: false, revoked: false, pairedAt: this.clock, updatedAt: this.clock,
    });
    this.credentials.set(input.credentialTokenHash, { deviceId: input.deviceId, revoked: false });
  }
  private deviceFor(hash: string): MobileDevice {
    const credential = this.credentials.get(hash);
    const device = credential && !credential.revoked ? this.devices.find(d => d.deviceId === credential.deviceId) : undefined;
    if (!device || device.revoked) throw new Error("device_unauthorized: device is not paired");
    return device;
  }
  async updateLocation(input: {
    credentialTokenHash: string; latitude: number; longitude: number;
    accuracyMeters: number; capturedAt: number; defaultRadiusKm: number;
  }) {
    const device = this.deviceFor(input.credentialTokenHash);
    const existing = this.profiles.find(p => p.userId === device.userId);
    const applied = applyMobileLocation(device, existing, input, input.defaultRadiusKm, this.clock);
    if (!applied) return;
    Object.assign(device, applied.device);
    await this.upsertProfile(applied.profile);
  }
  async setSharing(hash: string, enabled: boolean) {
    const device = this.deviceFor(hash);
    if (enabled) requireUploadingDevice(device);
    device.sharingEnabled = enabled;
  }
  async checkCredential(hash: string, deviceId: string) {
    if (this.deviceFor(hash).deviceId !== deviceId) throw new Error("device_unauthorized: device is not paired");
  }
  getDevice(deviceId: string) {
    return this.devices.find(d => d.deviceId === deviceId);
  }
  async revokeDevice(deviceId: string) {
    const device = this.getDevice(deviceId);
    if (!device) throw new Error(`Device ${deviceId} does not exist`);
    Object.assign(device, { revoked: true, trackingActive: false, sharingEnabled: false });
    for (const credential of this.credentials.values()) if (credential.deviceId === deviceId) credential.revoked = true;
  }
}

const BASE = "https://photon.example";
const REGISTERED_PHONE = "+15551234567";
const text = (value: string, messageId = value): InboundMessage => ({
  messageId, spaceId: "space-1", senderId: "sender-1",
  receivedAt: "2026-10-03T18:00:00.000Z", content: { type: "text", text: value },
});

function setup() {
  const backend = new FakeBackend();
  let n = 0;
  const route = createCommandRouter({
    store: backend, geocoder: { geocode: async () => null }, radiusKm: 10, publicAppUrl: "https://downwind.example",
    mobilePairingBaseUrl: BASE, now: () => backend.clock,
  });
  const api = createMobileApi({
    store: backend,
    radiusKm: 10,
    id: () => `00000000-0000-4000-8000-00000000000${n++}`,
    resolveRegistration: async phone => {
      if (phone !== REGISTERED_PHONE) return undefined;
      const profile = backend.profiles.find(row => row.senderId === "sender-1" && row.alertsEnabled);
      const watch = backend.watches.find(row => row.senderId === "sender-1" && row.active);
      const registration = profile ?? watch;
      return registration ? {
        userId: profile?.userId ?? "sender-1", spaceId: registration.spaceId, senderId: "sender-1",
      } : undefined;
    },
  });
  return { backend, route, api };
}

async function pairedDevice(ctx = setup()) {
  const reply = (await ctx.route(text("WATCH ME")))?.text ?? "";
  const token = /\/pair\/([A-Za-z0-9_-]{43})/.exec(reply)?.[1];
  assert.ok(token, reply);
  const paired = await ctx.api.pair({ pairingToken: token });
  assert.equal(paired.status, 201);
  return { ...ctx, token, deviceToken: paired.body.deviceToken as string, paired };
}

const fix = (clock: number, overrides: Record<string, number> = {}) => ({
  latitude: 42.2808, longitude: -83.743, accuracyMeters: 37, capturedAt: clock - 1000, ...overrides,
});

test("WATCH ME sends a single-use pairing link resolved server-side to the sender", async () => {
  const { backend, route } = setup();
  const reply = (await route(text("watch me")))?.text ?? "";
  assert.match(reply, /https:\/\/photon\.example\/pair\/[A-Za-z0-9_-]{43}/);
  assert.match(reply, /expires in 10 minutes/);
  assert.equal(backend.pairingRows.length, 1);
  const [pairing] = backend.pairingRows;
  assert.equal(pairing?.senderId, "sender-1");
  assert.equal(pairing?.spaceId, "space-1");
  // Only the hash is stored.
  assert.doesNotMatch(JSON.stringify(backend.pairingRows), new RegExp(/\/pair\/(\S+)/.exec(reply)![1]!));
  assert.equal(backend.watches.length, 0, "WATCH ME is not a place watch");
});

test("pairing returns a device token once; the link cannot be reused", async () => {
  const { api, token, paired } = await pairedDevice();
  assert.match(paired.body.deviceToken as string, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(paired.body.trackingActive, true);
  assert.equal(paired.body.sharingEnabled, false);
  const again = await api.pair({ pairingToken: token });
  assert.equal(again.status, 410);
  assert.equal(again.body.error, "pairing_used");
  assert.equal((await api.pair({ pairingToken: "nope" })).status, 404);
});

test("an enrolled phone pairs directly in the app without a message link", async () => {
  const { backend, api } = setup();
  backend.watches.push({
    id: "watch-1", spaceId: "space-1", senderId: "sender-1", placeLabel: "Ann Arbor",
    latitude: 42.2808, longitude: -83.743, radiusKm: 10, active: true, createdAt: backend.clock,
  });
  const paired = await api.pairRegistered({ phone: REGISTERED_PHONE });
  assert.equal(paired.status, 201);
  assert.match(paired.body.deviceToken as string, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(backend.pairingRows.length, 1);
  assert.notEqual(backend.pairingRows[0]?.usedAt, undefined, "the internal token is redeemed immediately");
  assert.equal((await api.location(`Bearer ${paired.body.deviceToken}`, fix(backend.clock))).status, 200);
});

test("direct app pairing requires prior registration", async () => {
  const { backend, api } = setup();
  const result = await api.pairRegistered({ phone: "+15550000000" });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "registration_required");
  assert.equal(backend.devices.length, 0);
  assert.equal((await api.pairRegistered({ phone: "555-1234" })).status, 422);
});

test("expired pairing links are rejected", async () => {
  const ctx = setup();
  const reply = (await ctx.route(text("WATCH ME")))?.text ?? "";
  const token = /\/pair\/(\S+)/.exec(reply)![1]!;
  ctx.backend.clock += 10 * 60_000 + 1;
  const result = await ctx.api.pair({ pairingToken: token });
  assert.equal(result.status, 410);
  assert.equal(result.body.error, "pairing_expired");
});

test("location uploads move one profile in place and never create watches", async () => {
  const { backend, api, deviceToken } = await pairedDevice();
  const auth = `Bearer ${deviceToken}`;
  assert.equal((await api.location(auth, fix(backend.clock))).status, 200);
  backend.clock += 60_000;
  assert.equal((await api.location(auth, fix(backend.clock, { latitude: 42.3, accuracyMeters: 20 }))).status, 200);
  assert.equal(backend.profiles.length, 1);
  assert.equal(backend.watches.length, 0);
  assert.equal(backend.profiles[0]?.latitude, 42.3);
  assert.equal(backend.profiles[0]?.accuracyMeters, 20);
  assert.equal(backend.profiles[0]?.alertsEnabled, true);
  assert.equal(backend.devices[0]?.sharingEnabled, true);
});

test("location uploads require a valid bearer token and a good fix", async () => {
  const { backend, api, deviceToken } = await pairedDevice();
  assert.equal((await api.location(undefined, fix(backend.clock))).status, 401);
  assert.equal((await api.location(`Bearer ${deviceToken}x`, fix(backend.clock))).status, 401);
  const forged = `${deviceToken.split(".")[0]}.${"A".repeat(43)}`;
  assert.equal((await api.location(`Bearer ${forged}`, fix(backend.clock))).status, 401);
  const coarse = await api.location(`Bearer ${deviceToken}`, fix(backend.clock, { accuracyMeters: 900 }));
  assert.equal(coarse.status, 422);
  assert.equal(coarse.body.error, "location_invalid");
  assert.equal((await api.location(`Bearer ${deviceToken}`, { latitude: "1" })).status, 422);
  assert.equal(backend.profiles.length, 0);
});

test("STOP rejects further uploads; WATCH ME reuses the pairing without new setup", async () => {
  const { backend, route, api, deviceToken } = await pairedDevice();
  const auth = `Bearer ${deviceToken}`;
  await api.location(auth, fix(backend.clock));
  assert.equal((await route(text("STOP")))?.text, STOP_REPLY);
  assert.equal(backend.profiles[0]?.alertsEnabled, false);

  backend.clock += 60_000;
  const rejected = await api.location(auth, fix(backend.clock, { latitude: 43 }));
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error, "tracking_stopped");
  assert.equal(backend.profiles[0]?.latitude, 42.2808, "rejected upload does not move the profile");
  assert.equal((await api.status(auth)).body.trackingActive, false);

  assert.equal((await route(text("WATCH ME", "m-again")))?.text, TRACKING_RESUMED_REPLY);
  assert.equal(backend.pairingRows.length, 1, "no new pairing link");
  assert.equal(backend.profiles[0]?.alertsEnabled, true);
  assert.equal((await api.location(auth, fix(backend.clock, { latitude: 43 }))).status, 200);
  assert.equal(backend.profiles[0]?.latitude, 43);
});

test("PAIR issues a fresh link and replaces the old device", async () => {
  const { backend, route, api, deviceToken } = await pairedDevice();
  const reply = (await route(text("PAIR")))?.text ?? "";
  const token = /\/pair\/(\S+)/.exec(reply)![1]!;
  const second = await api.pair({ pairingToken: token });
  assert.equal(second.status, 201);
  assert.equal((await api.location(`Bearer ${deviceToken}`, fix(backend.clock))).status, 401);
  assert.equal((await api.location(`Bearer ${second.body.deviceToken}`, fix(backend.clock))).status, 200);
});

test("in-app sharing toggle and server-side revocation", async () => {
  const { backend, api, deviceToken, paired } = await pairedDevice();
  const auth = `Bearer ${deviceToken}`;
  assert.equal((await api.sharing(auth, { enabled: true })).body.sharingEnabled, true);
  assert.equal((await api.sharing(auth, { enabled: false })).body.sharingEnabled, false);
  assert.equal((await api.sharing(auth, { enabled: "yes" })).status, 422);
  const status = await api.status(auth);
  assert.equal(status.status, 200);
  assert.equal(status.body.deviceId, paired.body.deviceId);

  assert.equal((await api.revoke({ deviceId: paired.body.deviceId })).status, 200);
  assert.equal((await api.location(auth, fix(backend.clock))).status, 401);
  assert.equal((await api.status(auth)).status, 401);
  assert.equal((await api.revoke({ deviceId: "missing" })).status, 404);
});

test("STATUS reports live location from the app and uses the longer freshness window", async () => {
  const { backend, route, api, deviceToken } = await pairedDevice();
  await api.location(`Bearer ${deviceToken}`, fix(backend.clock));
  backend.clock += 2 * 60 * 60_000; // Stationary for 2 hours: past the 30-minute snapshot window.
  const status = (await route(text("STATUS")))?.text ?? "";
  assert.match(status, /Live location from the Sauron app, updated 2 hours ago/);
  await api.sharing(`Bearer ${deviceToken}`, { enabled: false });
  const stopped = (await route(text("STATUS", "s2")))?.text ?? "";
  assert.match(stopped, /out of date/);
  assert.match(stopped, /sharing is stopped in the app/);
});

test("WATCH ME without a configured pairing URL explains it is unavailable; HELP lists it", async () => {
  const store = new MemoryMessagingStore();
  const route = createCommandRouter({
    store, geocoder: { geocode: async () => { throw new Error("must not geocode"); } },
    radiusKm: 10, publicAppUrl: "https://downwind.example",
  });
  assert.equal((await route(text("WATCH ME")))?.text, MOBILE_UNAVAILABLE_REPLY);
  assert.match(HELP_REPLY, /WATCH ME/);
});

test("error codes map to HTTP statuses without leaking internals", () => {
  assert.deepEqual(errorResponse(new Error("SenderError: tracking_stopped: stopped")), {
    status: 403, body: { error: "tracking_stopped", message: "stopped" },
  });
  assert.equal(errorResponse(new Error("connection reset")).status, 502);
  assert.equal(errorResponse(new Error("connection reset")).body.message, "Location service is unavailable");
});

test("pair page hands the token to the app without redeeming it", () => {
  const token = "A".repeat(43);
  const html = pairPage(token, "https://photon.example/");
  assert.match(html, new RegExp(`sauron://pair\\?token=${token}&amp;api=https%3A%2F%2Fphoton\\.example"`));
  assert.equal(pairingUrl("https://photon.example/base/", token), `https://photon.example/base/pair/${token}`);
  assert.equal(hashToken("x").length, 64);
});
