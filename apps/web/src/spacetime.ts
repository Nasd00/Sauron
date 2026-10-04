import type { Camera, Incident, IncidentReport, Observation, UserAlertProfile, Watch } from "@tempmhacks/shared";
import { createDb } from "@tempmhacks/shared/db";
import { DbConnection } from "./module_bindings";
import { LiveState } from "./live-state";

export function connectSpacetime(state: LiveState, status: (message: string) => void) {
  const uri = import.meta.env.VITE_SPACETIMEDB_URI || "http://127.0.0.1:3000";
  const database = import.meta.env.VITE_SPACETIMEDB_DATABASE || "tempmhacks-local";
  const tokenKey = `sauron:identity:${uri}:${database}`;
  let token: string | undefined;
  try { token = localStorage.getItem(tokenKey) ?? undefined; } catch { /* storage may be disabled */ }
  let disposed = false;
  status("Connecting to SpaceTimeDB…");
  const connection = DbConnection.builder().withUri(uri).withDatabaseName(database).withToken(token)
    .onConnect((conn, _identity, issuedToken) => {
      if (disposed) { conn.disconnect(); return; }
      try { localStorage.setItem(tokenKey, issuedToken); } catch { /* storage may be disabled */ }
      conn.subscriptionBuilder().onApplied(() => status("SpaceTimeDB · live"))
        .onError(() => status("SpaceTimeDB subscription failed"))
        .subscribe(["SELECT * FROM camera", "SELECT * FROM incident", "SELECT * FROM observation", "SELECT * FROM watch", "SELECT * FROM alert", "SELECT * FROM user_alert_profile", "SELECT * FROM conversation_context", "SELECT * FROM incident_report"]);
    })
    .onConnectError(() => status("SpaceTimeDB unavailable · check server and database"))
    .onDisconnect(() => { if (!disposed) status("SpaceTimeDB disconnected"); })
    .build();

  const cameraInsert = (_ctx: unknown, row: typeof connection.db.camera extends { iter(): Iterable<infer R> } ? R : never) => state.update("cameras", row as Camera);
  const incidentInsert = (_ctx: unknown, row: typeof connection.db.incident extends { iter(): Iterable<infer R> } ? R : never) => state.update("incidents", row as Incident);
  const observationInsert = (_ctx: unknown, row: typeof connection.db.observation extends { iter(): Iterable<infer R> } ? R : never) => state.update("observations", row as Observation);
  const watchInsert = (_ctx: unknown, row: typeof connection.db.watch extends { iter(): Iterable<infer R> } ? R : never) => state.update("watches", row as Watch);
  connection.db.camera.onInsert(cameraInsert);
  connection.db.camera.onUpdate((ctx, _old, row) => cameraInsert(ctx, row));
  connection.db.camera.onDelete((_ctx, row) => state.update("cameras", row as Camera, true));
  connection.db.incident.onInsert(incidentInsert);
  connection.db.incident.onUpdate((ctx, _old, row) => incidentInsert(ctx, row));
  connection.db.incident.onDelete((_ctx, row) => state.update("incidents", row as Incident, true));
  connection.db.observation.onInsert(observationInsert);
  connection.db.observation.onUpdate((ctx, _old, row) => observationInsert(ctx, row));
  connection.db.observation.onDelete((_ctx, row) => state.update("observations", row as Observation, true));
  connection.db.watch.onInsert(watchInsert);
  connection.db.watch.onUpdate((ctx, _old, row) => watchInsert(ctx, row));
  connection.db.watch.onDelete((_ctx, row) => state.update("watches", row as Watch, true));

  const reportInsert = (_ctx: unknown, row: IncidentReport) => state.update("reports", row);
  connection.db.incident_report.onInsert(reportInsert);
  connection.db.incident_report.onUpdate((ctx, _old, row) => reportInsert(ctx, row));
  connection.db.incident_report.onDelete((_ctx, row) => state.update("reports", row as IncidentReport, true));
  const profileInsert = (_ctx: unknown, row: UserAlertProfile) => state.update("profiles", row);
  connection.db.user_alert_profile.onInsert((ctx, row) => profileInsert(ctx, row as UserAlertProfile));
  connection.db.user_alert_profile.onUpdate((ctx, _old, row) => profileInsert(ctx, row as UserAlertProfile));
  connection.db.user_alert_profile.onDelete((_ctx, row) => state.update("profiles", row as UserAlertProfile, true));

  const db = createDb(connection);
  return { db, disconnect() { disposed = true; connection.disconnect(); } };
}
