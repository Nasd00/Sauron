import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SAMPLING_INTERVAL_MS,
  JpegFrameParser,
  LiveFrameSource,
  ReplayFrameSource,
  type ReplayFrameReader,
} from "../src/sources/index.js";

function readerFor(values: number[]): ReplayFrameReader {
  return async function* () {
    for (const value of values) yield Uint8Array.of(value);
  };
}

test("replay preserves frame order, camera ID, two-second cadence, and can restart", async () => {
  let now = 10_000;
  const delays: number[] = [];
  const source = new ReplayFrameSource({
    cameraId: "demo-camera-001",
    videoPath: "fixture.mp4",
    reader: readerFor([3, 1, 2]),
    clock: () => now,
    sleep: async milliseconds => {
      delays.push(milliseconds);
      now += milliseconds;
    },
  });

  const firstRun: { value: number; cameraId: string; capturedAt: number }[] = [];
  await source.start(async frame => {
    firstRun.push({ value: frame.image[0], cameraId: frame.cameraId, capturedAt: frame.capturedAt });
  });

  assert.deepEqual(firstRun, [
    { value: 3, cameraId: "demo-camera-001", capturedAt: 10_000 },
    { value: 1, cameraId: "demo-camera-001", capturedAt: 12_000 },
    { value: 2, cameraId: "demo-camera-001", capturedAt: 14_000 },
  ]);
  assert.deepEqual(delays, [DEFAULT_SAMPLING_INTERVAL_MS, DEFAULT_SAMPLING_INTERVAL_MS]);

  const secondRun: number[] = [];
  await source.start(async frame => { secondRun.push(frame.image[0]); });
  assert.deepEqual(secondRun, [3, 1, 2]);
});

test("stopping replay aborts its reader and leaves the source restartable", async () => {
  let cleanedUp = 0;
  const blockingReader: ReplayFrameReader = async function* ({ signal }) {
    try {
      yield Uint8Array.of(1);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally {
      cleanedUp += 1;
    }
  };
  const source = new ReplayFrameSource({
    cameraId: "demo-camera-001",
    videoPath: "fixture.mp4",
    intervalMs: 1,
    reader: blockingReader,
  });

  let frames = 0;
  const running = source.start(async () => { frames += 1; });
  while (frames === 0) await new Promise(resolve => setImmediate(resolve));
  await source.stop();
  await running;

  assert.equal(frames, 1);
  assert.equal(cleanedUp, 1);

  const restarted = source.start(async () => { frames += 1; });
  while (frames === 1) await new Promise(resolve => setImmediate(resolve));
  await source.stop();
  await restarted;
  assert.equal(cleanedUp, 2);
});

test("JPEG parser handles frame markers split across process chunks", () => {
  const parser = new JpegFrameParser();
  assert.deepEqual(parser.push(Uint8Array.of(0, 0xff)), []);
  assert.deepEqual(parser.push(Uint8Array.of(0xd8, 1, 2, 0xff)), []);
  const frames = parser.push(Uint8Array.of(0xd9, 0xff, 0xd8, 3, 0xff, 0xd9));
  assert.deepEqual(frames.map(frame => [...frame]), [
    [0xff, 0xd8, 1, 2, 0xff, 0xd9],
    [0xff, 0xd8, 3, 0xff, 0xd9],
  ]);
});

test("live snapshot polling stops an in-flight cadence cleanly", async () => {
  let fetched = 0;
  let received: { cameraId: string; image: number[] } | undefined;
  let markReceived: (() => void) | undefined;
  const firstFrame = new Promise<void>(resolve => { markReceived = resolve; });
  const source = new LiveFrameSource({
    cameraId: "usgs-kilauea-k2",
    snapshotUrl: "https://example.test/snapshot.jpg",
    intervalMs: 60_000,
    fetch: async () => {
      fetched += 1;
      return new Response(Uint8Array.of(7, 8, 9), { status: 200 });
    },
  });

  const running = source.start(async frame => {
    received = { cameraId: frame.cameraId, image: [...frame.image] };
    markReceived?.();
  });
  await firstFrame;
  await source.stop();
  await running;

  assert.equal(fetched, 1);
  assert.deepEqual(received, { cameraId: "usgs-kilauea-k2", image: [7, 8, 9] });
});
