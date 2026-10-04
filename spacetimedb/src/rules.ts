import type { Alert, Camera, Incident, IncidentHazard, IncidentReport, InboundReceipt, Observation, Watch, UserAlertProfile, ConversationContext, MobileDevice } from "@tempmhacks/shared";

// Mirrors MANUAL_CAMERA_ID / REPORTABLE_HAZARDS in @tempmhacks/shared; the module only imports types
// from shared, and tests pin the two together.
export const MANUAL_CAMERA_ID = "manual";
export const REPORTABLE_HAZARDS: readonly IncidentHazard[] = ["fire", "smoke_fire", "flood", "gas_leak", "chemical", "violence", "other"];

export function requireConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Confidence must be a finite number between 0 and 1");
  }
}

export function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Timestamp must be a nonnegative safe integer in Unix milliseconds");
  }
}

export function requireHazard(type: string): asserts type is "smoke_fire" {
  if (type !== "smoke_fire") throw new Error("Only smoke_fire observations and incidents are supported");
}

export function normalizePlaceLabel(placeLabel: string): string {
  const normalized = placeLabel.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Watch placeLabel must not be empty");
  return normalized;
}

export function validateWatch(watch: Watch): Watch {
  if (!watch.spaceId.trim()) throw new Error("Watch spaceId must not be empty");
  if (!watch.senderId.trim()) throw new Error("Watch senderId must not be empty");
  if (!Number.isFinite(watch.radiusKm) || watch.radiusKm <= 0) {
    throw new Error("Watch radiusKm must be greater than 0");
  }
  requireTimestamp(watch.createdAt);
  return { ...watch, active: true, placeLabel: normalizePlaceLabel(watch.placeLabel) };
}

export function validateAlertStatus(status: string): asserts status is Alert["status"] {
  if (status !== "pending" && status !== "sending" && status !== "sent" && status !== "failed") {
    throw new Error("Invalid alert status");
  }
}

export function claimAlert(alert: Alert): Alert {
  if (alert.status !== "pending") throw new Error(`Cannot claim ${alert.status} alert`);
  return { ...alert, status: "sending" };
}

export function markAlertSent(alert: Alert, providerMessageId: string, sentAt: number): Alert {
  if (alert.status !== "sending") throw new Error(`Cannot mark ${alert.status} alert as sent`);
  if (!providerMessageId.trim()) throw new Error("Provider message ID must not be empty");
  requireTimestamp(sentAt);
  return { ...alert, status: "sent", providerMessageId, sentAt };
}

export function markAlertFailed(alert: Alert, error: string): Alert {
  if (alert.status !== "sending") throw new Error(`Cannot mark ${alert.status} alert as failed`);
  if (!error.trim()) throw new Error("Alert error must not be empty");
  return { ...alert, status: "failed", error };
}

export function requireCameraStatus(status: string): asserts status is Camera["status"] {
  if (status !== "online" && status !== "offline") throw new Error("Camera status must be online or offline");
}

export function validateCamera(camera: Camera): void {
  requireCameraStatus(camera.status);
  if (camera.sourceType !== "live" && camera.sourceType !== "replay") {
    throw new Error("Camera sourceType must be replay or live");
  }
  if (camera.lastSeenAt !== undefined) requireTimestamp(camera.lastSeenAt);
}

export function cameraStatusUpdate(camera: Camera, status: Camera["status"], lastSeenAt: number): Camera {
  requireCameraStatus(status);
  requireTimestamp(lastSeenAt);
  return { ...camera, status, lastSeenAt };
}

export function validateObservation(observation: Observation): void {
  requireHazard(observation.type);
  requireConfidence(observation.confidence);
  requireTimestamp(observation.timestamp);
}

export const MIN_REPORT_RADIUS_KM = 0.1;
export const MAX_REPORT_RADIUS_KM = 100;

