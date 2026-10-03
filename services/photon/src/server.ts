import { createServer, type IncomingHttpHeaders } from "node:http";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { connectDb } from "@tempmhacks/shared/db";
import { loadConfig } from "./config.js";
import { NominatimGeocoder } from "./geocoder.js";
import { normalizeSpectrumMessage } from "./normalize.js";
import { createMessageProcessor } from "./processor.js";
import { createCommandRouter } from "./router.js";
import { createMessagingStore } from "./store.js";

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
const geocoder = new NominatimGeocoder({
  baseUrl: config.geocoderBaseUrl,
  userAgent: config.geocoderUserAgent,
});
const route = createCommandRouter({ store, geocoder, radiusKm: config.watchRadiusKm });
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
  if (request.method !== "POST" || request.url !== "/spectrum/webhook") {
    response.writeHead(404).end();
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
  const result = await spectrumApp.webhook(
    { body: Buffer.concat(chunks), headers: normalizedHeaders(request.headers) },
    async (space, message) => {
      const normalized = normalizeSpectrumMessage(space, message);
      if (!normalized) return;
      await processMessage(normalized, text => space.send(text));
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
