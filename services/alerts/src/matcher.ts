import type { Incident, Watch } from "@tempmhacks/shared";

const EARTH_RADIUS_KM = 6371.0088;

const radians = (degrees: number) => degrees * Math.PI / 180;

export function haversineDistanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface AlertMatcherStore {
  listActiveWatches(): Promise<Watch[]>;
  /** Returns false when the incident/watch pair already has an alert. */
  createAlert(incidentId: string, watchId: string): Promise<boolean>;
}

export async function matchConfirmedIncident(incident: Incident, store: AlertMatcherStore): Promise<number> {
  if (incident.status !== "confirmed") return 0;
  let created = 0;
  for (const watch of await store.listActiveWatches()) {
    if (!watch.active) continue;
    const distanceKm = haversineDistanceKm(
      incident.latitude, incident.longitude, watch.latitude, watch.longitude,
    );
    if (distanceKm <= watch.radiusKm && await store.createAlert(incident.id, watch.id)) created += 1;
  }
  return created;
}
