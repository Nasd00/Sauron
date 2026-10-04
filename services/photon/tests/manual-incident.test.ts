import assert from "node:assert/strict";
import { test } from "node:test";
import { FinishReason, GenerateContentResponse, type Content, type GenerateContentParameters } from "@google/genai";
import type { IncidentView } from "@tempmhacks/shared";
import { HelpAgent, offerPrompt, type GenerateContent, type Person } from "../src/assist/agent.js";
import { distanceKm, type LatLng } from "../src/assist/geo.js";
import type { RouteRequest, Router } from "../src/assist/routing.js";
import { runTool, type KnownIncident, type ToolDeps } from "../src/assist/tools.js";
import { answerFollowUp } from "../src/answer.js";
import { handleIncidentAdmin, parseIncidentReport } from "../src/incidents.js";

const home: LatLng = { latitude: 42.2814, longitude: -83.7485 };
const gasLeak: KnownIncident = {
  id: "manual-1", cameraId: "manual", type: "gas_leak", confidence: 1, latitude: 42.2850, longitude: -83.7485,
  report: { incidentId: "manual-1", title: "Gas leak on Main St", description: "Strong smell", radiusKm: 2, reportedBy: "op", reportedAt: 0 },
};
const routes: RouteRequest[] = [];
const router: Router = {
  route: async request => {
    routes.push(request);
    const km = distanceKm(request.from, request.to);
    return { ...request, geometry: [request.from, request.to], distanceKm: km, durationMin: km * 2, via: ["Main St"], provider: "valhalla" };
  },
};
const deps = (incidents: KnownIncident[]): ToolDeps => ({
  router, shelters: async () => [], incidents: () => incidents, dangerRadiusKm: 3, userAgent: "test", clock: () => 0,
});

test("get_situation describes operator reports with their danger zone", async () => {
  const result = await runTool("get_situation", {}, { location: home }, deps([gasLeak]));
  const [nearby] = (result as { confirmed_incidents_nearby: Record<string, unknown>[] }).confirmed_incidents_nearby;
  assert.equal(nearby!.source, "operator report");
  assert.equal(nearby!.title, "Gas leak on Main St");
  assert.equal(nearby!.type, "gas leak");
  assert.equal(nearby!.danger_radius_km, 2);
  assert.equal(nearby!.inside_danger_zone, true);
});

test("get_escape_route heads away from the danger to just past the zone, without excluding the person's own zone", async () => {
  routes.length = 0;
  const other: KnownIncident = { id: "fire", cameraId: "cam", confidence: 0.9, latitude: 42.2, longitude: -83.9 };
  const result = await runTool("get_escape_route", {}, { location: home }, deps([gasLeak, other])) as Record<string, unknown>;
  assert.equal(result.inside_danger_zone, true);
  assert.equal(result.head, "south", "the leak is north of the person");
  const safe = result.safe_point as LatLng;
  assert.ok(Math.abs(distanceKm(gasLeak, safe) - 3) < 0.05, "1 km past the 2 km zone edge");
  assert.deepEqual(routes[0]!.avoid.map(c => c.id), ["fire"], "the zone the person is in can't be excluded");
});

test("offers of help reach everyone in a manual danger zone and ask the model to lead them out", async () => {
  const requests: GenerateContentParameters[] = [];
  const generate: GenerateContent = async params => {
    requests.push(structuredClone(params));
    return Object.assign(new GenerateContentResponse(), {
      candidates: [{ content: { role: "model", parts: [{ text: "Head south now." }] }, finishReason: FinishReason.STOP }],
    });
  };
  const sent: string[] = [];
  const agent = new HelpAgent({
    generate, radiusKm: 1, send: async spaceId => { sent.push(spaceId); },
    tools: { router, shelters: async () => [], dangerRadiusKm: 3, userAgent: "test" },
  });
  const person = (id: string, at: LatLng): Person => ({ senderId: id, spaceId: `space-${id}`, location: at });
  // 2.5 km away: outside the 1 km offer radius alone, but within the 2 km zone + 1 km.
  await agent.onIncident(gasLeak, [person("near", { latitude: 42.2625, longitude: -83.7485 }), person("far", { latitude: 42.20, longitude: -83.7485 })]);
  assert.deepEqual(sent, ["space-near"]);
  const opening = ((requests[0]!.contents as Content[])[0]!.parts ?? []).map(p => p.text).join("\n");
  assert.match(opening, /An operator reported a dangerous event: Gas leak on Main St \(gas leak, reported by an operator\)/);
  assert.match(opening, /outside the danger zone but nearby/);
  assert.match(offerPrompt(gasLeak, 0.5, 2), /INSIDE the danger zone.*get_escape_route/);
  agent.forgetIncident("manual-1");
  assert.deepEqual(agent.activeIncidents(), []);
});

