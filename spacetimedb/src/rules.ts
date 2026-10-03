import type { Camera, Observation, Incident } from "@tempmhacks/shared";

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
