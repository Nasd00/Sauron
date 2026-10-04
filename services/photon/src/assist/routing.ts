import { decodePolyline, distanceKm, simplifyPath, type LatLng, type Polygon } from "./geo.js";

/** An area routes must avoid, e.g. the surroundings of a camera-confirmed fire. */
export type Closure = { id: string; label: string; area: Polygon };

export type RouteSummary = {
  from: LatLng;
  to: LatLng;
  distanceKm: number;
  durationMin: number;
  geometry: LatLng[];
  /** Notable named roads along the route, in travel order. */
  via: string[];
  provider: "valhalla" | "estimate";
};

export type RouteRequest = { from: LatLng; to: LatLng; avoid: Closure[] };
export interface Router {
  route(request: RouteRequest): Promise<RouteSummary>;
}

type ValhallaManeuver = { street_names?: string[]; length: number };
type ValhallaResponse = {
  trip?: { summary: { length: number; time: number }; legs: { shape: string; maneuvers: ValhallaManeuver[] }[] };
  error?: string;
};

export type ValhallaRouterOptions = {
  baseUrl?: string;
  userAgent: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const point = (p: LatLng) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Driving routes from Valhalla's public FOSSGIS instance, which takes `exclude_polygons` so closures
 * are avoided by the router itself. Falls back to a labeled straight-line estimate when unreachable.
 */
export class ValhallaRouter implements Router {
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #cache = new Map<string, RouteSummary>();

  constructor(options: ValhallaRouterOptions) {
    this.#baseUrl = options.baseUrl ?? "https://valhalla1.openstreetmap.de";
    this.#userAgent = options.userAgent;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8000;
  }

  async route(request: RouteRequest): Promise<RouteSummary> {
    const key = `${point(request.from)}>${point(request.to)}|${request.avoid.map(c => c.id).sort().join("+")}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    try {
      const route = await this.#fetchRoute(request);
      this.#cache.set(key, route);
      return route;
    } catch {
      return estimateRoute(request);
    }
  }

  async #fetchRoute({ from, to, avoid }: RouteRequest): Promise<RouteSummary> {
    const response = await this.#fetch(`${this.#baseUrl}/route`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": this.#userAgent },
      body: JSON.stringify({
        locations: [{ lat: from.latitude, lon: from.longitude }, { lat: to.latitude, lon: to.longitude }],
        costing: "auto",
        units: "kilometers",
        exclude_polygons: avoid.map(closure => {
          const ring = closure.area.map(p => [p.longitude, p.latitude]);
          return [...ring, ring[0]!];
        }),
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const data = await response.json() as ValhallaResponse;
    if (!response.ok || !data.trip) throw new Error(`Valhalla ${response.status}: ${data.error ?? "no trip"}`);
    const leg = data.trip.legs[0];
    if (!leg) throw new Error("Valhalla returned no legs");
    return {
      from, to,
      distanceKm: round(data.trip.summary.length, 2),
      durationMin: round(data.trip.summary.time / 60, 1),
      geometry: simplifyPath(decodePolyline(leg.shape, 6)),
      via: notableStreets(leg.maneuvers),
      provider: "valhalla",
    };
  }
}

function notableStreets(maneuvers: ValhallaManeuver[]): string[] {
  const streets: string[] = [];
  for (const maneuver of maneuvers) {
    const name = maneuver.street_names?.[0];
    if (!name || maneuver.length < 0.25) continue;
    if (streets[streets.length - 1] !== name) streets.push(name);
  }
  return streets;
}

/** Straight-line fallback so the assistant can still help when routing is unreachable. Always labeled. */
export function estimateRoute({ from, to }: RouteRequest): RouteSummary {
  const distance = distanceKm(from, to) * 1.35;
  return {
    from, to,
    distanceKm: round(distance, 2),
    durationMin: round(distance / 35 * 60, 1),
    geometry: [from, to],
    via: [],
    provider: "estimate",
  };
}
