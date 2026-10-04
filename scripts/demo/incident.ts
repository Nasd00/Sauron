import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectDb } from "@tempmhacks/shared/db";
import { demoReplayCamera } from "./cameras.js";

// Seeds one confirmed smoke_fire incident on the demo camera (Ann Arbor), so the
// alert service can match it against active watches and send a proactive alert.
// Flow: create_incident (candidate) -> confirm_incident. Idempotency is not
// attempted; each run creates a fresh incident with a unique id.
for (const path of [".env", fileURLToPath(new URL("../../.env", import.meta.url))]) {
  try { loadEnvFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const uri = process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000";
  const database = process.env.SPACETIMEDB_DATABASE?.trim() || "tempmhacks-local";
  const token = process.env.SPACETIMEDB_TOKEN?.trim();

  const { connection, db, disconnect } = await connectDb({ uri, database, token });

  const id = `incident-demo-${randomUUID()}`;
  const now = Date.now();
  const input = {
    id,
    cameraId: demoReplayCamera.id,
    type: "smoke_fire",
    status: "candidate",
    confidence: 0.92,
    latitude: demoReplayCamera.latitude,
    longitude: demoReplayCamera.longitude,
    firstSeenAt: now,
    lastSeenAt: now,
    confirmedAt: undefined,
    resolvedAt: undefined,
  };

  console.log(`Creating candidate incident ${id} on ${demoReplayCamera.id} ...`);
  await connection.reducers.createIncident({ input });

  console.log(`Confirming incident ${id} ...`);
  await db.incidents.confirm(id);

  // Give the subscription a moment to reflect the confirmed status.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const confirmed = db.incidents.get(id);
  if (!confirmed || confirmed.status !== "confirmed") {
    throw new Error(`Incident ${id} did not reach confirmed status (got ${confirmed?.status ?? "missing"})`);
  }
  console.log(JSON.stringify({
    status: "confirmed_incident_seeded",
    id,
    cameraId: confirmed.cameraId,
    latitude: confirmed.latitude,
    longitude: confirmed.longitude,
    confidence: confirmed.confidence,
  }));
  disconnect();
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  main().then(() => process.exit(0)).catch(error => {
    console.error("incident_seed_failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
