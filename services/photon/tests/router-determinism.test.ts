import assert from "node:assert/strict";
import { test } from "node:test";
import type { Geocoder, InboundMessage } from "../src/types.js";
import {
  createCommandRouter, STOP_REPLY, UNKNOWN_REPLY,
} from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";

// These tests lock in the deterministic top-level routing guarantee: STOP,
// STATUS, HELP, and exact WATCH must short-circuit before any fallback or
// future model/intent-classifier call. If a later change introduces an LLM,
// these control commands must continue to resolve deterministically here.

const place = { label: "Ann Arbor, Washtenaw County, Michigan, United States", latitude: 42.2808, longitude: -83.743 };
const geocoder: Geocoder = { geocode: async query => (query === "nowhere" ? null : place) };
const publicAppUrl = "https://downwind.example";

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
    store, geocoder, radiusKm: 10, publicAppUrl, now: () => 1000, id: () => `watch-${++nextId}`,
  });
  const replyText = async (message: InboundMessage) => (await route(message))?.text;
  return { store, route, replyText };
}

test("control commands are case-insensitive and whitespace-tolerant", async () => {
  for (const variant of ["STOP", "stop", "  Stop  ", "sToP"]) {
    const { replyText } = freshRouter();
    assert.equal(
      await replyText(textMessage(variant)),
      STOP_REPLY,
      `STOP variant failed: ${JSON.stringify(variant)}`,
    );
  }
  for (const variant of ["HELP", "help", " help "]) {
    const { replyText } = freshRouter();
    assert.match(
      (await replyText(textMessage(variant))) ?? "",
      /^I alert you about verified incidents/,
      `HELP variant failed: ${JSON.stringify(variant)}`,
    );
  }
});

test("identical input yields identical output across repeated calls (no nondeterminism)", async () => {
  const inputs = ["HELP", "STATUS", "STOP", "WATCH Ann Arbor", "ramble about wildfire smoke"];
  for (const input of inputs) {
    const first = freshRouter();
    const second = freshRouter();
    assert.equal(
      await first.replyText(textMessage(input)),
      await second.replyText(textMessage(input)),
      `nondeterministic output for ${JSON.stringify(input)}`,
    );
  }
});

test("control commands win: exact STOP/STATUS/HELP never fall through to WATCH or fallback", async () => {
  const { replyText } = freshRouter();
  assert.notEqual(await replyText(textMessage("HELP")), UNKNOWN_REPLY);
  assert.notEqual(await replyText(textMessage("STATUS")), UNKNOWN_REPLY);
  assert.notEqual(await replyText(textMessage("STOP")), UNKNOWN_REPLY);
});

test("a word that merely contains a command is not treated as that command", async () => {
  // "HELPER" / "STOPWATCH" must not trigger HELP/STOP; they are free text. With no
  // profile, the fallback onboards the sender (prompting them to share location)
  // and creates no watch.
  const { store, replyText } = freshRouter();
  assert.match((await replyText(textMessage("HELPER"))) ?? "", /^Welcome!/);
  assert.match((await replyText(textMessage("STOPWATCH"))) ?? "", /^Welcome!/);
  assert.equal(store.watches.length, 0);
});

test("WATCH with a place is recognized; bare STATUS before any watch is deterministic", async () => {
  const { replyText } = freshRouter();
  assert.match((await replyText(textMessage("STATUS"))) ?? "", /I don’t have a location for you/);
  const reply = await replyText(textMessage("WATCH Ann Arbor"));
  assert.match(reply ?? "", /^Watching Ann Arbor/);
  assert.match((await replyText(textMessage("STATUS"))) ?? "", new RegExp(`Also watching ${place.label} within 10 km\\.`));
});

test("non-text content never routes to a command", async () => {
  const { route } = freshRouter();
  const attachment: InboundMessage = {
    ...textMessage("ignored"),
    content: { type: "attachment", name: "photo.jpg", mimeType: "image/jpeg" },
  };
  assert.equal(await route(attachment), undefined);
});
