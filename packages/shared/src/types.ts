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
  userHandle: string;
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
  status: "pending" | "sent" | "failed";
  createdAt: number;
  sentAt?: number;
  providerMessageId?: string;
  error?: string;
};