export type ManualReportInput = {
  id: string; type: string; latitude: number; longitude: number;
  radiusKm: number; title: string; description: string; reportedBy: string;
};

/**
 * Builds the confirmed incident and its report for an operator's manual report. Manual reports
 * are confirmed on creation so the existing alert pipeline delivers them immediately.
 */
export function newManualIncident(input: ManualReportInput, now: number): { incident: Incident; report: IncidentReport } {
  if (!input.id.trim()) throw new Error("Incident id must not be empty");
  if (!(REPORTABLE_HAZARDS as readonly string[]).includes(input.type)) {
    throw new Error(`Hazard must be one of ${REPORTABLE_HAZARDS.join(", ")}`);
  }
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90
    || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    throw new Error("Report latitude and longitude must be valid coordinates");
  }
  if (!Number.isFinite(input.radiusKm) || input.radiusKm < MIN_REPORT_RADIUS_KM || input.radiusKm > MAX_REPORT_RADIUS_KM) {
    throw new Error(`Report radiusKm must be between ${MIN_REPORT_RADIUS_KM} and ${MAX_REPORT_RADIUS_KM}`);
  }
  const title = input.title.trim().replace(/\s+/g, " ");
  if (!title || title.length > 120) throw new Error("Report title must be 1-120 characters");
  const description = input.description.trim();
  if (description.length > 1000) throw new Error("Report description must be at most 1000 characters");
  requireTimestamp(now);
  const incident: Incident = {
    id: input.id, cameraId: MANUAL_CAMERA_ID, type: input.type as IncidentHazard, status: "confirmed",
    confidence: 1, latitude: input.latitude, longitude: input.longitude,
    firstSeenAt: now, lastSeenAt: now, confirmedAt: now,
  };
  const report: IncidentReport = {
    incidentId: input.id, title, description, radiusKm: input.radiusKm,
    reportedBy: input.reportedBy.trim().slice(0, 80) || "operator", reportedAt: now,
  };
  return { incident, report };
}

export function validateNewIncident(incident: Incident): void {
  requireHazard(incident.type);
  requireConfidence(incident.confidence);
  if (incident.status !== "candidate") throw new Error("New incidents must have candidate status");
  if (incident.confirmedAt !== undefined || incident.resolvedAt !== undefined) {
    throw new Error("New candidates cannot have confirmation or resolution timestamps");
  }
  requireTimestamp(incident.firstSeenAt);
  requireTimestamp(incident.lastSeenAt);
}

export function updateDetection(incident: Incident, confidence: number, lastSeenAt: number): Incident {
  if (incident.status !== "candidate" && incident.status !== "confirmed") {
    throw new Error(`Cannot update detection for ${incident.status} incident`);
  }
  requireConfidence(confidence);
  requireTimestamp(lastSeenAt);
  return { ...incident, confidence, lastSeenAt };
}

export function confirmIncident(incident: Incident, confirmedAt: number): Incident {
  if (incident.status !== "candidate") throw new Error(`Cannot confirm ${incident.status} incident`);
  if (incident.confirmedAt !== undefined) throw new Error("Confirmation timestamp is already set");
  requireTimestamp(confirmedAt);
  return { ...incident, status: "confirmed", confirmedAt };
}

export function dismissIncident(incident: Incident): Incident {
  if (incident.status !== "candidate") throw new Error(`Cannot dismiss ${incident.status} incident`);
  return { ...incident, status: "dismissed" };
}

export function resolveIncident(incident: Incident, resolvedAt: number): Incident {
  if (incident.status !== "confirmed") throw new Error(`Cannot resolve ${incident.status} incident`);
  if (incident.resolvedAt !== undefined) throw new Error("Resolution timestamp is already set");
  requireTimestamp(resolvedAt);
  return { ...incident, status: "resolved", resolvedAt };
}

/**
 * Validates the identity and metadata fields of an inbound receipt before it is
 * durably claimed. Pure; throws on invalid input.
 */
