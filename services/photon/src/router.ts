import { randomUUID } from "node:crypto";
import type { ConversationContext, UserAlertProfile, Watch } from "@tempmhacks/shared";
import { evaluateLocationFreshness } from "@tempmhacks/shared/geo";
import { answerFollowUp, classifyFollowUp, type GroundedContext } from "./answer.js";
import { classifyLocationShare, type ParsedLocation } from "./location.js";
import type { Geocoder, InboundMessage, MessagingStore, NativeShareKind } from "./types.js";

/** The one supported way to share location: Apple Maps → blue dot → Share → Messages. */
export const APPLE_MAPS_SHARE_HINT =
  "To share your location: open Apple Maps, tap your blue location dot, then Share → Messages → send it here.";

export const HELP_REPLY = [
  `I alert you about verified incidents near your location.\n\n${APPLE_MAPS_SHARE_HINT}`,
  [
    "STATUS — what I’m monitoring",
    "WATCH <place> — watch a place",
    "STOP — unsubscribe",
    "After an alert, just ask: “what happened?” or “show me”.",
  ].join("\n"),
].join("\n\n");

export const ALERTS_ALWAYS_ON_REPLY =
  "Alerts are always on while I have your location. To unsubscribe from everything, send STOP.";

export const UNKNOWN_REPLY =
  "I didn’t understand that. Reply HELP for options, or ask about an active incident.";
export const WATCH_FORMAT_REPLY = "Send WATCH <place>, for example: WATCH Ann Arbor.";
export const WATCH_NOT_FOUND_REPLY = "I couldn’t find that place. Try a more specific city, address, or postal code.";
export const NO_ACTIVE_INCIDENT_REPLY =
  "I don’t have an active incident for this conversation right now. I’ll message you if a verified incident affects your area.";
export const STOP_REPLY =
  "You’re unsubscribed. Everything is off, and I no longer have an active location for you. Message me anytime to start again.";

/** Explicit "no location received" explanations, keyed by what actually arrived. */
export const NO_LOCATION_REPLIES = {
  find_my: [
    "❌ No location received.",
    "Find My “Share My Location” keeps your location inside Find My, so I can’t read it.",
  ].join("\n") + `\n\n${APPLE_MAPS_SHARE_HINT}`,
  maps_balloon: [
    "❌ No location received.",
    "That map card came from a Maps app extension, which doesn’t include coordinates I can read.",
  ].join("\n") + `\n\n${APPLE_MAPS_SHARE_HINT}`,
  short_link: [
    "❌ No location received.",
    "That’s a shortened map link, which doesn’t include coordinates I can read.",
  ].join("\n") + `\n\n${APPLE_MAPS_SHARE_HINT}`,
  no_coordinates: [
    "❌ No location received.",
    "That map link doesn’t include coordinates.",
  ].join("\n") + `\n\n${APPLE_MAPS_SHARE_HINT}`,
} as const;

export type RouterReply = { text: string; sendEvidence?: boolean; evidenceUrl?: string };

export type CommandRouterOptions = {
  store: MessagingStore;
  geocoder: Geocoder;
  radiusKm: number;
  /** Base URL for building incident deep links in grounded answers. */
  publicAppUrl: string;
  now?: () => number;
  id?: () => string;
};

const KM_PER_MILE = 1.609344;
const miles = (km: number) => Math.max(1, Math.round(km / KM_PER_MILE));

/** Human-readable age, e.g. "just now", "12 minutes ago", "3 hours ago". */
export function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Deterministic command/intent router. Control commands (STOP, STATUS, HELP,
 * WATCH) and location shares short-circuit before any grounded Q&A. Every location
 * attempt gets an explicit reply: either the location was received (and what was
 * saved), or no location was received (and why, with how to share from Apple Maps).
 */
