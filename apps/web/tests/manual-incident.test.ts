import assert from "node:assert/strict";
import { test } from "node:test";
import type { Incident, IncidentView, UserAlertProfile, Watch } from "@tempmhacks/shared";
import { escapePlan, estimateReach, summarizeDangers } from "../src/danger.js";
import { LiveState } from "../src/live-state.js";
import { reportIncident, resolveIncidentViaPhoton, transitionIncidentViaPhoton } from "../src/photon-client.js";

const KM = 6371.0088 * Math.PI / 180;
const manual: IncidentView = {
  id: "manual-1", cameraId: "manual", type: "flood", status: "confirmed", confidence: 1,
  latitude: 0, longitude: 0, firstSeenAt: 1, lastSeenAt: 1, confirmedAt: 1,
  report: { incidentId: "manual-1", title: "River flooding", description: "", radiusKm: 2, reportedBy: "op", reportedAt: 1 },
};

test("reach counts each person once when their area overlaps the zone", () => {
  const watch = (senderId: string, km: number): Watch => ({
    id: `w-${senderId}`, spaceId: "s", senderId, placeLabel: "p", latitude: km / KM, longitude: 0, radiusKm: 1, active: true, createdAt: 0,
  });
  const profile = (senderId: string, km: number, alertsEnabled = true): UserAlertProfile => ({
    userId: `u-${senderId}`, spaceId: "s", senderId, latitude: km / KM, longitude: 0, locationUpdatedAt: 0, radiusKm: 1,
    alertsEnabled, createdAt: 0, updatedAt: 0,
  });
  assert.equal(estimateReach({ latitude: 0, longitude: 0 }, 2,
    [watch("a", 2.5), watch("b", 3.5)], [profile("a", 0), profile("c", 2.9), profile("d", 0, false)]), 2);
});

test("dangers say who is inside a zone, and the way out heads away from it", () => {
  const camera: IncidentView = { ...manual, id: "cam", cameraId: "cam-1", type: "smoke_fire", report: undefined, latitude: 1 };
  const from = { latitude: -1 / KM, longitude: 0 }; // 1 km south of the flood
  const [first, second] = summarizeDangers([camera, manual], from);
  assert.deepEqual([first!.id, first!.insideDangerZone, first!.source, first!.what], ["manual-1", true, "operator report", "River flooding (flooding)"]);
  assert.equal(second!.source, "camera");
  const plan = escapePlan([manual], from)!;
  assert.equal(plan.head, "south");
  assert.ok(Math.abs(plan.safePoint.latitude * KM + 3) < 0.05, "1 km past the 2 km edge");
  assert.equal(plan.kmToSafety, 2);
});

test("live state joins reports onto incidents", () => {
  const state = new LiveState();
  const { report, ...incident } = manual;
  state.update("incidents", incident as Incident);
  state.update("reports", report!);
  assert.deepEqual(state.confirmedViews(), [manual]);
  state.update("reports", report!, true);
  assert.equal(state.view("manual-1")?.report, undefined);
});

test("reportIncident and resolve post to Photon with the operator key", async () => {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetcher = (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ incident: { id: "manual-9" } }), { status: 201 });
  }) as typeof fetch;
  const request = { type: "flood", latitude: 1, longitude: 2, radiusKm: 2, title: "Flood", description: "" };
  assert.deepEqual(await reportIncident("https://photon.example", "k", request, fetcher), { ok: true, incidentId: "manual-9" });
  assert.deepEqual(await resolveIncidentViaPhoton("https://photon.example", "k", "manual-9", fetcher), { ok: true });
  assert.deepEqual(await transitionIncidentViaPhoton("https://photon.example", "k", "cam-9", "confirm", fetcher), { ok: true });
  assert.deepEqual(calls, [
    { url: "https://photon.example/admin/incidents", auth: "Bearer k", body: { ...request, reportedBy: "web operator" } },
    { url: "https://photon.example/admin/incidents/resolve", auth: "Bearer k", body: { id: "manual-9" } },
    { url: "https://photon.example/admin/incidents/confirm", auth: "Bearer k", body: { id: "cam-9" } },
  ]);
  const denied = await reportIncident("https://p.example", "bad", request, (async () => new Response("{}", { status: 401 })) as typeof fetch);
  assert.equal(denied.ok === false && denied.reason, "unauthorized");
});
