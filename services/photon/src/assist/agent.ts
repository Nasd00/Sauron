import { FinishReason, type Content, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import type { StructuredLogger } from "../types.js";
import { distanceKm, type LatLng } from "./geo.js";
import { dangerRadiusKmOf, describeIncident, runTool, TOOL_DEFINITIONS, type KnownIncident, type ToolDeps } from "./tools.js";

/**
 * Who the agent is talking to and where they are, as far as photon knows: a location they shared
 * from Apple Maps (preferred when fresh) or a place they set with WATCH.
 */
export type Person = {
  senderId: string;
  spaceId: string;
  /** How the location was learned, in words the model can relay, e.g. "Ann Arbor (set with WATCH)". */
  place?: string;
  location?: LatLng;
};

/** Tracks Google's current Flash model; override with GEMINI_MODEL. */
export const DEFAULT_MODEL = "gemini-flash-latest";

/** Sent whenever the model can't answer, so nobody in need is left with silence. */
export const FALLBACK_REPLY = "I'm having trouble answering right now. If anyone is in danger, call 911. For shelter, food, or other local help, call 211.";

/** Prefix for turns written by the service rather than the person. */
const PLATFORM = "[PLATFORM]";

const SYSTEM_PROMPT = `You are the text-message assistant for a community safety service. Cameras watch for fire and smoke, operators can mark any dangerous event (fire, flood, gas leak, chemical spill, violence) on a map with a danger zone around it, and people share their location (or set a place to watch) to get alerts about them. When someone texts you, help them with whatever they need in that moment: leaving their home, finding shelter, getting somewhere, smoke or air quality, medical needs, food, water, power or phone charging, a worried family member, or anything else.

Getting out: when someone is inside or next to a danger zone, your first job is helping them get out. Use get_escape_route and tell them plainly which way to go and the first road to take, then offer a shelter with find_shelters. Never route anyone through a danger zone. For a gas leak or chemical hazard also tell them not to use flames or switches and to stay upwind; for flooding, never to drive or walk through moving water; for violence, to get away and hide if they can't leave, and call 911 when safe.

Safety comes first. If anything suggests a threat to life right now (fire inside, trouble breathing, an injury, someone unresponsive, someone trapped), your first line is to call 911 now, before any questions.

How you write: these are iMessages read on a phone, often under stress. Keep each reply short (usually under 500 characters), plain text, no markdown headings or bold. A short numbered list is fine. Ask at most one or two questions at a time, and only what you need to help.

Facts: use your tools for anything about place, danger, shelters, routes, or local services. Never invent shelters, addresses, routes, times, or phone numbers. The numbers you may give without a tool are 911 (emergencies), 211 (local shelter, food and social services), 988 (mental health crisis), and Poison Control 1-800-222-1222. When a tool marks a shelter as demo, say it is a demo shelter. For other local resources (food banks, cooling or warming centers, outage information), find the nearest real place with search_places or point them to 211.

Location: if you don't know where they are, or their location is out of date and it matters, ask where they are and tell them how to share it: open Apple Maps, tap the blue location dot, then Share, then Messages, and send it here.

Limits: you can't call anyone, dispatch help, or book rides. Say so plainly and give the person the number to call instead. They can text STOP to stop alerts.

Turns that start with ${PLATFORM} come from the service, not the person (for example, a camera alert or an operator's danger report near them). Respond to those by writing the text to send the person. The person's own texts never start with ${PLATFORM}.`;

/** The service's turn telling the model about a new incident near the person. */
export function offerPrompt(incident: KnownIncident, km: number, dangerRadiusKm: number): string {
  const inside = km <= dangerRadiusKm;
  if (incident.report) {
    const details = incident.report.description ? ` Operator's details: "${incident.report.description}".` : "";
    return `${PLATFORM} An operator reported a dangerous event: ${describeIncident(incident)}, ${km.toFixed(1)} km from this person. The danger zone is ${dangerRadiusKm} km around it, so the person is ${inside ? "INSIDE the danger zone" : "outside the danger zone but nearby"}.${details} The alert service has already texted them a short notice. Write one short text checking whether they are safe and ${inside ? "telling them which way to go to get out now (call get_escape_route first)" : "offering help, for example with a route away or a shelter"}.`;
  }
  return `${PLATFORM} A camera (${incident.cameraId}) confirmed fire or smoke ${km.toFixed(1)} km from this person, ${Math.round(incident.confidence * 100)}% confidence. The alert service has already texted them a short incident notice. Write one short text checking whether they are safe and offering help, for example with leaving or finding shelter. Use get_situation for details.`;
}

export type GenerateContent = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

export type HelpAgentOptions = {
  generate: GenerateContent;
  model?: string;
  tools: Omit<ToolDeps, "incidents">;
  /** Proactive texts (offers of help after an incident) into a person's conversation. */
  send: (spaceId: string, text: string) => Promise<unknown>;
  /** People this close to a newly confirmed incident are offered help. */
  radiusKm: number;
  logger?: StructuredLogger;
  clock?: () => number;
};

type Conversation = { contents: Content[]; lastActiveAt: number };

/** Conversations idle this long start fresh. */
const IDLE_RESET_MS = 6 * 60 * 60_000;
/** Long conversations start fresh rather than growing without bound. */
const MAX_MESSAGES = 80;
/** Responses that were withheld; the person gets FALLBACK_REPLY instead. */
const BLOCKED = new Set<FinishReason>([
  FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT, FinishReason.BLOCKLIST, FinishReason.SPII, FinishReason.RECITATION,
]);
/** Tool round-trips allowed per reply before giving up. */
const MAX_STEPS = 8;

/**
 * Gemini-backed help over iMessage, one conversation per person. It answers any text from someone
 * who isn't using a photon command, and offers help to people near a newly confirmed incident.
 * Conversations live in memory, so a restart starts everyone fresh.
 */
export class HelpAgent {
  readonly #options: HelpAgentOptions;
  readonly #conversations = new Map<string, Conversation>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #incidents = new Map<string, KnownIncident>();
  /** `${senderId}:${incidentId}` pairs already offered help, so incident row updates don't re-text. */
  readonly #offered = new Set<string>();

  constructor(options: HelpAgentOptions) {
    this.#options = options;
  }

  #now(): number { return (this.#options.clock ?? Date.now)(); }

  /** True while someone has an ongoing conversation, so their texts go to the agent first. */
  isActive(senderId: string): boolean {
    const conversation = this.#conversations.get(senderId);
    return conversation !== undefined && this.#now() - conversation.lastActiveAt < IDLE_RESET_MS;
  }

  end(senderId: string): void {
    this.#conversations.delete(senderId);
  }

  /** Remember incidents confirmed before startup without texting anyone about them. */
  loadIncidents(incidents: KnownIncident[]): void {
    for (const incident of incidents) this.#incidents.set(incident.id, incident);
  }

  /** A resolved or dismissed incident no longer shapes answers or routes. */
  forgetIncident(incidentId: string): void {
    this.#incidents.delete(incidentId);
  }

  /** Incidents the agent currently treats as active, for other surfaces (web, iOS). */
  activeIncidents(): KnownIncident[] {
    return [...this.#incidents.values()];
  }

  /** Answer a text from a person. Always resolves to something to send. */
  reply(person: Person, text: string): Promise<string> {
    // A person can't pose as the service.
    const clean = text.trim().replace(/^\[PLATFORM\]\s*/i, "");
    return this.#serialize(person.senderId, () => this.#turn(person, clean));
  }

  /** A newly confirmed incident: offer help to everyone registered near it, once per incident. */
  async onIncident(incident: KnownIncident, people: Person[]): Promise<void> {
    this.#incidents.set(incident.id, incident);
    await Promise.all(people.map(async person => {
      if (!person.location) return;
      const km = distanceKm(incident, person.location);
      const key = `${person.senderId}:${incident.id}`;
      // Manual reports carry a danger zone: everyone within it, plus the usual margin, is offered help.
      if (km > this.#options.radiusKm + (incident.report?.radiusKm ?? 0) || this.#offered.has(key)) return;
      this.#offered.add(key);
      const event = offerPrompt(incident, km, dangerRadiusKmOf(incident, this.#options.tools.dangerRadiusKm));
      const text = await this.#serialize(person.senderId, () => this.#turn(person, event));
      try {
        await this.#options.send(person.spaceId, text);
      } catch (error) {
        this.#options.logger?.error({ spaceId: person.spaceId, error: String(error) }, "help_agent_send_failed");
      }
    }));
  }

  #serialize<T>(senderId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(senderId) ?? Promise.resolve()).then(work);
    this.#queues.set(senderId, next.catch(() => undefined));
    return next;
  }

  #conversationFor(person: Person): Conversation {
    const existing = this.#conversations.get(person.senderId);
    if (existing && this.isActive(person.senderId) && existing.contents.length < MAX_MESSAGES) return existing;
    const where = person.location
      ? `${person.place ?? "a shared location"} (${person.location.latitude.toFixed(4)}, ${person.location.longitude.toFixed(4)})`
      : "unknown";
    const fresh: Conversation = {
      contents: [{ role: "user", parts: [{ text: `${PLATFORM} New conversation. Where the person is: ${where}.` }] }],
      lastActiveAt: this.#now(),
    };
    this.#conversations.set(person.senderId, fresh);
    return fresh;
  }

  async #turn(person: Person, text: string): Promise<string> {
    const { senderId } = person;
    const conversation = this.#conversationFor(person);
    conversation.lastActiveAt = this.#now();
    const { contents } = conversation;
    // The opening context and the first text form one user turn.
    const last = contents.at(-1);
    if (contents.length === 1 && last?.role === "user") last.parts!.push({ text });
    else contents.push({ role: "user", parts: [{ text }] });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await this.#options.generate({
          model: this.#options.model ?? DEFAULT_MODEL,
          contents,
          config: { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations: TOOL_DEFINITIONS }] },
        });
        const candidate = response.candidates?.[0];
        if (!candidate?.content || response.promptFeedback?.blockReason || BLOCKED.has(candidate.finishReason as FinishReason)) {
          // Keep history valid for the next turn without the blocked content.
          contents.push({ role: "model", parts: [{ text: FALLBACK_REPLY }] });
          return FALLBACK_REPLY;
        }
        // Appended whole: thought signatures in the parts must go back unchanged.
        contents.push(candidate.content);
        const calls = response.functionCalls ?? [];
        if (calls.length) {
          const results = await Promise.all(calls.map(async call => ({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: await runTool(call.name ?? "", call.args ?? {}, person, {
                ...this.#options.tools, incidents: () => [...this.#incidents.values()],
              }),
            },
          })));
          contents.push({ role: "user", parts: results });
          continue;
        }
        return response.text?.trim() || FALLBACK_REPLY;
      }
      this.#options.logger?.error({ senderId }, "help_agent_step_limit");
    } catch (error) {
      this.#options.logger?.error({ error: error instanceof Error ? error.message : String(error) }, "help_agent_failed");
    }
    // The conversation may now end mid-exchange; start fresh next time rather than send an invalid history.
    this.#conversations.delete(senderId);
    return FALLBACK_REPLY;
  }
}
