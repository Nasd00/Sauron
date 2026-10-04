import type {
  Closure, DestinationOption, Helper, Household, OfficialWarning, RouteSummary, Shelter, SourceRef,
} from "@tempmhacks/shared/evac";
import { describeNeeds } from "../domain/intake.js";

/** Plain-text message templates. Kept short and scannable for SMS/iMessage. */

export const sourceLabel = (source: SourceRef) => source.live ? source.name : `${source.name}`;

export function clockTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

const minutes = (value: number) => `${Math.max(1, Math.round(value))} min`;
const via = (route: RouteSummary) => route.via.length ? ` via ${route.via.slice(0, 3).join(", ")}` : "";
const routeLine = (route: RouteSummary) => route.provider === "estimate"
  ? `~${minutes(route.durationMin)} (straight-line estimate; live routing unavailable)`
  : `${minutes(route.durationMin)} (${route.distanceKm.toFixed(1)} km)${via(route)}`;

export function osmDirections(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): string {
  const point = (p: typeof from) => `${p.latitude.toFixed(5)}%2C${p.longitude.toFixed(5)}`;
  return `https://www.openstreetmap.org/directions?engine=fossgis_valhalla_car&route=${point(from)}%3B${point(to)}`;
}

export function warningNotice(warning: OfficialWarning, household: Household): string {
  return [
    `OFFICIAL WARNING: ${warning.event}`,
    `Source: ${sourceLabel(warning.source)}`,
    warning.headline,
    `"${warning.instruction}"`,
    `Your address (${household.address}) is inside this area.`,
    "I can help you work out how your household leaves. Who is with you, does anyone need mobility or medical help, and do you have a car?",
    "If anyone is in immediate danger, call 911.",
  ].join("\n\n");
}

export function askMissing(missing: ("people" | "vehicle")[], understood: string[]): string {
  const ack = understood.length ? `Got it: ${understood.join(", ")}. ` : "";
  const questions = missing.map(item => item === "people"
    ? "How many people are leaving with you (including you)?"
    : "Do you have a car you can use?");
  return `${ack}${questions.join(" ")}`;
}

export function destinationList(household: Household, options: DestinationOption[], shelters: Map<string, Shelter>): string {
  const lines = options.map((option, index) => {
    const shelter = shelters.get(option.shelterId)!;
    const notes = [...option.reasons, ...option.warnings.map(w => `note: ${w}`)].join(", ");
    return `${index + 1}. ${shelter.name}: ${routeLine(option.route)}. ${notes}.`;
  });
  const sources = [...new Set(options.map(option => sourceLabel(shelters.get(option.shelterId)!.source)))];
  return [
    `Got it: ${describeNeeds(household.needs)}.`,
    `Open destinations outside the order area that fit your household:\n${lines.join("\n")}`,
    `Shelter info: ${sources.join("; ")}.`,
  ].join("\n\n");
}

export function offerRide(helper: Helper, shelter: Shelter, distanceKm: number): string {
  return [
    `You said you don't have a car. ${helper.name.split(" ")[0]}, an enrolled volunteer driver with a ${helper.vehicle.description}, is about ${distanceKm.toFixed(1)} km away.`,
    `Can I request a pickup to ${shelter.name}? This shares your address and the needs you told me with the volunteer driver who accepts. Nobody else gets them.`,
    "Reply YES to send the request, or 2 or 3 to pick a different destination.",
  ].join("\n\n");
}

export function chooseToDrive(): string {
  return "Reply 1, 2, or 3 and I'll send the route. I'll message you if a closure affects it.";
}

export function noHelpers(): string {
  return "I couldn't find an enrolled volunteer with a suitable vehicle right now. Call 211 to ask for accessible evacuation transport. If anyone is in immediate danger, call 911. I'll keep looking and message you if a driver becomes available.";
}

export function noDestinations(warning: OfficialWarning | undefined): string {
  return `I couldn't find an open destination that fits your household right now. Follow the official instruction${warning ? `: "${warning.instruction}"` : ""}. Call 211 for shelter information, or 911 if anyone is in danger.`;
}

export function requestSentToResident(helper: Helper, timeoutMin: number): string {
  return [
    `Request sent to ${helper.name.split(" ")[0]}. If there's no answer in ${timeoutMin} min, I'll ask the next available driver.`,
    "While you wait: medications, phone chargers, IDs, and the wheelchair or its charger if it's powered.",
  ].join("\n\n");
}

