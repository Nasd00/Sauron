import assert from "node:assert/strict";
import { test } from "node:test";
import type { Arrangement, HouseholdNeeds, RouteSummary } from "@tempmhacks/shared/evac";
import { describeNeeds, missingDetails, parseHouseholdMessage } from "../src/domain/intake.js";
import { evaluateShelter, rankDestinations } from "../src/domain/destinations.js";
import { candidateHelpers, helperFit } from "../src/domain/helpers.js";
import { canTransition, transition } from "../src/domain/arrangement.js";
import { bufferLine, decodePolyline, pathIntersectsPolygon, pointInPolygon } from "../src/domain/geo.js";
import { annArborScenario } from "../src/scenario/ann-arbor.js";

const empty: HouseholdNeeds = { mobility: [], medical: [], pets: 0, notes: [] };

test("parses the demo household message", () => {
  const { needs, understood } = parseHouseholdMessage(
    "We’re three people. My dad uses a wheelchair, and we don’t have a car.", empty);
  assert.equal(needs.people, 3);
  assert.deepEqual(needs.mobility, ["wheelchair"]);
  assert.deepEqual(needs.notes, ["dad (wheelchair)"]);
  assert.equal(needs.hasVehicle, false);
  assert.equal(needs.pets, 0);
  assert.deepEqual(understood, ["3 people", "your dad uses a wheelchair", "no car"]);
  assert.deepEqual(missingDetails(needs), []);
  assert.equal(describeNeeds(needs), "3 people · dad (wheelchair) · no vehicle");
});

test("parses listed household members, pets, medical needs, and vehicles", () => {
  const listed = parseHouseholdMessage("It's me, my wife and two kids. We have a car and 2 dogs", empty).needs;
  assert.equal(listed.people, 4);
  assert.equal(listed.pets, 2);
  assert.equal(listed.hasVehicle, true);
  const medical = parseHouseholdMessage("My mom is on oxygen and uses a walker", empty).needs;
  assert.deepEqual(medical.medical, ["oxygen"]);
  assert.deepEqual(medical.mobility, ["walker"]);
  assert.equal(medical.people, undefined);
  assert.deepEqual(missingDetails(medical), ["people", "vehicle"]);
  assert.equal(parseHouseholdMessage("just me, no pets, I can't drive", empty).needs.people, 1);
  assert.equal(parseHouseholdMessage("just me, no pets, I can't drive", empty).needs.hasVehicle, false);
  assert.equal(parseHouseholdMessage("Our location is near the cathedral", empty).needs.pets, 0);
});

test("merges new facts into what is already known", () => {
  const first = parseHouseholdMessage("my dad uses a wheelchair", empty).needs;
  const second = parseHouseholdMessage("there are 3 of us and no car", first).needs;
  assert.equal(second.people, 3);
  assert.deepEqual(second.mobility, ["wheelchair"]);
  assert.equal(second.hasVehicle, false);
});

test("geometry helpers detect containment and crossings", () => {
  const square = [
    { latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 },
    { latitude: 1, longitude: 1 }, { latitude: 1, longitude: 0 },
  ];
  assert.equal(pointInPolygon({ latitude: 0.5, longitude: 0.5 }, square), true);
  assert.equal(pointInPolygon({ latitude: 1.5, longitude: 0.5 }, square), false);
  assert.equal(pathIntersectsPolygon([{ latitude: -1, longitude: 0.5 }, { latitude: 2, longitude: 0.5 }], square), true);
  assert.equal(pathIntersectsPolygon([{ latitude: -1, longitude: 2 }, { latitude: 2, longitude: 2 }], square), false);
  const corridor = bufferLine([{ latitude: 42.29, longitude: -83.70 }, { latitude: 42.30, longitude: -83.70 }], 40);
  assert.equal(pointInPolygon({ latitude: 42.295, longitude: -83.70 }, corridor), true);
  assert.equal(pointInPolygon({ latitude: 42.295, longitude: -83.699 }, corridor), false);
  // Reference polyline from the Google polyline algorithm docs, at precision 5.
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5).map(p => [p.latitude, p.longitude]),
    [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

const route = (minutes: number): RouteSummary => ({
  id: "r", from: { latitude: 0, longitude: 0 }, to: { latitude: 0, longitude: 0 }, distanceKm: minutes,
  durationMin: minutes, geometry: [], via: [], provider: "valhalla", avoidedClosureIds: [],
  source: { name: "test", kind: "routing", live: false, retrievedAt: 0 },
});

test("filters shelters inside the warning area and ranks the rest by fit", () => {
  const scenario = annArborScenario(0);
  const household = { ...scenario.households[0]!, needs: parseHouseholdMessage(
    "We're three people. My dad uses a wheelchair, and we don't have a car.", empty).needs };
  const [warning] = scenario.warnings;
  assert.ok(pointInPolygon(household.location, warning!.area), "demo household is inside the warning area");
  const minutes: Record<string, number> = { "shelter-huron-hs": 8, "shelter-pioneer-hs": 11, "shelter-wcc": 14, "shelter-skyline-hs": 9 };
  const evaluations = scenario.shelters.map(shelter =>
    evaluateShelter(shelter, route(minutes[shelter.id]!), household, scenario.warnings, []));
  const skyline = evaluations.find(e => !e.eligible && e.shelterId === "shelter-skyline-hs");
  assert.ok(skyline && !skyline.eligible && /inside the Evacuation Immediate area/.test(skyline.reason));
  const ranked = rankDestinations(evaluations);
  assert.deepEqual(ranked.map(option => option.shelterId), ["shelter-huron-hs", "shelter-wcc", "shelter-pioneer-hs"]);
  assert.ok(ranked[0]!.reasons.includes("wheelchair accessible"));
  assert.ok(ranked[2]!.warnings.some(w => /% full/.test(w)));
});

test("matches only enrolled helpers whose vehicle fits, nearest first", () => {
  const scenario = annArborScenario(0);
  const household = { ...scenario.households[0]!, needs: { ...empty, people: 3, mobility: ["wheelchair" as const] } };
  const jordan = scenario.helpers.find(h => h.id === "jordan")!;
  assert.deepEqual(helperFit(jordan, household), { ok: false, reason: "vehicle is not wheelchair accessible" });
  assert.deepEqual(candidateHelpers(scenario.helpers, household, []).map(h => h.id), ["maya", "luis"]);
  assert.deepEqual(candidateHelpers(scenario.helpers, household, ["maya"]).map(h => h.id), ["luis"]);
  const notEnrolled = scenario.helpers.map(h => ({ ...h, enrolled: false }));
  assert.deepEqual(candidateHelpers(notEnrolled, household, []), []);
});

test("arrangement lifecycle only allows forward progress", () => {
  const base: Arrangement = {
    id: "a", householdId: "h", shelterId: "s", requestedHelperIds: [], status: "awaiting_consent",
    tripRoute: route(5), history: [],
  };
  const requested = transition(base, "requested", 1, "asked maya", { helperId: "maya" });
  const confirmed = transition(requested, "confirmed", 2, "maya accepted");
  const picked = transition(confirmed, "picked_up", 3, "picked up");
  const arrived = transition(picked, "arrived", 4, "arrived");
  assert.deepEqual(arrived.history.map(h => h.status), ["requested", "confirmed", "picked_up", "arrived"]);
  assert.equal(arrived.helperId, "maya");
  assert.throws(() => transition(arrived, "requested", 5, "again"), /cannot move from arrived/);
  assert.equal(canTransition("picked_up", "cancelled"), false);
});
