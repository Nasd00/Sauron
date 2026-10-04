import type { LatLng, Shelter } from "@tempmhacks/shared/evac";

const FEMA_OPEN_SHELTERS = "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0/query";

type FemaAttributes = {
  shelter_id: number | string; shelter_name: string; address?: string; city?: string; state?: string;
  shelter_status?: string; evacuation_capacity?: number | null; total_population?: number | null;
  wheelchair_accessible?: string | null; ada_compliant?: string | null; pet_accommodations_code?: string | null;
  latitude: number; longitude: number;
};

const yes = (value: string | null | undefined) => typeof value === "string" && /^(y|yes|true|1)$/i.test(value.trim());

/**
 * Open shelters reported to FEMA's National Shelter System near a point. Accessibility
 * flags are only treated as true when the record explicitly says so.
 */
export async function fetchFemaOpenShelters(
  point: LatLng,
  options: { radiusMiles?: number; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Shelter[]> {
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${point.longitude},${point.latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(options.radiusMiles ?? 40),
    units: "esriSRUnit_StatuteMile",
    outFields: "shelter_id,shelter_name,address,city,state,shelter_status,evacuation_capacity,total_population,wheelchair_accessible,ada_compliant,pet_accommodations_code,latitude,longitude",
    returnGeometry: "false",
    f: "json",
  });
  const response = await (options.fetch ?? fetch)(`${FEMA_OPEN_SHELTERS}?${params}`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
  });
  if (!response.ok) throw new Error(`FEMA shelters ${response.status}`);
  const data = await response.json() as { features?: { attributes: FemaAttributes }[]; error?: { message: string } };
  if (data.error) throw new Error(`FEMA shelters: ${data.error.message}`);
  const retrievedAt = Date.now();
  return (data.features ?? []).map(({ attributes: a }) => {
    const capacity = a.evacuation_capacity ?? 0;
    const pets = a.pet_accommodations_code?.trim();
    return {
      id: `fema-${a.shelter_id}`,
      name: a.shelter_name,
      address: [a.address, a.city, a.state].filter(Boolean).join(", "),
      location: { latitude: a.latitude, longitude: a.longitude },
      capacity,
      occupied: Math.min(capacity, a.total_population ?? 0),
      wheelchairAccessible: yes(a.wheelchair_accessible) || yes(a.ada_compliant),
      petFriendly: Boolean(pets) && !/^(n|no|none)$/i.test(pets!),
      medicalSupport: false,
      status: /open/i.test(a.shelter_status ?? "") ? "open" : "closed",
      source: {
        name: "FEMA National Shelter System (open shelters)", kind: "official",
        url: "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0", live: true, retrievedAt,
      },
    } satisfies Shelter;
  });
}
