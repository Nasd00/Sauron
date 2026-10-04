import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hazardLabel, type IncidentView, type MobileDevice } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";
import { haversineDistanceKm } from "@tempmhacks/shared/geo";

/**
 * Backend for the Sauron iPhone companion app. The app's only job is to keep the
 * paired user's current-location profile up to date; it never sees Spectrum or
 * SpacetimeDB credentials. Raw tokens exist only in transit and in the iPhone
 * Keychain: the database stores SHA-256 hashes.
 */

export const MOBILE_PAIRING_TTL_MINUTES = 10;
const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN_PATTERN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const MAX_BODY_BYTES = 16_384;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 256-bit, URL-safe pairing token. */
export function newPairingToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Device bearer token: `<deviceId>.<256-bit secret>`, so the device row can be read after auth. */
export function newDeviceToken(deviceId: string): string {
  return `${deviceId}.${randomBytes(32).toString("base64url")}`;
}

export function pairingUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/pair/${token}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Database operations the mobile API needs; token arguments are hashes. */
export interface MobileStore {
  createPairing(input: { tokenHash: string; userId: string; spaceId: string; senderId: string }): Promise<void>;
  redeemPairing(input: { pairingTokenHash: string; credentialTokenHash: string; deviceId: string }): Promise<void>;
  updateLocation(input: {
    credentialTokenHash: string; latitude: number; longitude: number;
    accuracyMeters: number; capturedAt: number; defaultRadiusKm: number;
  }): Promise<void>;
  setSharing(credentialTokenHash: string, enabled: boolean): Promise<void>;
  checkCredential(credentialTokenHash: string, deviceId: string): Promise<void>;
  getDevice(deviceId: string): MobileDevice | undefined;
  revokeDevice(deviceId: string): Promise<void>;
  /** Confirmed incidents, with operator reports attached. Optional so older tests keep working. */
  listActiveIncidents?(): IncidentView[];
  /** The location-backed profile a device updates. */
  getProfile?(userId: string): { latitude: number; longitude: number; radiusKm: number } | undefined;
}

/** An active incident near the device, as the app shows it and notifies about it. */
export type NearbyIncident = {
  id: string;
  title: string;
  hazard: string;
  source: "operator" | "camera";
  details?: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
  dangerRadiusKm: number;
  insideDangerZone: boolean;
  /** Compass direction straight away from the danger. */
  headAway: string;
  reportedAt: number;
};

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

/**
 * Incidents close enough to matter to someone at `at` with alert radius `radiusKm`, using the
 * alert service's overlap rule. Nearest first.
 */
export function nearbyIncidents(
  incidents: IncidentView[], at: { latitude: number; longitude: number }, radiusKm: number, cameraDangerRadiusKm: number,
): NearbyIncident[] {
  return incidents.flatMap(incident => {
    const danger = incident.report?.radiusKm ?? cameraDangerRadiusKm;
    const km = haversineDistanceKm(at.latitude, at.longitude, incident.latitude, incident.longitude);
    if (km > radiusKm + (incident.report?.radiusKm ?? 0)) return [];
    const dy = at.latitude - incident.latitude;
    const dx = (at.longitude - incident.longitude) * Math.cos(incident.latitude * Math.PI / 180);
    const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    return [{
      id: incident.id,
      title: incident.report?.title ?? hazardLabel(incident.type),
      hazard: hazardLabel(incident.type),
      source: incident.report ? "operator" as const : "camera" as const,
      ...(incident.report?.description ? { details: incident.report.description } : {}),
      latitude: incident.latitude, longitude: incident.longitude,
      distanceKm: Math.round(km * 10) / 10, dangerRadiusKm: danger, insideDangerZone: km <= danger,
      headAway: COMPASS[Math.round(bearing / 45) % 8]!,
      reportedAt: incident.report?.reportedAt ?? incident.confirmedAt ?? incident.lastSeenAt,
    }];
  }).sort((a, b) => a.distanceKm - b.distanceKm);
}

export function createMobileStore(db: Db): MobileStore {
  return {
    createPairing: input => db.mobile.createPairing(input),
    redeemPairing: input => db.mobile.redeemPairing(input),
    updateLocation: input => db.mobile.updateLocation(input),
    setSharing: (hash, enabled) => db.mobile.setSharing(hash, enabled),
    checkCredential: (hash, deviceId) => db.mobile.checkCredential(hash, deviceId),
    getDevice: deviceId => db.mobile.getDevice(deviceId),
    revokeDevice: deviceId => db.mobile.revokeDevice(deviceId),
    listActiveIncidents: () => db.incidents.listConfirmed().map(incident => db.incidents.view(incident.id) ?? incident),
    getProfile: userId => db.profiles.get(userId),
  };
}

