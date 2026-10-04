import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import type { Camera } from "@tempmhacks/shared";
import { connectDb } from "@tempmhacks/shared/db";
import { createGeminiDetector } from "./detector.js";
import { LiveFrameSource, ReplayFrameSource, type FrameSource } from "./sources/index.js";
import { createDetectionStore, createFrameHandler, runCamera, type Logger } from "./worker.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
for (const path of [".env", resolve(repositoryRoot, ".env")]) {
  try { loadEnvFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const log: Logger = (message, fields = {}) => console.info(JSON.stringify({ level: "info", message, ...fields }));

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) throw new Error("GEMINI_API_KEY is required for smoke detection");
function intervalFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isFinite(value) || value < 1_000) throw new Error(`${name} must be at least 1000`);
  return value;
}
// Every sampled frame is one Gemini call. Live webcams refresh about once a minute; the demo
// replay is an 11-second clip, so it is sampled densely and looped.
const intervalMs = intervalFromEnv("CV_INTERVAL_MS", 30_000);
const replayIntervalMs = intervalFromEnv("CV_REPLAY_INTERVAL_MS", 3_000);
const cameraFilter = new Set((process.env.CV_CAMERA_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean));

const gemini = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 4 } } });
const detector = createGeminiDetector({
  generate: params => gemini.models.generateContent(params),
  model: process.env.CV_MODEL?.trim() || undefined,
});

const database = await connectDb({
  uri: process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000",
  database: process.env.SPACETIMEDB_DATABASE?.trim() || "tempmhacks-local",
  token: process.env.SPACETIMEDB_TOKEN,
});
const { db } = database;
const store = createDetectionStore(database.db);

function sourceFor(camera: Camera): FrameSource | undefined {
  if (!camera.streamUrl) return undefined;
  if (camera.sourceType === "live") {
    return new LiveFrameSource({ cameraId: camera.id, snapshotUrl: camera.streamUrl, intervalMs });
  }
  const videoPath = isAbsolute(camera.streamUrl) ? camera.streamUrl : resolve(repositoryRoot, camera.streamUrl);
  // Replay fixtures aren't committed (npm run demo:download-fixture), so hosts without one skip them.
  if (!existsSync(videoPath)) return undefined;
  return new ReplayFrameSource({ cameraId: camera.id, videoPath, intervalMs: replayIntervalMs });
}

const controller = new AbortController();
const running = new Map<string, Promise<void>>();

function startCamera(camera: Camera): void {
  if (running.has(camera.id) || controller.signal.aborted) return;
  if (cameraFilter.size && !cameraFilter.has(camera.id)) return;
  const source = sourceFor(camera);
  if (!source) {
    log("camera_skipped", { cameraId: camera.id, reason: camera.streamUrl ? "replay file missing" : "no stream URL" });
    running.set(camera.id, Promise.resolve());
    return;
  }
  log("camera_started", {
    cameraId: camera.id, sourceType: camera.sourceType,
    intervalMs: camera.sourceType === "live" ? intervalMs : replayIntervalMs,
  });
  running.set(camera.id, runCamera({
    camera, source, store, log, signal: controller.signal,
    onFrame: createFrameHandler({ camera, detector, store, log }),
  }).catch(error => console.error("camera_runner_failed", camera.id, error)));
}

for (const camera of db.cameras.list()) startCamera(camera);
db.cameras.subscribe(camera => {
  if (db.cameras.get(camera.id)) startCamera(camera);
});
log("detection_started", { cameras: running.size });

async function shutdown(): Promise<void> {
  controller.abort();
  await Promise.all(running.values());
  database.disconnect();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
