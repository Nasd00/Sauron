import { pathToFileURL } from "node:url";
import { connectDemoDb } from "./connect.js";
import { demoReplayCamera, seedCameraRegistry } from "./cameras.js";

// SDK-based camera seeding for hosted SpacetimeDB (e.g. maincloud), where the
// local `spacetime` CLI is not required. Registers the demo camera(s)
// idempotently: an existing camera ID is treated as success and left unchanged.
//
// Set ENABLE_LIVE_CAMERA=1 or pass --include-live to also register the live
// USGS Kīlauea camera.

function liveEnabled(): boolean {
  const value = process.env.ENABLE_LIVE_CAMERA?.toLowerCase();
  return process.argv.includes("--include-live") || value === "1" || value === "true";
}

export async function seedCamerasViaSdk(): Promise<string[]> {
  const { db, connection, disconnect } = await connectDemoDb();
  try {
    const existing = new Set<string>();
    for (const row of connection.db.camera.iter()) existing.add(row.id);

    const planned = seedCameraRegistry(() => {}, liveEnabled());
    for (const camera of planned) {
      if (existing.has(camera.id)) {
        console.log(`Already registered ${camera.id}; leaving the existing row unchanged`);
        continue;
      }
      await db.cameras.register(camera);
      console.log(`Registered ${camera.id}`);
    }

    const after = new Set<string>();
    for (const row of connection.db.camera.iter()) after.add(row.id);
    if (!after.has(demoReplayCamera.id)) {
      throw new Error(`Seed failed: ${demoReplayCamera.id} not found after register`);
    }
    console.log(`Camera seed complete (${planned.map(camera => camera.id).join(", ")})`);
    return planned.map(camera => camera.id);
  } finally {
    disconnect();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  seedCamerasViaSdk().then(() => process.exit(0)).catch(error => {
    console.error("camera_seed_failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
