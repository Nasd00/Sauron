import type {
  Arrangement, Closure, DestinationOption, EvacSnapshot, GodsEyeIncident, Helper, Household,
  OfficialWarning, Participant, RouteSummary, Shelter, SourceRef, TimelineEvent, TimelineKind, TranscriptEntry,
} from "@tempmhacks/shared/evac";
import { isActive, transition } from "../domain/arrangement.js";
import { evaluateShelter, rankDestinations } from "../domain/destinations.js";
import { circlePolygon, distanceKm, distanceToPathKm, pathIntersectsPolygon, pointInPolygon } from "../domain/geo.js";
import { candidateHelpers } from "../domain/helpers.js";
import { missingDetails, parseHouseholdMessage } from "../domain/intake.js";
import type { Scenario } from "../scenario/ann-arbor.js";
import type { Router } from "../sources/routing.js";
import * as say from "./messages.js";

export interface Messenger {
  /** Deliver text to a participant over their channel. Resolves once handed to the provider. */
  deliver(participant: Participant, text: string): Promise<void>;
}
export type Scheduler = (callback: () => void, delayMs: number) => () => void;
type ActiveRoute = { household: Household; arrangement?: Arrangement; leg: "trip" | "pickup"; route: RouteSummary };

export type EvacAgentOptions = {
  scenario: (now: number) => Scenario;
  router: Router;
  messenger: Messenger;
  clock?: () => number;
  schedule?: Scheduler;
  /** How long a helper has to answer before the request goes to the next driver. */
  helperTimeoutMs?: number;
  /** Boarding time added between pickup and departure. */
  boardingMin?: number;
  onChange?: (snapshot: EvacSnapshot) => void;
};

