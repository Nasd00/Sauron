import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EvacAgent } from "./agent/agent.js";
import { startSpectrumChannels } from "./channels/spectrum.js";
import { WebSimHub } from "./channels/web-sim.js";
import { annArborScenario } from "./scenario/ann-arbor.js";
import { EvacServer } from "./server.js";
import { startGodsEyePoller } from "./sources/gods-eye.js";
import { RouteCache, ValhallaRouter } from "./sources/routing.js";
import { fetchFemaOpenShelters } from "./sources/shelters.js";
import { fetchNwsAlerts } from "./sources/warnings.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const env = process.env;
const log = (message: string) => console.log(`[evac] ${message}`);
const flag = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true";

const offline = flag(env.EVAC_OFFLINE);
const port = Number(env.EVAC_PORT || 8787);
const scenario = annArborScenario();

// Participant ID → iMessage handle, e.g. EVAC_IMESSAGE_HANDLES="resident-alex=+15551234567,helper-maya=+15557654321"
const imessageHandles = Object.fromEntries((env.EVAC_IMESSAGE_HANDLES ?? "")
  .split(",").map(pair => pair.split("=").map(part => part.trim())).filter(([id, handle]) => id && handle)) as Record<string, string>;
const photon = env.PHOTON_PROJECT_ID && env.PHOTON_SECRET
  ? { projectId: env.PHOTON_PROJECT_ID, projectSecret: env.PHOTON_SECRET } : undefined;

const hub = new WebSimHub();
let server: EvacServer | undefined;
let agent!: EvacAgent;
const channels = await startSpectrumChannels({
  hub, photon, imessageHandles, log,
  typingMs: Number(env.EVAC_TYPING_MS ?? 700),
});

const router = new ValhallaRouter({
  offline,
  cache: new RouteCache({
    seedPaths: [fileURLToPath(new URL("../fixtures/route-cache.json", import.meta.url))],
    writePath: fileURLToPath(new URL("../.cache/routes.json", import.meta.url)),
  }),
  onHealth: (ok, detail) => agent?.recordHealth("Valhalla routing", ok, detail),
});

agent = new EvacAgent({
  scenario: annArborScenario,
  router,
  messenger: channels.messenger,
  helperTimeoutMs: Number(env.EVAC_HELPER_TIMEOUT_SEC ?? 120) * 1000,
  onChange: snapshot => server?.broadcast({ type: "snapshot", snapshot }),
});
for (const [participantId, address] of Object.entries(imessageHandles)) {
  if (photon && agent.participant(participantId)) agent.bindChannel(participantId, { platform: "imessage", address });
}
await agent.setChannels(channels.channels);
void channels.listen(agent);

server = new EvacServer(agent, hub);
await server.listen(port);
log(`API on http://127.0.0.1:${port} (loopback only, no auth: local demo use)`);
log(`Channels: ${channels.channels.map(c => c.platform).join(", ")}${photon ? "" : " (set PHOTON_PROJECT_ID, PHOTON_SECRET, EVAC_IMESSAGE_HANDLES for iMessage)"}`);

const household = scenario.households[0]!;
if (!offline) {
  fetchNwsAlerts(household.location)
    .then(async warnings => {
      await agent.setLiveWarnings(warnings);
      agent.recordHealth("NWS alerts", true, `${warnings.length} active alert(s) at the household`);
    })
    .catch(error => agent.recordHealth("NWS alerts", false, (error as Error).message));
  fetchFemaOpenShelters(household.location)
    .then(async shelters => {
      await agent.setLiveShelters(shelters);
      agent.recordHealth("FEMA open shelters", true, `${shelters.length} open shelter(s) within 40 mi`);
    })
    .catch(error => agent.recordHealth("FEMA open shelters", false, (error as Error).message));
} else {
  agent.recordHealth("Live sources", false, "EVAC_OFFLINE=1: using supplied data and cached routes only");
}

let stopGodsEye: (() => void) | undefined;
if (env.SPACETIMEDB_URI && env.SPACETIMEDB_DATABASE && !flag(env.EVAC_DISABLE_GODS_EYE)) {
  stopGodsEye = startGodsEyePoller({
    uri: env.SPACETIMEDB_URI,
    database: env.SPACETIMEDB_DATABASE,
    onIncidents: incidents => void agent.setIncidents(incidents),
    onHealth: (ok, detail) => agent.recordHealth("God's Eye incidents", ok, detail),
  });
} else {
  agent.recordHealth("God's Eye incidents", false, "Set SPACETIMEDB_URI and SPACETIMEDB_DATABASE to watch confirmed camera incidents");
}

async function shutdown(): Promise<void> {
  stopGodsEye?.();
  await server?.close();
  await channels.stop();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
