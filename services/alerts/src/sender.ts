import type { Alert, Camera, IncidentView } from "@tempmhacks/shared";
import { hazardLabel, incidentUrl, isManualIncident } from "@tempmhacks/shared";
import { splitMessage } from "@tempmhacks/shared/text";
import { haversineDistanceKm, kilometersToMiles } from "@tempmhacks/shared/geo";
import type { AlertTarget } from "./store.js";

export interface PendingAlertStore {
  claimAlert(alertId: string): Promise<boolean>;
  getIncident(incidentId: string): Promise<IncidentView | undefined>;
  /** The camera that spotted the incident, named in the alert when known. */
  getCamera(cameraId: string): Promise<Camera | undefined>;
  /** Resolves the delivery target (watch or current-location profile) by its id. */
  getTarget(targetId: string): Promise<AlertTarget | undefined>;
  markSent(alertId: string, providerMessageId: string, sentAt: number): Promise<void>;
  markFailed(alertId: string, error: string): Promise<void>;
  /** Anchors the conversation to the alerted incident for grounded follow-ups. */
  recordAlertContext(spaceId: string, incidentId: string, alertedAt: number): Promise<void>;
}

export interface ConversationMessenger {
  send(spaceId: string, text: string): Promise<string | undefined>;
}

function formatMiles(km: number): string {
  const miles = kilometersToMiles(km);
  return miles < 10 ? miles.toFixed(1) : String(Math.round(miles));
}

/**
 * Deterministic alert body built only from structured DB state. For current-location
 * profiles it reports the distance from the user's shared location ("near you"); for
 * place-based watches it names the watched place. Manual reports lead with the operator's
 * title, say plainly when the person is inside the danger zone, and include the description.
 * No LLM, no invented facts.
 */
export function formatAlertMessage(
  incident: IncidentView, target: AlertTarget, baseUrl: string, camera?: Pick<Camera, "name">,
): string {
  const distanceKm = haversineDistanceKm(
    incident.latitude, incident.longitude, target.latitude, target.longitude,
  );
  const report = incident.report;
  if (report) {
    const inside = target.placeLabel === undefined && distanceKm <= report.radiusKm;
    const where = target.placeLabel !== undefined
      ? `near ${target.placeLabel}`
      : inside ? "where you are" : `about ${formatMiles(distanceKm)} mi from your shared location`;
    return [
      `DANGER: ${report.title} reported ${where}.`,
      ...(inside ? ["You are inside the danger zone. Leave the area now if it is safe to do so."] : []),
      `Type: ${hazardLabel(incident.type)}`,
      `Danger zone: ${formatMiles(report.radiusKm)} mi around the reported spot`,
      ...(report.description ? [`Details: ${report.description}`] : []),
      `Reported: ${new Date(report.reportedAt).toISOString()}`,
      "",
      "View live incident:",
      incidentUrl(baseUrl, incident.id),
      "",
      "If anyone is in danger, call 911.",
      "Reported by a community operator — not an official emergency warning.",
      "Reply to ask how to get out safely or where to go.",
      "Reply STOP to unsubscribe.",
    ].join("\n");
  }
  const proximity = target.placeLabel !== undefined
    ? `Verified incident near ${target.placeLabel}.`
    : `Verified incident about ${formatMiles(distanceKm)} mi from your shared location.`;
  return [
    proximity,
    `Type: ${hazardLabel(incident.type)}`,
    ...(camera ? [`Spotted by: ${camera.name}`] : []),
    `Detected: ${new Date(incident.lastSeenAt).toISOString()}`,
    "",
    "View live incident:",
    incidentUrl(baseUrl, incident.id),
    "",
    "Community-generated alert — not an official emergency warning.",
    "Reply with a question or ask me to show the latest camera view.",
    "Reply STOP to unsubscribe.",
  ].join("\n");
}

/** Sent to everyone who was alerted once an incident is resolved. */
export function formatAllClearMessage(incident: IncidentView): string {
  const what = incident.report?.title ?? hazardLabel(incident.type);
  return `All clear: the ${what} you were alerted about has been marked resolved. Follow any instructions from local officials before returning.`;
}

export type AlertSenderOptions = {
  store: PendingAlertStore;
  messenger: ConversationMessenger;
  publicAppUrl: string;
  now?: () => number;
};

export function createAlertSender(options: AlertSenderOptions) {
  const now = options.now ?? Date.now;
  return async (alert: Alert): Promise<"sent" | "failed" | "skipped"> => {
    if (alert.status !== "pending") return "skipped";
    if (!await options.store.claimAlert(alert.id)) return "skipped";
    try {
      const [incident, target] = await Promise.all([
        options.store.getIncident(alert.incidentId),
        options.store.getTarget(alert.watchId),
      ]);
      if (!incident) throw new Error(`Incident ${alert.incidentId} not found`);
      if (!target) throw new Error(`Alert target ${alert.watchId} not found`);
      const camera = isManualIncident(incident)
        ? undefined
        : await options.store.getCamera(incident.cameraId).catch(() => undefined);
      const message = formatAlertMessage(incident, target, options.publicAppUrl, camera);
      const [first, ...rest] = splitMessage(message);
      // The first chunk carries the headline facts and is the delivery of record.
      const providerMessageId = await options.messenger.send(target.spaceId, first ?? message);
      if (!providerMessageId) throw new Error("Photon did not return an outbound message ID");
      const sentAt = now();
      await options.store.markSent(alert.id, providerMessageId, sentAt);
      await options.store.recordAlertContext(target.spaceId, incident.id, sentAt);
      // Follow-up chunks are best-effort: the alert is already delivered, so a
      // failure here is logged rather than marking the alert failed.
      for (const chunk of rest) {
        try {
          await options.messenger.send(target.spaceId, chunk);
        } catch (error) {
          console.error(JSON.stringify({
            level: "error", message: "alert_followup_chunk_failed", alertId: alert.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      return "sent";
    } catch (error) {
      const concise = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await options.store.markFailed(alert.id, concise || "Unknown alert delivery error");
      return "failed";
    }
  };
}

export interface AllClearStore {
  getIncident(incidentId: string): Promise<IncidentView | undefined>;
  getTarget(targetId: string): Promise<AlertTarget | undefined>;
  listAlertsForIncident(incidentId: string): Promise<Alert[]>;
}

/**
 * Texts "all clear" once to every conversation that was successfully alerted about a now-resolved
 * incident. Best-effort: there is no delivery record, so callers must only invoke it once per
 * resolution (the pipeline only does so for resolutions it sees happen live).
 */
export function createAllClearSender(options: { store: AllClearStore; messenger: ConversationMessenger }) {
  return async (incidentId: string): Promise<number> => {
    const incident = await options.store.getIncident(incidentId);
    if (!incident || incident.status !== "resolved") return 0;
    const text = formatAllClearMessage(incident);
    const spaces = new Set<string>();
    for (const alert of await options.store.listAlertsForIncident(incidentId)) {
      if (alert.status !== "sent") continue;
      const target = await options.store.getTarget(alert.watchId);
      if (target) spaces.add(target.spaceId);
    }
    let sent = 0;
    for (const spaceId of spaces) {
      try {
        await options.messenger.send(spaceId, text);
        sent += 1;
      } catch (error) {
        console.error(JSON.stringify({
          level: "error", message: "all_clear_send_failed", incidentId, spaceId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return sent;
  };
}
