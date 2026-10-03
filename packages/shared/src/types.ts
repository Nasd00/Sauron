/** Canonical contracts. IDs are strings; timestamps are Unix milliseconds. */
export type HazardType = "smoke_fire";
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
  cameraId: string;
  type: HazardType;
  status: IncidentStatus;
  confidence: number;
  latitude: number;
  longitude: number;
  firstSeenAt: number;
  lastSeenAt: number;
  confirmedAt?: number;
  resolvedAt?: number;
};

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

export function incidentUrl(baseUrl: string, incidentId: string): string {
  const base = new URL(baseUrl);
  const normalizedPath = base.pathname.replace(/\/$/, "");
  base.pathname = `${normalizedPath}/incident/${encodeURIComponent(incidentId)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}