export function validateInboundReceipt(receipt: InboundReceipt): void {
  if (!receipt.messageId.trim() || !receipt.spaceId.trim() || !receipt.senderId.trim()) {
    throw new Error("Inbound message identity fields must not be empty");
  }
  requireTimestamp(receipt.receivedAt);
  if (!receipt.contentType.trim()) throw new Error("Inbound contentType must not be empty");
}

export function requireLatitude(value: number): void {
  if (!Number.isFinite(value) || value < -90 || value > 90) {
    throw new Error("Latitude must be a finite number between -90 and 90");
  }
}

export function requireLongitude(value: number): void {
  if (!Number.isFinite(value) || value < -180 || value > 180) {
    throw new Error("Longitude must be a finite number between -180 and 180");
  }
}

/**
 * Validates a current-location monitoring profile and returns a normalized copy.
 * Pure; throws on invalid input. The reducer runs this inside its transaction so
 * a malformed profile is rejected atomically with the upsert.
 */
export function validateUserAlertProfile(profile: UserAlertProfile): UserAlertProfile {
  if (!profile.userId.trim()) throw new Error("Profile userId must not be empty");
  if (!profile.spaceId.trim()) throw new Error("Profile spaceId must not be empty");
  if (!profile.senderId.trim()) throw new Error("Profile senderId must not be empty");
  requireLatitude(profile.latitude);
  requireLongitude(profile.longitude);
  if (profile.accuracyMeters !== undefined) {
    if (!Number.isFinite(profile.accuracyMeters) || profile.accuracyMeters < 0) {
      throw new Error("Profile accuracyMeters must be a nonnegative finite number");
    }
  }
  requireTimestamp(profile.locationUpdatedAt);
  if (!Number.isFinite(profile.radiusKm) || profile.radiusKm <= 0) {
    throw new Error("Profile radiusKm must be greater than 0");
  }
  requireTimestamp(profile.createdAt);
  requireTimestamp(profile.updatedAt);
  return profile;
}

/** Validates a conversation context before it is persisted. Pure; throws on invalid input. */
export function validateConversationContext(context: ConversationContext): ConversationContext {
  if (!context.spaceId.trim()) throw new Error("ConversationContext spaceId must not be empty");
  if (context.activeIncidentId !== undefined && !context.activeIncidentId.trim()) {
    throw new Error("ConversationContext activeIncidentId must not be empty when present");
  }
  if (context.lastCameraId !== undefined && !context.lastCameraId.trim()) {
    throw new Error("ConversationContext lastCameraId must not be empty when present");
  }
  if (context.lastIntent !== undefined && !context.lastIntent.trim()) {
    throw new Error("ConversationContext lastIntent must not be empty when present");
  }
  if (context.alertedAt !== undefined) requireTimestamp(context.alertedAt);
  requireTimestamp(context.updatedAt);
  return context;
}

// --- Mobile companion app (pairing, device credentials, location uploads) ---
// Error messages start with a stable code so the HTTP layer can map them to status codes.

export const MOBILE_PAIRING_TTL_MS = 10 * 60 * 1000;
export const MOBILE_MAX_ACCURACY_METERS = 500;
/** Uploads captured more than this far in the future (clock skew) are rejected. */
export const MOBILE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Uploads older than this are rejected; the app only sends recent fixes. */
export const MOBILE_MAX_FIX_AGE_MS = 60 * 60 * 1000;

export type MobilePairing = {
  tokenHash: string; userId: string; spaceId: string; senderId: string;
  createdAt: number; expiresAt: number; usedAt?: number;
};

export type MobileLocationInput = {
  latitude: number; longitude: number; accuracyMeters: number; capturedAt: number;
};

/** Tokens are stored and compared only as lowercase hex SHA-256 digests. */
export function requireTokenHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("token_invalid: token hash must be a SHA-256 hex digest");
}