/** Issues a single-use pairing link for a sender (the WATCH ME / PAIR command). */
export async function issuePairingLink(
  store: Pick<MobileStore, "createPairing">,
  baseUrl: string,
  user: { userId: string; spaceId: string; senderId: string },
): Promise<string> {
  const token = newPairingToken();
  await store.createPairing({ tokenHash: hashToken(token), ...user });
  return pairingUrl(baseUrl, token);
}

export type ApiResponse = { status: number; body: Record<string, unknown> };

/** Maps the module's coded reducer errors onto HTTP responses for the app. */
export function errorResponse(error: unknown): ApiResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code = /\b(pairing_invalid|pairing_used|pairing_expired|device_unauthorized|tracking_stopped|location_invalid|token_invalid)\b/
    .exec(message)?.[1];
  const status: Record<string, number> = {
    pairing_invalid: 404, pairing_used: 410, pairing_expired: 410,
    device_unauthorized: 401, token_invalid: 401, tracking_stopped: 403, location_invalid: 422,
  };
  if (!code) return { status: 502, body: { error: "unavailable", message: "Location service is unavailable" } };
  const detail = message.slice(message.indexOf(code) + code.length).replace(/^:\s*/, "");
  return { status: status[code]!, body: { error: code, message: detail || code } };
}

function deviceState(device: MobileDevice | undefined) {
  return device ? {
    deviceId: device.deviceId,
    trackingActive: device.trackingActive && !device.revoked,
    sharingEnabled: device.sharingEnabled,
    lastLocationAt: device.lastLocationAt ?? null,
    lastAccuracyMeters: device.lastAccuracyMeters ?? null,
  } : undefined;
}

function bearer(authorization: string | undefined): { token: string; deviceId: string } | undefined {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  const match = token ? DEVICE_TOKEN_PATTERN.exec(token) : null;
  return match ? { token: token!, deviceId: match[1]! } : undefined;
}

const unauthorized: ApiResponse = { status: 401, body: { error: "device_unauthorized", message: "device is not paired" } };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export type MobileApiOptions = {
  store: MobileStore;
  /** Radius for a newly created location-backed profile. */
  radiusKm: number;
  id?: () => string;
  /** Receives unexpected (non-coded) backend errors; coded errors are normal client outcomes. */
  onUnexpectedError?: (route: string, error: unknown) => void;
  /** Danger-zone radius for camera incidents, which have no operator radius. Defaults to 3 km. */
  dangerRadiusKm?: number;
  /** The help agent; enables POST /api/mobile/assist. Same conversation as the person's iMessages. */
  assistant?: {
    reply(person: { senderId: string; spaceId: string; place?: string; location?: { latitude: number; longitude: number } }, text: string): Promise<string>;
  };
  clock?: () => number;
};

/** Assist messages a device may send per window, so the app can't run up the model bill. */
const ASSIST_LIMIT = 20;
const ASSIST_WINDOW_MS = 10 * 60_000;
const MAX_ASSIST_TEXT = 1000;

