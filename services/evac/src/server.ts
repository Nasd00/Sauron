import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EvacServerEvent } from "@tempmhacks/shared/evac";
import type { EvacAgent } from "./agent/agent.js";
import type { WebSimHub } from "./channels/web-sim.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 1000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 200) throw new HttpError(400, `${field} must be a short string`);
  return value;
};

/**
 * Local demo API + Server-Sent Events stream for the dashboard.
 * There is no authentication: it binds to loopback only and is not meant to be exposed.
 */
export class EvacServer {
  readonly #clients = new Set<ServerResponse>();
  readonly #server: Server;

  constructor(readonly agent: EvacAgent, readonly hub: WebSimHub) {
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        if (!response.headersSent) json(response, status, { error: error instanceof Error ? error.message : "Internal error" });
        else response.end();
      });
    });
    hub.onTyping = (participantId, typing) => this.broadcast({ type: "typing", participantId, typing });
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise(resolve => this.#server.listen(port, host, resolve));
  }

  close(): Promise<void> {
    for (const client of this.#clients) client.end();
    return new Promise(resolve => this.#server.close(() => resolve()));
  }

  broadcast(event: EvacServerEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients) client.write(frame);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/health":
        return json(response, 200, { ok: true });
      case "GET /api/state":
        return json(response, 200, this.agent.snapshot());
      case "GET /api/catalog":
        return json(response, 200, this.agent.catalog());
      case "GET /api/events":
        return this.#stream(request, response);
      case "POST /api/messages": {
        const body = await readJson(request);
        const participantId = optionalString(body.participantId, "participantId");
        const text = body.text;
        if (!participantId || typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
          throw new HttpError(400, `participantId and text (1-${MAX_TEXT_LENGTH} chars) are required`);
        }
        const participant = this.agent.participant(participantId);
        if (!participant) throw new HttpError(404, "Unknown participant");
        if (participant.channel.platform !== "web_sim") {
          throw new HttpError(409, `${participant.name} is connected over ${participant.channel.platform}; reply from that device`);
        }
        // Goes through Spectrum's message loop like any other platform.
        const id = this.hub.push(participantId, text.trim());
        return json(response, 202, { accepted: true, id });
      }
      case "POST /api/demo/warning": {
        const body = await readJson(request);
        await this.agent.issueWarning(optionalString(body.warningId, "warningId"));
        return json(response, 202, { accepted: true });
      }
      case "POST /api/demo/closure": {
        const body = await readJson(request);
        const closureId = optionalString(body.closureId, "closureId");
        if (!closureId) throw new HttpError(400, "closureId is required");
        await this.agent.injectClosure(closureId).catch(error => { throw new HttpError(404, (error as Error).message); });
        return json(response, 202, { accepted: true });
      }
      case "POST /api/demo/reset":
        await this.agent.reset();
        return json(response, 202, { accepted: true });
      default:
        throw new HttpError(404, "Not found");
    }
  }

  #stream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", snapshot: this.agent.snapshot() })}\n\n`);
    this.#clients.add(response);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      this.#clients.delete(response);
    });
  }
}
