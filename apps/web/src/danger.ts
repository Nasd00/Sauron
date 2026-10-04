import type { IncidentView, UserAlertProfile, Watch } from "@tempmhacks/shared";
import { hazardLabel } from "@tempmhacks/shared";
import { haversineDistanceKm } from "@tempmhacks/shared/geo";

export type Point = { latitude: number; longitude: number };

/** The radius people must leave: an operator's danger zone, else a small zone around a camera sighting. */
export const CAMERA_DANGER_RADIUS_KM = 1;
export function dangerRadiusKm(incident: IncidentView): number {
  return incident.report?.radiusKm ?? CAMERA_DANGER_RADIUS_KM;
}

/**
 * Upper bound on how many people a report at `point` would alert, using the alert service's rule
 * (the target's area overlaps the danger zone). Freshness is checked by the alert service, so this
 * may overcount people whose shared location has gone stale.
 */
export function estimateReach(
  point: Point, radiusKm: number, watches: Iterable<Watch>, profiles: Iterable<UserAlertProfile>,
): number {
  const people = new Set<string>();
  const inRange = (target: Point & { radiusKm: number }) =>
    haversineDistanceKm(point.latitude, point.longitude, target.latitude, target.longitude) <= radiusKm + target.radiusKm;
  for (const watch of watches) if (watch.active && inRange(watch)) people.add(watch.senderId);
  for (const profile of profiles) if (profile.alertsEnabled && inRange(profile)) people.add(profile.senderId);
  return people.size;
}

export type DangerSummary = {
  id: string;
  what: string;
  source: "operator report" | "camera";
  details?: string;
  latitude: number;
  longitude: number;
  dangerRadiusKm: number;
  distanceKm?: number;
  insideDangerZone?: boolean;
};

/** What IRIS and the panel say about active incidents, nearest first when a position is known. */
export function summarizeDangers(incidents: IncidentView[], from?: Point): DangerSummary[] {
  return incidents.map(incident => {
    const radius = dangerRadiusKm(incident);
    const km = from ? haversineDistanceKm(from.latitude, from.longitude, incident.latitude, incident.longitude) : undefined;
    return {
      id: incident.id,
      what: incident.report ? `${incident.report.title} (${hazardLabel(incident.type)})` : hazardLabel(incident.type),
      source: incident.report ? "operator report" as const : "camera" as const,
      details: incident.report?.description || undefined,
      latitude: incident.latitude,
      longitude: incident.longitude,
      dangerRadiusKm: radius,
      distanceKm: km === undefined ? undefined : Math.round(km * 10) / 10,
      insideDangerZone: km === undefined ? undefined : km <= radius,
    };
  }).sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
}

/** The point `km` from `origin` on compass bearing `degrees` (flat-earth; fine at city scale). */
export function offsetPoint(origin: Point, degrees: number, km: number): Point {
  const radians = degrees * Math.PI / 180;
  return {
    latitude: origin.latitude + (km * Math.cos(radians)) / 111.32,
    longitude: origin.longitude + (km * Math.sin(radians)) / (111.32 * Math.cos(origin.latitude * Math.PI / 180)),
  };
}

export function bearingDegrees(from: Point, to: Point): number {
  const dy = to.latitude - from.latitude;
  const dx = (to.longitude - from.longitude) * Math.cos(from.latitude * Math.PI / 180);
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
export function compass(degrees: number): string {
  return COMPASS[Math.round(degrees / 45) % 8]!;
}

/**
 * Where to go to get out of the nearest danger zone: straight away from its center to 1 km past
 * its edge. A direction and a target point, not a road route.
 */
export function escapePlan(incidents: IncidentView[], from: Point): {
  danger: DangerSummary; head: string; safePoint: Point; kmToSafety: number;
} | undefined {
  const nearest = summarizeDangers(incidents, from)
    .sort((a, b) => (a.distanceKm! - a.dangerRadiusKm) - (b.distanceKm! - b.dangerRadiusKm))[0];
  if (!nearest) return undefined;
  const away = nearest.distanceKm! < 0.01 ? 0 : bearingDegrees(nearest, from);
  const safePoint = offsetPoint(nearest, away, nearest.dangerRadiusKm + 1);
  return {
    danger: nearest, head: compass(away), safePoint,
    kmToSafety: Math.round(haversineDistanceKm(from.latitude, from.longitude, safePoint.latitude, safePoint.longitude) * 10) / 10,
  };
}
