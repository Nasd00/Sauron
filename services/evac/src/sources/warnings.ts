import type { LatLng, OfficialWarning, WarningSeverity } from "@tempmhacks/shared/evac";

type NwsFeature = {
  id: string;
  geometry: { type: string; coordinates: number[][][] | number[][][][] } | null;
  properties: {
    id: string; event: string; severity: string; headline?: string | null; description?: string;
    instruction?: string | null; areaDesc: string; sent: string; expires?: string | null;
  };
};

const SEVERITIES: WarningSeverity[] = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];

/** Active National Weather Service alerts for a point (api.weather.gov; US only, no key). */
export async function fetchNwsAlerts(point: LatLng, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<OfficialWarning[]> {
  const url = `https://api.weather.gov/alerts/active?point=${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`;
  const response = await (options.fetch ?? fetch)(url, {
    headers: { accept: "application/geo+json", "user-agent": "tempMhacks-evac/0.1 (MHacks demo)" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
  });
  if (!response.ok) throw new Error(`NWS alerts ${response.status}`);
  const data = await response.json() as { features?: NwsFeature[] };
  const retrievedAt = Date.now();
  return (data.features ?? []).map(feature => {
    const p = feature.properties;
    return {
      id: `nws-${p.id}`,
      event: p.event,
      severity: SEVERITIES.includes(p.severity as WarningSeverity) ? p.severity as WarningSeverity : "Unknown",
      headline: p.headline ?? p.event,
      instruction: (p.instruction ?? p.description ?? "").replace(/\s+/g, " ").trim(),
      areaLabel: p.areaDesc,
      area: outerRing(feature.geometry),
      issuedAt: Date.parse(p.sent),
      expiresAt: p.expires ? Date.parse(p.expires) : undefined,
      source: { name: "National Weather Service", kind: "official", url: feature.id, live: true, retrievedAt },
    };
  });
}

function outerRing(geometry: NwsFeature["geometry"]): LatLng[] {
  if (!geometry) return [];
  const ring = geometry.type === "Polygon"
    ? (geometry.coordinates as number[][][])[0]
    : geometry.type === "MultiPolygon" ? (geometry.coordinates as number[][][][])[0]?.[0] : undefined;
  return (ring ?? []).slice(0, -1).map(([longitude, latitude]) => ({ latitude: latitude!, longitude: longitude! }));
}
