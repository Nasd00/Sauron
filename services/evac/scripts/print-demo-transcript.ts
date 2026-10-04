/** Run the scripted demo offline against the seed route cache and print the conversation. */
import { fileURLToPath } from "node:url";
import { EvacAgent } from "../src/agent/agent.js";
import { annArborScenario } from "../src/scenario/ann-arbor.js";
import { RouteCache, ValhallaRouter } from "../src/sources/routing.js";

const seed = fileURLToPath(new URL("../fixtures/route-cache.json", import.meta.url));
const agent = new EvacAgent({
  scenario: annArborScenario,
  router: new ValhallaRouter({ cache: new RouteCache({ seedPaths: [seed] }), offline: true }),
  messenger: { deliver: async () => undefined },
});

await agent.issueWarning();
await agent.handleInbound("resident-alex", "We’re three people. My dad uses a wheelchair, and we don’t have a car.");
await agent.handleInbound("resident-alex", "Yes");
await agent.handleInbound("helper-maya", "Accept");
await agent.injectClosure("closure-huron-pkwy");
await agent.handleInbound("helper-maya", "Picked up");
await agent.handleInbound("helper-maya", "Arrived");

const snapshot = agent.snapshot();
const names = new Map(snapshot.participants.map(p => [p.id, p.name]));
for (const entry of snapshot.transcript) {
  const who = entry.direction === "inbound" ? `${names.get(entry.participantId)} →` : `Agent → ${names.get(entry.participantId)}`;
  console.log(`\n── ${who}\n${entry.text}`);
}
console.log("\n── Timeline");
for (const event of snapshot.timeline) console.log(`${event.kind.padEnd(12)} ${event.title}${event.detail ? ` — ${event.detail}` : ""}`);