const YES = /^(y|yes|yeah|yep|ok|okay|sure|please|do it|send it|go ahead)\b/i;
const NO = /^(n|no|nope|don't|do not|cancel)\b/i;
const ACCEPT = /^(accept|accepted|yes|y|ok|okay|on my way|omw|confirm)\b/i;
const DECLINE = /^(decline|declined|no|n|can't|cannot|unavailable|sorry)\b/i;
const PICKED_UP = /picked ?up|aboard|got them|in the (van|car)/i;
const ARRIVED = /^arrived\b|we('re| are) here|made it|arrived at|we've arrived|dropped (them )?off/i;

/**
 * The evacuation-assist agent. It monitors an official warning, resolves household constraints over
 * conversation, arranges transport with an enrolled helper, reroutes on verified closures, and tracks
 * whether the arrangement actually happened. All mutations run through a single queue.
 */
export class EvacAgent {
  readonly #options: Required<Omit<EvacAgentOptions, "onChange">> & Pick<EvacAgentOptions, "onChange">;
  #scenario!: Scenario;
  #startedAt = 0;
  #activeWarnings: OfficialWarning[] = [];
  #liveWarnings: OfficialWarning[] = [];
  #liveShelters: Shelter[] = [];
  #shelters!: Map<string, Shelter>;
  #households!: Map<string, Household>;
  #helpers!: Map<string, Helper>;
  #participants!: Map<string, Participant>;
  #closures: Closure[] = [];
  #arrangements = new Map<string, Arrangement>();
  #options_by_household: Record<string, DestinationOption[]> = {};
  #transcript: TranscriptEntry[] = [];
  #timeline: TimelineEvent[] = [];
  #incidents: GodsEyeIncident[] = [];
  #processedIncidents = new Set<string>();
  #channels: EvacSnapshot["channels"] = [];
  #health = new Map<string, EvacSnapshot["sourceHealth"][number]>();
  #timers = new Map<string, () => void>();
  #queue: Promise<unknown> = Promise.resolve();
  #sequence = 0;

  constructor(options: EvacAgentOptions) {
    this.#options = {
      clock: Date.now,
      schedule: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); },
      helperTimeoutMs: 2 * 60_000,
      boardingMin: 4,
      ...options,
    };
    this.#load();
  }

  // ---- public API (all serialized) ----

  reset(): Promise<void> {
    return this.#run(() => { this.#load(); this.#log("system", "Scenario reset"); });
  }

  /** Activate the supplied official warning and notify every household inside its area. */
  issueWarning(warningId?: string): Promise<void> {
    return this.#run(async () => {
      const warning = this.#scenario.warnings.find(w => !warningId || w.id === warningId);
      if (!warning) throw new Error(`Unknown warning ${warningId}`);
      if (this.#activeWarnings.some(w => w.id === warning.id)) return;
      const issued = { ...warning, issuedAt: this.#now() };
      this.#activeWarnings.push(issued);
      this.#log("warning", `${issued.event}: ${issued.areaLabel}`, issued.headline, issued.source);
      for (const household of this.#households.values()) {
        if (!pointInPolygon(household.location, issued.area) || household.stage !== "idle") continue;
        household.stage = "warned";
        await this.#send(household.residentId, say.warningNotice(issued, household));
      }
    });
  }

  handleInbound(participantId: string, text: string, platform = "web_sim"): Promise<void> {
    return this.#run(async () => {
      const participant = this.#participants.get(participantId);
      if (!participant) throw new Error(`Unknown participant ${participantId}`);
      const clean = text.trim();
      if (!clean) return;
      this.#transcript.push({ id: this.#id("msg"), participantId, direction: "inbound", text: clean, at: this.#now(), platform });
      if (participant.role === "resident") await this.#onResident(participant, clean);
      else await this.#onHelper(participant, clean);
    });
  }

  /** Activate a closure from the scenario's verified closure feed. */
  injectClosure(closureId: string): Promise<void> {
    return this.#run(async () => {
      const closure = this.#scenario.closureLibrary.find(c => c.id === closureId);
      if (!closure) throw new Error(`Unknown closure ${closureId}`);
      if (this.#closures.some(c => c.id === closure.id)) return;
      await this.#applyClosure({ ...closure, reportedAt: this.#now() });
    });
  }

  /** Confirmed God's Eye incidents. Ones that sit on an active route become camera-verified closures. */
  setIncidents(incidents: GodsEyeIncident[]): Promise<void> {
    return this.#run(async () => {
      this.#incidents = incidents;
      for (const incident of incidents) {
        if (this.#processedIncidents.has(incident.id)) continue;
        const nearRoute = this.#activeRoutes().some(({ route }) => distanceToPathKm(incident.location, route.geometry) <= 0.3);
        if (!nearRoute) continue;
        this.#processedIncidents.add(incident.id);
        const source: SourceRef = {
          name: `God's Eye camera ${incident.cameraId}`, kind: "gods_eye", live: true, retrievedAt: this.#now(),
        };
        await this.#applyClosure({
          id: `closure-${incident.id}`,
          road: `Area near camera ${incident.cameraId}`,
          description: `Camera-confirmed smoke/fire next to the route (${Math.round(incident.confidence * 100)}% confidence)`,
          area: circlePolygon(incident.location, 200),
          reportedAt: this.#now(),
          status: "active",
          verifiedBy: [source],
        });
      }
    });
  }

  setLiveWarnings(warnings: OfficialWarning[]): Promise<void> {
    return this.#run(() => { this.#liveWarnings = warnings; });
  }

  setLiveShelters(shelters: Shelter[]): Promise<void> {
    return this.#run(() => {
      this.#liveShelters = shelters;
      for (const shelter of shelters) this.#shelters.set(shelter.id, shelter);
    });
  }

  setChannels(channels: EvacSnapshot["channels"]): Promise<void> {
    return this.#run(() => { this.#channels = channels; });
  }

  recordHealth(name: string, ok: boolean, detail: string): void {
    this.#health.set(name, { name, ok, detail, checkedAt: this.#now() });
    void this.#run(() => undefined);
  }

  /** What the demo operator can trigger: the supplied warning and the verified closure feed. */
  catalog(): { warnings: Pick<OfficialWarning, "id" | "event" | "areaLabel">[]; closures: Pick<Closure, "id" | "road" | "description">[] } {
    return {
      warnings: this.#scenario.warnings.map(({ id, event, areaLabel }) => ({ id, event, areaLabel })),
      closures: this.#scenario.closureLibrary.map(({ id, road, description }) => ({ id, road, description })),
    };
  }

  participant(id: string): Participant | undefined {
    return this.#participants.get(id);
  }

  participants(): Participant[] {
    return [...this.#participants.values()];
  }

  /** Bind a participant to a real channel (e.g. iMessage) instead of the web simulator. */
  bindChannel(participantId: string, channel: Participant["channel"]): void {
    const participant = this.#participants.get(participantId);
    if (participant) participant.channel = channel;
  }

  /** Wait for all queued work, for tests and shutdown. */
  idle(): Promise<void> {
    return this.#queue.then(() => undefined, () => undefined);
  }

  snapshot(): EvacSnapshot {
    const s = this.#scenario;
    return structuredClone({
      scenario: { id: s.id, title: s.title, startedAt: this.#startedAt, areaCenter: s.areaCenter, timeZone: s.timeZone },
      warnings: [...this.#activeWarnings, ...this.#liveWarnings],
      households: [...this.#households.values()],
      shelters: [...this.#shelters.values()],
      helpers: [...this.#helpers.values()],
      closures: this.#closures,
      arrangements: [...this.#arrangements.values()],
      destinationOptions: this.#options_by_household,
      participants: [...this.#participants.values()],
      transcript: this.#transcript,
      timeline: this.#timeline,
      incidents: this.#incidents,
      channels: this.#channels,
      sourceHealth: [...this.#health.values()],
    });
  }

  // ---- internals ----

  #load(): void {
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
    this.#startedAt = this.#now();
    this.#scenario = this.#options.scenario(this.#startedAt);
    const previous = this.#participants;
    this.#participants = new Map(this.#scenario.participants.map(p => [p.id, { ...p, channel: previous?.get(p.id)?.channel ?? p.channel }]));
    this.#households = new Map(this.#scenario.households.map(h => [h.id, h]));
    this.#helpers = new Map(this.#scenario.helpers.map(h => [h.id, h]));
    this.#shelters = new Map([...this.#scenario.shelters, ...this.#liveShelters].map(s => [s.id, s]));
    this.#activeWarnings = [];
    this.#closures = [];
    this.#arrangements.clear();
    this.#options_by_household = {};
    this.#transcript = [];
    this.#timeline = [];
    this.#processedIncidents.clear();
  }

  #run<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => undefined).then(() => this.#options.onChange?.(this.snapshot()));
    return next;
  }

  #now(): number { return this.#options.clock(); }
  #id(prefix: string): string { return `${prefix}-${++this.#sequence}`; }
  #tz(): string { return this.#scenario.timeZone; }
  #warnings(): OfficialWarning[] { return [...this.#activeWarnings, ...this.#liveWarnings]; }
  #activeClosures(): Closure[] { return this.#closures.filter(c => c.status === "active"); }

  #log(kind: TimelineKind, title: string, detail?: string, source?: SourceRef): void {
    this.#timeline.push({ id: this.#id("evt"), at: this.#now(), kind, title, detail, source });
  }

  async #send(participantId: string, text: string): Promise<void> {
    const participant = this.#participants.get(participantId);
    if (!participant) return;
    this.#transcript.push({
      id: this.#id("msg"), participantId, direction: "outbound", text, at: this.#now(), platform: participant.channel.platform,
    });
    try {
      await this.#options.messenger.deliver(participant, text);
    } catch (error) {
      this.#log("system", `Delivery to ${participant.name} failed`, error instanceof Error ? error.message : String(error));
    }
  }

  #householdForResident(participantId: string): Household | undefined {
    return [...this.#households.values()].find(h => h.residentId === participantId);
  }

  #arrangementFor(householdId: string): Arrangement | undefined {
    return [...this.#arrangements.values()].reverse().find(a => a.householdId === householdId);
  }

  #save(arrangement: Arrangement): Arrangement {
    this.#arrangements.set(arrangement.id, arrangement);
    return arrangement;
  }

  // ---- resident conversation ----

  async #onResident(participant: Participant, text: string): Promise<void> {
    const household = this.#householdForResident(participant.id);
    if (!household) return;
    const upper = text.toUpperCase();
    if (upper === "STATUS") return this.#send(participant.id, this.#statusText(household));
    if (upper === "HELP") return this.#send(participant.id, say.HELP_TEXT);
    if (household.stage === "idle") {
      return this.#send(participant.id, "There's no active warning for your address right now. I'm watching official sources and will message you if that changes.");
    }

    const arrangement = this.#arrangementFor(household.id);
    if (household.stage === "awaiting_consent" && arrangement?.status === "awaiting_consent") {
      const choice = text.match(/^\s*([123])\b/);
      if (YES.test(text)) return this.#requestRide(household, arrangement);
      if (choice) return this.#switchDestination(household, arrangement, Number(choice[1]) - 1);
      if (NO.test(text)) {
        this.#save(transition(arrangement, "cancelled", this.#now(), "Resident declined to share details"));
        household.stage = "intake";
        this.#log("consent", "Resident declined the ride request");
        return this.#send(participant.id, "Okay, I haven't shared anything. Reply RIDE if you change your mind, or tell me what would work better. Please follow the official instruction to leave now if you can.");
      }
    }
    if (/^ride\b/i.test(text) && (household.stage === "intake" || household.stage === "awaiting_helper")) {
      return this.#planDestinations(household);
    }
    if (household.stage === "choosing_destination") {
      const choice = text.match(/^\s*([123])\b/);
      if (choice) return this.#selfEvacuate(household, Number(choice[1]) - 1);
    }
    if (ARRIVED.test(text) && (household.stage === "arranged" || household.stage === "self_evacuating")) {
      return this.#markArrived(household, "resident");
    }

    const { needs, understood } = parseHouseholdMessage(text, household.needs);
    if (understood.length && ["arranged", "awaiting_helper"].includes(household.stage) && arrangement && isActive(arrangement)) {
      household.needs = needs;
      this.#log("intake", "Household update forwarded", understood.join(", "));
      const helper = arrangement.helperId ? this.#helpers.get(arrangement.helperId) : undefined;
      if (helper) await this.#send(helper.participantId, `Update from the ${household.label}: ${understood.join(", ")}.`);
      return this.#send(participant.id, `Thanks, I've passed that on${helper ? ` to ${helper.name.split(" ")[0]}` : ""}: ${understood.join(", ")}.`);
    }
    if (["warned", "intake", "choosing_destination", "awaiting_consent"].includes(household.stage)) {
      household.needs = needs;
      if (household.stage === "warned") household.stage = "intake";
      if (understood.length) this.#log("intake", "Household details", understood.join(", "));
      const missing = missingDetails(needs);
      if (missing.length) return this.#send(participant.id, say.askMissing(missing, understood));
      if (arrangement?.status === "awaiting_consent") this.#save(transition(arrangement, "cancelled", this.#now(), "Replanned after new details"));
      return this.#planDestinations(household);
    }
    return this.#send(participant.id, this.#statusText(household));
  }

  async #routeFor(from: Household["location"], to: Household["location"]): Promise<RouteSummary> {
    return this.#options.router.route({ from, to, avoid: this.#activeClosures() });
  }

  async #planDestinations(household: Household): Promise<void> {
    const shelters = [...this.#shelters.values()].filter(s => s.status === "open");
    const routes = await Promise.all(shelters.map(shelter => this.#routeFor(household.location, shelter.location)));
    const evaluations = shelters.map((shelter, index) =>
      evaluateShelter(shelter, routes[index]!, household, this.#warnings(), this.#activeClosures()));
    const options = rankDestinations(evaluations);
    this.#options_by_household[household.id] = options;
    household.offeredShelterIds = options.map(o => o.shelterId);
    const rejected = evaluations.flatMap(e => e.eligible ? [] : [`${this.#shelters.get(e.shelterId)?.name}: ${e.reason}`]);
    this.#log("destination", `${options.length} destination(s) fit`, rejected.length ? `Excluded: ${rejected.join("; ")}` : undefined);

    if (!options.length) {
      household.stage = "intake";
      return this.#send(household.residentId, say.noDestinations(this.#activeWarnings[0]));
    }
    await this.#send(household.residentId, say.destinationList(household, options, this.#shelters));
    if (household.needs.hasVehicle) {
      household.stage = "choosing_destination";
      return this.#send(household.residentId, say.chooseToDrive());
    }
    const [helper] = candidateHelpers([...this.#helpers.values()], household, []);
    const top = options[0]!;
    const arrangement = this.#save({
      id: this.#id("arr"), householdId: household.id, shelterId: top.shelterId, requestedHelperIds: [],
      status: "awaiting_consent", tripRoute: top.route,
      history: [{ status: "awaiting_consent", at: this.#now(), note: "Ride offered; waiting for permission to share details" }],
    });
    household.selectedShelterId = top.shelterId;
    if (!helper) {
      this.#save(transition(arrangement, "cancelled", this.#now(), "No eligible enrolled helper"));
      household.stage = "awaiting_helper";
      this.#log("escalation", "No eligible helper available");
      return this.#send(household.residentId, say.noHelpers());
    }
    household.stage = "awaiting_consent";
    this.#log("consent", "Asked permission to request a ride", `${helper.name} is the nearest eligible enrolled driver`);
    await this.#send(household.residentId, say.offerRide(helper, this.#shelters.get(top.shelterId)!, distanceKm(helper.home, household.location)));
  }

  async #switchDestination(household: Household, arrangement: Arrangement, index: number): Promise<void> {
    const option = this.#options_by_household[household.id]?.[index];
    if (!option) return this.#send(household.residentId, "Please reply with one of the listed numbers.");
    const updated = this.#save({ ...arrangement, shelterId: option.shelterId, tripRoute: option.route });
    household.selectedShelterId = option.shelterId;
    const [helper] = candidateHelpers([...this.#helpers.values()], household, updated.requestedHelperIds);
    if (!helper) return this.#send(household.residentId, say.noHelpers());
    return this.#send(household.residentId, say.offerRide(helper, this.#shelters.get(option.shelterId)!, distanceKm(helper.home, household.location)));
  }

  async #selfEvacuate(household: Household, index: number): Promise<void> {
    const option = this.#options_by_household[household.id]?.[index];
    if (!option) return this.#send(household.residentId, "Please reply with one of the listed numbers.");
    const shelter = this.#shelters.get(option.shelterId)!;
    household.selectedShelterId = shelter.id;
    household.activeRoute = option.route;
    household.stage = "self_evacuating";
    this.#log("destination", `Driving to ${shelter.name}`, `${option.route.durationMin} min`);
    await this.#send(household.residentId, `Route to ${shelter.name}, ${shelter.address}: ${option.route.via.join(" → ") || "see link"} (${Math.round(option.route.durationMin)} min).\n\n${say.osmDirections(option.route.from, option.route.to)}\n\nReply ARRIVED when you get there. I'll message you if a closure affects this route.`);
  }

  async #requestRide(household: Household, arrangement: Arrangement): Promise<void> {
    this.#log("consent", "Resident gave permission to share details with a volunteer driver");
    const [helper] = candidateHelpers([...this.#helpers.values()], household, arrangement.requestedHelperIds);
    if (!helper) {
      this.#save(transition(arrangement, "unfilled", this.#now(), "No eligible helper"));
      household.stage = "awaiting_helper";
      return this.#send(household.residentId, say.noHelpers());
    }
    household.stage = "awaiting_helper";
    await this.#sendRequest(household, arrangement, helper);
    await this.#send(household.residentId, say.requestSentToResident(helper, Math.round(this.#options.helperTimeoutMs / 60_000)));
  }

  async #sendRequest(household: Household, arrangement: Arrangement, helper: Helper): Promise<Arrangement> {
    const pickupRoute = await this.#routeFor(helper.home, household.location);
    const updated = this.#save(transition(arrangement, "requested", this.#now(), `Asked ${helper.name}`, {
      helperId: helper.id,
      pickupRoute,
      requestedHelperIds: [...arrangement.requestedHelperIds, helper.id],
      requestExpiresAt: this.#now() + this.#options.helperTimeoutMs,
    }));
    helper.status = "requested";
    this.#log("request", `Transport requested from ${helper.name}`, `${helper.vehicle.description}; pickup ${Math.round(pickupRoute.durationMin)} min away`);
    const shelter = this.#shelters.get(updated.shelterId)!;
    await this.#send(helper.participantId, say.helperRequest(household, shelter, updated.tripRoute, pickupRoute, this.#activeWarnings[0]));
    this.#timers.get(updated.id)?.();
    this.#timers.set(updated.id, this.#options.schedule(() => {
      void this.#run(() => this.#onRequestTimeout(updated.id, helper.id));
    }, this.#options.helperTimeoutMs));
    return updated;
  }

  async #onRequestTimeout(arrangementId: string, helperId: string): Promise<void> {
    const arrangement = this.#arrangements.get(arrangementId);
    if (!arrangement || arrangement.status !== "requested" || arrangement.helperId !== helperId) return;
    const minutes = Math.round(this.#options.helperTimeoutMs / 60_000);
    const helper = this.#helpers.get(helperId)!;
    await this.#send(helper.participantId, "No problem, I've passed this request to another driver.");
    await this.#escalate(arrangement, `didn't answer within ${minutes} min`);
  }

  async #escalate(arrangement: Arrangement, reason: string): Promise<void> {
    const household = this.#households.get(arrangement.householdId)!;
    const previous = arrangement.helperId ? this.#helpers.get(arrangement.helperId) : undefined;
    if (previous) previous.status = "unavailable";
    this.#timers.get(arrangement.id)?.();
    this.#log("escalation", `${previous?.name ?? "Helper"} ${reason}`);
    const [next] = candidateHelpers([...this.#helpers.values()], household, arrangement.requestedHelperIds);
    if (!next) {
      this.#save(transition(arrangement, "unfilled", this.#now(), `No more eligible helpers after ${previous?.name} ${reason}`));
      household.stage = "awaiting_helper";
      return this.#send(household.residentId, say.noHelpers());
    }
    await this.#sendRequest(household, arrangement, next);
    if (previous) await this.#send(household.residentId, say.escalating(previous, next, reason));
  }

  // ---- helper conversation ----

  async #onHelper(participant: Participant, text: string): Promise<void> {
    const helper = [...this.#helpers.values()].find(h => h.participantId === participant.id);
    if (!helper) return;
    const arrangement = [...this.#arrangements.values()].find(a => a.helperId === helper.id && isActive(a));
    const first = helper.name.split(" ")[0];
    if (!arrangement) {
      return this.#send(participant.id, `Thanks, ${first}. There are no open requests for you right now. I'll message you if a household nearby needs a ride.`);
    }
    const household = this.#households.get(arrangement.householdId)!;
    const shelter = this.#shelters.get(arrangement.shelterId)!;

    if (arrangement.status === "requested") {
      if (ACCEPT.test(text)) return this.#confirm(arrangement, helper, household, shelter);
      if (DECLINE.test(text)) {
        await this.#send(participant.id, "Understood, thanks for letting me know quickly. I'll ask someone else.");
        return this.#escalate(arrangement, "can't make it");
      }
      return this.#send(participant.id, "Please reply ACCEPT or DECLINE for the pickup request above.");
    }
    if ((arrangement.status === "confirmed" || arrangement.status === "en_route") && PICKED_UP.test(text)) {
      const now = this.#now();
      const arrivalEta = now + arrangement.tripRoute.durationMin * 60_000;
      this.#save(transition(arrangement, "picked_up", now, `${helper.name} reported pickup`, { arrivalEta }));
      this.#log("checkin", "Household picked up", `Reported by ${helper.name}`);
      await this.#send(participant.id, `Thanks. Head to ${shelter.name}. I'll message you if anything changes on the way.`);
      return this.#send(household.residentId, say.pickedUpResident(helper, shelter, arrivalEta, this.#tz()));
    }
    if (arrangement.status === "picked_up" && ARRIVED.test(text)) {
      return this.#markArrived(household, "helper");
    }
    if (DECLINE.test(text) && (arrangement.status === "confirmed" || arrangement.status === "en_route")) {
      await this.#send(participant.id, "Understood. I'll find another driver and let the family know.");
      return this.#escalate(arrangement, "had to cancel");
    }
    return this.#send(participant.id, arrangement.status === "picked_up"
      ? "Text ARRIVED once everyone is at the shelter."
      : "Text PICKED UP once everyone is aboard, or DECLINE if you can't make it.");
  }

  async #confirm(arrangement: Arrangement, helper: Helper, household: Household, shelter: Shelter): Promise<void> {
    this.#timers.get(arrangement.id)?.();
    const now = this.#now();
    const pickupEta = now + (arrangement.pickupRoute?.durationMin ?? 0) * 60_000;
    const arrivalEta = pickupEta + (this.#options.boardingMin + arrangement.tripRoute.durationMin) * 60_000;
    this.#save(transition(arrangement, "confirmed", now, `${helper.name} accepted`, { pickupEta, arrivalEta, requestExpiresAt: undefined }));
    helper.status = "assigned";
    household.stage = "arranged";
    household.activeRoute = arrangement.tripRoute;
    household.selectedShelterId = shelter.id;
    this.#log("confirmed", `${helper.name} confirmed the pickup`, `Pickup ~${say.clockTime(pickupEta, this.#tz())}, arrival ~${say.clockTime(arrivalEta, this.#tz())}`);
    await this.#send(helper.participantId, say.helperConfirmed(household, shelter, arrangement.tripRoute, arrangement.pickupRoute));
    await this.#send(household.residentId, say.residentConfirmed(helper, shelter, pickupEta, arrivalEta, this.#tz()));
  }

  async #markArrived(household: Household, reportedBy: "helper" | "resident"): Promise<void> {
    const shelter = this.#shelters.get(household.selectedShelterId ?? "");
    if (!shelter) return;
    const arrangement = this.#arrangementFor(household.id);
    if (arrangement && isActive(arrangement)) {
      let current = arrangement;
      if (current.status === "confirmed" || current.status === "en_route") {
        current = transition(current, "picked_up", this.#now(), "Pickup implied by arrival");
      }
      this.#save(transition(current, "arrived", this.#now(), `Arrival reported by ${reportedBy}`));
      this.#timers.get(arrangement.id)?.();
      const helper = arrangement.helperId ? this.#helpers.get(arrangement.helperId) : undefined;
      if (helper) {
        helper.status = "available";
        await this.#send(helper.participantId, reportedBy === "helper"
          ? `Thank you, ${helper.name.split(" ")[0]}. The ${household.label} is checked in as arrived at ${shelter.name}. You're marked available again.`
          : `The ${household.label} reports they've arrived at ${shelter.name}. Thank you. You're marked available again.`);
      }
    }
    shelter.occupied = Math.min(shelter.capacity, shelter.occupied + (household.needs.people ?? 1));
    household.stage = "complete";
    this.#log("checkin", `Arrived at ${shelter.name}`, `Reported by ${reportedBy}`);
    await this.#send(household.residentId, say.arrivedResident(shelter, household));
  }

  // ---- monitoring ----

  /** Routes that are still being travelled or about to be. */
  #activeRoutes(): ActiveRoute[] {
    const routes: ActiveRoute[] = [];
    for (const household of this.#households.values()) {
      const arrangement = this.#arrangementFor(household.id);
      if (arrangement && isActive(arrangement)) {
        if (arrangement.status !== "arrived") routes.push({ household, arrangement, leg: "trip", route: arrangement.tripRoute });
        if (arrangement.pickupRoute && ["requested", "confirmed", "en_route"].includes(arrangement.status)) {
          routes.push({ household, arrangement, leg: "pickup", route: arrangement.pickupRoute });
        }
      } else if (household.stage === "self_evacuating" && household.activeRoute) {
        routes.push({ household, leg: "trip", route: household.activeRoute });
      }
    }
    return routes;
  }

  async #applyClosure(closure: Closure): Promise<void> {
    this.#closures.push(closure);
    this.#log("closure", `Closure: ${closure.road}`, closure.description, closure.verifiedBy[0]);
    const affected = this.#activeRoutes().filter(({ route }) => pathIntersectsPolygon(route.geometry, closure.area));

    // Quietly refresh offered (not yet chosen) options so later choices use closure-aware routes.
    for (const household of this.#households.values()) {
      const offered = this.#options_by_household[household.id];
      if (!offered?.length || household.stage === "complete") continue;
      for (const option of offered) {
        if (!pathIntersectsPolygon(option.route.geometry, closure.area)) continue;
        option.route = await this.#routeFor(household.location, this.#shelters.get(option.shelterId)!.location);
      }
    }

    if (!affected.length) {
      this.#log("system", "No active routes affected by the closure");
      return;
    }
    for (const { household, arrangement, leg, route } of affected) {
      const destination = leg === "trip" ? this.#shelters.get(arrangement?.shelterId ?? household.selectedShelterId ?? "")!.location : household.location;
      const updated = await this.#options.router.route({ from: route.from, to: destination, avoid: this.#activeClosures() });
      const deltaMin = updated.durationMin - route.durationMin;
      const shelter = this.#shelters.get(arrangement?.shelterId ?? household.selectedShelterId ?? "")!;
      const helper = arrangement?.helperId ? this.#helpers.get(arrangement.helperId) : undefined;
      const stillBlocked = pathIntersectsPolygon(updated.geometry, closure.area);
      this.#log("reroute", `Rerouted ${leg === "pickup" ? "pickup" : "trip"} for the ${household.label}`,
        `${updated.via.join(" → ") || updated.provider} · ${deltaMin >= 0 ? "+" : ""}${deltaMin.toFixed(1)} min${stillBlocked ? " · could not fully avoid closure" : ""}`,
        updated.source);

      if (arrangement) {
        const patch: Partial<Arrangement> = leg === "trip"
          ? { tripRoute: updated, arrivalEta: arrangement.arrivalEta ? arrangement.arrivalEta + deltaMin * 60_000 : undefined }
          : {
            pickupRoute: updated,
            pickupEta: arrangement.pickupEta ? arrangement.pickupEta + deltaMin * 60_000 : undefined,
            arrivalEta: arrangement.arrivalEta ? arrangement.arrivalEta + deltaMin * 60_000 : undefined,
          };
        const saved = this.#save({
          ...arrangement, ...patch,
          history: [...arrangement.history, { status: arrangement.status, at: this.#now(), note: `Rerouted ${leg} around ${closure.road}` }],
        });
        if (leg === "trip") household.activeRoute = updated;
        if (helper && ["confirmed", "en_route", "picked_up", "requested"].includes(saved.status)) {
          await this.#send(helper.participantId, say.rerouteHelper(closure, shelter, updated, leg));
        }
        if (leg === "trip" && saved.status !== "awaiting_consent") {
          await this.#send(household.residentId, say.rerouteResident(closure, helper, shelter, route, updated, deltaMin, saved.arrivalEta, this.#tz()));
        } else if (leg === "pickup" && saved.pickupEta && saved.status !== "requested") {
          await this.#send(household.residentId, `ROUTE UPDATE: ${say.closureNotice(closure)}\n\n${helper?.name.split(" ")[0] ?? "Your driver"} is taking a different way to you. New pickup estimate: around ${say.clockTime(saved.pickupEta, this.#tz())}.`);
        }
      } else {
        household.activeRoute = updated;
        await this.#send(household.residentId, say.rerouteResident(closure, undefined, shelter, route, updated, deltaMin, undefined, this.#tz())
          + `\n\n${say.osmDirections(updated.from, updated.to)}`);
      }
    }
  }

  #statusText(household: Household): string {
    const arrangement = this.#arrangementFor(household.id);
    const shelter = this.#shelters.get(household.selectedShelterId ?? "");
    const helper = arrangement?.helperId ? this.#helpers.get(arrangement.helperId) : undefined;
    const tz = this.#tz();
    switch (household.stage) {
      case "arranged":
        return arrangement?.status === "picked_up"
          ? `On the way to ${shelter?.name} with ${helper?.name.split(" ")[0]}. Arrival around ${say.clockTime(arrangement.arrivalEta ?? this.#now(), tz)}.`
          : `${helper?.name.split(" ")[0]} is coming to pick you up around ${say.clockTime(arrangement?.pickupEta ?? this.#now(), tz)}, then ${shelter?.name}.`;
      case "awaiting_helper":
        return helper ? `Waiting for ${helper.name.split(" ")[0]} to confirm. I'll update you as soon as they answer.` : say.noHelpers();
      case "awaiting_consent":
        return "Reply YES and I'll request the pickup, or 2 or 3 to pick a different destination.";
      case "self_evacuating":
        return `Driving to ${shelter?.name}. Reply ARRIVED when you get there.`;
      case "complete":
        return `You're checked in at ${shelter?.name}. I'll let you know when officials lift the order.`;
      default:
        return "Tell me who is with you, any mobility or medical needs, and whether you have a car, and I'll find options.";
    }
  }
}
