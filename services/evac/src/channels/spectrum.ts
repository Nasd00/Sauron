import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Participant } from "@tempmhacks/shared/evac";
import type { EvacAgent, Messenger } from "../agent/agent.js";
import { createWebSimPlatform, type WebSimHub } from "./web-sim.js";

export type SpectrumChannelOptions = {
  hub: WebSimHub;
  /** Photon Spectrum Cloud credentials. When absent, only the web simulator runs. */
  photon?: { projectId: string; projectSecret: string };
  /** Participant ID → phone/email handle to reach over iMessage instead of the simulator. */
  imessageHandles?: Record<string, string>;
  /** Simulated typing time before each web message, for a natural pace in the demo. */
  typingMs?: number;
  log?: (message: string) => void;
};

export type SpectrumChannels = {
  messenger: Messenger;
  /** Run the inbound loop, routing every text to the agent. Resolves when Spectrum stops. */
  listen(agent: EvacAgent): Promise<void>;
  channels: { platform: string; label: string; connected: boolean }[];
  stop(): Promise<void>;
};

const normalizeHandle = (handle: string) => handle.includes("@") ? handle.trim().toLowerCase() : handle.replace(/[^\d+]/g, "").replace(/^\+?1?(\d{10})$/, "+1$1");

export async function startSpectrumChannels(options: SpectrumChannelOptions): Promise<SpectrumChannels> {
  const webSim = createWebSimPlatform(options.hub);
  const useIMessage = Boolean(options.photon && Object.keys(options.imessageHandles ?? {}).length);
  // Platform narrowing needs the concrete provider tuple, so each branch narrows its own app.
  let app: { messages: AsyncIterable<[Space, Message]>; stop(): Promise<void> };
  let webSpace: (participantId: string) => Promise<Space>;
  let imessageSpace: ((address: string) => Promise<Space>) | undefined;
  if (useIMessage) {
    const both = await Spectrum({
      projectId: options.photon!.projectId,
      projectSecret: options.photon!.projectSecret,
      providers: [webSim.config(), imessage.config()],
      options: { logLevel: "warn" },
    });
    const web = webSim(both);
    const im = imessage(both);
    app = both;
    webSpace = id => web.space.get(id);
    imessageSpace = async address => im.space.create(await im.user(address));
  } else {
    const webOnly = await Spectrum({ providers: [webSim.config()], options: { logLevel: "warn" } });
    const web = webSim(webOnly);
    app = webOnly;
    webSpace = id => web.space.get(id);
  }
  const handleToParticipant = new Map(Object.entries(options.imessageHandles ?? {}).map(([id, handle]) => [normalizeHandle(handle), id]));
  const spaces = new Map<string, Space>();
  const typingMs = options.typingMs ?? 700;

  async function spaceFor(participant: Participant): Promise<Space> {
    const key = `${participant.channel.platform}:${participant.id}`;
    const cached = spaces.get(key);
    if (cached) return cached;
    let space: Space;
    if (participant.channel.platform === "imessage" && imessageSpace && participant.channel.address) {
      space = await imessageSpace(participant.channel.address);
    } else {
      space = await webSpace(participant.id);
    }
    spaces.set(key, space);
    return space;
  }

  const messenger: Messenger = {
    async deliver(participant, text) {
      const space = await spaceFor(participant);
      await space.responding(async () => {
        if (participant.channel.platform === "web_sim" && typingMs > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(typingMs * 2, typingMs + text.length * 4)));
        }
        await space.send(text);
      });
    },
  };

  async function listen(agent: EvacAgent): Promise<void> {
    for await (const [, message] of app.messages) {
      if (message.direction === "outbound" || message.content.type !== "text") continue;
      const senderId = message.sender?.id ?? "";
      const participantId = message.platform === "web_sim" ? senderId : handleToParticipant.get(normalizeHandle(senderId));
      if (!participantId || !agent.participant(participantId)) {
        options.log?.(`Ignoring ${message.platform} message from unenrolled sender`);
        continue;
      }
      agent.handleInbound(participantId, message.content.text, message.platform).catch(error => {
        options.log?.(`Agent error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  return {
    messenger,
    listen,
    channels: [
      { platform: "web_sim", label: "Dashboard phone simulator (Spectrum custom platform)", connected: true },
      ...(useIMessage ? [{ platform: "imessage", label: "iMessage via Photon Spectrum", connected: true }] : []),
    ],
    stop: () => app.stop(),
  };
}
