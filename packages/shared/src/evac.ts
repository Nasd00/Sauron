/**
 * Evacuation-assist contracts shared by services/evac and apps/web.
 * IDs are strings; timestamps are Unix milliseconds; coordinates are WGS84 degrees.
 */
export type LatLng = { latitude: number; longitude: number };
/** A closed ring; the first point is not repeated at the end. */
export type Polygon = LatLng[];

/** Where a piece of situational evidence came from. Shown to people next to the claim. */
export type SourceRef = {
  name: string;
  kind: "official" | "gods_eye" | "routing" | "demo_fixture";
  url?: string;
  /** True when fetched from a live upstream during this session, false for supplied/fixture data. */
  live: boolean;
  retrievedAt: number;
};

export type WarningSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
export type OfficialWarning = {
  id: string;
  event: string;
  severity: WarningSeverity;
  headline: string;
  /** Official instruction text, quoted verbatim to residents. */
  instruction: string;
  areaLabel: string;
  area: Polygon;
  issuedAt: number;
  expiresAt?: number;
  source: SourceRef;
};

export type MobilityNeed = "wheelchair" | "walker" | "limited_walking";
export type HouseholdNeeds = {
  people?: number;
  mobility: MobilityNeed[];
  /** Free-form medical needs relevant to a destination, e.g. "oxygen", "dialysis". */
  medical: string[];
  pets: number;
  hasVehicle?: boolean;
  /** Short human phrases describing who is in the household, e.g. "dad (wheelchair)". */
  notes: string[];
};

export type Household = {
  id: string;
  label: string;
  address: string;
  location: LatLng;
  residentId: string;
  needs: HouseholdNeeds;
  /** Conversation stage, driven by the agent. */
  stage:
    | "idle"
    | "warned"
    | "intake"
    | "choosing_destination"
    | "awaiting_consent"
    | "awaiting_helper"
    | "arranged"
    | "self_evacuating"
    | "complete";
  selectedShelterId?: string;
  /** Shelter IDs offered in the last destination message, in the order shown. */
  offeredShelterIds: string[];
  /** The route the household is currently expected to take to its destination. */
  activeRoute?: RouteSummary;
};

export type Shelter = {
  id: string;
  name: string;
  address: string;
  location: LatLng;
  capacity: number;
  occupied: number;
  wheelchairAccessible: boolean;
  petFriendly: boolean;
  medicalSupport: boolean;
  status: "open" | "full" | "closed";
  source: SourceRef;
};

export type RouteSummary = {
  id: string;
  from: LatLng;
  to: LatLng;
  distanceKm: number;
  durationMin: number;
  geometry: LatLng[];
  /** Notable named roads along the route, in travel order. */
  via: string[];
  provider: "valhalla" | "cache" | "estimate";
  /** Closures this route was computed to avoid. */
  avoidedClosureIds: string[];
  source: SourceRef;
};

export type DestinationOption = {
  shelterId: string;
  route: RouteSummary;
  reasons: string[];
  warnings: string[];
  score: number;
};

export type Helper = {
  id: string;
  name: string;
  participantId: string;
  home: LatLng;
  vehicle: { description: string; seats: number; wheelchairAccessible: boolean };
  /** Enrolled helpers have opted in to receive transport requests. */
  enrolled: boolean;
  status: "available" | "requested" | "assigned" | "unavailable";
};

export type Closure = {
  id: string;
  road: string;
  description: string;
  area: Polygon;
  /** Centerline used for drawing; optional. */
  line?: LatLng[];
  reportedAt: number;
  status: "active" | "cleared";
  /** A closure is verified when at least one official or camera-confirmed source supports it. */
  verifiedBy: SourceRef[];
};

export type ArrangementStatus =
  | "awaiting_consent"
  | "requested"
  | "confirmed"
  | "en_route"
  | "picked_up"
  | "arrived"
  | "unfilled"
  | "cancelled";

export type ArrangementHistoryEntry = { status: ArrangementStatus; at: number; note: string };
export type Arrangement = {
  id: string;
  householdId: string;
  shelterId: string;
  helperId?: string;
  /** Helpers already asked, in order, so escalation never repeats a request. */
  requestedHelperIds: string[];
  status: ArrangementStatus;
  tripRoute: RouteSummary;
  pickupRoute?: RouteSummary;
  pickupEta?: number;
  arrivalEta?: number;
  requestExpiresAt?: number;
  history: ArrangementHistoryEntry[];
};

export type Participant = {
  id: string;
  role: "resident" | "helper";
  name: string;
  /** Channel used to reach this participant. "web_sim" is the in-dashboard phone simulator. */
  channel: { platform: string; address?: string };
};

export type TranscriptEntry = {
  id: string;
  participantId: string;
  direction: "inbound" | "outbound";
  text: string;
  at: number;
  platform: string;
};

export type TimelineKind =
  | "warning" | "intake" | "destination" | "consent" | "request" | "confirmed"
  | "closure" | "reroute" | "checkin" | "escalation" | "system";
export type TimelineEvent = {
  id: string;
  at: number;
  kind: TimelineKind;
  title: string;
  detail?: string;
  source?: SourceRef;
};

/** A confirmed God's Eye camera incident, summarized for the evacuation view. */
export type GodsEyeIncident = {
  id: string;
  cameraId: string;
  location: LatLng;
  confidence: number;
  confirmedAt?: number;
  status: string;
};

export type EvacSnapshot = {
  scenario: { id: string; title: string; startedAt: number; areaCenter: LatLng; timeZone: string };
  warnings: OfficialWarning[];
  households: Household[];
  shelters: Shelter[];
  helpers: Helper[];
  closures: Closure[];
  arrangements: Arrangement[];
  /** Latest ranked options per household. */
  destinationOptions: Record<string, DestinationOption[]>;
  participants: Participant[];
  transcript: TranscriptEntry[];
  timeline: TimelineEvent[];
  incidents: GodsEyeIncident[];
  channels: { platform: string; label: string; connected: boolean }[];
  /** Upstream sources checked this session and whether they responded. */
  sourceHealth: { name: string; ok: boolean; detail: string; checkedAt: number }[];
};

export type EvacServerEvent =
  | { type: "snapshot"; snapshot: EvacSnapshot }
  | { type: "typing"; participantId: string; typing: boolean };