export function requireNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

export function newMobilePairing(
  input: { tokenHash: string; userId: string; spaceId: string; senderId: string }, now: number,
): MobilePairing {
  requireTokenHash(input.tokenHash);
  requireNonEmpty(input.userId, "Pairing userId");
  requireNonEmpty(input.spaceId, "Pairing spaceId");
  requireNonEmpty(input.senderId, "Pairing senderId");
  requireTimestamp(now);
  return { ...input, createdAt: now, expiresAt: now + MOBILE_PAIRING_TTL_MS, usedAt: undefined };
}

/** Throws unless the pairing exists, is unused, and has not expired. */
export function requireRedeemablePairing(pairing: MobilePairing | undefined, now: number): MobilePairing {
  if (!pairing) throw new Error("pairing_invalid: pairing link is not valid");
  if (pairing.usedAt !== undefined) throw new Error("pairing_used: pairing link was already used");
  if (now > pairing.expiresAt) throw new Error("pairing_expired: pairing link has expired");
  return pairing;
}

export function validateMobileLocation(location: MobileLocationInput, now: number): void {
  try {
    requireLatitude(location.latitude);
    requireLongitude(location.longitude);
    requireTimestamp(location.capturedAt);
  } catch (error) {
    throw new Error(`location_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isFinite(location.accuracyMeters) || location.accuracyMeters < 0) {
    throw new Error("location_invalid: accuracyMeters must be a nonnegative finite number");
  }
  if (location.accuracyMeters > MOBILE_MAX_ACCURACY_METERS) {
    throw new Error(`location_invalid: accuracy worse than ${MOBILE_MAX_ACCURACY_METERS} m is not accepted`);
  }
  if (location.capturedAt > now + MOBILE_MAX_FUTURE_SKEW_MS) {
    throw new Error("location_invalid: capturedAt is in the future");
  }
  if (location.capturedAt < now - MOBILE_MAX_FIX_AGE_MS) {
    throw new Error("location_invalid: capturedAt is too old");
  }
}

/** Throws unless the device may currently upload locations. */
export function requireUploadingDevice(device: MobileDevice | undefined): MobileDevice {
  if (!device || device.revoked) throw new Error("device_unauthorized: device is not paired");
  if (!device.trackingActive) throw new Error("tracking_stopped: location sharing was stopped over iMessage");
  return device;
}

/**
 * Applies an accepted upload: the device's single location-backed profile is
 * moved in place (created on the first upload after pairing). Returns undefined
 * for an out-of-order fix older than the last accepted one, which is ignored.
 */
export function applyMobileLocation(
  device: MobileDevice,
  profile: UserAlertProfile | undefined,
  location: MobileLocationInput,
  defaultRadiusKm: number,
  now: number,
): { device: MobileDevice; profile: UserAlertProfile } | undefined {
  requireUploadingDevice(device);
  validateMobileLocation(location, now);
  if (device.lastLocationAt !== undefined && location.capturedAt <= device.lastLocationAt) return undefined;
  if (!Number.isFinite(defaultRadiusKm) || defaultRadiusKm <= 0) throw new Error("radiusKm must be greater than 0");
  const nextProfile = validateUserAlertProfile({
    userId: device.userId,
    spaceId: device.spaceId,
    senderId: device.senderId,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracyMeters: location.accuracyMeters,
    locationUpdatedAt: location.capturedAt,
    radiusKm: profile?.radiusKm ?? defaultRadiusKm,
    // Tracking consent (pairing / WATCH ME) is what enables alerts for this profile.
    alertsEnabled: true,
    createdAt: profile?.createdAt ?? now,
    updatedAt: now,
  });
  return {
    device: {
      ...device, sharingEnabled: true, lastLocationAt: location.capturedAt,
      lastAccuracyMeters: location.accuracyMeters, updatedAt: now,
    },
    profile: nextProfile,
  };
}
