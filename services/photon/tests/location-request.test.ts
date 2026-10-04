import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserAlertProfile } from "@tempmhacks/shared";
import { APPLE_MAPS_SHARE_HINT, createCommandRouter, formatAge, NO_LOCATION_REPLIES } from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";
import type { Geocoder, InboundMessage } from "../src/types.js";

const geocoder: Geocoder = { geocode: async () => null };
const publicAppUrl = "https://downwind.example";
const FRESHNESS_MS = 30 * 60 * 1000;
const APPLE_MAPS_CURRENT =
  "https://maps.apple.com/place?address=1%20Main%20St,%20Brighton,%20MI%2048116,%20United%20States&coordinate=42.509770,-83.730130&name=My%20Location&map=explore";
const APPLE_MAPS_PLACE =
  "https://maps.apple.com/place?address=500%20S%20State%20St,%20Ann%20Arbor&coordinate=42.2808,-83.7430&name=University%20of%20Michigan";

const text = (value: string, messageId = "m1"): InboundMessage => ({
  messageId, spaceId: "space-1", senderId: "sender-1",
  receivedAt: "2026-10-03T18:00:00.000Z", content: { type: "text", text: value },
});
const other = (shareKind: "find_my" | "maps_balloon"): InboundMessage => ({
  ...text("unused"), content: { type: "other", shareKind },
});
const profile = (overrides: Partial<UserAlertProfile> = {}): UserAlertProfile => ({
  userId: "sender-1", spaceId: "space-1", senderId: "sender-1",
  latitude: 42.28, longitude: -83.74, locationUpdatedAt: 1_000_000,
  radiusKm: 16, alertsEnabled: true, createdAt: 1_000_000, updatedAt: 1_000_000, ...overrides,
});
const router = (store: MemoryMessagingStore, now = () => 2_000_000) =>
  createCommandRouter({ store, geocoder, radiusKm: 16, publicAppUrl, now });

test("Apple Maps 'My Location' share: explicit received confirmation naming current location", async () => {
  const store = new MemoryMessagingStore();
  const reply = (await router(store)(text(APPLE_MAPS_CURRENT)))?.text ?? "";
  assert.match(reply, /^✅ Location received\. I saved your current location \(near 1 Main St\)\./);
  assert.match(reply, /within ~10 mi/);
  assert.match(reply, /one-time snapshot, not live tracking/);
  assert.equal(store.profiles[0]?.latitude, 42.50977);
  assert.equal(store.profiles[0]?.alertsEnabled, true);
});

test("Apple Maps searched-place share is saved as that place, not current location", async () => {
  const store = new MemoryMessagingStore();
  const reply = (await router(store)(text(APPLE_MAPS_PLACE)))?.text ?? "";
  assert.match(reply, /I saved the place you shared: University of Michigan\./);
  assert.equal(store.profiles[0]?.latitude, 42.2808);
});

test("re-sharing after STOP says alerts are back on", async () => {
  const store = new MemoryMessagingStore();
  await store.upsertProfile(profile({ alertsEnabled: false }));
  const reply = (await router(store)(text(APPLE_MAPS_CURRENT)))?.text ?? "";
  assert.match(reply, /your alerts are back on/);
});

test("Find My and Maps balloons get an explicit 'no location received' reply and save nothing", async () => {
  const store = new MemoryMessagingStore();
  const route = router(store);
  assert.equal((await route(other("find_my")))?.text, NO_LOCATION_REPLIES.find_my);
  assert.equal((await route(other("maps_balloon")))?.text, NO_LOCATION_REPLIES.maps_balloon);
  assert.match(NO_LOCATION_REPLIES.find_my, /^❌ No location received\./);
  assert.equal(store.profiles.length, 0);
});

test("short map links and links without coordinates get an explicit 'no location received' reply", async () => {
  const store = new MemoryMessagingStore();
  const route = router(store);
  assert.equal((await route(text("https://maps.app.goo.gl/AbC123")))?.text, NO_LOCATION_REPLIES.short_link);
  assert.equal(
    (await route(text("https://maps.apple.com/place?name=Somewhere")))?.text,
    NO_LOCATION_REPLIES.no_coordinates,
  );
  assert.equal(store.profiles.length, 0);
});

test("onboarding and HELP tell the user how to share from Apple Maps", async () => {
  const store = new MemoryMessagingStore();
  const route = router(store);
  const welcome = (await route(text("hi")))?.text ?? "";
  assert.match(welcome, /I don’t have your location yet/);
  assert.ok(welcome.includes(APPLE_MAPS_SHARE_HINT));
  assert.ok(((await route(text("HELP")))?.text ?? "").includes(APPLE_MAPS_SHARE_HINT));
});

test("STATUS states whether a location is on file and how old it is", async () => {
  const none = new MemoryMessagingStore();
  assert.match((await router(none)(text("STATUS")))?.text ?? "", /I don’t have a location for you/);

  const fresh = new MemoryMessagingStore();
  await fresh.upsertProfile(profile());
  const freshReply = (await router(fresh, () => 1_000_000 + 12 * 60_000)(text("STATUS")))?.text ?? "";
  assert.match(freshReply, /Location received 12 minutes ago\. Monitoring within ~10 mi\./);

  const stale = new MemoryMessagingStore();
  await stale.upsertProfile(profile());
  const staleReply = (await router(stale, () => 1_000_000 + FRESHNESS_MS + 60 * 60_000)(text("STATUS")))?.text ?? "";
  assert.match(staleReply, /received 1 hour ago and is out of date/);
});

test("formatAge produces readable ages", () => {
  assert.equal(formatAge(10_000), "just now");
  assert.equal(formatAge(60_000), "1 minute ago");
  assert.equal(formatAge(3 * 60 * 60_000), "3 hours ago");
  assert.equal(formatAge(2 * 24 * 60 * 60_000), "2 days ago");
});
