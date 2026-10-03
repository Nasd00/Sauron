import type { Incident, Watch } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

export function haversineDistanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export type CreateAlert = (incidentId: string, watchId: string) => Promise<void> | void;

export async function matchConfirmedIncident(
  incident: Incident,
  watches: Iterable<Watch>,
  createAlert: CreateAlert,
  existingAlertKeys: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (incident.status !== "confirmed") return 0;

  const matchedKeys = new Set(existingAlertKeys);
  let created = 0;
  for (const watch of watches) {
    if (!watch.active) continue;
    const key = alertKey(incident.id, watch.id);
    if (matchedKeys.has(key)) continue;
    const distanceKm = haversineDistanceKm(
      incident.latitude, incident.longitude, watch.latitude, watch.longitude,
    );
    if (distanceKm <= watch.radiusKm) {
      matchedKeys.add(key);
      await createAlert(incident.id, watch.id);
      created += 1;
    }
  }
  return created;
}

function alertKey(incidentId: string, watchId: string): string {
  return `${incidentId}:${watchId}`;
}

export function startIncidentMatcher(
  db: Pick<Db, "incidents" | "alerts">,
  getWatches: () => Iterable<Watch>,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  const existingAlertKeys = new Set<string>();
  const stopAlerts = db.alerts.subscribe(alert => {
    const key = alertKey(alert.incidentId, alert.watchId);
    if (alert.status === "pending" || alert.status === "sent" || alert.status === "failed") {
      existingAlertKeys.add(key);
    }
  });
  const stopIncidents = db.incidents.subscribe(incident => {
    if (incident.status !== "confirmed") return;
    void matchConfirmedIncident(incident, getWatches(), (incidentId, watchId) =>
      db.alerts.create(incidentId, watchId), existingAlertKeys).then(() => undefined).catch(onError);
  });
  return () => {
    stopIncidents();
    stopAlerts();
  };
}
