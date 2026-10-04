import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { connectDb } from "@tempmhacks/shared/db";
import { createMobileApi, createMobileHttpHandler, createMobileStore } from "../services/photon/src/mobile.js";
import { createCommandRouter } from "../services/photon/src/router.js";
import { createMessagingStore } from "../services/photon/src/store.js";

// Runs the Sauron iOS app on a simulator against a published local module:
// WATCH ME → open link → pair → permission prompts → simulated movement → relaunch → background move.
// Requires Xcode, a local SpacetimeDB, and IOS_SIMULATOR (default "iPhone 17").
const uri = process.env.SPACETIMEDB_URI || "http://127.0.0.1:3000";
const database = process.env.SPACETIMEDB_DATABASE || "tempmhacks-local";
const simulator = process.env.IOS_SIMULATOR || "iPhone 17";
const port = Number(process.env.MOBILE_E2E_PORT || 3066);
assert(["localhost", "127.0.0.1"].includes(new URL(uri).hostname), "iOS e2e requires a local server");
const iosDir = fileURLToPath(new URL("../apps/ios", import.meta.url));

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, quiet = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: iosDir, env });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (!quiet) for (const line of chunk.toString().split("\n")) {
        if (/SAURON_E2E_PHASE|Test Case|error:|failed|TEST (SUCCEEDED|FAILED)/.test(line)) console.log(line.trim());
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}\n${output.slice(-3000)}`)));
  });
}

const { db, disconnect } = await connectDb({ uri, database });
const suffix = randomUUID().slice(0, 8);
const senderId = `ios-e2e-sender-${suffix}`;
const spaceId = `ios-e2e-space-${suffix}`;
const base = `http://127.0.0.1:${port}`;
const handler = createMobileHttpHandler({
  api: createMobileApi({ store: createMobileStore(db), radiusKm: 10 }),
  publicBaseUrl: base, adminSecret: randomUUID(), bundleId: "com.tempmhacks.sauron",
  logger: { info: fields => console.log("api", JSON.stringify(fields)) },
});
const server = createServer((request, response) => {
  void handler(request, response).then(handled => { if (!handled) response.writeHead(404).end(); });
});
await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));

// Record every change to this sender's profile with the time it was observed.
const updates: { at: number; latitude: number }[] = [];
const poll = setInterval(() => {
  const profile = db.profiles.getForSender(senderId);
  if (profile && updates.at(-1)?.latitude !== profile.latitude) updates.push({ at: Date.now(), latitude: profile.latitude });
}, 100);

try {
  const route = createCommandRouter({
    store: createMessagingStore(db), geocoder: { geocode: async () => null }, radiusKm: 10,
    publicAppUrl: "https://downwind.example", mobilePairingBaseUrl: base,
  });
  const reply = await route({
    messageId: randomUUID(), spaceId, senderId, receivedAt: new Date().toISOString(),
    content: { type: "text", text: "WATCH ME" },
  });
  const token = /\/pair\/([A-Za-z0-9_-]{43})/.exec(reply?.text ?? "")?.[1];
  assert.ok(token, reply?.text);
  // The URL the pairing page hands to the app.
  const pairUrl = `sauron://pair?token=${token}&api=${encodeURIComponent(base)}`;

  // Fresh install and permission state so the real prompts appear.
  await run("xcrun", ["simctl", "boot", simulator]).catch(() => undefined);
  await run("xcrun", ["simctl", "uninstall", simulator, "com.tempmhacks.sauron"], process.env, true).catch(() => undefined);
  await run("xcrun", ["simctl", "privacy", simulator, "reset", "location", "com.tempmhacks.sauron"], process.env, true).catch(() => undefined);

  const output = await run("xcodebuild", [
    "-project", "SauronLocation.xcodeproj", "-scheme", "SauronLocationE2E",
    "-destination", `platform=iOS Simulator,name=${simulator}`, "-derivedDataPath", "/tmp/sauron-e2e-dd", "test",
  ], { ...process.env, TEST_RUNNER_SAURON_PAIR_URL: pairUrl });
  await new Promise(resolve => setTimeout(resolve, 1000));

  const phases = Object.fromEntries([...output.matchAll(/SAURON_E2E_PHASE (\S+) (\d+)/g)].map(m => [m[1]!, Number(m[2])]));
  for (const phase of ["first-upload", "nearby-done", "foreground-move-done", "backgrounded", "background-move-done"]) {
    assert.ok(phases[phase], `phase ${phase} reached`);
  }
  console.log("profile updates:", JSON.stringify(updates.map(u => u.latitude)));

  const device = db.mobile.getActiveDeviceForSender(senderId);
  assert.ok(device, "device paired");
  assert.equal(device.spaceId, spaceId, "pairing resolved to the iMessage conversation that sent WATCH ME");
  const near = (latitude: number, target: number) => Math.abs(latitude - target) < 0.0005;
  assert.ok(updates.some(u => near(u.latitude, 42.2808)), "initial location uploaded");
  assert.ok(!updates.some(u => near(u.latitude, 42.2848)), "~450 m move did not upload");
  assert.ok(updates.some(u => near(u.latitude, 42.2998) && u.at <= phases["foreground-move-done"]! + 500), ">1 km foreground move uploaded");
  const background = updates.find(u => near(u.latitude, 42.3188));
  assert.ok(background && background.at >= phases.backgrounded!, ">1 km move uploaded while backgrounded");
  const profile = db.profiles.getForSender(senderId);
  assert.ok(profile && near(profile.latitude, 42.3188) && profile.alertsEnabled, "profile holds the latest location");
  assert.equal(db.profiles.list().filter(p => p.senderId === senderId).length, 1, "one location-backed profile");
  console.log(`iOS e2e passed (sender ${senderId})`);
} finally {
  clearInterval(poll);
  server.close();
  disconnect();
}
