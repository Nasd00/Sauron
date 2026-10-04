import { schema, table, t, type Infer } from "spacetimedb/server";
import type { Camera, Observation, Incident, Watch, Alert, InboundReceipt, UserAlertProfile, ConversationContext, MobileDevice } from "@tempmhacks/shared";

// String enums stay strings on the wire, matching the shared contracts.
// Reducers validate their allowed values before writing.
const cameraFields = {
  id: t.string(), name: t.string(), latitude: t.f64(), longitude: t.f64(),
  sourceType: t.string(), streamUrl: t.string().optional(), status: t.string(),
  lastSeenAt: t.f64().optional(),
};
const observationFields = {
  id: t.string(), cameraId: t.string(), type: t.string(), confidence: t.f64(),
  timestamp: t.f64(), evidenceUrl: t.string().optional(),
  bbox: t.object("BoundingBox", {
    x: t.f64(), y: t.f64(), width: t.f64(), height: t.f64(),
  }).optional(),
};
const incidentFields = {
  id: t.string(), cameraId: t.string(), type: t.string(), status: t.string(),
  confidence: t.f64(), latitude: t.f64(), longitude: t.f64(),
  firstSeenAt: t.f64(), lastSeenAt: t.f64(),
  confirmedAt: t.f64().optional(), resolvedAt: t.f64().optional(),
};
const watchFields = {
  id: t.string(), spaceId: t.string(), senderId: t.string(), placeLabel: t.string(),
  latitude: t.f64(), longitude: t.f64(), radiusKm: t.f64(),
  active: t.bool(), createdAt: t.f64(),
};
const inboundReceiptFields = {
  messageId: t.string(), spaceId: t.string(), senderId: t.string(),
  receivedAt: t.f64(), contentType: t.string(),
};
const alertFields = {
  id: t.string(), incidentId: t.string(), watchId: t.string(), status: t.string(),
  createdAt: t.f64(), sentAt: t.f64().optional(),
  providerMessageId: t.string().optional(), error: t.string().optional(),
};
const userAlertProfileFields = {
  userId: t.string(), spaceId: t.string(), senderId: t.string(),
  latitude: t.f64(), longitude: t.f64(), accuracyMeters: t.f64().optional(),
  locationUpdatedAt: t.f64(), radiusKm: t.f64(), alertsEnabled: t.bool(),
  createdAt: t.f64(), updatedAt: t.f64(),
};
const conversationContextFields = {
  spaceId: t.string(), activeIncidentId: t.string().optional(),
  lastCameraId: t.string().optional(), lastIntent: t.string().optional(),
  alertedAt: t.f64().optional(), updatedAt: t.f64(),
};
const mobileDeviceFields = {
  deviceId: t.string(), userId: t.string(), spaceId: t.string(), senderId: t.string(),
  trackingActive: t.bool(), sharingEnabled: t.bool(), revoked: t.bool(),
  pairedAt: t.f64(), updatedAt: t.f64(),
  lastLocationAt: t.f64().optional(), lastAccuracyMeters: t.f64().optional(),
};

export const cameraInput = t.object("CameraInput", cameraFields);
export const observationInput = t.object("ObservationInput", observationFields);
export const incidentInput = t.object("IncidentInput", incidentFields);
export const watchInput = t.object("WatchInput", watchFields);
export const alertInput = t.object("AlertInput", alertFields);
export const inboundReceiptInput = t.object("InboundReceiptInput", inboundReceiptFields);
export const userAlertProfileInput = t.object("UserAlertProfileInput", userAlertProfileFields);
export const conversationContextInput = t.object("ConversationContextInput", conversationContextFields);
export const mobileDeviceInput = t.object("MobileDeviceInput", mobileDeviceFields);

// Compile-time schema parity, allowing only the deliberate string-enum widening
// and required undefined-valued fields used by the database's option encoding.
type WidenString<T> = T extends string ? string : T;
type StorageShape<T> = { [K in keyof T]-?: WidenString<NonNullable<T[K]>> };
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Assert<T extends true> = T;
type Matches<A, B> = Equal<StorageShape<A>, StorageShape<B>> extends true
  ? Equal<OptionalKeys<A>, OptionalKeys<B>> : false;
