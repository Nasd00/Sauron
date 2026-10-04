import assert from "node:assert/strict";
import { test } from "node:test";
import type { Camera, Incident, Observation } from "@tempmhacks/shared";
import { createGeminiDetector, parseDetection, type Detection } from "../src/detector.js";
import { CameraIncidentTracker, type TrackerAction } from "../src/incidents.js";
import { createFrameHandler, runCamera, type DetectionStore } from "../src/worker.js";

const camera: Camera = {
  id: "cam-1", name: "Test", latitude: 42.28, longitude: -83.74,
  sourceType: "live", streamUrl: "https://example.com/cam.jpg", status: "online",
};

function tracker(open?: Incident) {
  let n = 0;
  return new CameraIncidentTracker(camera, { newId: () => `incident-${++n}`, open });
}

function run(t: CameraIncidentTracker, confidences: number[], start = 0, stepMs = 30_000): TrackerAction["kind"][][] {
  return confidences.map((confidence, i) => t.step(confidence, start + i * stepMs).map(action => action.kind));
}

test("sightings open a candidate and repeated strong sightings confirm it", () => {
  const t = tracker();
  assert.deepEqual(run(t, [0.1, 0.8, 0.9, 0.85]), [[], ["create"], ["update"], ["update", "confirm"]]);
  assert.equal(t.openIncidentId, "incident-1");
});

test("the created candidate carries the camera position and first sighting", () => {
  const [action] = tracker().step(0.6, 5_000);
  assert.equal(action.kind, "create");
  assert.deepEqual(action.kind === "create" && action.incident, {
    id: "incident-1", cameraId: "cam-1", type: "smoke_fire", status: "candidate", confidence: 0.6,
    latitude: 42.28, longitude: -83.74, firstSeenAt: 5_000, lastSeenAt: 5_000,
  });
});

test("weak sightings never confirm, however many there are", () => {
  const t = tracker();
  const kinds = run(t, [0.55, 0.6, 0.6, 0.65, 0.6]).flat();
  assert.ok(!kinds.includes("confirm"));
});

test("hits must land within the confirm window", () => {
  // hit, miss, miss, hit, miss, miss, hit: never 3 hits among any 5 consecutive frames
  const kinds = run(tracker(), [0.9, 0, 0, 0.9, 0, 0, 0.9]).flat();
  assert.ok(!kinds.includes("confirm"));
});

test("a candidate is dismissed after consecutive misses, and the next sighting opens a new one", () => {
  const t = tracker();
  assert.deepEqual(run(t, [0.8, 0, 0, 0, 0, 0.8]), [["create"], [], [], [], ["dismiss"], ["create"]]);
  assert.equal(t.openIncidentId, "incident-2");
});

test("a confirmed incident resolves after a quiet period, not on a single miss", () => {
  const t = tracker();
  run(t, [0.9, 0.9, 0.9]);
  assert.deepEqual(t.step(0, 120_000), []);
  assert.deepEqual(t.step(0.9, 150_000).map(a => a.kind), ["update"]);
  assert.deepEqual(t.step(0, 150_000 + 15 * 60_000 - 1), []);
  assert.deepEqual(t.step(0, 150_000 + 15 * 60_000), [{ kind: "resolve", id: "incident-1", resolvedAt: 150_000 + 15 * 60_000 }]);
  assert.equal(t.openIncidentId, undefined);
});

test("resuming a confirmed incident updates it instead of opening a duplicate", () => {
  const open: Incident = {
    id: "existing", cameraId: "cam-1", type: "smoke_fire", status: "confirmed", confidence: 0.9,
    latitude: 0, longitude: 0, firstSeenAt: 0, lastSeenAt: 0, confirmedAt: 1,
  };
  assert.deepEqual(tracker(open).step(0.7, 10), [{ kind: "update", id: "existing", confidence: 0.9, lastSeenAt: 10 }]);
});

