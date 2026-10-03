import { t, SenderError, type Infer, type ReducerCtx } from "spacetimedb/server";
import type { Alert, Camera, Observation, Incident, Watch, InboundReceipt } from "@tempmhacks/shared";
import db, { cameraInput, observationInput, incidentInput, watchInput, alertInput, inboundReceiptInput } from "./schema";
import {
  validateCamera, validateObservation, validateNewIncident, cameraStatusUpdate,
  requireCameraStatus, requireTimestamp, updateDetection, confirmIncident,
  dismissIncident, resolveIncident,
  validateWatch, validateAlertStatus, claimAlert, markAlertSent, markAlertFailed,
} from "./rules";

export default db;
type Context = ReducerCtx<typeof db.schemaType>;

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
  if (ctx.db.inbound_receipt.messageId.find(receipt.messageId)) {
    throw new SenderError(`Inbound message ${receipt.messageId} was already claimed`);
  }
  checked(() => {
    if (!receipt.messageId.trim() || !receipt.spaceId.trim() || !receipt.senderId.trim()) {
      throw new Error("Inbound message identity fields must not be empty");
    }
    requireTimestamp(receipt.receivedAt);
    if (!receipt.contentType.trim()) throw new Error("Inbound contentType must not be empty");
  });
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

// Owner-only schema fixture writes for integration setup.
function requireOwner(ctx: Context): void {
  if (!ctx.db.module_config.ownerIdentity.find(ctx.sender)) {
    throw new SenderError("Only the database owner may insert schema fixtures");
  }
}

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
