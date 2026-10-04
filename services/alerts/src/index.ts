import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { connectDb } from "@tempmhacks/shared/db";
import { createImessageMessenger } from "@tempmhacks/messaging";
import { startAlertPipeline } from "./pipeline.js";
import { createAlertSender } from "./sender.js";
import { createAlertServiceStore } from "./store.js";

for (const path of [".env", fileURLToPath(new URL("../../../.env", import.meta.url))]) {
  try { loadEnvFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const requiredEither = (primary: string, legacy: string) => {
  const value = process.env[primary]?.trim() || process.env[legacy]?.trim();
  if (!value) throw new Error(`${primary} is required (${legacy} is also accepted)`);
  return value;
};

const database = await connectDb({
  uri: process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000",
  database: process.env.SPACETIMEDB_DATABASE?.trim() || "tempmhacks-local",
  token: process.env.SPACETIMEDB_TOKEN,
});
const app = await Spectrum({
  projectId: requiredEither("SPECTRUM_PROJECT_ID", "PHOTON_PROJECT_ID"),
  projectSecret: requiredEither("SPECTRUM_PROJECT_SECRET", "PHOTON_SECRET"),
  providers: [imessage.config()],
});
const imessageMessenger = createImessageMessenger(app);
const store = createAlertServiceStore(database.db);
const sendAlert = createAlertSender({
  store,
  publicAppUrl: required("PUBLIC_APP_URL"),
  messenger: {
    send: (spaceId, text) => imessageMessenger.sendText(spaceId, text),
  },
});

startAlertPipeline({ db: database.db, store, sendAlert });

console.info(JSON.stringify({ level: "info", message: "alert_service_started" }));

async function shutdown(): Promise<void> {
  database.disconnect();
  await app.stop();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
