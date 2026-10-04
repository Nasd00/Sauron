import type { Alert, Camera, Incident, InboundReceipt, Observation, Watch, UserAlertProfile, ConversationContext } from "@tempmhacks/shared";

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
