import type { FunctionDeclaration } from "@google/genai";
import type { Incident } from "@tempmhacks/shared";
import { circlePolygon, distanceKm, type LatLng } from "./geo.js";
import type { Closure, RouteSummary, Router } from "./routing.js";
import { evaluateShelter, rankDestinations, type Shelter } from "./shelters.js";

export type KnownIncident = Pick<Incident, "id" | "cameraId" | "confidence" | "latitude" | "longitude"> & { confirmedAt?: number };

/** Where the person is, as far as the service knows: their watched place. */
export type PersonContext = { place?: string; location?: LatLng };

export type ToolDeps = {
  router: Router;
  shelters: (near: LatLng) => Promise<Shelter[]>;
  incidents: () => KnownIncident[];
  /** Shelters this close to a confirmed incident are never suggested. */
  dangerRadiusKm: number;
  userAgent: string;
  clock?: () => number;
  fetch?: typeof fetch;
};

/** Routes avoid this much space around each confirmed incident. */
const ROUTE_BUFFER_M = 300;
const MAX_ROUTED_SHELTERS = 8;

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
function direction(from: LatLng, to: LatLng): string {
  const dy = to.latitude - from.latitude;
  const dx = (to.longitude - from.longitude) * Math.cos(from.latitude * Math.PI / 180);
  const degrees = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return COMPASS[Math.round(degrees / 45) % 8]!;
}

function directionsLink(route: RouteSummary): string {
  const p = (point: LatLng) => `${point.latitude.toFixed(5)}%2C${point.longitude.toFixed(5)}`;
  return `https://www.openstreetmap.org/directions?engine=fossgis_valhalla_car&route=${p(route.from)}%3B${p(route.to)}`;
}

function routeSummary(route: RouteSummary) {
  return {
    drive_minutes: Math.max(1, Math.round(route.durationMin)),
    distance_km: Math.round(route.distanceKm * 10) / 10,
    via: route.via.slice(0, 4),
    estimate_only: route.provider === "estimate",
    directions_link: directionsLink(route),
  };
}

const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object" as const, properties, required, additionalProperties: false });

/** Functions the agent can call. */
export const TOOL_DEFINITIONS: FunctionDeclaration[] = [
  {
    name: "get_situation",
    description: "The person's registered place and coordinates, the current local time, and every camera-confirmed fire or smoke incident within 25 km with its distance and direction from them. Call this before giving any advice that depends on where danger is.",
    parametersJsonSchema: object({}, []),
  },
  {
    name: "find_shelters",
    description: "The best open shelters for the person, ranked by drive time and fit. Shelters near confirmed incidents are excluded and routes avoid incident areas. Results marked demo are demonstration data: always tell the person a shelter is a demo shelter. Ask about the people, wheelchair, pets and medical needs first if you don't know them.",
    parametersJsonSchema: object({
      people: { type: "integer", description: "How many people need space" },
      wheelchair: { type: "boolean", description: "Someone uses a wheelchair" },
      pets: { type: "boolean", description: "They are bringing pets" },
      medical: { type: "boolean", description: "Someone needs medical support, e.g. oxygen or dialysis" },
    }, ["people", "wheelchair", "pets", "medical"]),
  },
  {
    name: "get_directions",
    description: "A driving route from the person to a destination, avoiding confirmed incident areas, with drive time, main roads and a map link to send them.",
    parametersJsonSchema: object({
      latitude: { type: "number" },
      longitude: { type: "number" },
      label: { type: "string", description: "Destination name, for your reference" },
    }, ["latitude", "longitude", "label"]),
  },
  {
    name: "search_places",
    description: "Find real places near the person on OpenStreetMap, e.g. \"hospital\", \"pharmacy\", \"urgent care\", \"grocery\", \"library\", \"gas station\". Returns names, addresses, coordinates and distances.",
    parametersJsonSchema: object({ query: { type: "string" } }, ["query"]),
  },
];