export function helperRequest(household: Household, shelter: Shelter, trip: RouteSummary, pickup: RouteSummary, warning?: OfficialWarning): string {
  return [
    "TRANSPORT REQUEST",
    `${household.label}, ${household.address}${warning ? ` (inside the ${warning.event} area)` : ""}.`,
    `Household: ${describeNeeds(household.needs)}.`,
    `Your drive to pickup: ${routeLine(pickup)}.`,
    `Drop-off: ${shelter.name}, ${shelter.address}. ${routeLine(trip)}.`,
    "Reply ACCEPT or DECLINE. Only accept if you can get there safely, and follow any instructions from officials on scene.",
  ].join("\n");
}

export function helperConfirmed(household: Household, shelter: Shelter, trip: RouteSummary, pickup?: RouteSummary): string {
  return [
    `Confirmed. Thank you. I've told the ${household.label.replace(/ household$/, "")} family you're coming.`,
    `Pickup: ${household.address}${pickup ? `\n${osmDirections(pickup.from, pickup.to)}` : ""}`,
    `Then: ${shelter.name}, ${routeLine(trip)}.\n${osmDirections(trip.from, trip.to)}`,
    "Text PICKED UP when everyone is aboard and ARRIVED at the shelter. I'll message you if the route changes.",
  ].join("\n\n");
}

export function residentConfirmed(helper: Helper, shelter: Shelter, pickupEta: number, arrivalEta: number, timeZone: string): string {
  return [
    `Confirmed: ${helper.name.split(" ")[0]} is on the way in a ${helper.vehicle.description}.`,
    `Pickup around ${clockTime(pickupEta, timeZone)}. Arrival at ${shelter.name} around ${clockTime(arrivalEta, timeZone)}.`,
    "Wait somewhere safe near the door. I'll message you if anything changes.",
  ].join("\n\n");
}

export function escalating(previous: Helper, next: Helper, reason: string): string {
  return `${previous.name.split(" ")[0]} ${reason}. I've asked ${next.name.split(" ")[0]} (${next.vehicle.description}) instead. Your details only go to whoever accepts.`;
}

export function closureNotice(closure: Closure): string {
  const verified = closure.verifiedBy.map(sourceLabel).join(" + ");
  return `${closure.description}. Verified by: ${verified}.`;
}

/** "via Bonisteel Boulevard instead of Huron Parkway" — the part of a reroute a person cares about. */
export function routeChange(previous: RouteSummary, next: RouteSummary): string {
  const added = next.via.filter(street => !previous.via.includes(street));
  const dropped = previous.via.filter(street => !next.via.includes(street));
  if (!added.length) return routeLine(next);
  return `now via ${added.join(", ")}${dropped.length ? ` instead of ${dropped.join(", ")}` : ""}, ${minutes(next.durationMin)} (${next.distanceKm.toFixed(1)} km)`;
}

export function rerouteResident(closure: Closure, helper: Helper | undefined, shelter: Shelter, previous: RouteSummary, route: RouteSummary, deltaMin: number, arrivalEta: number | undefined, timeZone: string): string {
  const who = helper ? `${helper.name.split(" ")[0]} has the new route` : "New route";
  const change = Math.abs(deltaMin) < 0.5 ? "about the same time" : `${deltaMin > 0 ? "+" : "-"}${minutes(Math.abs(deltaMin))}`;
  return [
    `ROUTE UPDATE: ${closureNotice(closure)}`,
    `${who} to ${shelter.name}: ${routeChange(previous, route)} (${change}).`,
    arrivalEta ? `New arrival estimate: around ${clockTime(arrivalEta, timeZone)}.` : "",
  ].filter(Boolean).join("\n\n");
}

export function rerouteHelper(closure: Closure, shelter: Shelter, route: RouteSummary, leg: "trip" | "pickup"): string {
  return [
    `ROUTE CHANGE: ${closureNotice(closure)}`,
    `New route ${leg === "pickup" ? "to the pickup" : `to ${shelter.name}`}: ${route.via.length ? route.via.join(" → ") : "see link"} (${route.distanceKm.toFixed(1)} km, ${minutes(route.durationMin)}).`,
    osmDirections(route.from, route.to),
  ].join("\n\n");
}

export function pickedUpResident(helper: Helper, shelter: Shelter, arrivalEta: number, timeZone: string): string {
  return `${helper.name.split(" ")[0]} says everyone is aboard. Heading to ${shelter.name}, arriving around ${clockTime(arrivalEta, timeZone)}.`;
}

export function arrivedResident(shelter: Shelter, household: Household): string {
  const needs = [...household.needs.notes, ...household.needs.medical];
  const tell = needs.length ? `tell staff about: ${needs.join(", ")}` : "tell staff about any mobility or medical needs";
  return `You've arrived at ${shelter.name}. Check in at the registration desk and ${tell}. I'll keep watching the order and let you know when officials lift it.`;
}

export const HELP_TEXT = "Reply STATUS for your current plan, or tell me what changed. If anyone is in immediate danger, call 911.";
