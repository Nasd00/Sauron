import type { Incident, MobileDevice, UserAlertProfile, Watch } from "@tempmhacks/shared";
import { evaluateProfileFreshness, haversineDistanceKm, isLiveTracked } from "@tempmhacks/shared/geo";

// Re-exported so existing imports (and tests) keep a single source of truth.
export { haversineDistanceKm };

export interface AlertMatcherStore {
  listActiveWatches(): Promise<Watch[]>;
  /** Returns false when the incident/watch pair already has an alert. */
  createAlert(incidentId: string, watchId: string): Promise<boolean>;
}

export interface ProfileAlertMatcherStore {
  listProfiles(): Promise<UserAlertProfile[]>;
  /** Paired Sauron iPhones; a live-tracked profile stays fresh for longer between uploads. */
  listMobileDevices(): Promise<MobileDevice[]>;
  /** Returns false when the incident/profile pair already has an alert. */
  createProfileAlert(incidentId: string, userId: string): Promise<boolean>;
}

/**
 * Secondary, place-based matching: confirmed incidents against active WATCH
 * subscriptions. Unchanged behavior; kept as the fallback surface.
 */
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

export type ProfileMatchOptions = { now: number };

/**
 * Primary, current-location matching. A confirmed incident alerts a profile only
 * when alerts are enabled, the shared location is still fresh, and the incident is
 * within the profile's radius. Deterministic; the freshness and distance rules are
 * pure and shared with the conversational phrasing layer. One alert per
 * incident/profile is enforced by the store's createProfileAlert.
 */
export async function matchConfirmedIncidentToProfiles(
  incident: Incident,
  store: ProfileAlertMatcherStore,
  options: ProfileMatchOptions,
): Promise<number> {
  if (incident.status !== "confirmed") return 0;
  let created = 0;
  const devices = await store.listMobileDevices();
  for (const profile of await store.listProfiles()) {
    if (!profile.alertsEnabled) continue;
    const live = isLiveTracked(profile.senderId, devices);
    if (!evaluateProfileFreshness(profile, live, options.now).fresh) continue;
    const distanceKm = haversineDistanceKm(
      incident.latitude, incident.longitude, profile.latitude, profile.longitude,
    );
    if (distanceKm <= profile.radiusKm && await store.createProfileAlert(incident.id, profile.userId)) {
      created += 1;
    }
  }
  return created;
}
