import assert from "node:assert/strict";
import { test } from "node:test";
import type { Geocoder, InboundMessage } from "../src/types.js";
import {
  createCommandRouter, HELP_REPLY, UNKNOWN_REPLY,
} from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";

// These tests lock in the deterministic top-level routing guarantee: STOP,
// STATUS, HELP, and exact WATCH must short-circuit before any fallback or
// future model/intent-classifier call. If a later change introduces an LLM,
// these control commands must continue to resolve deterministically here.

const place = { label: "Ann Arbor, Washtenaw County, Michigan, United States", latitude: 42.2808, longitude: -83.743 };
const geocoder: Geocoder = { geocode: async query => (query === "nowhere" ? null : place) };

const textMessage = (text: string, messageId = "message-1"): InboundMessage => ({
  messageId,
  spaceId: "space-1",
  senderId: "sender-1",
  receivedAt: "2026-10-03T18:00:00.000Z",
  content: { type: "text", text },
});

function freshRouter() {
  const store = new MemoryMessagingStore();
  let nextId = 0;
  const route = createCommandRouter({
    store, geocoder, radiusKm: 10, now: () => 1000, id: () => `watch-${++nextId}`,
  });
  return { store, route };
}

test("control commands are case-insensitive and whitespace-tolerant", async () => {
  for (const variant of ["STOP", "stop", "  Stop  ", "sToP"]) {
    const { route } = freshRouter();
    assert.equal(
      await route(textMessage(variant)),
      "Alerts stopped. Send WATCH <place> to subscribe again.",
      `STOP variant failed: ${JSON.stringify(variant)}`,
    );
  }
  for (const variant of ["HELP", "help", " help "]) {
    const { route } = freshRouter();
    assert.equal(await route(textMessage(variant)), HELP_REPLY, `HELP variant failed: ${JSON.stringify(variant)}`);
  }
});

test("identical input yields identical output across repeated calls (no nondeterminism)", async () => {
  const inputs = ["HELP", "STATUS", "STOP", "WATCH Ann Arbor", "ramble about wildfire smoke"];
  for (const input of inputs) {
    const first = freshRouter();
    const second = freshRouter();
    assert.equal(
      await first.route(textMessage(input)),
      await second.route(textMessage(input)),
      `nondeterministic output for ${JSON.stringify(input)}`,
    );
  }
});

test("control commands win: exact STOP/STATUS/HELP never fall through to WATCH or fallback", async () => {
  // Exact control words must not be treated as free text, even though the
  // fallback (UNKNOWN_REPLY) would otherwise claim any unrecognized input.
  const { route } = freshRouter();
  assert.notEqual(await route(textMessage("HELP")), UNKNOWN_REPLY);
  assert.notEqual(await route(textMessage("STATUS")), UNKNOWN_REPLY);
  assert.notEqual(await route(textMessage("STOP")), UNKNOWN_REPLY);
});

test("a word that merely contains a command is not treated as that command", async () => {
  // "HELPER" / "STOPWATCH" must not trigger HELP/STOP; they are free text and
  // fall through to the deterministic fallback (no watch is created).
  const { store, route } = freshRouter();
  assert.equal(await route(textMessage("HELPER")), UNKNOWN_REPLY);
  assert.equal(await route(textMessage("STOPWATCH")), UNKNOWN_REPLY);
  assert.equal(store.watches.length, 0);
});

test("WATCH with a place is recognized; bare STATUS before any watch is deterministic", async () => {
  const { route } = freshRouter();
  assert.equal(await route(textMessage("STATUS")), "No active watch. Send WATCH <place> to subscribe.");
  const reply = await route(textMessage("WATCH Ann Arbor"));
  assert.match(reply ?? "", /^Watching Ann Arbor/);
  assert.equal(await route(textMessage("STATUS")), `Watching ${place.label} within 10 km.`);
});

test("non-text content never routes to a command", async () => {
  const { route } = freshRouter();
  const attachment: InboundMessage = {
    ...textMessage("ignored"),
    content: { type: "attachment", name: "photo.jpg", mimeType: "image/jpeg" },
  };
  assert.equal(await route(attachment), undefined);
});
