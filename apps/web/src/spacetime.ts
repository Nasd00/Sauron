import type { Camera, Incident, Observation, Watch } from "@tempmhacks/shared";
import { createDb } from "@tempmhacks/shared/db";
import { DbConnection } from "./module_bindings";
import { LiveState } from "./live-state";

// Translate the SDK's (context, row) callbacks into the shared adapter contract.
function adaptTable<Row, Context>(table: {
  onInsert(cb: (ctx: Context, row: Row) => void): void;
  removeOnInsert(cb: (ctx: Context, row: Row) => void): void;
  onUpdate(cb: (ctx: Context, oldRow: Row, row: Row) => void): void;
  removeOnUpdate(cb: (ctx: Context, oldRow: Row, row: Row) => void): void;
  onDelete(cb: (ctx: Context, row: Row) => void): void;
  removeOnDelete(cb: (ctx: Context, row: Row) => void): void;
}) {
  const inserts = new Map<(row: Row) => void, (ctx: Context, row: Row) => void>();
  const updates = new Map<(oldRow: Row, row: Row) => void, (ctx: Context, oldRow: Row, row: Row) => void>();
  const deletes = new Map<(row: Row) => void, (ctx: Context, row: Row) => void>();
  return {
    onInsert(cb: (row: Row) => void) { const fn = (_ctx: Context, row: Row) => cb(row); inserts.set(cb, fn); table.onInsert(fn); },
    removeOnInsert(cb: (row: Row) => void) { const fn = inserts.get(cb); if (fn) table.removeOnInsert(fn); inserts.delete(cb); },
    onUpdate(cb: (oldRow: Row, row: Row) => void) { const fn = (_ctx: Context, oldRow: Row, row: Row) => cb(oldRow, row); updates.set(cb, fn); table.onUpdate(fn); },
    removeOnUpdate(cb: (oldRow: Row, row: Row) => void) { const fn = updates.get(cb); if (fn) table.removeOnUpdate(fn); updates.delete(cb); },
    onDelete(cb: (row: Row) => void) { const fn = (_ctx: Context, row: Row) => cb(row); deletes.set(cb, fn); table.onDelete(fn); },
    removeOnDelete(cb: (row: Row) => void) { const fn = deletes.get(cb); if (fn) table.removeOnDelete(fn); deletes.delete(cb); },
  };
}

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
        .subscribe(["SELECT * FROM camera", "SELECT * FROM incident", "SELECT * FROM observation", "SELECT * FROM watch"]);
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

  const db = createDb({ db: {
    camera: adaptTable(connection.db.camera), observation: adaptTable(connection.db.observation),
    incident: adaptTable(connection.db.incident), alert: adaptTable(connection.db.alert),
  }, reducers: connection.reducers });
  return { db, disconnect() { disposed = true; connection.disconnect(); } };
}
