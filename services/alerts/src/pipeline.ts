import type { Alert, Incident, IncidentView } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";
import { matchConfirmedIncident, matchConfirmedIncidentToProfiles } from "./matcher.js";
import type { AlertServiceStore } from "./store.js";

/**
 * Connects confirmed incidents to deliveries. Whatever confirms an incident (the
 * smoke detector in services/cv, an operator's manual report, or a demo seed), the
 * subscription matches it to nearby profiles and watches, and each resulting pending
 * alert is sent. Existing confirmed incidents and pending alerts are handled on start,
 * so a restart loses nothing. Incidents resolved while running get one all-clear text.
 * Returns a function that stops listening.
 */
export function startAlertPipeline(options: {
  db: Pick<Db, "incidents" | "alerts"> & Partial<Pick<Db, "reports">>;
  store: AlertServiceStore;
  sendAlert: (alert: Alert) => Promise<unknown>;
  /** Optional: texts everyone alerted about an incident once it is resolved. */
  sendAllClear?: (incidentId: string) => Promise<unknown>;
  now?: () => number;
}): () => void {
  const { db, store, sendAlert, sendAllClear } = options;
  const now = options.now ?? Date.now;
  const clearedIncidents = new Set<string>();

  // The report carries the danger radius; matching is idempotent, so re-running is safe.
  const view = (incident: Incident): IncidentView => db.incidents.view?.(incident.id) ?? incident;

  function matchIncident(incident: Incident): void {
    if (incident.status !== "confirmed") return;
    const full = view(incident);
    void matchConfirmedIncident(full, store).catch(error => console.error("alert_match_failed", error));
    void matchConfirmedIncidentToProfiles(full, store, { now: now() })
      .catch(error => console.error("alert_profile_match_failed", error));
  }
  function onIncident(incident: Incident): void {
    if (incident.status === "resolved" && sendAllClear && !clearedIncidents.has(incident.id)) {
      clearedIncidents.add(incident.id);
      void sendAllClear(incident.id).catch(error => console.error("all_clear_failed", error));
      return;
    }
    matchIncident(incident);
  }
  function send(alert: Alert): void {
    if (alert.status !== "pending") return;
    void sendAlert(alert).catch(error => console.error("alert_send_failed", error));
  }

  const stopIncidents = db.incidents.subscribe(onIncident);
  const stopAlerts = db.alerts.subscribe(send);
  const stopReports = db.reports?.subscribe(report => {
    const incident = db.incidents.get(report.incidentId);
    if (incident) matchIncident(incident);
  });
  for (const alert of store.listPending()) send(alert);
  for (const incident of db.incidents.listConfirmed()) matchIncident(incident);
  return () => {
    stopIncidents();
    stopAlerts();
    stopReports?.();
  };
}
