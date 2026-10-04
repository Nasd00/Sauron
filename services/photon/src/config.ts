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
  const spectrumProjectSecret = requiredEither("SPECTRUM_PROJECT_SECRET", "PHOTON_SECRET");
  return {
    spectrumProjectId: requiredEither("SPECTRUM_PROJECT_ID", "PHOTON_PROJECT_ID"),
    spectrumProjectSecret,
    // Photon signs webhooks with the project secret unless a separate one is configured.
    spectrumWebhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET?.trim() || spectrumProjectSecret,
    photonAdminSecret: required("PHOTON_ADMIN_SECRET"),
    spacetimeUri: process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000",
    spacetimeDatabase: process.env.SPACETIMEDB_DATABASE?.trim() || "tempmhacks-local",
    spacetimeToken: process.env.SPACETIMEDB_TOKEN,
    watchRadiusKm: positiveNumber("WATCH_RADIUS_KM", 10),
    publicAppUrl: required("PUBLIC_APP_URL"),
    geocoderBaseUrl: process.env.GEOCODER_BASE_URL,
    geocoderUserAgent: required("GEOCODER_USER_AGENT"),
    port: positiveNumber("PHOTON_PORT", 3001),
    /** The help agent runs on Gemini; without a key it stays off. */
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
    geminiModel: process.env.GEMINI_MODEL?.trim() || undefined,
    /** People this close to a newly confirmed incident are offered help. */
    assistRadiusKm: positiveNumber("ASSIST_RADIUS_KM", 3),
    /** Offer the labeled Ann Arbor demo shelters alongside live FEMA open shelters. */
    assistDemoShelters: process.env.ASSIST_DEMO_SHELTERS?.trim() !== "0",
  };
}
