import type {
  Closure, DestinationOption, Household, OfficialWarning, RouteSummary, Shelter,
} from "@tempmhacks/shared/evac";
import { pathIntersectsPolygon, pointInPolygon } from "./geo.js";

export type ShelterEvaluation =
  | { eligible: true; option: DestinationOption }
  | { eligible: false; shelterId: string; reason: string };

/**
 * Decide whether a shelter fits this household and score it. Lower scores are better;
 * the score is travel minutes plus explicit penalties so the ranking is explainable.
 */
export function evaluateShelter(
  shelter: Shelter,
  route: RouteSummary,
  household: Household,
  warnings: OfficialWarning[],
  closures: Closure[],
): ShelterEvaluation {
  const { needs } = household;
  const people = needs.people ?? 1;
  const reject = (reason: string): ShelterEvaluation => ({ eligible: false, shelterId: shelter.id, reason });

  if (shelter.status !== "open") return reject(`${shelter.status}`);
  const insideWarning = warnings.find(warning => pointInPolygon(shelter.location, warning.area));
  if (insideWarning) return reject(`inside the ${insideWarning.event} area`);
  const available = shelter.capacity - shelter.occupied;
  if (available < people) return reject(`only ${Math.max(0, available)} spaces left`);
  if (needs.mobility.includes("wheelchair") && !shelter.wheelchairAccessible) return reject("not wheelchair accessible");

  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = route.durationMin;

  if (needs.mobility.length && shelter.wheelchairAccessible) reasons.push("wheelchair accessible");
  if (needs.medical.length) {
    if (shelter.medicalSupport) reasons.push("medical support on site");
    else { cautions.push("no on-site medical support"); score += 12; }
  }
  if (needs.pets) {
    if (shelter.petFriendly) reasons.push("accepts pets");
    else { cautions.push("does not accept pets"); score += 20; }
  }
  const fill = shelter.occupied / shelter.capacity;
  if (fill > 0.75) { cautions.push(`${Math.round(fill * 100)}% full`); score += 8; }
  else reasons.push(`${available} spaces open`);

  if (route.provider === "estimate") {
    cautions.push("travel time is a straight-line estimate");
    const blocked = closures.find(closure => closure.status === "active" && pathIntersectsPolygon(route.geometry, closure.area));
    if (blocked) { cautions.push(`may cross the ${blocked.road} closure`); score += 15; }
  }
  return {
    eligible: true,
    option: { shelterId: shelter.id, route, reasons, warnings: cautions, score: Math.round(score * 10) / 10 },
  };
}

export function rankDestinations(evaluations: ShelterEvaluation[], limit = 3): DestinationOption[] {
  return evaluations
    .flatMap(evaluation => evaluation.eligible ? [evaluation.option] : [])
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}
