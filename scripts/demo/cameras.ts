import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Camera } from "@tempmhacks/shared";

export const REPLAY_FIXTURE_PATH = "fixtures/demo/lava-smoke.mp4";

export const demoReplayCamera: Camera = {
  id: "demo-camera-001",
  name: "Ann Arbor demo replay",
  latitude: 42.2808,
  longitude: -83.743,
  sourceType: "replay",
  streamUrl: REPLAY_FIXTURE_PATH,
  status: "online",
};

export const usgsKilaueaCamera: Camera = {
  id: "usgs-kilauea-k2",
  name: "USGS Kīlauea K2 webcam",
  latitude: 19.4202,
  longitude: -155.2881,
  sourceType: "live",
  streamUrl: "https://volcanoes.usgs.gov/observatories/hvo/cams/K2cam/images/M.jpg",
  status: "online",
};

type RegisterCamera = (camera: Camera) => void;

function optional(value: unknown): unknown {
  return value === undefined ? null : { some: value };
}

function cameraWire(camera: Camera): Record<string, unknown> {
  return {
    id: camera.id,
    name: camera.name,
    latitude: camera.latitude,
    longitude: camera.longitude,
    source_type: camera.sourceType,
    stream_url: optional(camera.streamUrl),
    status: camera.status,
    last_seen_at: optional(camera.lastSeenAt),
  };
}

export function seedCameraRegistry(register: RegisterCamera, includeLive: boolean): Camera[] {
  const cameras = includeLive ? [demoReplayCamera, usgsKilaueaCamera] : [demoReplayCamera];
  for (const camera of cameras) register(camera);
  return cameras;
}

function isAlreadyRegistered(error: unknown): boolean {
  const stderr = (error as { stderr?: string | Buffer }).stderr;
  return /already exists/i.test(stderr?.toString() ?? String(error));
}

function registerWithCli(camera: Camera): void {
  const bin = process.env.SPACETIME_BIN ?? "spacetime";
  const uri = process.env.SPACETIMEDB_URI || "http://127.0.0.1:3000";
  const database = process.env.SPACETIMEDB_DATABASE || "tempmhacks-local";

  try {
    execFileSync(
      bin,
      ["call", database, "register_camera", JSON.stringify(cameraWire(camera)), "--server", uri],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(`Registered ${camera.id}`);
  } catch (error) {
    if (isAlreadyRegistered(error)) {
      console.log(`Already registered ${camera.id}; leaving the existing row unchanged`);
      return;
    }
    throw error;
  }
}

function liveEnabled(): boolean {
  const value = process.env.ENABLE_LIVE_CAMERA?.toLowerCase();
  return process.argv.includes("--include-live") || value === "1" || value === "true";
}

function main(): void {
  const includeLive = liveEnabled();
  const seeded = seedCameraRegistry(registerWithCli, includeLive);
  console.log(`Camera seed complete (${seeded.map(camera => camera.id).join(", ")})`);
  if (!includeLive) {
    console.log("Live camera disabled; set ENABLE_LIVE_CAMERA=1 or pass --include-live to register it");
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) main();