export function createCommandRouter(options: CommandRouterOptions) {
  if (!Number.isFinite(options.radiusKm) || options.radiusKm <= 0) {
    throw new Error("WATCH_RADIUS_KM must be greater than zero");
  }
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;

  function freshness(profile: UserAlertProfile) {
    return evaluateLocationFreshness(profile.locationUpdatedAt, now());
  }

  async function handleLocation(
    message: InboundMessage,
    location: ParsedLocation,
    detail: { isCurrentLocation: boolean; label?: string },
  ): Promise<RouterReply> {
    const existing = await options.store.getProfileForSender(message.senderId);
    const timestamp = now();
    const profile: UserAlertProfile = {
      userId: existing?.userId ?? message.senderId,
      spaceId: message.spaceId,
      senderId: message.senderId,
      latitude: location.latitude,
      longitude: location.longitude,
      locationUpdatedAt: timestamp,
      radiusKm: existing?.radiusKm ?? options.radiusKm,
      alertsEnabled: true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await options.store.upsertProfile(profile);
    // Re-enroll cleanly: a returning user (e.g. after STOP) must not inherit a
    // pre-STOP incident anchor, so clear any stale conversation context.
    await options.store.clearConversationContext(message.spaceId);

    const what = detail.isCurrentLocation
      ? `your current location${detail.label ? ` (near ${detail.label})` : ""}`
      : detail.label ? `the place you shared: ${detail.label}` : "the location you shared";
    const wasPaused = existing !== undefined && !existing.alertsEnabled;
    return {
      text: [
        `✅ Location received. I saved ${what}.`,
        `I’ll alert you about verified incidents within ~${miles(profile.radiusKm)} mi${wasPaused ? ", and your alerts are back on" : ""}.`,
      ].join("\n") + "\n\nThis is a one-time snapshot, not live tracking. Share again from Apple Maps whenever you move.",
    };
  }

  function noLocation(reason: NativeShareKind | "short_link" | "no_coordinates"): RouterReply {
    return { text: NO_LOCATION_REPLIES[reason] };
  }

  async function handleText(message: InboundMessage, input: string): Promise<RouterReply | undefined> {
    // Safety/control commands intentionally remain ahead of everything else.
    if (/^STOP$/i.test(input)) {
      // Full un-enroll: drop watches, pause the location profile, and clear the
      // conversation's active-incident anchor so no follow-ups resolve against a
      // pre-STOP incident. (No row-delete reducer exists; disabled is the durable
      // un-enrolled state.)
      await options.store.deactivateWatches(message.senderId);
      const profile = await options.store.getProfileForSender(message.senderId);
      if (profile) await options.store.setAlertsEnabled(profile.userId, false);
      await options.store.clearConversationContext(message.spaceId);
      return { text: STOP_REPLY };
    }
    // Alerts are always on while I have a location; there is no pause toggle.
    // STOP is the only opt-out (it unsubscribes from everything).
    if (/^ALERTS\b/i.test(input)) return { text: ALERTS_ALWAYS_ON_REPLY };
    if (/^STATUS$/i.test(input)) {
      const [profile, watch] = await Promise.all([
        options.store.getProfileForSender(message.senderId),
        options.store.getActiveWatch(message.senderId),
      ]);
      const lines: string[] = [];
      if (!profile) {
        lines.push(`📍 I don’t have a location for you.\n\n${APPLE_MAPS_SHARE_HINT}`);
      } else {
        const { fresh, ageMs } = freshness(profile);
        const age = formatAge(ageMs);
        if (!profile.alertsEnabled) {
          lines.push(`📍 You’re unsubscribed, so I’m not monitoring a location for you.\n\n${APPLE_MAPS_SHARE_HINT}`);
        } else if (!fresh) {
          lines.push(`📍 Your last location was received ${age} and is out of date, so alerts may be inaccurate.\n\n${APPLE_MAPS_SHARE_HINT}`);
        } else {
          lines.push(`📍 Location received ${age}. Monitoring within ~${miles(profile.radiusKm)} mi.`);
        }
      }
      if (watch) lines.push(`Also watching ${watch.placeLabel} within ${watch.radiusKm} km.`);
      return { text: lines.join("\n") };
    }
    if (/^HELP$/i.test(input)) return { text: HELP_REPLY };

    // Location shares: Apple Maps link (primary), LOC <lat>,<lng>, or a bare pair.
    // A map link without readable coordinates gets an explicit "no location" reply.
    const share = classifyLocationShare(input);
    if (share?.kind === "location") {
      return handleLocation(message, share.location, {
        isCurrentLocation: share.isCurrentLocation, label: share.label,
      });
    }
    if (share?.kind === "unreadable") return noLocation(share.reason);

    const watchMatch = /^WATCH(?:\s+(.*))?$/i.exec(input);
    if (watchMatch) {
      const query = watchMatch[1]?.trim();
      if (!query) return { text: WATCH_FORMAT_REPLY };
      const place = await options.geocoder.geocode(query);
      if (!place) return { text: WATCH_NOT_FOUND_REPLY };
      const watch: Watch = {
        id: id(),
        spaceId: message.spaceId,
        senderId: message.senderId,
        placeLabel: place.label,
        latitude: place.latitude,
        longitude: place.longitude,
        radiusKm: options.radiusKm,
        active: true,
        createdAt: now(),
      };
      await options.store.replaceWatch(watch);
      return {
        text: `Watching ${watch.placeLabel} within ${watch.radiusKm} km. I’ll message you if a verified incident affects this area. Reply STATUS, STOP, or HELP anytime.`,
      };
    }

    // Grounded follow-up Q&A anchored on the conversation's active incident.
    const intent = classifyFollowUp(input);
    if (intent) {
      const reply = await answerGroundedFollowUp(message, intent);
      if (reply) return reply;
      return { text: NO_ACTIVE_INCIDENT_REPLY };
    }

    // Fallback doubles as onboarding and as a location-state reminder, so the user
    // always knows whether I currently have a usable location for them.
    const profile = await options.store.getProfileForSender(message.senderId);
    if (!profile) {
      return {
        text: `Welcome! I alert you about verified incidents near you. I don’t have your location yet.\n\n${APPLE_MAPS_SHARE_HINT}`,
      };
    }
    if (!profile.alertsEnabled) {
      return {
        text: `You’re currently unsubscribed. To start again, share your location.\n\n${APPLE_MAPS_SHARE_HINT}`,
      };
    }
    if (!freshness(profile).fresh) {
      return { text: `${UNKNOWN_REPLY}\nYour location is out of date, so please share it again.\n\n${APPLE_MAPS_SHARE_HINT}` };
    }
    return { text: UNKNOWN_REPLY };
  }

  async function answerGroundedFollowUp(
    message: InboundMessage,
    intent: ReturnType<typeof classifyFollowUp> & string,
  ): Promise<RouterReply | undefined> {
    const context = await options.store.getConversationContext(message.spaceId);
    if (!context?.activeIncidentId) return undefined;
    const incident = await options.store.getIncident(context.activeIncidentId);
    if (!incident) return undefined;
    const camera = await options.store.getCamera(incident.cameraId);
    const [latestObservation, profile] = await Promise.all([
      options.store.getLatestObservation(incident.cameraId),
      options.store.getProfileForSender(message.senderId),
    ]);
    const otherNearbyCameraCount = await options.store.countOtherNearbyCameras(
      incident.cameraId, incident.latitude, incident.longitude, profile?.radiusKm ?? options.radiusKm,
    );
    const grounded: GroundedContext = {
      incident, camera, latestObservation, otherNearbyCameraCount, profile,
      baseUrl: options.publicAppUrl, now: now(),
    };
    const answer = answerFollowUp(intent, grounded);
    // Persist the last intent (and camera, for "show me") for conversational continuity.
    const nextContext: ConversationContext = {
      ...context, lastIntent: intent, lastCameraId: answer.cameraId ?? context.lastCameraId, updatedAt: now(),
    };
    await options.store.upsertConversationContext(nextContext);
    return { text: answer.text, sendEvidence: answer.sendEvidence, evidenceUrl: answer.evidenceUrl };
  }

  return async (message: InboundMessage): Promise<RouterReply | undefined> => {
    const { content } = message;
    if (content.type === "location") {
      // Native vCard location (older iOS "Send My Current Location").
      return handleLocation(message, { latitude: content.latitude, longitude: content.longitude }, {
        isCurrentLocation: true,
      });
    }
    if (content.type === "other" && content.shareKind) return noLocation(content.shareKind);
    if (content.type !== "text") return undefined;
    return handleText(message, content.text.trim());
  };
}
