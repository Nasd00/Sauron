import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Incident } from "@tempmhacks/shared";
import { connectDemoDb } from "./connect.js";
import { demoReplayCamera } from "./cameras.js";

// Seeds one confirmed smoke_fire incident on the demo camera (Ann Arbor) so the
// alert service can match it against active watches and send a proactive alert.
// Flow: create (candidate) -> confirm. Each run creates a fresh incident with a
// unique id; this is a manual stand-in until the CV/incident workstreams land.

export function buildDemoIncident(now: number = Date.now()): Incident {
  return {
    id: `incident-demo-${randomUUID()}`,
    cameraId: demoReplayCamera.id,
    type: "smoke_fire",
    status: "candidate",
    confidence: 0.92,
    latitude: demoReplayCamera.latitude,
    longitude: demoReplayCamera.longitude,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

export async function seedConfirmedIncident(): Promise<Incident> {
  const { db, disconnect } = await connectDemoDb();
  try {
    const incident = buildDemoIncident();
    console.log(`Creating candidate incident ${incident.id} on ${incident.cameraId} ...`);
    await db.incidents.create(incident);

    console.log(`Confirming incident ${incident.id} ...`);
    await db.incidents.confirm(incident.id);

    // Allow the subscription to reflect the confirmed status.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const confirmed = db.incidents.get(incident.id);
    if (!confirmed || confirmed.status !== "confirmed") {
      throw new Error(`Incident ${incident.id} did not reach confirmed status (got ${confirmed?.status ?? "missing"})`);
    }
    console.log(JSON.stringify({
      status: "confirmed_incident_seeded",
      id: confirmed.id,
      cameraId: confirmed.cameraId,
      latitude: confirmed.latitude,
      longitude: confirmed.longitude,
      confidence: confirmed.confidence,
    }));
    return confirmed;
  } finally {
    disconnect();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  seedConfirmedIncident().then(() => process.exit(0)).catch(error => {
    console.error("incident_seed_failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
