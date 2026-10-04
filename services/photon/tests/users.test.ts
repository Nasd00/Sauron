import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandRouter, watchConfirmation, WATCH_NOT_FOUND_REPLY } from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";
import type { Geocoder } from "../src/types.js";
import { normalizePhone, parseRegistration, registerPhotonUser, RegistrationError, type SpectrumUserDirectory } from "../src/users.js";

const place = { label: "Ann Arbor, Washtenaw County, Michigan, United States", latitude: 42.2808, longitude: -83.743 };
const geocoder: Geocoder = { geocode: async query => query === "nowhere" ? null : place };

function fakeDirectory() {
  const calls: string[] = [];
  const sent: string[] = [];
  const directory: SpectrumUserDirectory = {
    user: async phone => { calls.push(`user:${phone}`); return { id: `imessage:${phone}` }; },
    space: { create: async user => {
      calls.push(`space:${user.id}`);
      return { id: "space-1", send: async text => { sent.push(text); } };
    } },
  };
  return { directory, calls, sent };
}

test("normalizes and validates E.164 phone numbers", () => {
  assert.equal(normalizePhone("  +15551234567 "), "+15551234567");
  assert.throws(() => normalizePhone("5551234567"), RegistrationError);
  assert.throws(() => normalizePhone("+"), /E.164/);
});

test("registers a user, creates their watch, and texts a confirmation", async () => {
  const { directory, calls, sent } = fakeDirectory();
  const store = new MemoryMessagingStore();
  const result = await registerPhotonUser(directory, { phone: "+15551234567", place: " Ann Arbor " }, {
    geocoder, store, radiusKm: 10, now: () => 1000, id: () => "watch-1",
  });
  const watch = {
    id: "watch-1", spaceId: "space-1", senderId: "imessage:+15551234567", placeLabel: place.label,
    latitude: place.latitude, longitude: place.longitude, radiusKm: 10, active: true, createdAt: 1000,
  };
  assert.deepEqual(result, { phone: "+15551234567", spaceId: "space-1", watch });
  assert.deepEqual(calls, ["user:+15551234567", "space:imessage:+15551234567"]);
  assert.deepEqual(store.watches, [watch]);
  assert.deepEqual(sent, [watchConfirmation(watch)]);
});

test("a registered watch answers to the user's later STATUS and STOP texts", async () => {
  const { directory } = fakeDirectory();
  const store = new MemoryMessagingStore();
  await registerPhotonUser(directory, { phone: "+15551234567", place: "Ann Arbor" }, { geocoder, store, radiusKm: 10 });
  const route = createCommandRouter({
    store, geocoder, radiusKm: 10, publicAppUrl: "https://example.test",
  });
  const text = (body: string) => ({
    messageId: body, spaceId: "space-1", senderId: "imessage:+15551234567",
    receivedAt: "2026-10-04T18:00:00.000Z", content: { type: "text" as const, text: body },
  });
  const status = await route(text("STATUS"));
  assert.match(status?.text ?? "", /I don’t have a location for you/);
  assert.match(status?.text ?? "", new RegExp(`Also watching ${place.label} within 10 km`));
  await route(text("STOP"));
  assert.equal(store.watches.filter(watch => watch.active).length, 0);
});

test("invalid input is rejected before Spectrum is called", async () => {
  const { directory, calls } = fakeDirectory();
  const store = new MemoryMessagingStore();
  const options = { geocoder, store, radiusKm: 10 };
  await assert.rejects(registerPhotonUser(directory, { phone: "555", place: "Ann Arbor" }, options), RegistrationError);
  await assert.rejects(registerPhotonUser(directory, { phone: "+15551234567", place: "  " }, options), /place is required/);
  await assert.rejects(
    registerPhotonUser(directory, { phone: "+15551234567", place: "nowhere" }, options),
    { message: WATCH_NOT_FOUND_REPLY },
  );
  assert.deepEqual(calls, []);
  assert.equal(store.watches.length, 0);
});

test("a point picked on the web globe registers without geocoding, with its own radius", async () => {
  const { directory, calls } = fakeDirectory();
  const store = new MemoryMessagingStore();
  const geocoded: string[] = [];
  const input = parseRegistration({ phone: "+15551234567", latitude: 42.28, longitude: -83.74, label: "Grandma's house", radiusKm: 2.5 });
  const result = await registerPhotonUser(directory, input, {
    geocoder: { geocode: async query => { geocoded.push(query); return null; } }, store, radiusKm: 10,
  });
  assert.deepEqual(geocoded, []);
  assert.equal(calls.length, 2, "user lookup and conversation");
  assert.deepEqual([result.watch.placeLabel, result.watch.latitude, result.watch.longitude, result.watch.radiusKm],
    ["Grandma's house", 42.28, -83.74, 2.5]);
});

test("registration bodies are validated", () => {
  assert.deepEqual(parseRegistration({ phone: "+15551234567", place: "Ann Arbor" }), { phone: "+15551234567", place: "Ann Arbor" });
  assert.throws(() => parseRegistration({ phone: "+15551234567" }), /place, or latitude/);
  assert.throws(() => parseRegistration({ phone: "+1", latitude: 95, longitude: 0, label: "x" }), /valid coordinates/);
  assert.throws(() => parseRegistration({ phone: "+1", latitude: 42, longitude: -83 }), /label is required/);
  assert.throws(() => parseRegistration({ phone: "+1", place: "x", radiusKm: 500 }), /radiusKm/);
  assert.throws(() => parseRegistration([]), RegistrationError);
});
