/** Canonical contracts. IDs are strings; timestamps are Unix milliseconds. */
/** What a camera detector can observe. */
export type HazardType = "smoke_fire";
/** What an incident can be: camera detections plus hazards an operator can report by hand. */
export type IncidentHazard = HazardType | "fire" | "flood" | "gas_leak" | "chemical" | "violence" | "other";
export const REPORTABLE_HAZARDS = ["fire", "smoke_fire", "flood", "gas_leak", "chemical", "violence", "other"] as const satisfies readonly IncidentHazard[];
export const HAZARD_LABELS: Record<IncidentHazard, string> = {
  smoke_fire: "smoke or fire",
  fire: "fire",
  flood: "flooding",
  gas_leak: "gas leak",
  chemical: "chemical hazard",
  violence: "violence or active threat",
  other: "dangerous event",
};
export function hazardLabel(type: string): string {
  return HAZARD_LABELS[type as IncidentHazard] ?? type.replace(/_/g, " ");
}
/** Camera id carried by incidents an operator reported by hand; no camera row exists for it. */
export const MANUAL_CAMERA_ID = "manual";
export type IncidentStatus = "candidate" | "confirmed" | "dismissed" | "resolved";

export type Camera = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  sourceType: "replay" | "live";
  streamUrl?: string;
  status: "online" | "offline";
  lastSeenAt?: number;
};

export type Observation = {
  id: string;
  cameraId: string;
  type: HazardType;
  /** Normalized to 0..1, inclusive. */
  confidence: number;
  timestamp: number;
  evidenceUrl?: string;
  bbox?: { x: number; y: number; width: number; height: number };
};

export type Incident = {
  id: string;
  /** The detecting camera, or {@link MANUAL_CAMERA_ID} for operator reports. */
  cameraId: string;
  type: IncidentHazard;
  status: IncidentStatus;
  confidence: number;
  latitude: number;
  longitude: number;
  firstSeenAt: number;
  lastSeenAt: number;
  confirmedAt?: number;
  resolvedAt?: number;
};

/**
 * The operator's description of a manually reported incident, one per incident. Kept in its own
 * table so camera incidents are unchanged. `radiusKm` is the danger zone: people inside it are
 * alerted and routes avoid it.
 */
export type IncidentReport = {
  incidentId: string;
  title: string;
  description: string;
  radiusKm: number;
  /** Free-text operator label, e.g. "web operator". Not an identity. */
  reportedBy: string;
  reportedAt: number;
};

/** Incident context everything downstream (alerts, agents, apps) shares. */
export type IncidentView = Incident & { report?: IncidentReport };

export function isManualIncident(incident: Pick<Incident, "cameraId">): boolean {
  return incident.cameraId === MANUAL_CAMERA_ID;
}

export type Watch = {
  id: string;
  /** Stable Spectrum conversation identifier used for replies and alerts. */
  spaceId: string;
  /** Stable provider-neutral Spectrum participant identifier. */
  senderId: string;
  placeLabel: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  active: boolean;
  createdAt: number;
};

export type Alert = {
  id: string;
  incidentId: string;
  watchId: string;
  status: "pending" | "sending" | "sent" | "failed";
  createdAt: number;
  sentAt?: number;
  providerMessageId?: string;
  error?: string;
};

/** Durable claim written before processing an at-least-once Photon delivery. */
export type InboundReceipt = {
  messageId: string;
  spaceId: string;
  senderId: string;
  receivedAt: number;
  contentType: string;
};

/**
 * Current-location monitoring profile for an enrolled user. This is the primary
 * alerting surface: a user shares their device location once and the system
 * continuously evaluates whether a confirmed incident is close enough to matter.
 * `WATCH <place>` remains a secondary, place-based fallback modeled by {@link Watch}.
 *
 * `locationUpdatedAt` is the freshness anchor. Alerts and "near you" phrasing are
 * only valid when the location is sufficiently recent; see freshness rules.
 */
export type UserAlertProfile = {
  /** Stable identity for the profile row. One active profile per senderId. */
  userId: string;
  /** Stable Spectrum conversation identifier used for replies and alerts. */
  spaceId: string;
  /** Stable provider-neutral Spectrum participant identifier. */
  senderId: string;
  latitude: number;
  longitude: number;
  /** Reported horizontal accuracy of the shared location, in meters. */
  accuracyMeters?: number;
  /** Unix ms when the location was last shared. Freshness is measured from here. */
  locationUpdatedAt: number;
  radiusKm: number;
  /** When false, the user is enrolled but suppressed from all proximity alerts. */
  alertsEnabled: boolean;
  createdAt: number;
  updatedAt: number;
};

/**
 * Associates an iMessage conversation (space) with the incident the user was most
 * recently alerted about, enabling grounded natural-language follow-ups ("what
 * happened?", "show me") without the user restating an incident ID. One context
 * per space; the active incident advances as new alerts land in the conversation.
 */
export type ConversationContext = {
  /** Stable Spectrum conversation identifier; the primary key for the context. */
  spaceId: string;
  /** Incident the conversation is currently anchored to, if any. */
  activeIncidentId?: string;
  /** Camera most recently shown or referenced for the active incident, if any. */
  lastCameraId?: string;
  /** Most recent classified follow-up intent, for observability and continuity. */
  lastIntent?: string;
  /** Unix ms when the anchoring alert was sent, if the context came from an alert. */
  alertedAt?: number;
  updatedAt: number;
};

/**
 * An iPhone running the Sauron location companion app, paired to one Spectrum
 * user through a single-use pairing link. The device keeps that user's
 * {@link UserAlertProfile} location current; it never sends messages itself.
 * Contains no credentials: device-token hashes live in a private table.
 */
export type MobileDevice = {
  deviceId: string;
  /** The {@link UserAlertProfile.userId} this device updates. */
  userId: string;
  spaceId: string;
  senderId: string;
  /**
   * Consent from the messaging channel: true after pairing or `WATCH ME`, false
   * after `STOP`. While false, location uploads are rejected.
   */
  trackingActive: boolean;
  /** The in-app Start/Stop Sharing toggle. */
  sharingEnabled: boolean;
  /** Revoked devices are permanently rejected; pair again to replace them. */
  revoked: boolean;
  pairedAt: number;
  updatedAt: number;
  /** Capture time of the most recent accepted location upload. */
  lastLocationAt?: number;
  lastAccuracyMeters?: number;
};

export function incidentUrl(baseUrl: string, incidentId: string): string {
  const base = new URL(baseUrl);
  const normalizedPath = base.pathname.replace(/\/$/, "");
  base.pathname = `${normalizedPath}/incident/${encodeURIComponent(incidentId)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}
