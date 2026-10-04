import { pathToFileURL } from "node:url";
import { connectDemoDb } from "./connect.js";

// Resets demo messaging/alert state to a clean baseline without deleting the
// camera registry. SpacetimeDB has no row-delete reducer here, so "reset" means
// transitioning rows to terminal/inactive states:
//   - confirmed incidents  -> resolved
//   - candidate incidents  -> dismissed
//   - active watches       -> deactivated (per sender)
// Cameras are intentionally left untouched. Idempotent: a clean DB is a no-op.

export async function resetDemoState(): Promise<void> {
  const { db, connection, disconnect } = await connectDemoDb();
  try {
    const now = Date.now();

    // Deactivate every active watch, grouped by sender.
    const senders = new Set<string>();
    for (const watch of db.watches.listActive()) senders.add(watch.senderId);
    for (const senderId of senders) {
      await db.watches.stopForSender(senderId);
      console.log(`Deactivated watches for ${senderId}`);
    }

    // Move incidents out of active states.
    for (const row of connection.db.incident.iter()) {
      if (row.status === "confirmed") {
        await db.incidents.resolve(row.id, now);
        console.log(`Resolved incident ${row.id}`);
      } else if (row.status === "candidate") {
        await db.incidents.dismiss(row.id);
        console.log(`Dismissed incident ${row.id}`);
      }
    }

    // Allow subscriptions to settle, then report remaining active state.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const activeWatches = db.watches.listActive().length;
    const openIncidents = Array.from(connection.db.incident.iter())
      .filter(row => row.status === "candidate" || row.status === "confirmed").length;
    console.log(JSON.stringify({
      status: "reset_complete",
      activeWatches,
      openIncidents,
      cameras: Array.from(connection.db.camera.iter(), row => row.id),
    }));
    if (activeWatches !== 0 || openIncidents !== 0) {
      throw new Error(`Reset incomplete: activeWatches=${activeWatches}, openIncidents=${openIncidents}`);
    }
  } finally {
    disconnect();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  resetDemoState().then(() => process.exit(0)).catch(error => {
    console.error("demo_reset_failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
