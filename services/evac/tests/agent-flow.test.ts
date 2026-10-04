import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Participant } from "@tempmhacks/shared/evac";
import { EvacAgent, type Messenger } from "../src/agent/agent.js";
import { annArborScenario } from "../src/scenario/ann-arbor.js";
import { RouteCache, ValhallaRouter } from "../src/sources/routing.js";
import { pathIntersectsPolygon } from "../src/domain/geo.js";

const seed = fileURLToPath(new URL("../fixtures/route-cache.json", import.meta.url));

function harness() {
  let now = Date.UTC(2026, 9, 3, 19, 30);
  const sent: { to: string; text: string }[] = [];
  const timers: { callback: () => void; at: number; cancelled: boolean }[] = [];
  const messenger: Messenger = { deliver: async (participant: Participant, text) => { sent.push({ to: participant.id, text }); } };
  const agent = new EvacAgent({
    scenario: annArborScenario,
    // Offline: only the committed seed cache is used, so the test is deterministic and needs no network.
    router: new ValhallaRouter({ cache: new RouteCache({ seedPaths: [seed] }), offline: true }),
    messenger,
    clock: () => now,
    schedule: (callback, delay) => {
      const timer = { callback, at: now + delay, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    helperTimeoutMs: 120_000,
  });
  const inbox = (id: string) => sent.filter(m => m.to === id).map(m => m.text);
  const last = (id: string) => inbox(id).at(-1) ?? "";
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers) if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.callback(); }
    await agent.idle();
  };
  return { agent, sent, inbox, last, advance };
}

