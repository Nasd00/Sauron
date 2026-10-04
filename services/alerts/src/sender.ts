import type { Alert, Incident } from "@tempmhacks/shared";
import { incidentUrl } from "@tempmhacks/shared";
import { splitMessage } from "@tempmhacks/shared/text";
import { haversineDistanceKm, kilometersToMiles } from "@tempmhacks/shared/geo";
import type { AlertTarget } from "./store.js";

export interface PendingAlertStore {
  claimAlert(alertId: string): Promise<boolean>;
  getIncident(incidentId: string): Promise<Incident | undefined>;
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
 * place-based watches it names the watched place. No LLM, no invented facts.
 */
export function formatAlertMessage(incident: Incident, target: AlertTarget, baseUrl: string): string {
  const distanceKm = haversineDistanceKm(
    incident.latitude, incident.longitude, target.latitude, target.longitude,
  );
  const proximity = target.placeLabel !== undefined
    ? `Verified incident near ${target.placeLabel}.`
    : `Verified incident about ${formatMiles(distanceKm)} mi from your shared location.`;
  return [
    proximity,
    `Type: ${incident.type}`,
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
      const message = formatAlertMessage(incident, target, options.publicAppUrl);
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
