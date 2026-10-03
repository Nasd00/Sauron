import assert from "node:assert/strict";
import { test } from "node:test";
import type { Geocoder, InboundMessage, StructuredLogger } from "../src/types.js";
import { createMessageProcessor } from "../src/processor.js";
import {
  createCommandRouter, HELP_REPLY, UNKNOWN_REPLY, WATCH_FORMAT_REPLY, WATCH_NOT_FOUND_REPLY,
} from "../src/router.js";
import { MemoryMessagingStore } from "../src/store.js";

const place = { label: "Ann Arbor, Washtenaw County, Michigan, United States", latitude: 42.2808, longitude: -83.743 };
const geocoder: Geocoder = { geocode: async query => query === "nowhere" ? null : place };
const textMessage = (text: string, messageId = "message-1"): InboundMessage => ({
  messageId,
  spaceId: "space-1",
  senderId: "sender-1",
  receivedAt: "2026-10-03T18:00:00.000Z",
  content: { type: "text", text },
});

test("WATCH creates one active watch, confirms it, and a second WATCH replaces it", async () => {
  const store = new MemoryMessagingStore();
  let nextId = 0;
  const route = createCommandRouter({ store, geocoder, radiusKm: 12, now: () => 1000, id: () => `watch-${++nextId}` });
  assert.equal(await route(textMessage("watch Ann Arbor")),
    "Watching Ann Arbor, Washtenaw County, Michigan, United States within 12 km. I’ll message you if a verified incident affects this area. Reply STATUS, STOP, or HELP anytime.");
  assert.equal(store.watches.length, 1);
  assert.deepEqual(store.watches[0], {
    id: "watch-1", spaceId: "space-1", senderId: "sender-1", placeLabel: place.label,
    latitude: place.latitude, longitude: place.longitude, radiusKm: 12, active: true, createdAt: 1000,
  });
  await route(textMessage("WATCH Detroit", "message-2"));
  assert.equal(store.watches.length, 2);
  assert.equal(store.watches[0]?.active, false);
  assert.equal(store.watches[1]?.active, true);
});

test("WATCH validation is deterministic and creates no watch on errors", async () => {
  const store = new MemoryMessagingStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 10 });
  assert.equal(await route(textMessage("WATCH")), WATCH_FORMAT_REPLY);
  assert.equal(await route(textMessage("WATCH nowhere")), WATCH_NOT_FOUND_REPLY);
  assert.equal(store.watches.length, 0);
});

test("router handles STOP, STATUS, HELP, then WATCH, then fallback", async () => {
  const store = new MemoryMessagingStore();
  const route = createCommandRouter({ store, geocoder, radiusKm: 10, id: () => "watch-1", now: () => 1000 });
  assert.equal(await route(textMessage("STATUS")), "No active watch. Send WATCH <place> to subscribe.");
  assert.equal(await route(textMessage("HELP")), HELP_REPLY);
  assert.equal(await route(textMessage("tell me about smoke")), UNKNOWN_REPLY);
  await route(textMessage("WATCH Ann Arbor"));
  assert.equal(await route(textMessage("status")), `Watching ${place.label} within 10 km.`);
  assert.equal(await route(textMessage("stop")), "Alerts stopped. Send WATCH <place> to subscribe again.");
  assert.equal(await route(textMessage("STOP")), "Alerts stopped. Send WATCH <place> to subscribe again.");
  assert.equal(store.watches.filter(watch => watch.active).length, 0);
});

test("dedupe happens before reply or command side effects", async () => {
  const store = new MemoryMessagingStore();
  const entries: Record<string, unknown>[] = [];
  const logger: StructuredLogger = {
    info: fields => { entries.push(fields); },
    error: fields => { entries.push(fields); },
  };
  const route = createCommandRouter({ store, geocoder, radiusKm: 10, id: () => "watch-1", now: () => 1000 });
  const process = createMessageProcessor({ store, route, logger });
  const replies: string[] = [];
  const message = textMessage("WATCH Ann Arbor");
  await process(message, async reply => { replies.push(reply); });
  await process(message, async reply => { replies.push(reply); });
  assert.equal(replies.length, 1);
  assert.equal(store.watches.length, 1);
  assert.equal(entries[1]?.deduped, true);
  assert.match(String(entries[0]?.senderHash), /^[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(entries).includes("sender-1"), false);
});

test("attachments are claimed and recorded without a reply", async () => {
  const store = new MemoryMessagingStore();
  const entries: Record<string, unknown>[] = [];
  const process = createMessageProcessor({
    store,
    route: createCommandRouter({ store, geocoder, radiusKm: 10 }),
    logger: { info: fields => { entries.push(fields); }, error: fields => { entries.push(fields); } },
  });
  let replies = 0;
  await process({
    ...textMessage("unused"),
    content: { type: "attachment", name: "photo.jpg", mimeType: "image/jpeg" },
  }, async () => { replies += 1; });
  assert.equal(replies, 0);
  assert.equal(entries[0]?.processingResult, "unsupported_content");
});
