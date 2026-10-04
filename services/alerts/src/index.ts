import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { connectDb } from "@tempmhacks/shared/db";
import { createImessageMessenger } from "@tempmhacks/messaging";
import { matchConfirmedIncident, matchConfirmedIncidentToProfiles } from "./matcher.js";
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

function matchIncident(incident: import("@tempmhacks/shared").Incident): void {
  if (incident.status !== "confirmed") return;
  void matchConfirmedIncident(incident, store).catch(error => console.error("alert_match_failed", error));
  void matchConfirmedIncidentToProfiles(incident, store, { now: Date.now() })
    .catch(error => console.error("alert_profile_match_failed", error));
}

database.db.incidents.subscribe(incident => {
  matchIncident(incident);
});
database.db.alerts.subscribe(alert => {
  if (alert.status === "pending") {
    void sendAlert(alert).catch(error => console.error("alert_send_failed", error));
  }
});
for (const alert of store.listPending()) void sendAlert(alert);
for (const incident of database.db.incidents.listConfirmed()) {
  matchIncident(incident);
}

console.info(JSON.stringify({ level: "info", message: "alert_service_started" }));

async function shutdown(): Promise<void> {
  database.disconnect();
  await app.stop();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
