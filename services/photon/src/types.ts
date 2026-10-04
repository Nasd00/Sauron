import type {
  Camera, ConversationContext, Incident, Observation, UserAlertProfile, Watch,
} from "@tempmhacks/shared";

export type InboundMessage = {
  messageId: string;
  spaceId: string;
  senderId: string;
  receivedAt: string;
  content:
    | { type: "text"; text: string }
    | { type: "location"; latitude: number; longitude: number }
    | { type: "attachment"; url?: string; mimeType?: string; name?: string }
    | { type: "other"; shareKind?: NativeShareKind };
};

/** Native iMessage share balloons that never carry readable coordinates. */
export type NativeShareKind = "find_my" | "maps_balloon";

export type GeocodeResult = { label: string; latitude: number; longitude: number };

export interface Geocoder {
  geocode(query: string): Promise<GeocodeResult | null>;
}

export interface MessagingStore {
  /** Atomically persist the message ID; false means it was already claimed. */
  claimInbound(message: InboundMessage): Promise<boolean>;
  getActiveWatch(senderId: string): Promise<Watch | undefined>;
  replaceWatch(watch: Watch): Promise<void>;
  deactivateWatches(senderId: string): Promise<void>;

  // Current-location profiles.
  getProfileForSender(senderId: string): Promise<UserAlertProfile | undefined>;
  upsertProfile(profile: UserAlertProfile): Promise<void>;
  setAlertsEnabled(userId: string, alertsEnabled: boolean): Promise<void>;

  // Conversation context + grounded Q&A reads.
  getConversationContext(spaceId: string): Promise<ConversationContext | undefined>;
  upsertConversationContext(context: ConversationContext): Promise<void>;
  /** Clears the active-incident anchor for a conversation (used on STOP/re-enroll). */
  clearConversationContext(spaceId: string): Promise<void>;
  getIncident(incidentId: string): Promise<Incident | undefined>;
  getCamera(cameraId: string): Promise<Camera | undefined>;
  getLatestObservation(cameraId: string): Promise<Observation | undefined>;
  countOtherNearbyCameras(cameraId: string, latitude: number, longitude: number, radiusKm: number): Promise<number>;
}

export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
