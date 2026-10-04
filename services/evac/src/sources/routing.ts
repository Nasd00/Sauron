import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Closure, LatLng, RouteSummary } from "@tempmhacks/shared/evac";
import { decodePolyline, distanceKm, simplifyPath } from "../domain/geo.js";

export type RouteRequest = { from: LatLng; to: LatLng; avoid: Closure[] };
export interface Router {
  route(request: RouteRequest): Promise<RouteSummary>;
}

type CachedRoute = Omit<RouteSummary, "id" | "provider" | "source"> & { retrievedAt: number };

export function routeCacheKey({ from, to, avoid }: RouteRequest): string {
  const point = (p: LatLng) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
  const closures = avoid.map(closure => closure.id).sort().join("+") || "none";
  return `${point(from)}>${point(to)}|${closures}`;
}

/**
 * JSON-file route cache. A committed seed file keeps the demo scenario deterministic and
 * offline-capable; new lookups are written to a separate runtime file.
 */
export class RouteCache {
  readonly #entries = new Map<string, CachedRoute>();
  readonly #writePath?: string;

  constructor(options: { seedPaths?: string[]; writePath?: string } = {}) {
    this.#writePath = options.writePath;
    for (const path of [...(options.seedPaths ?? []), ...(options.writePath ? [options.writePath] : [])]) {
      if (!existsSync(path)) continue;
      const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, CachedRoute>;
      for (const [key, value] of Object.entries(data)) this.#entries.set(key, value);
    }
  }

  get(key: string): CachedRoute | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: CachedRoute): void {
    this.#entries.set(key, value);
    if (!this.#writePath) return;
    mkdirSync(dirname(this.#writePath), { recursive: true });
    writeFileSync(this.#writePath, `${JSON.stringify(Object.fromEntries(this.#entries), null, 1)}\n`);
  }

  entries(): Record<string, CachedRoute> {
    return Object.fromEntries(this.#entries);
  }
}

type ValhallaManeuver = { street_names?: string[]; length: number };
type ValhallaResponse = {
  trip?: { summary: { length: number; time: number }; legs: { shape: string; maneuvers: ValhallaManeuver[] }[] };
  error?: string;
  error_code?: number;
};

export type ValhallaRouterOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  cache?: RouteCache;
  timeoutMs?: number;
  userAgent?: string;
  /** When true, never call the network; serve cache hits or straight-line estimates. */
  offline?: boolean;
  onHealth?: (ok: boolean, detail: string) => void;
};

const VALHALLA_DEFAULT = "https://valhalla1.openstreetmap.de";

/**
 * Routes with Valhalla's public FOSSGIS instance, which supports `exclude_polygons`
 * so closures are avoided by the router itself rather than guessed afterwards.
 */
export class ValhallaRouter implements Router {
  readonly #options: Required<Omit<ValhallaRouterOptions, "cache" | "onHealth">> & Pick<ValhallaRouterOptions, "cache" | "onHealth">;
  #sequence = 0;

  constructor(options: ValhallaRouterOptions = {}) {
    this.#options = {
      baseUrl: options.baseUrl ?? VALHALLA_DEFAULT,
      fetch: options.fetch ?? fetch,
      timeoutMs: options.timeoutMs ?? 8000,
      userAgent: options.userAgent ?? "tempMhacks-evac/0.1 (MHacks demo)",
      offline: options.offline ?? false,
      cache: options.cache,
      onHealth: options.onHealth,
    };
  }

  async route(request: RouteRequest): Promise<RouteSummary> {
    const key = routeCacheKey(request);
    const id = `route-${++this.#sequence}`;
    const cached = this.#options.cache?.get(key);
    if (cached) return { ...cached, id, provider: "cache", source: this.#source(false, cached.retrievedAt) };
    if (!this.#options.offline) {
      try {
        const live = await this.#fetchRoute(request);
        this.#options.cache?.set(key, live);
        this.#options.onHealth?.(true, "Valhalla responded");
        return { ...live, id, provider: "valhalla", source: this.#source(true, live.retrievedAt) };
      } catch (error) {
        this.#options.onHealth?.(false, error instanceof Error ? error.message : String(error));
      }
    }
    return estimateRoute(request, id);
  }

  #source(live: boolean, retrievedAt: number) {
    return {
      name: "Valhalla routing on OpenStreetMap data",
      kind: "routing" as const,
      url: "https://valhalla1.openstreetmap.de",
      live,
      retrievedAt,
    };
  }

  async #fetchRoute({ from, to, avoid }: RouteRequest): Promise<CachedRoute> {
    const body = {
      locations: [
        { lat: from.latitude, lon: from.longitude },
        { lat: to.latitude, lon: to.longitude },
      ],
      costing: "auto",
      units: "kilometers",
      exclude_polygons: avoid.filter(closure => closure.status === "active").map(closure => {
        const ring = closure.area.map(point => [point.longitude, point.latitude]);
        return [...ring, ring[0]!];
      }),
    };
    const response = await this.#options.fetch(`${this.#options.baseUrl}/route`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": this.#options.userAgent },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#options.timeoutMs),
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
      avoidedClosureIds: avoid.map(closure => closure.id),
      retrievedAt: Date.now(),
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

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Straight-line fallback so the agent can still reason when routing is unreachable. Clearly labeled. */
export function estimateRoute({ from, to, avoid }: RouteRequest, id: string): RouteSummary {
  const distance = distanceKm(from, to) * 1.35;
  return {
    id, from, to,
    distanceKm: round(distance, 2),
    durationMin: round(distance / 35 * 60, 1),
    geometry: [from, to],
    via: [],
    provider: "estimate",
    avoidedClosureIds: avoid.map(closure => closure.id),
    source: { name: "Straight-line estimate (routing unavailable)", kind: "routing", live: false, retrievedAt: Date.now() },
  };
}
