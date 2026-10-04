import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

for (const path of [".env", fileURLToPath(new URL("../../../.env", import.meta.url))]) {
  try { loadEnvFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredEither(primary: string, legacy: string): string {
  const value = process.env[primary]?.trim() || process.env[legacy]?.trim();
  if (!value) throw new Error(`${primary} is required (${legacy} is also accepted)`);
  return value;
}

function positiveNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  const value = raw === undefined && fallback !== undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

export function loadConfig() {
  return {
    spectrumProjectId: requiredEither("SPECTRUM_PROJECT_ID", "PHOTON_PROJECT_ID"),
    spectrumProjectSecret: requiredEither("SPECTRUM_PROJECT_SECRET", "PHOTON_SECRET"),
    spectrumWebhookSecret: required("SPECTRUM_WEBHOOK_SECRET"),
    spacetimeUri: process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000",
    spacetimeDatabase: process.env.SPACETIMEDB_DATABASE?.trim() || "tempmhacks-local",
    spacetimeToken: process.env.SPACETIMEDB_TOKEN,
    watchRadiusKm: positiveNumber("WATCH_RADIUS_KM", 10),
    publicAppUrl: required("PUBLIC_APP_URL"),
    geocoderBaseUrl: process.env.GEOCODER_BASE_URL,
    geocoderUserAgent: required("GEOCODER_USER_AGENT"),
    port: positiveNumber("PHOTON_PORT", 3001),
  };
}
