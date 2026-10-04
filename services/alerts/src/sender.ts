import type { Alert, Incident, Watch } from "@tempmhacks/shared";
import { incidentUrl } from "@tempmhacks/shared";

export interface PendingAlertStore {
  claimAlert(alertId: string): Promise<boolean>;
  getIncident(incidentId: string): Promise<Incident | undefined>;
  getWatch(watchId: string): Promise<Watch | undefined>;
  markSent(alertId: string, providerMessageId: string, sentAt: number): Promise<void>;
  markFailed(alertId: string, error: string): Promise<void>;
}

export interface ConversationMessenger {
  send(spaceId: string, text: string): Promise<string | undefined>;
}

export function formatAlertMessage(incident: Incident, watch: Watch, baseUrl: string): string {
  return [
    `Verified incident near ${watch.placeLabel}.`,
    `Type: ${incident.type}`,
    `Detected: ${new Date(incident.lastSeenAt).toISOString()}`,
    "",
    "View live incident:",
    incidentUrl(baseUrl, incident.id),
    "",
    "Community-generated alert — not an official emergency warning.",
    "Reply STATUS for details or STOP to unsubscribe.",
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
      const [incident, watch] = await Promise.all([
        options.store.getIncident(alert.incidentId),
        options.store.getWatch(alert.watchId),
      ]);
      if (!incident) throw new Error(`Incident ${alert.incidentId} not found`);
      if (!watch) throw new Error(`Watch ${alert.watchId} not found`);
      const message = formatAlertMessage(incident, watch, options.publicAppUrl);
      const providerMessageId = await options.messenger.send(watch.spaceId, message);
      if (!providerMessageId) throw new Error("Photon did not return an outbound message ID");
      await options.store.markSent(alert.id, providerMessageId, now());
      return "sent";
    } catch (error) {
      const concise = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await options.store.markFailed(alert.id, concise || "Unknown alert delivery error");
      return "failed";
    }
  };
}
