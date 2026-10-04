import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMessage } from "@tempmhacks/shared/text";
import { createMessageProcessor } from "../src/processor.js";
import { createCommandRouter, HELP_REPLY, NO_LOCATION_REPLIES } from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";
import type { InboundMessage } from "../src/types.js";

test("short text is sent as one message", () => {
  assert.deepEqual(splitMessage("Alerts are on for your area."), ["Alerts are on for your area."]);
  assert.deepEqual(splitMessage("   "), []);
});

test("long text splits at paragraph breaks and stays under the limit", () => {
  const a = "A".repeat(120);
  const b = "B".repeat(120);
  assert.deepEqual(splitMessage(`${a}\n\n${b}`), [a, b]);
});

test("short paragraphs are packed together when they fit", () => {
  assert.deepEqual(splitMessage(`${"x".repeat(150)}\n\nshort\n\n${"y".repeat(150)}`, 200),
    [`${"x".repeat(150)}\n\nshort`, "y".repeat(150)]);
});

test("an oversized paragraph splits at line breaks, never mid-line", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(60));
  const chunks = splitMessage(lines.join("\n"), 130);
  assert.deepEqual(chunks, [`${lines[0]}\n${lines[1]}`, `${lines[2]}\n${lines[3]}`, lines[4]]);
  const longUrl = `https://example.com/${"p".repeat(300)}`;
  assert.deepEqual(splitMessage(longUrl, 200), [longUrl]); // a single long line stays intact
});

test("HELP and no-location replies split into two readable messages", () => {
  const help = splitMessage(HELP_REPLY);
  assert.equal(help.length, 2);
  assert.match(help[0]!, /^I alert you about verified incidents/);
  assert.match(help[1]!, /^STATUS/);
  const noLocation = splitMessage(NO_LOCATION_REPLIES.maps_balloon);
  assert.equal(noLocation.length, 2);
  assert.match(noLocation[0]!, /^❌ No location received\./);
  assert.match(noLocation[1]!, /^To share your location: open Apple Maps/);
});

test("processor sends a long reply as ordered chunks", async () => {
  const store = new MemoryMessagingStore();
  const route = createCommandRouter({
    store, geocoder: { geocode: async () => null }, radiusKm: 10, publicAppUrl: "https://downwind.example",
  });
  const process = createMessageProcessor({ store, route, logger: { info: () => {}, error: () => {} } });
  const replies: string[] = [];
  const message: InboundMessage = {
    messageId: "m1", spaceId: "space-1", senderId: "sender-1",
    receivedAt: "2026-10-03T18:00:00.000Z", content: { type: "text", text: "HELP" },
  };
  await process(message, async text => { replies.push(text); });
  assert.deepEqual(replies, splitMessage(HELP_REPLY));
  assert.equal(replies.length, 2);
});