test("grounded follow-ups about a manual incident don't mention cameras", () => {
  const incident: IncidentView = {
    id: "manual-1", cameraId: "manual", type: "gas_leak", status: "confirmed", confidence: 1,
    latitude: 42.285, longitude: -83.7485, firstSeenAt: 0, lastSeenAt: 0, confirmedAt: 0, report: gasLeak.report,
  };
  const context = { incident, report: incident.report, baseUrl: "https://app.example", now: 0 };
  assert.match(answerFollowUp("what_happened", context).text, /^Gas leak on Main St: gas leak reported by an operator/);
  assert.match(answerFollowUp("which_camera", context).text, /reported by an operator, not seen by a camera/);
  assert.equal(answerFollowUp("show_me", context).sendEvidence, false);
});

test("POST /admin/incidents validates the report and calls the reducer", async () => {
  assert.throws(() => parseIncidentReport({ latitude: 1, longitude: 1, radiusKm: 1 }), /title/);
  assert.throws(() => parseIncidentReport({ type: "nope", latitude: 1, longitude: 1, radiusKm: 1, title: "x" }), /type/);
  assert.throws(() => parseIncidentReport({ latitude: 1, longitude: 1, radiusKm: 0, title: "x" }), /radiusKm/);
  const parsed = parseIncidentReport({ latitude: 1, longitude: 2, radiusKm: 1.5, title: " Flood ", type: "flood" }, () => "manual-x");
  assert.deepEqual(parsed, { id: "manual-x", type: "flood", latitude: 1, longitude: 2, radiusKm: 1.5, title: "Flood", description: "", reportedBy: "web operator" });

  const reported: unknown[] = [];
  const db = {
    report: async (input: unknown) => { reported.push(input); },
    confirm: async () => {},
    dismiss: async () => {},
    resolve: async () => { throw new Error("operator_required: nope"); },
    view: (id: string) => ({ id }) as IncidentView,
  };
  const created = await handleIncidentAdmin("/admin/incidents", { latitude: 1, longitude: 2, radiusKm: 1, title: "Fire" }, db);
  assert.equal(created.status, 201);
  assert.equal(reported.length, 1);
  assert.equal((await handleIncidentAdmin("/admin/incidents", {}, db)).status, 400);
  const denied = await handleIncidentAdmin("/admin/incidents/resolve", { id: "manual-1" }, db, "abc");
  assert.equal(denied.status, 403);
  assert.match(String(denied.body.error), /grant_operator '"abc"'/);
});

test("operator incident actions validate ids and call the requested transition", async () => {
  const actions: string[] = [];
  const db = {
    report: async () => {},
    confirm: async (id: string) => { actions.push(`confirm:${id}`); },
    dismiss: async (id: string) => { actions.push(`dismiss:${id}`); },
    resolve: async (id: string) => { actions.push(`resolve:${id}`); },
    view: (id: string) => ({ id }) as IncidentView,
  };
  for (const action of ["confirm", "dismiss", "resolve"]) {
    assert.equal((await handleIncidentAdmin(`/admin/incidents/${action}`, { id: "cam-1" }, db)).status, 200);
    assert.equal((await handleIncidentAdmin(`/admin/incidents/${action}`, {}, db)).status, 400);
  }
  assert.deepEqual(actions, ["confirm:cam-1", "dismiss:cam-1", "resolve:cam-1"]);
});
