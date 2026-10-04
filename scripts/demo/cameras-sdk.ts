import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { connectDb } from "@tempmhacks/shared/db";
import { demoReplayCamera, seedCameraRegistry } from "./cameras.js";

// SDK-based camera seeding for hosted SpacetimeDB (maincloud), where the local
// `spacetime` CLI is not required. Registers the demo camera idempotently:
// an existing camera ID is treated as success and left unchanged.
for (const path of [".env", fileURLToPath(new URL("../../.env", import.meta.url))]) {
  try { loadEnvFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function liveEnabled(): boolean {
  const value = process.env.ENABLE_LIVE_CAMERA?.toLowerCase();
  return process.argv.includes("--include-live") || value === "1" || value === "true";
}

async function main(): Promise<void> {
  const uri = process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000";
  const database = process.env.SPACETIMEDB_DATABASE?.trim() || "tempmhacks-local";
  const token = process.env.SPACETIMEDB_TOKEN?.trim();

  const { db, connection, disconnect } = await connectDb({ uri, database, token });
  const existing = new Set<string>();
  for (const row of connection.db.camera.iter()) existing.add(row.id);

  const includeLive = liveEnabled();
  const planned = seedCameraRegistry(() => {}, includeLive); // just resolves the list

  for (const camera of planned) {
    if (existing.has(camera.id)) {
      console.log(`Already registered ${camera.id}; leaving the existing row unchanged`);
      continue;
    }
    await db.cameras.register(camera);
    console.log(`Registered ${camera.id}`);
  }

  // Confirm the demo camera is present after seeding.
  const after = new Set<string>();
  for (const row of connection.db.camera.iter()) after.add(row.id);
  if (!after.has(demoReplayCamera.id)) {
    throw new Error(`Seed failed: ${demoReplayCamera.id} not found after register`);
  }
  console.log(`Camera seed complete (${planned.map(camera => camera.id).join(", ")})`);
  disconnect();
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  main().then(() => process.exit(0)).catch(error => {
    console.error("camera_seed_failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
