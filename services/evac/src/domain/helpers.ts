import type { Helper, Household } from "@tempmhacks/shared/evac";
import { distanceKm } from "./geo.js";

/** Why a helper can or cannot take this household, for the operator view and tests. */
export function helperFit(helper: Helper, household: Household): { ok: boolean; reason: string } {
  const people = household.needs.people ?? 1;
  if (!helper.enrolled) return { ok: false, reason: "not enrolled" };
  if (helper.status !== "available") return { ok: false, reason: helper.status };
  if (helper.vehicle.seats < people) return { ok: false, reason: `${helper.vehicle.seats} seats for ${people} people` };
  if (household.needs.mobility.includes("wheelchair") && !helper.vehicle.wheelchairAccessible) {
    return { ok: false, reason: "vehicle is not wheelchair accessible" };
  }
  return { ok: true, reason: helper.vehicle.description };
}

/** Eligible helpers not yet asked, nearest first (straight-line; pickup ETA is routed later). */
export function candidateHelpers(helpers: Helper[], household: Household, alreadyAsked: string[]): Helper[] {
  return helpers
    .filter(helper => !alreadyAsked.includes(helper.id) && helperFit(helper, household).ok)
    .sort((a, b) => distanceKm(a.home, household.location) - distanceKm(b.home, household.location));
}
