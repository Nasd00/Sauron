import assert from "node:assert/strict";
import { test } from "node:test";
import {
  demoReplayCamera,
  seedCameraRegistry,
  usgsKilaueaCamera,
} from "./cameras.js";

test("camera registry uses stable IDs and coordinates", () => {
  assert.deepEqual(
    [demoReplayCamera.id, demoReplayCamera.latitude, demoReplayCamera.longitude, demoReplayCamera.sourceType],
    ["demo-camera-001", 42.2808, -83.743, "replay"],
  );
  assert.deepEqual(
    [usgsKilaueaCamera.id, usgsKilaueaCamera.latitude, usgsKilaueaCamera.longitude, usgsKilaueaCamera.sourceType],
    ["usgs-kilauea-k2", 19.4202, -155.2881, "live"],
  );
});

test("live camera is opt-in and does not block replay registration", () => {
  const replayOnly: string[] = [];
  seedCameraRegistry(camera => replayOnly.push(camera.id), false);
  assert.deepEqual(replayOnly, ["demo-camera-001"]);

  const all: string[] = [];
  seedCameraRegistry(camera => all.push(camera.id), true);
  assert.deepEqual(all, ["demo-camera-001", "usgs-kilauea-k2"]);
});