/** Run one function call. Failures come back as `{ error }` for the model to handle, never thrown. */
export async function runTool(name: string, input: Record<string, unknown>, person: PersonContext, deps: ToolDeps): Promise<Record<string, unknown>> {
  const ok = (value: Record<string, unknown>) => value;
  const fail = (message: string) => ({ error: message });
  const now = (deps.clock ?? Date.now)();
  const closures = (): Closure[] => deps.incidents().map(i => ({
    id: i.id, label: `the fire near camera ${i.cameraId}`, area: circlePolygon(i, ROUTE_BUFFER_M),
  }));
  try {
    if (name === "get_situation") {
      return ok({
        where: person.place ?? "unknown (ask where they are)",
        location: person.location ?? null,
        local_time: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Detroit" }).format(now),
        confirmed_incidents_nearby: person.location
          ? deps.incidents()
            .map(i => ({ i, km: distanceKm(person.location!, i) }))
            .filter(({ km }) => km <= 25)
            .sort((a, b) => a.km - b.km)
            .map(({ i, km }) => ({
              type: "fire or smoke", distance_km: Math.round(km * 10) / 10, direction_from_person: direction(person.location!, i),
              camera: i.cameraId, confidence: Math.round(i.confidence * 100) / 100,
              minutes_ago: i.confirmedAt ? Math.round((now - i.confirmedAt) / 60_000) : null,
            }))
          : [],
      });
    }
    if (!person.location) return fail("The person's location is unknown. Ask where they are and how to share it: Apple Maps, tap the blue location dot, Share, Messages, send it here.");
    const from = person.location;

    if (name === "find_shelters") {
      const needs = { people: Number(input.people) || 1, wheelchair: input.wheelchair === true, pets: input.pets === true, medical: input.medical === true };
      const nearest = (await deps.shelters(from))
        .sort((a, b) => distanceKm(a.location, from) - distanceKm(b.location, from))
        .slice(0, MAX_ROUTED_SHELTERS);
      const avoid = closures();
      const zones = deps.incidents().map(i => circlePolygon(i, deps.dangerRadiusKm * 1000));
      const routes = await Promise.all(nearest.map(s => deps.router.route({ from, to: s.location, avoid })));
      const ranked = rankDestinations(nearest.map((s, i) => evaluateShelter(s, routes[i]!, needs, zones, avoid)));
      return ok({
        shelters: ranked.map(d => ({
          name: d.shelter.name, address: d.shelter.address, location: d.shelter.location,
          demo: d.shelter.source === "demo", fits: d.reasons, cautions: d.cautions, ...routeSummary(d.route),
        })),
        note: ranked.length ? undefined : "No open shelter fits. Suggest calling 211 for shelter information.",
      });
    }
    if (name === "get_directions") {
      const to = { latitude: Number(input.latitude), longitude: Number(input.longitude) };
      if (!Number.isFinite(to.latitude) || !Number.isFinite(to.longitude)) return fail("latitude and longitude must be numbers");
      return ok(routeSummary(await deps.router.route({ from, to, avoid: closures() })));
    }
    if (name === "search_places") {
      const query = String(input.query ?? "").trim();
      if (!query) return fail("query is required");
      const url = new URL("https://nominatim.openstreetmap.org/search");
      const span = 0.25;
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "5");
      url.searchParams.set("bounded", "1");
      url.searchParams.set("viewbox", `${from.longitude - span},${from.latitude + span},${from.longitude + span},${from.latitude - span}`);
      const response = await (deps.fetch ?? fetch)(url, {
        headers: { accept: "application/json", "user-agent": deps.userAgent }, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return fail(`place search returned HTTP ${response.status}`);
      const results = await response.json() as { display_name?: string; name?: string; lat: string; lon: string }[];
      return ok({
        places: results.map(r => {
          const at = { latitude: Number(r.lat), longitude: Number(r.lon) };
          return { name: r.name || r.display_name?.split(",")[0], address: r.display_name, location: at, distance_km: Math.round(distanceKm(from, at) * 10) / 10 };
        }).sort((a, b) => a.distance_km - b.distance_km),
      });
    }
    return fail(`Unknown tool ${name}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
