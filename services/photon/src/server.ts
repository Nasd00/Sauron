import { createServer, type IncomingHttpHeaders } from "node:http";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { connectDb } from "@tempmhacks/shared/db";
import { createImessageMessenger } from "@tempmhacks/messaging";
import { loadConfig } from "./config.js";
import { NominatimGeocoder } from "./geocoder.js";
import { normalizeSpectrumMessage } from "./normalize.js";
import { createMessageProcessor } from "./processor.js";
import { createCommandRouter } from "./router.js";
import { createMessagingStore } from "./store.js";
import { registerPhotonUser, RegistrationError } from "./users.js";

const config = loadConfig();
const database = await connectDb({
  uri: config.spacetimeUri,
  database: config.spacetimeDatabase,
  token: config.spacetimeToken,
});
const store = createMessagingStore(database.db);
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
const route = createCommandRouter({ store, geocoder, radiusKm: config.watchRadiusKm });
const messenger = createImessageMessenger(spectrumApp);
const logger = {
  info: (fields: Record<string, unknown>, message: string) => console.info(JSON.stringify({ level: "info", message, ...fields })),
  error: (fields: Record<string, unknown>, message: string) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};
const processMessage = createMessageProcessor({ store, route, logger });

function normalizedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) =>
    value === undefined ? [] : [[key.toLowerCase(), Array.isArray(value) ? value.join(",") : value]]));
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (request.method !== "POST" || !["/spectrum/webhook", "/admin/users"].includes(request.url ?? "")) {
    response.writeHead(404).end();
    return;
  }
  if (request.url === "/admin/users" && request.headers.authorization !== `Bearer ${config.photonAdminSecret}`) {
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
  if (request.url === "/admin/users") {
    try {
      let body: { phone?: unknown; place?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        throw new RegistrationError("body must be JSON");
      }
      if (typeof body.phone !== "string") throw new RegistrationError("phone is required");
      if (typeof body.place !== "string") throw new RegistrationError("place is required");
      const registered = await registerPhotonUser(userDirectory, { phone: body.phone, place: body.place }, {
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
      const normalized = normalizeSpectrumMessage(space, message);
      if (!normalized) return;
      await processMessage(normalized, text => messenger.sendText(normalized.spaceId, text));
    },
  );
  response.writeHead(result.status, result.headers).end(Buffer.from(result.body));
});

server.listen(config.port, () => logger.info({ port: config.port, route: "/spectrum/webhook" }, "photon_server_started"));

async function shutdown(): Promise<void> {
  server.close();
  database.disconnect();
  await spectrumApp.stop();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
