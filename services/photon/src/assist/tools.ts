import type { FunctionDeclaration } from "@google/genai";
import { hazardLabel, isManualIncident, type Incident, type IncidentReport } from "@tempmhacks/shared";
import { circlePolygon, distanceKm, pointInPolygon, type LatLng } from "./geo.js";
import type { Closure, RouteSummary, Router } from "./routing.js";
import { evaluateShelter, rankDestinations, type Shelter } from "./shelters.js";

export type KnownIncident = Pick<Incident, "id" | "cameraId" | "confidence" | "latitude" | "longitude">
  & { type?: Incident["type"]; confirmedAt?: number; report?: IncidentReport };

/** Routes avoid this much space around each camera-confirmed incident. */
const ROUTE_BUFFER_M = 300;

/** Radius of the area people must leave: the operator's danger zone, or the configured default. */
export function dangerRadiusKmOf(incident: KnownIncident, defaultKm: number): number {
  return incident.report?.radiusKm ?? defaultKm;
}

/** Short words for what and where an incident is, for prompts and tool output. */
export function describeIncident(incident: KnownIncident): string {
  if (incident.report) return `${incident.report.title} (${hazardLabel(incident.type ?? "other")}, reported by an operator)`;
  return `${hazardLabel(incident.type ?? "smoke_fire")} seen by camera ${incident.cameraId}`;
}

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

const MAX_ROUTED_SHELTERS = 8;

/** Escape points sit this far beyond the edge of a danger zone. */
const SAFE_MARGIN_KM = 1;

function bearingDegrees(from: LatLng, to: LatLng): number {
  const dy = to.latitude - from.latitude;
  const dx = (to.longitude - from.longitude) * Math.cos(from.latitude * Math.PI / 180);
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

/** The point `km` from `origin` on compass bearing `degrees` (flat-earth; fine at city scale). */
export function offsetPoint(origin: LatLng, degrees: number, km: number): LatLng {
  const radians = degrees * Math.PI / 180;
  return {
    latitude: origin.latitude + (km * Math.cos(radians)) / 111.32,
    longitude: origin.longitude + (km * Math.sin(radians)) / (111.32 * Math.cos(origin.latitude * Math.PI / 180)),
  };
}

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
    description: "The person's registered place and coordinates, the current local time, and every active incident within 25 km: camera-confirmed fire or smoke, and dangerous events an operator reported by hand (with title, details and danger-zone radius). Includes distance, direction, and whether the person is inside the danger zone. Call this before giving any advice that depends on where danger is.",
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
    name: "get_escape_route",
    description: "The fastest way out of the danger zone the person is in or nearest to: a safe point just outside the zone in the direction away from the danger, a driving route there that avoids other danger zones, and the walking direction. Use this first when someone is inside or next to a danger zone and needs to get out.",
    parametersJsonSchema: object({}, []),
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
  const incidentArea = (i: KnownIncident) => i.report ? circlePolygon(i, i.report.radiusKm * 1000) : circlePolygon(i, ROUTE_BUFFER_M);
  // A router can't start inside an excluded area, so zones the person is already in are left out:
  // the route leads out of them, and every other zone is avoided.
  const closures = (from?: LatLng): Closure[] => deps.incidents()
    .map(i => ({ id: i.id, label: describeIncident(i), area: incidentArea(i) }))
    .filter(closure => !from || !pointInPolygon(from, closure.area));
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
              type: hazardLabel(i.type ?? "smoke_fire"), distance_km: Math.round(km * 10) / 10, direction_from_person: direction(person.location!, i),
              source: isManualIncident(i) ? "operator report" : "camera",
              ...(i.report ? { title: i.report.title, details: i.report.description || undefined } : { camera: i.cameraId }),
              confidence: Math.round(i.confidence * 100) / 100,
              danger_radius_km: dangerRadiusKmOf(i, deps.dangerRadiusKm),
              inside_danger_zone: km <= dangerRadiusKmOf(i, deps.dangerRadiusKm),
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
      const avoid = closures(from);
      const zones = deps.incidents().map(i => circlePolygon(i, dangerRadiusKmOf(i, deps.dangerRadiusKm) * 1000));
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
      return ok(routeSummary(await deps.router.route({ from, to, avoid: closures(from) })));
    }
    if (name === "get_escape_route") {
      const nearest = deps.incidents()
        .map(i => ({ i, km: distanceKm(from, i), radius: dangerRadiusKmOf(i, deps.dangerRadiusKm) }))
        .sort((a, b) => (a.km - a.radius) - (b.km - b.radius))[0];
      if (!nearest || nearest.km - nearest.radius > 25) return ok({ note: "No active danger zone near the person." });
      // Head straight away from the danger's center to just past the edge of its zone.
      const away = nearest.km < 0.01 ? 0 : bearingDegrees(nearest.i, from);
      const safePoint = offsetPoint(nearest.i, away, nearest.radius + SAFE_MARGIN_KM);
      const route = await deps.router.route({ from, to: safePoint, avoid: closures(from) });
      const inside = nearest.km <= nearest.radius;
      return ok({
        danger: describeIncident(nearest.i),
        inside_danger_zone: inside,
        distance_to_zone_edge_km: Math.round(Math.abs(nearest.radius - nearest.km) * 10) / 10,
        head: COMPASS[Math.round(away / 45) % 8],
        safe_point: { latitude: Math.round(safePoint.latitude * 1e5) / 1e5, longitude: Math.round(safePoint.longitude * 1e5) / 1e5 },
        ...routeSummary(route),
        note: inside ? "The person is inside the zone: tell them which way to go first, then the route." : undefined,
      });
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
