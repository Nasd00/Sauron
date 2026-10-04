import type { Camera, Incident, Observation, UserAlertProfile } from "@tempmhacks/shared";
import { incidentUrl } from "@tempmhacks/shared";
import {
  evaluateProfileFreshness, haversineDistanceKm, kilometersToMiles,
} from "@tempmhacks/shared/geo";

/**
 * Grounded conversational Q&A for incident follow-ups. Everything here is pure and
 * deterministic: intents are classified by keyword, and answers are composed only
 * from structured DB state (Incident + Observation + Camera + the user's profile).
 * The model is primed by this state and never invents incident type, location,
 * distance, time, severity, or any safety advice.
 */

export type FollowUpIntent =
  | "what_happened"
  | "where"
  | "how_far"
  | "is_active"
  | "when"
  | "which_camera"
  | "show_me"
  | "other_cameras"
  | "what_changed";

/** Ordered keyword rules. "show me" and camera questions win over generic ones. */
const INTENT_RULES: ReadonlyArray<{ intent: FollowUpIntent; test: RegExp }> = [
  { intent: "show_me", test: /\b(show me|show it|latest (camera|view|image|photo|snapshot|frame)|see it|picture)\b/i },
  { intent: "other_cameras", test: /\b(other cameras|another camera|nearby cameras|more cameras)\b/i },
  { intent: "which_camera", test: /\b(which camera|what camera|camera saw|source)\b/i },
  { intent: "how_far", test: /\b(how far|how close|distance|how many (miles|km))\b/i },
  { intent: "where", test: /\b(where|location|located)\b/i },
  { intent: "is_active", test: /\b(still (active|happening|going)|is it (active|over|resolved|out)|status|ongoing)\b/i },
  { intent: "when", test: /\b(when|what time|how long ago|first seen|started)\b/i },
  { intent: "what_changed", test: /\b(what changed|any (update|change)|changed|new info)\b/i },
  { intent: "what_happened", test: /\b(what happened|what('?s| is) (going on|happening)|tell me|what('?s| is) (this|that)|details?)\b/i },
];

/** Classifies free text into a follow-up intent, or undefined when none matches. */
export function classifyFollowUp(text: string): FollowUpIntent | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  for (const rule of INTENT_RULES) if (rule.test.test(normalized)) return rule.intent;
  return undefined;
}

export type GroundedContext = {
  incident: Incident;
  camera?: Camera;
  /** Latest observation for the incident's camera, if known. */
  latestObservation?: Observation;
  /** Count of other online cameras near the incident, for "other cameras". */
  otherNearbyCameraCount?: number;
  /** The asking user's profile, enabling grounded "how far from me". */
  profile?: UserAlertProfile;
  /** True when the Sauron iPhone app keeps the profile location current. */
  liveTracked?: boolean;
  baseUrl: string;
  now: number;
};

const STATUS_LABEL: Record<Incident["status"], string> = {
  candidate: "being verified",
  confirmed: "active and verified",
  dismissed: "dismissed",
  resolved: "resolved",
};

function describeType(type: string): string {
  return type === "smoke_fire" ? "possible smoke/fire" : type;
}

function formatMiles(km: number): string {
  const miles = kilometersToMiles(km);
  return miles < 10 ? miles.toFixed(1) : String(Math.round(miles));
}

function distanceSentence(context: GroundedContext): string | undefined {
  const { profile, incident } = context;
  if (!profile) return undefined;
  const { fresh } = evaluateProfileFreshness(profile, context.liveTracked ?? false, context.now);
  const km = haversineDistanceKm(incident.latitude, incident.longitude, profile.latitude, profile.longitude);
  const miles = formatMiles(km);
  return fresh
    ? `It is about ${miles} mi from your location.`
    : `It is about ${miles} mi from your last shared location — share your location again for an up-to-date distance.`;
}

function whenSentence(incident: Incident): string {
  return `First seen ${new Date(incident.firstSeenAt).toISOString()}; last updated ${new Date(incident.lastSeenAt).toISOString()}.`;
}

/**
 * Produces a grounded answer for a classified intent. Returns the response text,
 * and for "show me" whether a camera-evidence attachment should accompany it.
 */
export function answerFollowUp(
  intent: FollowUpIntent,
  context: GroundedContext,
): { text: string; sendEvidence: boolean; evidenceUrl?: string; cameraId?: string } {
  const { incident, camera } = context;
  const link = incidentUrl(context.baseUrl, incident.id);

  switch (intent) {
    case "what_happened": {
      const parts = [
        `A ${describeType(incident.type)} incident is ${STATUS_LABEL[incident.status]}.`,
        camera ? `It was observed by camera ${camera.name}.` : undefined,
        distanceSentence(context),
        `View live: ${link}`,
      ].filter((value): value is string => value !== undefined);
      return { text: parts.join("\n"), sendEvidence: false };
    }
    case "where": {
      const place = camera ? `near ${camera.name}` : "near the reporting camera";
      return {
        text: [
          `The incident is ${place} at ${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}.`,
          distanceSentence(context),
          `View on the map: ${link}`,
        ].filter((v): v is string => v !== undefined).join("\n"),
        sendEvidence: false,
      };
    }
    case "how_far": {
      const sentence = distanceSentence(context);
      return {
        text: sentence
          ? sentence
          : "I don’t have your location yet. Share your location and I’ll tell you how far the incident is.",
        sendEvidence: false,
      };
    }
    case "is_active": {
      return {
        text: `This incident is currently ${STATUS_LABEL[incident.status]}. ${whenSentence(incident)}`,
        sendEvidence: false,
      };
    }
    case "when": {
      return { text: whenSentence(incident), sendEvidence: false };
    }
    case "which_camera": {
      return {
        text: camera
          ? `It was seen by camera ${camera.name} (${camera.id}), currently ${camera.status}.`
          : `It was reported by camera ${incident.cameraId}.`,
        sendEvidence: false,
      };
    }
    case "other_cameras": {
      const count = context.otherNearbyCameraCount ?? 0;
      return {
        text: count > 0
          ? `There ${count === 1 ? "is" : "are"} ${count} other nearby camera${count === 1 ? "" : "s"}. See them on the map: ${link}`
          : `I don’t see other nearby cameras right now. Full view: ${link}`,
        sendEvidence: false,
      };
    }
    case "what_changed": {
      return {
        text: [
          `Latest status: ${STATUS_LABEL[incident.status]}.`,
          whenSentence(incident),
          `Full detail: ${link}`,
        ].join("\n"),
        sendEvidence: false,
      };
    }
    case "show_me": {
      const evidenceUrl = context.latestObservation?.evidenceUrl ?? camera?.streamUrl;
      const header = camera
        ? `Latest view from ${camera.name}:`
        : "Latest available evidence:";
      return {
        text: evidenceUrl
          ? `${header}\n${link}`
          : `I don’t have a camera image to send yet. Watch live: ${link}`,
        sendEvidence: evidenceUrl !== undefined,
        evidenceUrl,
        cameraId: camera?.id,
      };
    }
    default: {
      return { text: `Here’s the latest: ${link}`, sendEvidence: false };
    }
  }
}
