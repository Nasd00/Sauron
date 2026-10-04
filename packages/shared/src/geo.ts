/**
 * Pure geospatial and location-freshness helpers shared by the alerts matcher
 * and the grounded conversational answer pipeline. These are deterministic and
 * have no I/O so both the proximity decision and the user-facing phrasing derive
 * from one source of truth. The SpacetimeDB module keeps an independent copy of
 * the freshness rule for module-side validation across the trust boundary.
 */

export const EARTH_RADIUS_KM = 6371.0088;

/** Default freshness window for current-location monitoring: 30 minutes in ms. */
export const DEFAULT_FRESHNESS_MS = 30 * 60 * 1000;

/** Kilometers per mile, for user-facing distance phrasing. */
export const KM_PER_MILE = 1.609344;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance between two WGS84 points in kilometers. */
export function haversineDistanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function kilometersToMiles(km: number): number {
  return km / KM_PER_MILE;
}

/**
 * Pure freshness decision. A location is fresh when it was updated within
 * `freshnessMs` of `now`. A future timestamp (clock skew) is treated as fresh.
 * Returns the age in ms so callers can pick "near you" vs "near your last
 * shared location".
 */
export function evaluateLocationFreshness(
  locationUpdatedAt: number,
  now: number,
  freshnessMs: number = DEFAULT_FRESHNESS_MS,
): { fresh: boolean; ageMs: number } {
  const ageMs = now - locationUpdatedAt;
  if (ageMs <= 0) return { fresh: true, ageMs: 0 };
  return { fresh: ageMs <= freshnessMs, ageMs };
}

/**
 * Freshness window for a location kept current by the Sauron iPhone app. The app
 * uploads on movement (~1 km) rather than on a timer, so a stationary phone goes
 * quiet while its last fix stays accurate. The longer window covers that case and
 * still expires the location if the phone dies or the app is removed.
 */
export const LIVE_TRACKING_FRESHNESS_MS = 6 * 60 * 60 * 1000;

type LiveTrackingDevice = {
  senderId: string; trackingActive: boolean; sharingEnabled: boolean; revoked: boolean; lastLocationAt?: number;
};

/** True when a paired device is actively keeping this sender's location current. */
export function isLiveTracked(senderId: string, devices: Iterable<LiveTrackingDevice>): boolean {
  for (const device of devices) {
    if (device.senderId === senderId && device.trackingActive && device.sharingEnabled &&
      !device.revoked && device.lastLocationAt !== undefined) return true;
  }
  return false;
}

/** Profile freshness, using the live-tracking window when the location comes from the app. */
export function evaluateProfileFreshness(
  profile: { locationUpdatedAt: number },
  liveTracked: boolean,
  now: number,
): { fresh: boolean; ageMs: number } {
  return evaluateLocationFreshness(
    profile.locationUpdatedAt, now, liveTracked ? LIVE_TRACKING_FRESHNESS_MS : DEFAULT_FRESHNESS_MS,
  );
}
