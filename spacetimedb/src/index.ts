import { Router, SyncResponse, t, SenderError, type Infer, type ReducerCtx } from "spacetimedb/server";
import type { Alert, Camera, Observation, Incident, Watch, InboundReceipt, UserAlertProfile, ConversationContext, MobileDevice } from "@tempmhacks/shared";
import db, { cameraInput, observationInput, incidentInput, watchInput, alertInput, inboundReceiptInput, userAlertProfileInput, conversationContextInput, mobileDeviceInput } from "./schema";
import {
  validateCamera, validateObservation, validateNewIncident, cameraStatusUpdate,
  requireCameraStatus, requireTimestamp, updateDetection, confirmIncident,
  dismissIncident, resolveIncident,
  validateWatch, validateAlertStatus, claimAlert, markAlertSent, markAlertFailed,
  validateInboundReceipt,
  validateUserAlertProfile, validateConversationContext,
  requireTokenHash, newMobilePairing, requireRedeemablePairing, requireUploadingDevice, applyMobileLocation,
  newManualIncident,
} from "./rules";

export default db;
type Context = ReducerCtx<typeof db.schemaType>;

type SpectrumWebhook = { event_id?: unknown; eventId?: unknown };

export const spectrum_webhook = db.httpHandler({ name: "spectrum_webhook" }, (ctx, request) => {
  if (request.method !== "POST") {
    return new SyncResponse(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "content-type": "application/json", allow: "POST" },
    });
  }

  let payload: SpectrumWebhook;
  try {
    payload = request.json() as SpectrumWebhook;
  } catch {
    return new SyncResponse(JSON.stringify({ error: "Request body must be valid JSON" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  const eventId = typeof payload.event_id === "string"
    ? payload.event_id : typeof payload.eventId === "string" ? payload.eventId : undefined;
  if (!eventId?.trim()) {
    return new SyncResponse(JSON.stringify({ error: "Missing event_id" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  const accepted = ctx.withTx(tx => {
    if (tx.db.spectrum_event.eventId.find(eventId)) return false;
    tx.db.spectrum_event.insert({ eventId, receivedAt: Date.now() });
    return true;
  });
  return new SyncResponse(JSON.stringify({ accepted, duplicate: !accepted }), {
    status: 202, headers: { "content-type": "application/json" },
  });
});

export const http = db.httpRouter(new Router().post("/webhooks/spectrum", spectrum_webhook));

export const init = db.init(ctx => {
  ctx.db.module_config.insert({ ownerIdentity: ctx.sender });
});

function checked<T>(action: () => T): T {
  try { return action(); }
  catch (error) { throw new SenderError(error instanceof Error ? error.message : String(error)); }
}

function requireCamera(ctx: Context, id: string) {
  const camera = ctx.db.camera.id.find(id);
  if (!camera) throw new SenderError(`Camera ${id} does not exist`);
  return camera;
}

function requireIncident(ctx: Context, id: string): Incident {
  const incident = ctx.db.incident.id.find(id);
  if (!incident) throw new SenderError(`Incident ${id} does not exist`);
  // All writes validate string enums; no local copies of shared shapes.
  return incident as Incident;
}

// Shared optional properties map to explicit undefined options in storage.
function storedIncident(incident: Incident): Infer<typeof incidentInput> {
  return { ...incident, confirmedAt: incident.confirmedAt, resolvedAt: incident.resolvedAt };
}

function storedAlert(alert: Alert): Infer<typeof alertInput> {
  return {
    ...alert,
    sentAt: alert.sentAt,
    providerMessageId: alert.providerMessageId,
    error: alert.error,
  };
}

function storedProfile(profile: UserAlertProfile): Infer<typeof userAlertProfileInput> {
  return { ...profile, accuracyMeters: profile.accuracyMeters };
}

function storedContext(context: ConversationContext): Infer<typeof conversationContextInput> {
  return {
    ...context,
    activeIncidentId: context.activeIncidentId,
    lastCameraId: context.lastCameraId,
    lastIntent: context.lastIntent,
    alertedAt: context.alertedAt,
  };
}

export const register_camera = db.reducer({ camera: cameraInput }, (ctx, { camera }) => {
  checked(() => validateCamera(camera as Camera));
  if (ctx.db.camera.id.find(camera.id)) throw new SenderError(`Camera ${camera.id} already exists`);
  ctx.db.camera.insert(camera);
});

export const set_camera_status = db.reducer({ cameraId: t.string(), status: t.string(), lastSeenAt: t.f64() },
  (ctx, { cameraId, status, lastSeenAt }) => {
    const camera = requireCamera(ctx, cameraId);
    checked(() => requireCameraStatus(status));
    const updated = checked(() => cameraStatusUpdate(camera as Camera, status as Camera["status"], lastSeenAt));
    ctx.db.camera.id.update({ ...camera, status: updated.status, lastSeenAt: updated.lastSeenAt });
  });

export const publish_observation = db.reducer({ observation: observationInput }, (ctx, { observation }) => {
  requireCamera(ctx, observation.cameraId);
  checked(() => validateObservation(observation as Observation));
  if (ctx.db.observation.id.find(observation.id)) throw new SenderError(`Observation ${observation.id} already exists`);
  ctx.db.observation.insert(observation);
});

export const create_incident = db.reducer({ input: incidentInput }, (ctx, { input }) => {
  requireCamera(ctx, input.cameraId);
  checked(() => validateNewIncident(input as Incident));
  if (ctx.db.incident.id.find(input.id)) throw new SenderError(`Incident ${input.id} already exists`);
  ctx.db.incident.insert(input);
});

export const update_incident_detection = db.reducer({ id: t.string(), confidence: t.f64(), lastSeenAt: t.f64() },
  (ctx, { id, confidence, lastSeenAt }) => {
    const incident = requireIncident(ctx, id);
    ctx.db.incident.id.update(storedIncident(checked(() => updateDetection(incident, confidence, lastSeenAt))));
  });

export const confirm_incident = db.reducer({ id: t.string(), confirmedAt: t.f64() }, (ctx, { id, confirmedAt }) => {
  const incident = requireIncident(ctx, id);
  ctx.db.incident.id.update(storedIncident(checked(() => confirmIncident(incident, confirmedAt))));
});

export const dismiss_incident = db.reducer({ id: t.string() }, (ctx, { id }) => {
  const incident = requireIncident(ctx, id);
  ctx.db.incident.id.update(storedIncident(checked(() => dismissIncident(incident))));
});

export const resolve_incident = db.reducer({ id: t.string(), resolvedAt: t.f64() }, (ctx, { id, resolvedAt }) => {
  const incident = requireIncident(ctx, id);
  // Reported incidents are operator actions: a public DB identity may read them,
  // but must not clear one without Photon's operator identity.
  if (incident.cameraId === "manual") requireOperator(ctx);
  ctx.db.incident.id.update(storedIncident(checked(() => resolveIncident(incident, resolvedAt))));
});

export const create_watch = db.reducer({ input: watchInput }, (ctx, { input }) => {
  const watch = checked(() => validateWatch(input as Watch));
  if (ctx.db.watch.id.find(watch.id)) throw new SenderError(`Watch ${watch.id} already exists`);
  for (const existing of ctx.db.watch.byActive.filter(true)) {
    if (existing.senderId === watch.senderId) ctx.db.watch.id.update({ ...existing, active: false });
  }
  ctx.db.watch.insert(watch);
});

export const deactivate_watches_for_sender = db.reducer({ senderId: t.string() }, (ctx, { senderId }) => {
  for (const watch of ctx.db.watch.byActive.filter(true)) {
    if (watch.senderId === senderId) ctx.db.watch.id.update({ ...watch, active: false });
  }
});

export const claim_inbound_message = db.reducer({ receipt: inboundReceiptInput }, (ctx, { receipt }) => {
  // Validate identity/metadata first (pure, throws on malformed input).
  checked(() => validateInboundReceipt(receipt as InboundReceipt));
  // Dedup on messageId. On the deployed backend the primary-key accessor
  // `.messageId.find()` returned false positives for this private table, and
  // insert() does not throw on a duplicate key, so scan explicitly. This is O(n)
  // in stored receipts; acceptable at MVP volume.
  for (const existing of ctx.db.inbound_receipt.iter()) {
    if (existing.messageId === receipt.messageId) {
      throw new SenderError(`Inbound message ${receipt.messageId} was already claimed`);
    }
  }
  ctx.db.inbound_receipt.insert(receipt as InboundReceipt);
});

export const create_alert = db.reducer({ incidentId: t.string(), watchId: t.string() }, (ctx, { incidentId, watchId }) => {
  const incident = ctx.db.incident.id.find(incidentId);
  if (!incident) throw new SenderError("Alert incident does not exist");
  if (incident.status !== "confirmed") throw new SenderError("Alerts require a confirmed incident");
  const watch = ctx.db.watch.id.find(watchId);
  if (!watch) throw new SenderError("Alert watch does not exist");
  if (!watch.active) throw new SenderError("Alert watch is not active");
  for (const existing of ctx.db.alert.byIncidentWatch.filter([incidentId, watchId])) {
    throw new SenderError(`Alert ${existing.id} already exists for this incident and watch`);
  }
  const alert: Alert = {
    id: `${incidentId}:${watchId}`, incidentId, watchId, status: "pending", createdAt: Date.now(),
    sentAt: undefined, providerMessageId: undefined, error: undefined,
  };
  ctx.db.alert.insert(storedAlert(alert));
});

// Profile-targeted alert. The alert's watchId column carries a namespaced target
// id ("profile:<userId>") so profile and watch alerts never collide on the
// (incidentId, target) uniqueness index. The sender resolves the source by prefix.
export const create_alert_for_profile = db.reducer(
  { incidentId: t.string(), userId: t.string() },
  (ctx, { incidentId, userId }) => {
    const incident = ctx.db.incident.id.find(incidentId);
    if (!incident) throw new SenderError("Alert incident does not exist");
    if (incident.status !== "confirmed") throw new SenderError("Alerts require a confirmed incident");
    const profile = ctx.db.user_alert_profile.userId.find(userId);
    if (!profile) throw new SenderError("Alert profile does not exist");
    if (!profile.alertsEnabled) throw new SenderError("Alert profile has alerts disabled");
    const targetId = `profile:${userId}`;
    for (const existing of ctx.db.alert.byIncidentWatch.filter([incidentId, targetId])) {
      throw new SenderError(`Alert ${existing.id} already exists for this incident and profile`);
    }
    const alert: Alert = {
      id: `${incidentId}:${targetId}`, incidentId, watchId: targetId, status: "pending",
      createdAt: Date.now(), sentAt: undefined, providerMessageId: undefined, error: undefined,
    };
    ctx.db.alert.insert(storedAlert(alert));
  });

export const mark_alert_sent = db.reducer({ alertId: t.string(), providerMessageId: t.string(), sentAt: t.f64() },
  (ctx, { alertId, providerMessageId, sentAt }) => {
    const alert = ctx.db.alert.id.find(alertId);
    if (!alert) throw new SenderError(`Alert ${alertId} does not exist`);
    ctx.db.alert.id.update(storedAlert(checked(() => markAlertSent(alert as Alert, providerMessageId, sentAt))));
  });

export const claim_alert = db.reducer({ alertId: t.string() }, (ctx, { alertId }) => {
  const alert = ctx.db.alert.id.find(alertId);
  if (!alert) throw new SenderError(`Alert ${alertId} does not exist`);
  ctx.db.alert.id.update(storedAlert(checked(() => claimAlert(alert as Alert))));
});

export const mark_alert_failed = db.reducer({ alertId: t.string(), error: t.string() }, (ctx, { alertId, error }) => {
  const alert = ctx.db.alert.id.find(alertId);
  if (!alert) throw new SenderError(`Alert ${alertId} does not exist`);
  ctx.db.alert.id.update(storedAlert(checked(() => markAlertFailed(alert as Alert, error))));
});

// --- Current-location profiles and conversation context ---

function requireProfile(ctx: Context, userId: string): UserAlertProfile {
  const profile = ctx.db.user_alert_profile.userId.find(userId);
  if (!profile) throw new SenderError(`Profile ${userId} does not exist`);
  return profile as UserAlertProfile;
}

// Upserts a user's current-location monitoring profile (one row per userId),
// preserving the original createdAt on update.
export const upsert_user_alert_profile = db.reducer({ input: userAlertProfileInput }, (ctx, { input }) => {
  const profile = checked(() => validateUserAlertProfile(input as UserAlertProfile));
  const existing = ctx.db.user_alert_profile.userId.find(profile.userId);
  if (existing) {
    ctx.db.user_alert_profile.userId.update(storedProfile({ ...profile, createdAt: existing.createdAt }));
  } else {
    ctx.db.user_alert_profile.insert(storedProfile(profile));
  }
});

export const set_alerts_enabled = db.reducer(
  { userId: t.string(), alertsEnabled: t.bool(), updatedAt: t.f64() },
  (ctx, { userId, alertsEnabled, updatedAt }) => {
    const profile = requireProfile(ctx, userId);
    checked(() => requireTimestamp(updatedAt));
    ctx.db.user_alert_profile.userId.update(storedProfile({ ...profile, alertsEnabled, updatedAt }));
  });

// Upserts the per-conversation context that anchors grounded follow-ups.
export const upsert_conversation_context = db.reducer({ input: conversationContextInput }, (ctx, { input }) => {
  const context = checked(() => validateConversationContext(input as ConversationContext));
  if (ctx.db.conversation_context.spaceId.find(context.spaceId)) {
    ctx.db.conversation_context.spaceId.update(storedContext(context));
  } else {
    ctx.db.conversation_context.insert(storedContext(context));
  }
});

// --- Mobile companion app ---
// Photon generates tokens, hashes them (SHA-256), and passes only hashes here; raw
// tokens are never stored. Private tables are scanned rather than looked up by
// primary key, matching the inbound_receipt workaround above.

function storedDevice(device: MobileDevice): Infer<typeof mobileDeviceInput> {
  return { ...device, lastLocationAt: device.lastLocationAt, lastAccuracyMeters: device.lastAccuracyMeters };
}

function findPairing(ctx: Context, tokenHash: string) {
  for (const pairing of ctx.db.mobile_pairing.iter()) if (pairing.tokenHash === tokenHash) return pairing;
  return undefined;
}

/** Resolves a device bearer credential to its device row; throws when unknown or revoked. */
function deviceForCredential(ctx: Context, credentialTokenHash: string): MobileDevice {
  checked(() => requireTokenHash(credentialTokenHash));
  for (const credential of ctx.db.mobile_credential.iter()) {
    if (credential.tokenHash !== credentialTokenHash) continue;
    if (credential.revokedAt !== undefined) break;
    const device = ctx.db.mobile_device.deviceId.find(credential.deviceId);
    if (device && !device.revoked) return device as MobileDevice;
    break;
  }
  throw new SenderError("device_unauthorized: device is not paired");
}

function revokeDevice(ctx: Context, device: MobileDevice, now: number): void {
  ctx.db.mobile_device.deviceId.update(storedDevice({
    ...device, revoked: true, trackingActive: false, sharingEnabled: false, updatedAt: now,
  }));
  for (const credential of ctx.db.mobile_credential.iter()) {
    if (credential.deviceId === device.deviceId && credential.revokedAt === undefined) {
      ctx.db.mobile_credential.tokenHash.update({ ...credential, revokedAt: now });
    }
  }
}

export const create_mobile_pairing = db.reducer(
  { tokenHash: t.string(), userId: t.string(), spaceId: t.string(), senderId: t.string() },
  (ctx, input) => {
    const pairing = checked(() => newMobilePairing(input, Date.now()));
    if (findPairing(ctx, pairing.tokenHash)) throw new SenderError("pairing_invalid: duplicate pairing token");
    ctx.db.mobile_pairing.insert({ ...pairing, usedAt: undefined });
  });

// Single-use redemption. One paired device per sender: earlier devices are revoked.
export const redeem_mobile_pairing = db.reducer(
  { pairingTokenHash: t.string(), credentialTokenHash: t.string(), deviceId: t.string() },
  (ctx, { pairingTokenHash, credentialTokenHash, deviceId }) => {
    const now = Date.now();
    checked(() => { requireTokenHash(pairingTokenHash); requireTokenHash(credentialTokenHash); });
    if (!deviceId.trim()) throw new SenderError("Device id must not be empty");
    const pairing = checked(() => requireRedeemablePairing(findPairing(ctx, pairingTokenHash), now));
    if (ctx.db.mobile_device.deviceId.find(deviceId)) throw new SenderError(`Device ${deviceId} already exists`);
    ctx.db.mobile_pairing.tokenHash.update({ ...pairing, usedAt: now });
    for (const existing of ctx.db.mobile_device.bySender.filter(pairing.senderId)) {
      if (!existing.revoked) revokeDevice(ctx, existing as MobileDevice, now);
    }
    ctx.db.mobile_device.insert(storedDevice({
      deviceId, userId: pairing.userId, spaceId: pairing.spaceId, senderId: pairing.senderId,
      trackingActive: true, sharingEnabled: false, revoked: false, pairedAt: now, updatedAt: now,
      lastLocationAt: undefined, lastAccuracyMeters: undefined,
    }));
    ctx.db.mobile_credential.insert({
      tokenHash: credentialTokenHash, deviceId, createdAt: now, revokedAt: undefined,
    });
  });

// Moves the paired user's single location-backed profile; never creates watches.
export const mobile_update_location = db.reducer(
  {
    credentialTokenHash: t.string(), latitude: t.f64(), longitude: t.f64(),
    accuracyMeters: t.f64(), capturedAt: t.f64(), defaultRadiusKm: t.f64(),
  },
  (ctx, { credentialTokenHash, defaultRadiusKm, ...location }) => {
    const device = deviceForCredential(ctx, credentialTokenHash);
    const existing = ctx.db.user_alert_profile.userId.find(device.userId) as UserAlertProfile | undefined;
    const applied = checked(() => applyMobileLocation(device, existing, location, defaultRadiusKm, Date.now()));
    if (!applied) return; // Out-of-order fix: ignored.
    ctx.db.mobile_device.deviceId.update(storedDevice(applied.device));
    if (existing) ctx.db.user_alert_profile.userId.update(storedProfile(applied.profile));
    else ctx.db.user_alert_profile.insert(storedProfile(applied.profile));
  });

// The in-app Start/Stop Sharing toggle. Starting requires messaging-channel consent.
export const mobile_set_sharing = db.reducer(
  { credentialTokenHash: t.string(), enabled: t.bool() },
  (ctx, { credentialTokenHash, enabled }) => {
    const device = deviceForCredential(ctx, credentialTokenHash);
    if (enabled) checked(() => requireUploadingDevice(device));
    ctx.db.mobile_device.deviceId.update(storedDevice({ ...device, sharingEnabled: enabled, updatedAt: Date.now() }));
  });

// Read-only credential check for the app's status request.
export const mobile_check_credential = db.reducer(
  { credentialTokenHash: t.string(), deviceId: t.string() },
  (ctx, { credentialTokenHash, deviceId }) => {
    const device = deviceForCredential(ctx, credentialTokenHash);
    if (device.deviceId !== deviceId) throw new SenderError("device_unauthorized: device is not paired");
  });

// STOP (active=false) and WATCH ME (active=true) over iMessage.
export const set_mobile_tracking_for_sender = db.reducer(
  { senderId: t.string(), active: t.bool() },
  (ctx, { senderId, active }) => {
    const now = Date.now();
    for (const device of ctx.db.mobile_device.bySender.filter(senderId)) {
      if (device.revoked || device.trackingActive === active) continue;
      ctx.db.mobile_device.deviceId.update(storedDevice({ ...(device as MobileDevice), trackingActive: active, updatedAt: now }));
    }
  });

export const revoke_mobile_device = db.reducer({ deviceId: t.string() }, (ctx, { deviceId }) => {
  const device = ctx.db.mobile_device.deviceId.find(deviceId);
  if (!device) throw new SenderError(`Device ${deviceId} does not exist`);
  if (!device.revoked) revokeDevice(ctx, device as MobileDevice, Date.now());
});

// Owner-only schema fixture writes for integration setup.
function requireOwner(ctx: Context): void {
  if (!ctx.db.module_config.ownerIdentity.find(ctx.sender)) {
    throw new SenderError("Only the database owner may insert schema fixtures");
  }
}

/** The owner, or an identity the owner granted with grant_operator (e.g. Photon's token). */
function requireOperator(ctx: Context): void {
  if (ctx.db.module_config.ownerIdentity.find(ctx.sender)) return;
  const sender = ctx.sender.toHexString().toLowerCase();
  // Private-table scan, matching the inbound_receipt workaround above.
  for (const operator of ctx.db.operator.iter()) {
    if (operator.identityHex === sender) return;
  }
  throw new SenderError("operator_required: only the owner or a granted operator may report incidents");
}

function normalizeIdentityHex(value: string): string {
  const hex = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new SenderError("Identity must be 64 hex characters");
  return hex;
}

export const grant_operator = db.reducer({ identityHex: t.string() }, (ctx, { identityHex }) => {
  requireOwner(ctx);
  const hex = normalizeIdentityHex(identityHex);
  for (const operator of ctx.db.operator.iter()) if (operator.identityHex === hex) return;
  ctx.db.operator.insert({ identityHex: hex, grantedAt: Date.now() });
});

export const revoke_operator = db.reducer({ identityHex: t.string() }, (ctx, { identityHex }) => {
  requireOwner(ctx);
  const hex = normalizeIdentityHex(identityHex);
  for (const operator of ctx.db.operator.iter()) {
    if (operator.identityHex === hex) ctx.db.operator.identityHex.delete(operator.identityHex);
  }
});

// A person marked a dangerous area by hand. The incident is confirmed on insert, so the alert
// pipeline and help agents pick it up exactly like a camera-confirmed incident.
export const report_incident = db.reducer(
  {
    id: t.string(), type: t.string(), latitude: t.f64(), longitude: t.f64(), radiusKm: t.f64(),
    title: t.string(), description: t.string(), reportedBy: t.string(),
  },
  (ctx, input) => {
    requireOperator(ctx);
    if (ctx.db.incident.id.find(input.id)) throw new SenderError(`Incident ${input.id} already exists`);
    const { incident, report } = checked(() => newManualIncident(input, Date.now()));
    ctx.db.incident.insert(storedIncident(incident));
    ctx.db.incident_report.insert(report);
  });

export const insert_watch = db.reducer({ watch: watchInput }, (ctx, { watch }) => {
  requireOwner(ctx);
  const normalized = checked(() => validateWatch(watch as Watch));
  if (ctx.db.watch.id.find(watch.id)) throw new SenderError(`Watch ${watch.id} already exists`);
  ctx.db.watch.insert(normalized);
});

export const insert_alert = db.reducer({ alert: alertInput }, (ctx, { alert }) => {
  requireOwner(ctx);
  if (ctx.db.alert.id.find(alert.id)) throw new SenderError(`Alert ${alert.id} already exists`);
  if (!ctx.db.incident.id.find(alert.incidentId)) throw new SenderError("Alert incident does not exist");
  if (!ctx.db.watch.id.find(alert.watchId)) throw new SenderError("Alert watch does not exist");
  for (const existing of ctx.db.alert.byIncidentWatch.filter([alert.incidentId, alert.watchId])) {
    throw new SenderError(`Alert ${existing.id} already exists for this incident and watch`);
  }
  checked(() => validateAlertStatus(alert.status));
  checked(() => {
    requireTimestamp(alert.createdAt);
    if (alert.sentAt !== undefined) requireTimestamp(alert.sentAt);
  });
  ctx.db.alert.insert(alert);
});
