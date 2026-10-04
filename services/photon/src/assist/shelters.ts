import { distanceKm, pathIntersectsPolygon, pointInPolygon, type LatLng, type Polygon } from "./geo.js";

/** What the person said about who is leaving, as gathered by the agent. */
export type ShelterNeeds = { people: number; wheelchair: boolean; pets: boolean; medical: boolean };
import type { Closure, RouteSummary } from "./routing.js";

export type Shelter = {
  id: string;
  name: string;
  address: string;
  location: LatLng;
  capacity: number;
  occupied: number;
  wheelchairAccessible: boolean;
  petFriendly: boolean;
  medicalSupport: boolean;
  /** "fema" shelters are live open-shelter reports; "demo" ones are labeled fixtures. */
  source: "fema" | "demo";
};

export type Destination = {
  shelter: Shelter;
  route: RouteSummary;
  reasons: string[];
  cautions: string[];
  score: number;
};

/**
 * Whether a shelter fits these needs, and how well. Lower scores are better: travel minutes plus
 * explicit penalties, so the ranking is explainable. Shelters inside a danger zone are never offered.
 */
export function evaluateShelter(
  shelter: Shelter, route: RouteSummary, needs: ShelterNeeds, dangerZones: Polygon[], closures: Closure[],
): Destination | undefined {
  const available = shelter.capacity - shelter.occupied;
  if (dangerZones.some(zone => pointInPolygon(shelter.location, zone))) return undefined;
  if (available < needs.people) return undefined;
  if (needs.wheelchair && !shelter.wheelchairAccessible) return undefined;

  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = route.durationMin;
  if (needs.wheelchair) reasons.push("wheelchair accessible");
  if (needs.medical) {
    if (shelter.medicalSupport) reasons.push("medical support on site");
    else { cautions.push("no on-site medical support"); score += 12; }
  }
  if (needs.pets) {
    if (shelter.petFriendly) reasons.push("accepts pets");
    else { cautions.push("does not accept pets"); score += 20; }
  }
  const fill = shelter.capacity ? shelter.occupied / shelter.capacity : 1;
  if (fill > 0.75) { cautions.push(`${Math.round(fill * 100)}% full`); score += 8; }
  else reasons.push(`${available} spaces open`);
  if (route.provider === "estimate") {
    cautions.push("travel time is a straight-line estimate");
    const blocked = closures.find(closure => pathIntersectsPolygon(route.geometry, closure.area));
    if (blocked) { cautions.push(`may pass ${blocked.label}`); score += 15; }
  }
  return { shelter, route, reasons, cautions, score: Math.round(score * 10) / 10 };
}

export function rankDestinations(candidates: (Destination | undefined)[], limit = 3): Destination[] {
  return candidates.filter((d): d is Destination => d !== undefined).sort((a, b) => a.score - b.score).slice(0, limit);
}

/**
 * Ann Arbor demo shelters, geocoded from OpenStreetMap. Capacity and services are made up, and every
 * message that lists them says "demo shelter", so nobody mistakes them for operating shelters.
 */
export const DEMO_SHELTERS: Shelter[] = [
  {
    id: "demo-huron-hs", name: "Huron High School", address: "2727 Fuller Rd, Ann Arbor",
    location: { latitude: 42.2806964, longitude: -83.7029278 },
    capacity: 300, occupied: 112, wheelchairAccessible: true, petFriendly: true, medicalSupport: true, source: "demo",
  },
  {
    id: "demo-pioneer-hs", name: "Pioneer High School", address: "601 W Stadium Blvd, Ann Arbor",
    location: { latitude: 42.2603039, longitude: -83.7538782 },
    capacity: 250, occupied: 204, wheelchairAccessible: true, petFriendly: false, medicalSupport: false, source: "demo",
  },
  {
    id: "demo-wcc", name: "Washtenaw Community College", address: "4800 E Huron River Dr, Ann Arbor",
    location: { latitude: 42.2631875, longitude: -83.6650462 },
    capacity: 400, occupied: 61, wheelchairAccessible: true, petFriendly: true, medicalSupport: false, source: "demo",
  },
  {
    id: "demo-skyline-hs", name: "Skyline High School", address: "2552 N Maple Rd, Ann Arbor",
    location: { latitude: 42.3052254, longitude: -83.77713 },
    capacity: 300, occupied: 0, wheelchairAccessible: true, petFriendly: true, medicalSupport: false, source: "demo",
  },
];

const FEMA_OPEN_SHELTERS = "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0/query";
type FemaAttributes = {
  shelter_id: number | string; shelter_name: string; address?: string; city?: string; state?: string;
  shelter_status?: string; evacuation_capacity?: number | null; total_population?: number | null;
  wheelchair_accessible?: string | null; ada_compliant?: string | null; pet_accommodations_code?: string | null;
  latitude: number; longitude: number;
};
const yes = (value: string | null | undefined) => typeof value === "string" && /^(y|yes|true|1)$/i.test(value.trim());

/** Open shelters reported to FEMA's National Shelter System within `radiusMiles`. Flags count only when explicit. */
export async function fetchFemaOpenShelters(near: LatLng, options: { radiusMiles?: number; fetch?: typeof fetch } = {}): Promise<Shelter[]> {
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${near.longitude},${near.latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(options.radiusMiles ?? 40),
    units: "esriSRUnit_StatuteMile",
    outFields: "shelter_id,shelter_name,address,city,state,shelter_status,evacuation_capacity,total_population,wheelchair_accessible,ada_compliant,pet_accommodations_code,latitude,longitude",
    returnGeometry: "false",
    f: "json",
  });
  const response = await (options.fetch ?? fetch)(`${FEMA_OPEN_SHELTERS}?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`FEMA shelters ${response.status}`);
  const data = await response.json() as { features?: { attributes: FemaAttributes }[]; error?: { message: string } };
  if (data.error) throw new Error(`FEMA shelters: ${data.error.message}`);
  return (data.features ?? []).flatMap(({ attributes: a }) => {
    if (!/open/i.test(a.shelter_status ?? "")) return [];
    const capacity = a.evacuation_capacity ?? 0;
    const pets = a.pet_accommodations_code?.trim();
    return [{
      id: `fema-${a.shelter_id}`,
      name: a.shelter_name,
      address: [a.address, a.city, a.state].filter(Boolean).join(", "),
      location: { latitude: a.latitude, longitude: a.longitude },
      capacity,
      occupied: Math.min(capacity, a.total_population ?? 0),
      wheelchairAccessible: yes(a.wheelchair_accessible) || yes(a.ada_compliant),
      petFriendly: Boolean(pets) && !/^(n|no|none)$/i.test(pets!),
      medicalSupport: false,
      source: "fema" as const,
    }];
  });
}

export type ShelterSourceOptions = {
  /** Include DEMO_SHELTERS near the person. */
  demo: boolean;
  fetchFema?: (near: LatLng) => Promise<Shelter[]>;
  /** Called when FEMA can't be reached; demo shelters are still returned. */
  onError?: (error: unknown) => void;
};

/** Live FEMA open shelters plus, optionally, the demo shelters within 50 km. */
export function createShelterSource(options: ShelterSourceOptions): (near: LatLng) => Promise<Shelter[]> {
  const fetchFema = options.fetchFema ?? (near => fetchFemaOpenShelters(near));
  return async near => {
    const live = await fetchFema(near).catch(error => { options.onError?.(error); return []; });
    const demo = options.demo ? DEMO_SHELTERS.filter(s => distanceKm(s.location, near) <= 50) : [];
    return [...live, ...demo];
  };
}