test("parseDetection converts Gemini's 0-1000 box and caps confidence on a negative verdict", () => {
  assert.deepEqual(
    parseDetection(JSON.stringify({ smoke_or_fire: true, confidence: 0.9, box_2d: [125, 250, 625, 750], description: " plume " })),
    { confidence: 0.9, bbox: { x: 0.25, y: 0.125, width: 0.5, height: 0.5 }, description: "plume" },
  );
  assert.deepEqual(
    parseDetection(JSON.stringify({ smoke_or_fire: false, confidence: 0.95, box_2d: [1, 2, 3, 4], description: "fog" })),
    { confidence: 0.2, bbox: undefined, description: "fog" },
  );
  assert.equal(parseDetection(JSON.stringify({ smoke_or_fire: true, confidence: 7, description: "" })).confidence, 1);
  assert.throws(() => parseDetection(""), /empty/);
});

test("the Gemini detector sends the frame as inline JPEG with a JSON schema", async () => {
  let sent: any;
  const detector = createGeminiDetector({
    generate: async params => {
      sent = params;
      return { text: JSON.stringify({ smoke_or_fire: true, confidence: 0.8, description: "smoke" }) } as any;
    },
  });
  const result = await detector.detect(Uint8Array.of(0xff, 0xd8));
  assert.equal(result.confidence, 0.8);
  assert.equal(sent.contents[0].parts[0].inlineData.data, Buffer.from([0xff, 0xd8]).toString("base64"));
  assert.equal(sent.config.responseMimeType, "application/json");
});

function fakeStore(incidents: Incident[] = []) {
  const calls: string[] = [];
  const observations: Observation[] = [];
  const store: DetectionStore = {
    listIncidents: () => incidents,
    publishObservation: async o => { observations.push(o); },
    createIncident: async i => { calls.push(`create ${i.id}`); },
    updateDetection: async id => { calls.push(`update ${id}`); },
    confirmIncident: async id => { calls.push(`confirm ${id}`); },
    dismissIncident: async id => { calls.push(`dismiss ${id}`); },
    resolveIncident: async id => { calls.push(`resolve ${id}`); },
    setCameraStatus: async () => {},
  };
  return { store, calls, observations };
}

function detectorReturning(values: (number | Error)[]) {
  return {
    detect: async (): Promise<Detection> => {
      const value = values.shift()!;
      if (value instanceof Error) throw value;
      return { confidence: value, description: "" };
    },
  };
}

test("the frame handler publishes sightings and drives the incident to confirmed", async () => {
  const { store, calls, observations } = fakeStore();
  const handle = createFrameHandler({
    camera, store, log: () => {}, newId: () => "inc",
    detector: detectorReturning([0.2, 0.8, new Error("rate limited"), 0.9, 0.9]),
  });
  for (let i = 0; i < 5; i++) await handle({ cameraId: "cam-1", capturedAt: i * 1000, image: new Uint8Array() });
  assert.deepEqual(calls, ["create inc", "update inc", "update inc", "confirm inc"]);
  assert.deepEqual(observations.map(o => o.timestamp), [1000, 3000, 4000]);
});

test("the frame handler resumes the camera's open incident from the database", async () => {
  const open: Incident = {
    id: "open-1", cameraId: "cam-1", type: "smoke_fire", status: "candidate", confidence: 0.6,
    latitude: 0, longitude: 0, firstSeenAt: 0, lastSeenAt: 0,
  };
  const { store, calls } = fakeStore([open]);
  const handle = createFrameHandler({ camera, store, log: () => {}, detector: detectorReturning([0.7]) });
  await handle({ cameraId: "cam-1", capturedAt: 1, image: new Uint8Array() });
  assert.deepEqual(calls, ["update open-1"]);
});

test("the camera runner loops a finished replay quickly and backs off a failing source", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  const statuses: string[] = [];
  let starts = 0;
  const { store } = fakeStore();
  store.setCameraStatus = async (_id, status) => { statuses.push(status); };
  await runCamera({
    camera, store, log: () => {}, signal: controller.signal, onFrame: async () => {},
    source: {
      start: async () => { starts += 1; if (starts === 2) throw new Error("HTTP 503"); },
      stop: async () => {},
    },
    sleep: async ms => { waits.push(ms); if (waits.length === 3) controller.abort(); },
  });
  assert.deepEqual(waits, [1_000, 30_000, 1_000]);
  assert.deepEqual(statuses, ["offline"]);
});
