import { randomUUID } from "node:crypto";
import type { Camera, Incident, Observation } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";
import type { Detector } from "./detector.js";
import { CameraIncidentTracker, DEFAULT_TRACKER_CONFIG, type TrackerAction, type TrackerConfig } from "./incidents.js";
import type { FrameSource, SampledFrame } from "./sources/types.js";
import { abortableSleep, type Sleep } from "./sources/timing.js";

/** The slice of the shared Db the detection worker writes through. */
export type DetectionStore = {
  listIncidents(): Incident[];
  publishObservation(observation: Observation): Promise<void>;
  createIncident(incident: Incident): Promise<void>;
  updateDetection(id: string, confidence: number, lastSeenAt: number): Promise<void>;
  confirmIncident(id: string): Promise<void>;
  dismissIncident(id: string): Promise<void>;
  resolveIncident(id: string, resolvedAt: number): Promise<void>;
  setCameraStatus(id: string, status: Camera["status"], lastSeenAt: number): Promise<void>;
};

export function createDetectionStore(db: Db): DetectionStore {
  return {
    listIncidents: () => db.incidents.list(),
    publishObservation: observation => db.observations.publish(observation),
    createIncident: incident => db.incidents.create(incident),
    updateDetection: (id, confidence, lastSeenAt) => db.incidents.updateDetection(id, confidence, lastSeenAt),
    confirmIncident: id => db.incidents.confirm(id),
    dismissIncident: id => db.incidents.dismiss(id),
    resolveIncident: (id, resolvedAt) => db.incidents.resolve(id, resolvedAt),
    setCameraStatus: (id, status, lastSeenAt) => db.cameras.setStatus(id, status, lastSeenAt),
  };
}

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export type FrameHandlerOptions = {
  camera: Camera;
  detector: Detector;
  store: DetectionStore;
  log: Logger;
  config?: TrackerConfig;
  newId?: () => string;
};

function openIncidentFor(store: DetectionStore, cameraId: string): Incident | undefined {
  return store.listIncidents()
    .filter(incident => incident.cameraId === cameraId
      && (incident.status === "candidate" || incident.status === "confirmed"))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
}

/**
 * Builds the per-frame pipeline for one camera: detect, publish the sighting as
 * an observation, and apply the tracker's incident actions. The tracker resumes
 * the camera's open incident from the database, so restarts don't duplicate it.
 */
export function createFrameHandler(options: FrameHandlerOptions): (frame: SampledFrame) => Promise<void> {
  const { camera, detector, store, log } = options;
  const config = options.config ?? DEFAULT_TRACKER_CONFIG;
  const newId = options.newId ?? (() => `incident-${camera.id}-${randomUUID()}`);
  const newTracker = () => new CameraIncidentTracker(camera, {
    config, newId, open: openIncidentFor(store, camera.id),
  });
  let tracker = newTracker();

  return async frame => {
    let detection;
    try {
      detection = await detector.detect(frame.image);
    } catch (error) {
      // A failed call says nothing about the scene, so it is not counted as a miss.
      log("detection_failed", { cameraId: camera.id, error: String(error) });
      return;
    }
    await store.setCameraStatus(camera.id, "online", frame.capturedAt)
      .catch(error => log("camera_status_failed", { cameraId: camera.id, error: String(error) }));

    if (detection.confidence >= config.detectThreshold) {
      log("smoke_sighted", { cameraId: camera.id, confidence: detection.confidence, description: detection.description });
      await store.publishObservation({
        id: `observation-${camera.id}-${frame.capturedAt}`,
        cameraId: camera.id,
        type: "smoke_fire",
        confidence: detection.confidence,
        timestamp: frame.capturedAt,
        bbox: detection.bbox,
      }).catch(error => log("observation_publish_failed", { cameraId: camera.id, error: String(error) }));
    }

    for (const action of tracker.step(detection.confidence, frame.capturedAt)) {
      try {
        await apply(store, action);
        log(`incident_${action.kind}`, { cameraId: camera.id, id: action.kind === "create" ? action.incident.id : action.id });
      } catch (error) {
        // The database disagrees (e.g. someone resolved the incident by hand): start over from its state.
        log("incident_action_failed", { cameraId: camera.id, action: action.kind, error: String(error) });
        tracker = newTracker();
        return;
      }
    }
  };
}

function apply(store: DetectionStore, action: TrackerAction): Promise<void> {
  switch (action.kind) {
    case "create": return store.createIncident(action.incident);
    case "update": return store.updateDetection(action.id, action.confidence, action.lastSeenAt);
    case "confirm": return store.confirmIncident(action.id);
    case "dismiss": return store.dismissIncident(action.id);
    case "resolve": return store.resolveIncident(action.id, action.resolvedAt);
  }
}

export type CameraRunnerOptions = {
  camera: Camera;
  source: FrameSource;
  onFrame: (frame: SampledFrame) => Promise<void>;
  store: DetectionStore;
  log: Logger;
  signal: AbortSignal;
  /** Wait before restarting a source that failed. */
  retryMs?: number;
  /** Wait before replaying a source that ran out (a replay video), so it loops. */
  loopMs?: number;
  clock?: () => number;
  sleep?: Sleep;
};

/** Keeps one camera's source running until aborted, marking the camera offline while it is down. */
export async function runCamera(options: CameraRunnerOptions): Promise<void> {
  const { camera, source, signal, log } = options;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const stop = () => { void source.stop(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted) {
      let waitMs = options.loopMs ?? 1_000;
      try {
        await source.start(options.onFrame);
      } catch (error) {
        if (signal.aborted) break;
        log("camera_source_failed", { cameraId: camera.id, error: String(error) });
        await options.store.setCameraStatus(camera.id, "offline", clock())
          .catch(statusError => log("camera_status_failed", { cameraId: camera.id, error: String(statusError) }));
        waitMs = options.retryMs ?? 30_000;
      }
      if (!signal.aborted) await sleep(waitMs, signal);
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
