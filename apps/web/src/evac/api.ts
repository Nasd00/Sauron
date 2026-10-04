import type { EvacServerEvent, EvacSnapshot } from "@tempmhacks/shared/evac";

export type Catalog = {
  warnings: { id: string; event: string; areaLabel: string }[];
  closures: { id: string; road: string; description: string }[];
};

async function post(path: string, body: unknown = {}): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
}

export const api = {
  catalog: async (): Promise<Catalog> => (await fetch("/api/catalog")).json() as Promise<Catalog>,
  sendMessage: (participantId: string, text: string) => post("/api/messages", { participantId, text }),
  issueWarning: (warningId?: string) => post("/api/demo/warning", { warningId }),
  injectClosure: (closureId: string) => post("/api/demo/closure", { closureId }),
  reset: () => post("/api/demo/reset"),
};

export type StreamHandlers = {
  onSnapshot(snapshot: EvacSnapshot): void;
  onTyping(participantId: string, typing: boolean): void;
  onConnection(connected: boolean): void;
};

/** Subscribe to the agent's SSE stream. EventSource reconnects on its own after drops. */
export function subscribe(handlers: StreamHandlers): () => void {
  const source = new EventSource("/api/events");
  const parse = (event: MessageEvent<string>) => JSON.parse(event.data) as EvacServerEvent;
  source.addEventListener("open", () => handlers.onConnection(true));
  source.addEventListener("error", () => handlers.onConnection(false));
  source.addEventListener("snapshot", event => {
    const data = parse(event as MessageEvent<string>);
    if (data.type === "snapshot") handlers.onSnapshot(data.snapshot);
  });
  source.addEventListener("typing", event => {
    const data = parse(event as MessageEvent<string>);
    if (data.type === "typing") handlers.onTyping(data.participantId, data.typing);
  });
  return () => source.close();
}