/** Transport-independent handlers for the app's JSON API. */
export function createMobileApi(options: MobileApiOptions) {
  const id = options.id ?? randomUUID;
  const { store } = options;
  const clock = options.clock ?? Date.now;
  const assistUse = new Map<string, number[]>();
  const incidentsNear = (at: { latitude: number; longitude: number } | undefined, radiusKm: number): NearbyIncident[] =>
    at && store.listActiveIncidents ? nearbyIncidents(store.listActiveIncidents(), at, radiusKm, options.dangerRadiusKm ?? 3) : [];
  const profileOf = (deviceId: string) => {
    const device = store.getDevice(deviceId);
    return device ? store.getProfile?.(device.userId) : undefined;
  };
  const failure = (route: string, error: unknown): ApiResponse => {
    const response = errorResponse(error);
    if (response.status === 502) options.onUnexpectedError?.(route, error);
    return response;
  };

  return {
    /** POST /api/mobile/pair { pairingToken } → device token (returned once). */
    async pair(body: unknown): Promise<ApiResponse> {
      const pairingToken = (body as { pairingToken?: unknown } | null)?.pairingToken;
      if (typeof pairingToken !== "string" || !PAIRING_TOKEN_PATTERN.test(pairingToken)) {
        return { status: 404, body: { error: "pairing_invalid", message: "pairing link is not valid" } };
      }
      const deviceId = id();
      const deviceToken = newDeviceToken(deviceId);
      try {
        await store.redeemPairing({
          pairingTokenHash: hashToken(pairingToken), credentialTokenHash: hashToken(deviceToken), deviceId,
        });
      } catch (error) {
        return failure("pair", error);
      }
      return {
        status: 201,
        body: { deviceToken, ...deviceState(store.getDevice(deviceId)) ?? {
          deviceId, trackingActive: true, sharingEnabled: false, lastLocationAt: null, lastAccuracyMeters: null,
        } },
      };
    },

    /** POST /api/mobile/location — moves the paired user's single location-backed profile. */
    async location(authorization: string | undefined, body: unknown): Promise<ApiResponse> {
      const auth = bearer(authorization);
      if (!auth) return unauthorized;
      const input = (body ?? {}) as Record<string, unknown>;
      const { latitude, longitude, accuracyMeters, capturedAt } = input;
      if (!finite(latitude) || !finite(longitude) || !finite(accuracyMeters) || !finite(capturedAt)) {
        return {
          status: 422,
          body: { error: "location_invalid", message: "latitude, longitude, accuracyMeters, and capturedAt are required numbers" },
        };
      }
      try {
        await store.updateLocation({
          credentialTokenHash: hashToken(auth.token), latitude, longitude, accuracyMeters,
          capturedAt, defaultRadiusKm: options.radiusKm,
        });
      } catch (error) {
        return failure("location", error);
      }
      const radiusKm = profileOf(auth.deviceId)?.radiusKm ?? options.radiusKm;
      return { status: 200, body: { accepted: true, capturedAt, incidents: incidentsNear({ latitude, longitude }, radiusKm) } };
    },

    /** POST /api/mobile/sharing { enabled } — the in-app Start/Stop Sharing control. */
    async sharing(authorization: string | undefined, body: unknown): Promise<ApiResponse> {
      const auth = bearer(authorization);
      if (!auth) return unauthorized;
      const enabled = (body as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== "boolean") return { status: 422, body: { error: "invalid_request", message: "enabled must be a boolean" } };
      try {
        await store.setSharing(hashToken(auth.token), enabled);
      } catch (error) {
        return failure("sharing", error);
      }
      const state = deviceState(store.getDevice(auth.deviceId));
      return { status: 200, body: { ...state, sharingEnabled: enabled } };
    },

    /** GET /api/mobile/status — current device state, so the app learns about STOP / WATCH ME. */
    async status(authorization: string | undefined): Promise<ApiResponse> {
      const auth = bearer(authorization);
      if (!auth) return unauthorized;
      try {
        await store.checkCredential(hashToken(auth.token), auth.deviceId);
      } catch (error) {
        return failure("status", error);
      }
      const state = deviceState(store.getDevice(auth.deviceId));
      if (!state) return unauthorized;
      const profile = profileOf(auth.deviceId);
      return { status: 200, body: { ...state, incidents: incidentsNear(profile, profile?.radiusKm ?? options.radiusKm) } };
    },

    /** POST /api/mobile/assist { text } — ask the help agent, e.g. how to get out of a danger zone. */
    async assist(authorization: string | undefined, body: unknown): Promise<ApiResponse> {
      const auth = bearer(authorization);
      if (!auth) return unauthorized;
      if (!options.assistant) return { status: 503, body: { error: "assistant_unavailable", message: "The assistant is not enabled" } };
      const text = (body as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || !text.trim() || text.length > MAX_ASSIST_TEXT) {
        return { status: 422, body: { error: "invalid_request", message: `text must be 1-${MAX_ASSIST_TEXT} characters` } };
      }
      try {
        await store.checkCredential(hashToken(auth.token), auth.deviceId);
      } catch (error) {
        return failure("assist", error);
      }
      const device = store.getDevice(auth.deviceId);
      if (!device) return unauthorized;
      const now = clock();
      const recent = (assistUse.get(device.deviceId) ?? []).filter(at => now - at < ASSIST_WINDOW_MS);
      if (recent.length >= ASSIST_LIMIT) {
        return { status: 429, body: { error: "rate_limited", message: "Too many messages. If you are in danger, call 911." } };
      }
      assistUse.set(device.deviceId, [...recent, now]);
      const profile = store.getProfile?.(device.userId);
      const reply = await options.assistant.reply({
        senderId: device.senderId, spaceId: device.spaceId,
        ...(profile ? { place: "their iPhone's live location", location: { latitude: profile.latitude, longitude: profile.longitude } } : {}),
      }, text);
      return { status: 200, body: { reply, incidents: incidentsNear(profile, profile?.radiusKm ?? options.radiusKm) } };
    },

    /** POST /admin/mobile/revoke { deviceId } — server-side revocation (admin secret required). */
    async revoke(body: unknown): Promise<ApiResponse> {
      const deviceId = (body as { deviceId?: unknown } | null)?.deviceId;
      if (typeof deviceId !== "string" || !deviceId.trim()) {
        return { status: 400, body: { error: "invalid_request", message: "deviceId is required" } };
      }
      try {
        await store.revokeDevice(deviceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/does not exist/.test(message)) return { status: 404, body: { error: "not_found", message } };
        return failure("revoke", error);
      }
      return { status: 200, body: { revoked: true, deviceId } };
    },
  };
}