test("evacuation demo: warning → intake → ride consent → helper confirms → closure reroute → arrival", async () => {
  const { agent, inbox, last } = harness();

  await agent.issueWarning();
  assert.match(last("resident-alex"), /OFFICIAL WARNING: Evacuation Immediate/);
  assert.match(last("resident-alex"), /"Leave now\./);
  assert.match(last("resident-alex"), /call 911/);

  await agent.handleInbound("resident-alex", "We’re three people. My dad uses a wheelchair, and we don’t have a car.");
  const [list, offer] = inbox("resident-alex").slice(-2);
  assert.match(list!, /3 people · dad \(wheelchair\) · no vehicle/);
  assert.match(list!, /1\. Huron High School: 8 min \(5\.8 km\) via Barton Drive, Plymouth Road, Murfin Avenue/);
  assert.match(list!, /2\. Washtenaw Community College/);
  assert.doesNotMatch(list!, /Skyline/, "shelter inside the order area is never offered");
  assert.match(offer!, /Maya, an enrolled volunteer driver with a wheelchair-accessible van/);
  assert.match(offer!, /Reply YES/);
  assert.equal(inbox("helper-maya").length, 0, "nothing is shared before permission");

  await agent.handleInbound("resident-alex", "yes please");
  assert.match(last("helper-maya"), /TRANSPORT REQUEST/);
  assert.match(last("helper-maya"), /3 people · dad \(wheelchair\) · no vehicle/);
  assert.match(last("helper-maya"), /Drop-off: Huron High School/);
  assert.equal(inbox("helper-jordan").length, 0, "sedan driver is never asked for a wheelchair user");

  await agent.handleInbound("helper-maya", "Accept");
  assert.match(last("resident-alex"), /Confirmed: Maya is on the way/);
  assert.match(last("helper-maya"), /Text PICKED UP/);
  let snapshot = agent.snapshot();
  assert.equal(snapshot.arrangements[0]!.status, "confirmed");
  const before = snapshot.arrangements[0]!.tripRoute;
  const closure = annArborScenario().closureLibrary[0]!;
  assert.ok(pathIntersectsPolygon(before.geometry, closure.area), "baseline route uses Huron Pkwy");

  await agent.injectClosure("closure-huron-pkwy");
  assert.match(last("resident-alex"), /ROUTE UPDATE: Huron Pkwy closed/);
  assert.match(last("resident-alex"), /Maya has the new route to Huron High School: now via Bonisteel Boulevard instead of Hubbard Road, Huron Parkway/);
  assert.match(last("helper-maya"), /ROUTE CHANGE: Huron Pkwy closed/);
  assert.match(last("helper-maya"), /Bonisteel Boulevard/);
  snapshot = agent.snapshot();
  const after = snapshot.arrangements[0]!.tripRoute;
  assert.equal(pathIntersectsPolygon(after.geometry, closure.area), false, "new route avoids the closure");
  assert.ok(after.durationMin > before.durationMin);
  assert.equal(snapshot.households[0]!.activeRoute!.id, after.id);

  await agent.handleInbound("helper-maya", "picked up");
  assert.match(last("resident-alex"), /everyone is aboard/);
  await agent.handleInbound("helper-maya", "arrived");
  assert.match(last("resident-alex"), /You've arrived at Huron High School/);
  assert.match(last("resident-alex"), /dad \(wheelchair\)/);

  snapshot = agent.snapshot();
  const arrangement = snapshot.arrangements[0]!;
  assert.deepEqual(arrangement.history.map(h => h.status),
    ["awaiting_consent", "requested", "confirmed", "confirmed", "picked_up", "arrived"]);
  assert.equal(snapshot.households[0]!.stage, "complete");
  assert.equal(snapshot.helpers.find(h => h.id === "maya")!.status, "available");
  assert.equal(snapshot.shelters.find(s => s.id === "shelter-huron-hs")!.occupied, 115);
  assert.deepEqual([...new Set(snapshot.timeline.map(e => e.kind))],
    ["warning", "intake", "destination", "consent", "request", "confirmed", "closure", "reroute", "checkin"]);
});

test("asks for missing details before planning", async () => {
  const { agent, last } = harness();
  await agent.issueWarning();
  await agent.handleInbound("resident-alex", "my mom uses a walker");
  assert.match(last("resident-alex"), /How many people are leaving with you/);
  assert.match(last("resident-alex"), /Do you have a car/);
  await agent.handleInbound("resident-alex", "2 of us, and we have a car");
  assert.match(last("resident-alex"), /Reply 1, 2, or 3/);
  await agent.handleInbound("resident-alex", "1");
  assert.match(last("resident-alex"), /Route to Huron High School/);
  await agent.injectClosure("closure-huron-pkwy");
  assert.match(last("resident-alex"), /ROUTE UPDATE/);
  assert.match(last("resident-alex"), /openstreetmap\.org\/directions/);
});

test("escalates to the next eligible helper on decline and on timeout", async () => {
  const { agent, last, inbox, advance } = harness();
  await agent.issueWarning();
  await agent.handleInbound("resident-alex", "We're three people. My dad uses a wheelchair, and we don't have a car.");
  await agent.handleInbound("resident-alex", "yes");
  await agent.handleInbound("helper-maya", "decline");
  assert.match(last("helper-luis"), /TRANSPORT REQUEST/);
  assert.match(last("resident-alex"), /Maya can't make it\. I've asked Luis/);
  await advance(121_000);
  assert.match(last("helper-luis"), /passed this request to another driver/);
  assert.match(last("resident-alex"), /Call 211/);
  const arrangement = agent.snapshot().arrangements[0]!;
  assert.equal(arrangement.status, "unfilled");
  assert.deepEqual(arrangement.requestedHelperIds, ["maya", "luis"]);
  assert.equal(inbox("helper-jordan").length, 0);
});

test("camera-confirmed incidents on an active route become verified closures", async () => {
  const { agent, last } = harness();
  await agent.issueWarning();
  await agent.handleInbound("resident-alex", "We're three people. My dad uses a wheelchair, and we don't have a car.");
  await agent.handleInbound("resident-alex", "yes");
  await agent.handleInbound("helper-maya", "accept");
  const far = { id: "inc-far", cameraId: "cam-x", location: { latitude: 42.2, longitude: -83.6 }, confidence: 0.9, status: "confirmed" };
  const onRoute = { id: "inc-on", cameraId: "demo-camera-002", location: { latitude: 42.2905, longitude: -83.7046 }, confidence: 0.86, status: "confirmed" };
  await agent.setIncidents([far]);
  assert.equal(agent.snapshot().closures.length, 0);
  await agent.setIncidents([far, onRoute]);
  const [closure] = agent.snapshot().closures;
  assert.equal(closure!.verifiedBy[0]!.kind, "gods_eye");
  assert.match(last("resident-alex"), /Verified by: God's Eye camera demo-camera-002/);
});
