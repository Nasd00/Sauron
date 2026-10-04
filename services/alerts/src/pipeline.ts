import type { Alert, Incident } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";
import { matchConfirmedIncident, matchConfirmedIncidentToProfiles } from "./matcher.js";
import type { AlertServiceStore } from "./store.js";

/**
 * Connects confirmed incidents to deliveries. Whatever confirms an incident (the
 * smoke detector in services/cv, or a demo seed), the subscription matches it to
 * nearby profiles and watches, and each resulting pending alert is sent. Existing
 * confirmed incidents and pending alerts are handled on start, so a restart loses
 * nothing. Returns a function that stops listening.
 */
export function startAlertPipeline(options: {
  db: Pick<Db, "incidents" | "alerts">;
  store: AlertServiceStore;
  sendAlert: (alert: Alert) => Promise<unknown>;
  now?: () => number;
}): () => void {
  const { db, store, sendAlert } = options;
  const now = options.now ?? Date.now;

  function matchIncident(incident: Incident): void {
    if (incident.status !== "confirmed") return;
    void matchConfirmedIncident(incident, store).catch(error => console.error("alert_match_failed", error));
    void matchConfirmedIncidentToProfiles(incident, store, { now: now() })
      .catch(error => console.error("alert_profile_match_failed", error));
  }
  function send(alert: Alert): void {
    if (alert.status !== "pending") return;
    void sendAlert(alert).catch(error => console.error("alert_send_failed", error));
  }

  const stopIncidents = db.incidents.subscribe(matchIncident);
  const stopAlerts = db.alerts.subscribe(send);
  for (const alert of store.listPending()) send(alert);
  for (const incident of db.incidents.listConfirmed()) matchIncident(incident);
  return () => {
    stopIncidents();
    stopAlerts();
  };
}