export type SchemaContractChecks = [
  Assert<Matches<Infer<typeof cameraInput>, Camera>>,
  Assert<Matches<Infer<typeof observationInput>, Observation>>,
  Assert<Matches<Infer<typeof incidentInput>, Incident>>,
  Assert<Matches<Infer<typeof watchInput>, Watch>>,
  Assert<Matches<Infer<typeof alertInput>, Alert>>,
  Assert<Matches<Infer<typeof inboundReceiptInput>, InboundReceipt>>,
  Assert<Matches<Infer<typeof userAlertProfileInput>, UserAlertProfile>>,
  Assert<Matches<Infer<typeof conversationContextInput>, ConversationContext>>,
  Assert<Matches<Infer<typeof mobileDeviceInput>, MobileDevice>>,
];

const db = schema({
  module_config: table({ name: "module_config" }, {
    ownerIdentity: t.identity().primaryKey(),
  }),
  spectrum_event: table({ name: "spectrum_event" }, {
    eventId: t.string().primaryKey(), receivedAt: t.f64(),
  }),
  camera: table({ name: "camera", public: true }, {
    ...cameraFields, id: t.string().primaryKey(),
  }),
  observation: table({ name: "observation", public: true, indexes: [
    { accessor: "byCameraTimestamp", algorithm: "btree", columns: ["cameraId", "timestamp"] },
  ] }, { ...observationFields, id: t.string().primaryKey() }),
  incident: table({ name: "incident", public: true, indexes: [
    { accessor: "byCameraTypeStatus", algorithm: "btree", columns: ["cameraId", "type", "status"] },
  ] }, { ...incidentFields, id: t.string().primaryKey() }),
  watch: table({ name: "watch", public: true, indexes: [
    { accessor: "byActive", algorithm: "btree", columns: ["active"] },
    { accessor: "bySenderActive", algorithm: "btree", columns: ["senderId", "active"] },
  ] }, { ...watchFields, id: t.string().primaryKey() }),
  alert: table({ name: "alert", public: true, indexes: [
    { accessor: "byIncidentWatch", algorithm: "btree", columns: ["incidentId", "watchId"] },
  ] }, { ...alertFields, id: t.string().primaryKey() }),
  inbound_receipt: table({ name: "inbound_receipt", public: false }, {
    ...inboundReceiptFields, messageId: t.string().primaryKey(),
  }),
  user_alert_profile: table({ name: "user_alert_profile", public: true, indexes: [
    { accessor: "bySender", algorithm: "btree", columns: ["senderId"] },
    { accessor: "byAlertsEnabled", algorithm: "btree", columns: ["alertsEnabled"] },
  ] }, { ...userAlertProfileFields, userId: t.string().primaryKey() }),
  conversation_context: table({ name: "conversation_context", public: true }, {
    ...conversationContextFields, spaceId: t.string().primaryKey(),
  }),
  // Paired iPhones. Public and credential-free so Photon/alerts can read tracking state.
  mobile_device: table({ name: "mobile_device", public: true, indexes: [
    { accessor: "bySender", algorithm: "btree", columns: ["senderId"] },
  ] }, { ...mobileDeviceFields, deviceId: t.string().primaryKey() }),
  // Single-use pairing links. Only SHA-256 hashes of tokens are stored, privately.
  mobile_pairing: table({ name: "mobile_pairing", public: false }, {
    tokenHash: t.string().primaryKey(), userId: t.string(), spaceId: t.string(), senderId: t.string(),
    createdAt: t.f64(), expiresAt: t.f64(), usedAt: t.f64().optional(),
  }),
  // Device bearer credentials (hashed), scoped to location updates for one device.
  mobile_credential: table({ name: "mobile_credential", public: false }, {
    tokenHash: t.string().primaryKey(), deviceId: t.string(), createdAt: t.f64(),
    revokedAt: t.f64().optional(),
  }),
});

export default db;
