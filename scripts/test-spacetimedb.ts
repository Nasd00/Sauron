import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Camera, Observation, Incident, Watch, Alert } from "@tempmhacks/shared";

// Run against a published local module. Unique IDs allow repeated runs without reset.
const bin = process.env.SPACETIME_BIN ?? "spacetime";
const uri = process.env.SPACETIMEDB_URI || "http://127.0.0.1:3000";
const database = process.env.SPACETIMEDB_DATABASE || "tempmhacks-local";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname), "Integration tests require a local server");
const suffix = randomUUID();
const id = (name: string) => `${name}-${suffix}`;
const now = Date.now();
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const snake = (key: string) => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const optionFields = new Set(["streamUrl", "evidenceUrl", "bbox", "confirmedAt", "resolvedAt", "sentAt", "providerMessageId", "error"]);

function wire(value: unknown): unknown {
  if (value === undefined) return null;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      snake(key), (optionFields.has(key) || (key === "lastSeenAt" && "sourceType" in value)) && entry !== undefined
        ? { some: wire(entry) } : wire(entry),
    ]));
  }
  return value;
}

function cli(args: string[]): string {
  return execFileSync(bin, [...args, "--server", uri], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
}

function call(reducer: string, ...args: unknown[]): void {
  cli(["call", database, reducer, ...args.map(value => JSON.stringify(wire(value)))]);
}

function rejects(reducer: string, args: unknown[], message: RegExp): void {
  assert.throws(() => call(reducer, ...args), (error: unknown) => {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    assert.match(stderr, message);
    return true;
  });
}

type SqlType = { Sum?: { variants: { name: { some: string }; algebraic_type: SqlType }[] }; Product?: { elements: SqlColumn[] } };
type SqlColumn = { name: { some: string }; algebraic_type: SqlType };
function decode(value: unknown, type: SqlType): unknown {
  if (type.Sum) {
    const [tag, payload] = value as [number, unknown];
    const variant = type.Sum.variants[tag];
    return variant.name.some === "none" ? undefined : decode(payload, variant.algebraic_type);
  }
  if (type.Product) {
    return Object.fromEntries(type.Product.elements.map((column, index) =>
      [camel(column.name.some), decode((value as unknown[])[index], column.algebraic_type)]));
  }
  return value;
}

function query(sql: string): Record<string, unknown>[] {
  const output = cli(["sql", "--format", "json", database, sql]);
  const result = JSON.parse(output.slice(output.indexOf("[{")))[0] as { schema: { elements: SqlColumn[] }; rows: unknown[][] };
  return result.rows.map(row => Object.fromEntries(result.schema.elements.map((column, index) =>
    [camel(column.name.some), decode(row[index], column.algebraic_type)])));
}

async function subscribe(sql: string) {
  const child = spawn(bin, ["subscribe", "--server", uri, "--print-initial-update", "--timeout", "45", database, sql],
    { stdio: ["ignore", "pipe", "pipe"] });
  const events: Record<string, { inserts: Record<string, unknown>[]; deletes: Record<string, unknown>[] }>[] = [];
  let buffer = "";
  let stderr = "";
  let failure: Error | undefined;
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.on("error", error => { failure = error; });
  child.on("exit", code => { if (code !== null) failure = new Error(`Subscription exited: ${code} ${stderr}`); });
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("{")) events.push(JSON.parse(line));
  });
  async function waitFor(predicate: (event: typeof events[number]) => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!events.some(predicate)) {
      if (failure) throw failure;
      assert(Date.now() < deadline, `Subscription timed out: ${sql} ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { await waitFor(() => true); }
  catch (error) { child.kill(); throw error; }
  return { waitFor, stop: () => child.kill() };
}

async function main() {
  const camera: Camera = {
    id: id("camera"), name: "Integration replay", latitude: 42.28, longitude: -83.74,
    sourceType: "replay", streamUrl: "https://example.test/replay", status: "online", lastSeenAt: now,
  };
  const observation: Observation = {
    id: id("observation"), cameraId: camera.id, type: "smoke_fire", confidence: 0.9, timestamp: now,
    evidenceUrl: "https://example.test/evidence", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  };
  const incident: Incident = {
    id: id("incident"), cameraId: camera.id, type: "smoke_fire", status: "candidate",
    confidence: 0.9, latitude: camera.latitude, longitude: camera.longitude, firstSeenAt: now, lastSeenAt: now,
    confirmedAt: undefined, resolvedAt: undefined,
  };
  const dismissed: Incident = { ...incident, id: id("dismissed") };
  const observations = await subscribe(`SELECT * FROM observation WHERE camera_id = '${camera.id}'`);
  const incidents = await subscribe(`SELECT * FROM incident WHERE camera_id = '${camera.id}'`);
  try {
    call("register_camera", camera);
    rejects("register_camera", [camera], /already exists/);
    call("set_camera_status", camera.id, "offline", now + 1);
    assert.deepEqual(query(`SELECT * FROM camera WHERE id = '${camera.id}'`)[0], { ...camera, status: "offline", lastSeenAt: now + 1 });
    rejects("set_camera_status", ["unknown-camera", "online", now], /does not exist/);
    rejects("set_camera_status", [camera.id, "unknown", now], /online or offline/);

    rejects("publish_observation", [{ ...observation, cameraId: "unknown-camera" }], /does not exist/);
    for (const confidence of [-0.1, 1.1]) {
      rejects("publish_observation", [{ ...observation, confidence }], /Confidence/);
    }
    rejects("publish_observation", [{ ...observation, type: "flood" }], /smoke_fire/);
    call("publish_observation", observation);
    rejects("publish_observation", [observation], /already exists/);
    await observations.waitFor(event => event.observation?.inserts.some(row => row.id === observation.id));
    assert.deepEqual(query(`SELECT * FROM observation WHERE camera_id = '${camera.id}' AND timestamp >= ${now}`)[0], observation);
    assert.equal(query(`SELECT * FROM incident WHERE camera_id = '${camera.id}'`).length, 0);

    rejects("create_incident", [{ ...incident, status: "confirmed" }], /candidate/);
    rejects("create_incident", [{ ...incident, confirmedAt: now }], /timestamps/);
    rejects("create_incident", [{ ...incident, cameraId: "unknown-camera" }], /does not exist/);
    call("create_incident", incident);
    rejects("create_incident", [incident], /already exists/);
    assert.equal(query(`SELECT * FROM incident WHERE camera_id = '${camera.id}' AND type = 'smoke_fire' AND status = 'candidate'`).length, 1);
    rejects("resolve_incident", [incident.id, now + 10], /Cannot resolve candidate/);
    call("update_incident_detection", incident.id, 0.95, now + 2);
    assert.equal(query(`SELECT * FROM incident WHERE id = '${incident.id}'`)[0].status, "candidate");
    rejects("update_incident_detection", [incident.id, 1.1, now + 2], /Confidence/);
    call("confirm_incident", incident.id, now + 3);
    await incidents.waitFor(event => event.incident?.inserts.some(row => row.id === incident.id && row.status === "confirmed"));
    rejects("confirm_incident", [incident.id, now + 4], /Cannot confirm confirmed/);
    rejects("dismiss_incident", [incident.id], /Cannot dismiss confirmed/);
    call("update_incident_detection", incident.id, 0.99, now + 4);
    assert.equal(query(`SELECT * FROM incident WHERE id = '${incident.id}'`)[0].confirmedAt, now + 3);
    call("resolve_incident", incident.id, now + 5);
    await incidents.waitFor(event => event.incident?.inserts.some(row => row.id === incident.id && row.status === "resolved"));
    rejects("resolve_incident", [incident.id, now + 6], /Cannot resolve resolved/);
    rejects("confirm_incident", [incident.id, now + 6], /Cannot confirm resolved/);
    rejects("update_incident_detection", [incident.id, 0.8, now + 6], /Cannot update detection/);
    assert.deepEqual(query(`SELECT * FROM incident WHERE id = '${incident.id}'`)[0], {
      ...incident, status: "resolved", confidence: 0.99, lastSeenAt: now + 4, confirmedAt: now + 3, resolvedAt: now + 5,
    });

    call("create_incident", dismissed);
    call("dismiss_incident", dismissed.id);
    await incidents.waitFor(event => event.incident?.inserts.some(row => row.id === dismissed.id && row.status === "dismissed"));
    rejects("confirm_incident", [dismissed.id, now + 7], /Cannot confirm dismissed/);
    rejects("update_incident_detection", [dismissed.id, 0.8, now + 7], /Cannot update detection/);
    rejects("confirm_incident", ["unknown-incident", now], /does not exist/);
    assert.equal(query(`SELECT * FROM alert WHERE incident_id = '${incident.id}'`).length, 0);
    assert.equal(query(`SELECT * FROM alert WHERE incident_id = '${dismissed.id}'`).length, 0);

    const watch: Watch = {
      id: id("watch"), userHandle: "integration-user", placeLabel: "Ann Arbor",
      latitude: camera.latitude, longitude: camera.longitude, radiusKm: 10, active: true, createdAt: now,
    };
    const alert: Alert = {
      id: id("alert"), incidentId: incident.id, watchId: watch.id, status: "pending", createdAt: now,
      sentAt: undefined, providerMessageId: undefined, error: undefined,
    };
    assert.throws(() => cli(["call", "--anonymous", database, "insert_watch", JSON.stringify(wire(watch))]),
      (error: unknown) => /Only the database owner/.test((error as { stderr: string }).stderr));
    call("insert_watch", watch);
    rejects("insert_watch", [watch], /already exists/);
    assert(query("SELECT * FROM watch WHERE active = true").some(row => row.id === watch.id));
    call("insert_alert", alert);
    rejects("insert_alert", [alert], /already exists/);
    rejects("insert_alert", [{ ...alert, id: id("duplicate-pair") }], /already exists for this incident and watch/);
    assert.deepEqual(query(`SELECT * FROM alert WHERE incident_id = '${incident.id}' AND watch_id = '${watch.id}'`)[0], alert);
    console.log("Integration passed: five tables, unique IDs and alert pairs, camera/observation validation, incident transitions, and realtime subscriptions.");
  } finally {
    observations.stop();
    incidents.stop();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
