import { randomUUID } from "node:crypto";
import { definePlatform } from "spectrum-ts";
import z from "zod";

type InboundRecord = { id: string; participantId: string; text: string; at: number };

/**
 * In-process bridge between the dashboard's phone simulators and Spectrum. Inbound texts are
 * pushed by the HTTP server; outbound texts and typing signals are surfaced to SSE listeners.
 */
export class WebSimHub {
  #buffer: InboundRecord[] = [];
  #waiters: ((record: InboundRecord | undefined) => void)[] = [];
  #closed = false;
  onOutbound: (participantId: string, text: string) => void = () => undefined;
  onTyping: (participantId: string, typing: boolean) => void = () => undefined;

  push(participantId: string, text: string): string {
    const record = { id: randomUUID(), participantId, text, at: Date.now() };
    const waiter = this.#waiters.shift();
    if (waiter) waiter(record); else this.#buffer.push(record);
    return record.id;
  }

  async *stream(): AsyncGenerator<InboundRecord> {
    while (!this.#closed) {
      const record = this.#buffer.shift() ?? await new Promise<InboundRecord | undefined>(resolve => this.#waiters.push(resolve));
      if (record) yield record;
    }
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }
}

/** A Spectrum platform for the dashboard simulators, so web chats run through the same agent loop as iMessage. */
export function createWebSimPlatform(hub: WebSimHub) {
  return definePlatform("web_sim", {
    config: z.object({}),
    lifecycle: {
      createClient: async () => hub,
      destroyClient: async ({ client }) => client.close(),
    },
    user: { resolve: async ({ input }) => ({ id: input.userID }) },
    space: {
      create: async ({ input }) => ({ id: input.users[0]?.id ?? "unknown" }),
      get: async ({ input }) => ({ id: input.id }),
    },
    async *messages({ client }) {
      for await (const record of client.stream()) {
        yield {
          id: record.id,
          content: { type: "text" as const, text: record.text },
          sender: { id: record.participantId },
          space: { id: record.participantId },
          timestamp: new Date(record.at),
        };
      }
    },
    send: async ({ space, content, client }) => {
      switch (content.type) {
        case "text":
          client.onOutbound(space.id, content.text);
          return { id: randomUUID(), content, space: { id: space.id }, timestamp: new Date() };
        case "markdown":
          client.onOutbound(space.id, content.markdown);
          return { id: randomUUID(), content, space: { id: space.id }, timestamp: new Date() };
        case "typing":
          client.onTyping(space.id, content.state === "start");
          return undefined;
        default:
          return undefined;
      }
    },
  });
}