export type MobileApi = ReturnType<typeof createMobileApi>;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/**
 * Landing page for https://<host>/pair/<token>. It never redeems the token
 * (iMessage link previews fetch it); it hands the token to the app through the
 * `sauron://` scheme, or through a universal link when Associated Domains are set up.
 */
export function pairPage(token: string, apiBaseUrl: string): string {
  // The app pairs with (and later uploads to) the server that issued the link.
  const appUrl = `sauron://pair?token=${encodeURIComponent(token)}&api=${encodeURIComponent(apiBaseUrl.replace(/\/$/, ""))}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pair Sauron Location</title>
<style>
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 24px; color: #111; background: #fff; text-align: center; }
  @media (prefers-color-scheme: dark) { body { color: #f2f2f2; background: #000; } }
  main { max-width: 420px; margin: 0 auto; }
  a.button { display: block; margin: 32px 0 16px; padding: 16px; border-radius: 14px; background: #0a63d8; color: #fff; text-decoration: none; font-weight: 600; }
  p { line-height: 1.4; }
</style>
</head>
<body>
<main>
  <h1>Sauron Location</h1>
  <p>Open the Sauron app on this iPhone to keep your incident alerts matched to where you are.</p>
  <a class="button" href="${escapeHtml(appUrl)}">Open in Sauron</a>
  <p><small>This link works once and expires ${MOBILE_PAIRING_TTL_MINUTES} minutes after it was sent. If it has expired, text WATCH ME again.</small></p>
</main>
</body>
</html>`;
}

/** apple-app-site-association for universal links; only served when a team id is configured. */
export function appSiteAssociation(teamId: string, bundleId: string): Record<string, unknown> {
  return { applinks: { details: [{ appIDs: [`${teamId}.${bundleId}`], components: [{ "/": "/pair/*" }] }] } };
}

async function readJson(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413 };
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") };
  } catch {
    return { ok: false, status: 400 };
  }
}

function sendJson(response: ServerResponse, result: ApiResponse): void {
  response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(result.body));
}

export type MobileHttpOptions = {
  api: MobileApi;
  /** Public HTTPS base URL of this server (MOBILE_PAIRING_BASE_URL); pairing is disabled without it. */
  publicBaseUrl?: string;
  adminSecret: string;
  appleTeamId?: string;
  bundleId: string;
  logger: { info(fields: Record<string, unknown>, message: string): void };
};

/** Handles the companion-app routes; returns false for any other path. */
export function createMobileHttpHandler(options: MobileHttpOptions) {
  const { api } = options;
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && path === "/.well-known/apple-app-site-association") {
      if (!options.appleTeamId) { response.writeHead(404).end(); return true; }
      sendJson(response, { status: 200, body: appSiteAssociation(options.appleTeamId, options.bundleId) });
      return true;
    }
    const pairMatch = /^\/pair\/([^/]+)$/.exec(path);
    if (method === "GET" && pairMatch) {
      const token = decodeURIComponent(pairMatch[1]!);
      if (!options.publicBaseUrl || !PAIRING_TOKEN_PATTERN.test(token)) {
        response.writeHead(404, { "content-type": "text/plain" }).end("This pairing link is not valid.");
        return true;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      }).end(pairPage(token, options.publicBaseUrl));
      return true;
    }

    const routes: Record<string, string[]> = {
      "/api/mobile/pair": ["POST"], "/api/mobile/location": ["POST"], "/api/mobile/sharing": ["POST"],
      "/api/mobile/status": ["GET"], "/api/mobile/assist": ["POST"], "/admin/mobile/revoke": ["POST"],
    };
    const allowed = routes[path];
    if (!allowed) return false;
    if (!allowed.includes(method)) {
      response.writeHead(405, { allow: allowed.join(", ") }).end();
      return true;
    }
    const authorization = request.headers.authorization;
    if (path === "/api/mobile/status") {
      sendJson(response, await api.status(authorization));
      return true;
    }
    if (path === "/admin/mobile/revoke" && authorization !== `Bearer ${options.adminSecret}`) {
      sendJson(response, { status: 401, body: { error: "unauthorized" } });
      return true;
    }
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, { status: body.status, body: { error: "invalid_request", message: "body must be JSON" } });
      return true;
    }
    const result = path === "/api/mobile/pair" ? await api.pair(body.value)
      : path === "/api/mobile/location" ? await api.location(authorization, body.value)
        : path === "/api/mobile/sharing" ? await api.sharing(authorization, body.value)
          : path === "/api/mobile/assist" ? await api.assist(authorization, body.value)
          : await api.revoke(body.value);
    // Never log tokens or coordinates; the status code and route are enough to debug.
    options.logger.info({ route: path, status: result.status, error: result.body.error }, "mobile_api");
    sendJson(response, result);
    return true;
  };
}
