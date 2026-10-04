import type { Watch } from "@tempmhacks/shared";

export type InboundMessage = {
  messageId: string;
  spaceId: string;
  senderId: string;
  receivedAt: string;
  content:
    | { type: "text"; text: string }
    | { type: "attachment"; url?: string; mimeType?: string; name?: string }
    | { type: "other" };
};

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
}

export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
