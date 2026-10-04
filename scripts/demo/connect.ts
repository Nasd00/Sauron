import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { connectDb } from "@tempmhacks/shared/db";

/**
 * Shared connection helper for demo tooling. Loads .env from the repo root (and
 * the current directory), then connects to SpacetimeDB using the standard env
 * vars, falling back to the local defaults when they are unset.
 */
export function loadDemoEnv(): void {
  for (const path of [".env", fileURLToPath(new URL("../../.env", import.meta.url))]) {
    try {
      loadEnvFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function connectDemoDb(): ReturnType<typeof connectDb> {
  loadDemoEnv();
  return connectDb({
    uri: process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000",
    database: process.env.SPACETIMEDB_DATABASE?.trim() || "tempmhacks-local",
    token: process.env.SPACETIMEDB_TOKEN,
  });
}
