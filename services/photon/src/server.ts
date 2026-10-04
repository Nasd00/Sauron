import { createServer, type IncomingHttpHeaders } from "node:http";
import { GoogleGenAI } from "@google/genai";
import type { Incident } from "@tempmhacks/shared";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { connectDb } from "@tempmhacks/shared/db";
import { createImessageMessenger } from "@tempmhacks/messaging";
import { loadConfig } from "./config.js";
import { NominatimGeocoder } from "./geocoder.js";
import { normalizeSpectrumMessage } from "./normalize.js";
import { createMessageProcessor } from "./processor.js";
import { HelpAgent, type Person } from "./assist/agent.js";
import { ValhallaRouter } from "./assist/routing.js";
import { createShelterSource } from "./assist/shelters.js";
import { createMobileApi, createMobileHttpHandler, createMobileStore } from "./mobile.js";
import { createCommandRouter } from "./router.js";
import { createMessagingStore } from "./store.js";
import { parseRegistration, registerPhotonUser, RegistrationError } from "./users.js";
import { handleIncidentAdmin } from "./incidents.js";

const config = loadConfig();
const database = await connectDb({
  uri: config.spacetimeUri,
  database: config.spacetimeDatabase,
  token: config.spacetimeToken,
});
const store = createMessagingStore(database.db);
/** Photon's SpacetimeDB identity; the owner grants it operator rights so it can report incidents. */
const dbIdentity = (database.connection as { identity?: { toHexString(): string } }).identity?.toHexString();
const spectrumApp = await Spectrum({
  projectId: config.spectrumProjectId,
  projectSecret: config.spectrumProjectSecret,
  webhookSecret: config.spectrumWebhookSecret,
  providers: [imessage.config()],
});
const im = imessage(spectrumApp);
const userDirectory = {
  user: (phone: string) => im.user(phone),
  space: { create: (user: Awaited<ReturnType<typeof im.user>>) => im.space.create(user) },
};
const geocoder = new NominatimGeocoder({
  baseUrl: config.geocoderBaseUrl,
  userAgent: config.geocoderUserAgent,
});
const messenger = createImessageMessenger(spectrumApp);
const logger = {
  info: (fields: Record<string, unknown>, message: string) => console.info(JSON.stringify({ level: "info", message, ...fields })),
  error: (fields: Record<string, unknown>, message: string) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};
// Without a Gemini key photon runs exactly as before, with no help agent.
// Short retries ride out brief overloads; anything longer gets the fixed fallback reply instead of a slow text.
const gemini = config.geminiApiKey
  ? new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 4 } } })
  : undefined;
const helpAgent = gemini
  ? new HelpAgent({
    generate: params => gemini.models.generateContent(params),
    model: config.geminiModel,
    tools: {
      router: new ValhallaRouter({ userAgent: config.geocoderUserAgent }),
      shelters: createShelterSource({
        demo: config.assistDemoShelters,
        onError: error => logger.error({ error: String(error) }, "fema_shelters_unavailable"),
      }),
      dangerRadiusKm: config.assistRadiusKm,
      userAgent: config.geocoderUserAgent,
    },
    send: (spaceId, text) => messenger.sendText(spaceId, text),
    radiusKm: config.assistRadiusKm,
    logger,
  })
  : undefined;
/** Everyone photon can reach with a location: shared Apple Maps locations win over watches. */
function knownPeople(): Person[] {
  const people = new Map<string, Person>();
  for (const watch of database.db.watches.listActive()) {
    people.set(watch.senderId, {
      senderId: watch.senderId, spaceId: watch.spaceId, place: `${watch.placeLabel} (set with WATCH)`,
      location: { latitude: watch.latitude, longitude: watch.longitude },
    });
  }
  for (const profile of database.db.profiles.list()) {
    if (!profile.alertsEnabled) continue;
    people.set(profile.senderId, {
      senderId: profile.senderId, spaceId: profile.spaceId, place: "the location they shared from Apple Maps",
      location: { latitude: profile.latitude, longitude: profile.longitude },
    });
  }
  return [...people.values()];
}
if (helpAgent) {
  // The subscription doesn't replay existing rows: incidents confirmed before startup inform answers
  // silently, and only newly confirmed ones prompt an offer of help.
  // Views carry an operator's report (title, details, danger radius) for manual incidents.
  const view = (incident: Incident) => database.db.incidents.view(incident.id) ?? incident;
  helpAgent.loadIncidents(database.db.incidents.listConfirmed().map(view));
  const offerHelp = (incident: Incident) => {
    if (incident.status !== "confirmed") {
      if (incident.status === "resolved" || incident.status === "dismissed") helpAgent.forgetIncident(incident.id);
      return;
    }
    helpAgent.onIncident(view(incident), knownPeople())
      .catch(error => logger.error({ incidentId: incident.id, error: String(error) }, "help_agent_incident_failed"));
  };
  database.db.incidents.subscribe(offerHelp);
  // In case a report row lands after its incident; offers are once per person and incident.
  database.db.reports.subscribe(report => {
    const incident = database.db.incidents.get(report.incidentId);
    if (incident) offerHelp(incident);
  });
} else {
  logger.info({}, "help_agent_disabled: set GEMINI_API_KEY to enable");
}
const route = createCommandRouter({
  store, geocoder, radiusKm: config.watchRadiusKm, publicAppUrl: config.publicAppUrl, assistant: helpAgent,
  mobilePairingBaseUrl: config.mobilePairingBaseUrl,
});
const processMessage = createMessageProcessor({ store, route, logger });
const handleMobile = createMobileHttpHandler({
  api: createMobileApi({
    store: createMobileStore(database.db), radiusKm: config.watchRadiusKm,
    dangerRadiusKm: config.assistRadiusKm, assistant: helpAgent,
    onUnexpectedError: (route, error) => logger.error({ route, error: String(error) }, "mobile_api_backend_error"),
  }),
  publicBaseUrl: config.mobilePairingBaseUrl,
  adminSecret: config.photonAdminSecret,
  appleTeamId: config.appleTeamId,
  bundleId: config.mobileBundleId,
  logger,
});
if (!config.mobilePairingBaseUrl) logger.info({}, "mobile_pairing_disabled: set MOBILE_PAIRING_BASE_URL to enable WATCH ME");

function normalizedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) =>
    value === undefined ? [] : [[key.toLowerCase(), Array.isArray(value) ? value.join(",") : value]]));
}

/**
 * The web app enrolls phones from the globe, so /admin/users answers browser preflights from the
 * app's own origin (and the local Vite dev server). The admin secret is still required.
 */
const ADMIN_PATHS = new Set(["/admin/users", "/admin/incidents", "/admin/incidents/resolve"]);
const corsOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
try { corsOrigins.add(new URL(config.publicAppUrl).origin); } catch { /* not a URL: only local dev origins */ }
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !corsOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, ngrok-skip-browser-warning",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

const server = createServer(async (request, response) => {
  if (ADMIN_PATHS.has(request.url ?? "")) {
    for (const [name, value] of Object.entries(corsHeaders(request.headers.origin))) response.setHeader(name, value);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
  }
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  try {
    if (await handleMobile(request, response)) return;
  } catch (error) {
    logger.error({ error: String(error) }, "mobile_api_failed");
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }).end('{"error":"internal"}');
    return;
  }
  if (request.method !== "POST" || !(request.url === "/spectrum/webhook" || ADMIN_PATHS.has(request.url ?? ""))) {
    response.writeHead(404).end();
    return;
  }
  if (ADMIN_PATHS.has(request.url ?? "") && request.headers.authorization !== `Bearer ${config.photonAdminSecret}`) {
    response.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 1_000_000) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(value);
  }
  if (request.url === "/admin/incidents" || request.url === "/admin/incidents/resolve") {
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
    const result = await handleIncidentAdmin(request.url, body, database.db.incidents, dbIdentity);
    if (result.status < 300) logger.info({ path: request.url, incident: result.body.incident }, "incident_admin");
    else logger.error({ path: request.url, status: result.status, error: result.body.error }, "incident_admin_failed");
    response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
    return;
  }
  if (request.url === "/admin/users") {
    try {
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        throw new RegistrationError("body must be JSON");
      }
      const registered = await registerPhotonUser(userDirectory, parseRegistration(body), {
        geocoder, store, radiusKm: config.watchRadiusKm,
      });
      logger.info({ spaceId: registered.spaceId, watchId: registered.watch.id }, "photon_user_registered");
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(registered));
    } catch (error) {
      const invalid = error instanceof RegistrationError;
      if (!invalid) logger.error({ error: String(error) }, "photon_user_registration_failed");
      response.writeHead(invalid ? 400 : 502, { "content-type": "application/json" }).end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return;
  }

  const result = await spectrumApp.webhook(
    { body: Buffer.concat(chunks), headers: normalizedHeaders(request.headers) },
    async (space, message) => {
      const normalized = await normalizeSpectrumMessage(space, message);
      if (!normalized) return;
      await processMessage(
        normalized,
        text => messenger.sendText(normalized.spaceId, text),
        (url, caption) => messenger.sendAttachment(normalized.spaceId, new URL(url), { name: caption }),
      );
    },
  );
  response.writeHead(result.status, result.headers).end(Buffer.from(result.body));
});

server.listen(config.port, () => logger.info({ port: config.port, route: "/spectrum/webhook", dbIdentity }, "photon_server_started"));

async function shutdown(): Promise<void> {
  server.close();
  database.disconnect();
  await spectrumApp.stop();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
