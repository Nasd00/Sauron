import type { Camera, Incident } from "@tempmhacks/shared";

export type TrackerConfig = {
  /** A frame at or above this confidence counts as a sighting. */
  detectThreshold: number;
  /** A candidate confirms only once one of its sightings reaches this confidence... */
  confirmThreshold: number;
  /** ...and it has this many sightings among its last `confirmWindow` frames. */
  confirmHits: number;
  confirmWindow: number;
  /** A candidate with this many misses in a row is dismissed as a false alarm. */
  dismissAfterMisses: number;
  /** A confirmed incident with no sighting for this long is resolved. */
  resolveAfterMs: number;
};

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  detectThreshold: 0.5,
  confirmThreshold: 0.7,
  confirmHits: 3,
  confirmWindow: 5,
  dismissAfterMisses: 4,
  resolveAfterMs: 15 * 60_000,
};

export type TrackerAction =
  | { kind: "create"; incident: Incident }
  | { kind: "update"; id: string; confidence: number; lastSeenAt: number }
  | { kind: "confirm"; id: string }
  | { kind: "dismiss"; id: string }
  | { kind: "resolve"; id: string; resolvedAt: number };

type Open = {
  id: string;
  status: "candidate" | "confirmed";
  confidence: number;
  lastSeenAt: number;
  /** Recent frames since the candidate opened: the confidence of each sighting, or undefined for a miss. */
  recent: (number | undefined)[];
  misses: number;
};

/**
 * Turns one camera's per-frame confidences into incident lifecycle actions. One
 * open incident per camera: a sighting opens a candidate, repeated strong
 * sightings confirm it (which is what triggers alerts), and quiet frames
 * dismiss a candidate or resolve a confirmed incident.
 */
export class CameraIncidentTracker {
  readonly #camera: Camera;
  readonly #config: TrackerConfig;
  readonly #newId: () => string;
  #open?: Open;

  constructor(camera: Camera, options: { config?: TrackerConfig; newId: () => string; open?: Incident }) {
    this.#camera = camera;
    this.#config = options.config ?? DEFAULT_TRACKER_CONFIG;
    this.#newId = options.newId;
    const open = options.open;
    if (open && (open.status === "candidate" || open.status === "confirmed")) {
      this.#open = {
        id: open.id, status: open.status, confidence: open.confidence,
        lastSeenAt: open.lastSeenAt, recent: [], misses: 0,
      };
    }
  }

  get openIncidentId(): string | undefined {
    return this.#open?.id;
  }

  step(confidence: number, capturedAt: number): TrackerAction[] {
    const sighting = confidence >= this.#config.detectThreshold;
    const open = this.#open;

    if (!open) {
      if (!sighting) return [];
      const incident: Incident = {
        id: this.#newId(),
        cameraId: this.#camera.id,
        type: "smoke_fire",
        status: "candidate",
        confidence,
        latitude: this.#camera.latitude,
        longitude: this.#camera.longitude,
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
      };
      this.#open = {
        id: incident.id, status: "candidate", confidence, lastSeenAt: capturedAt,
        recent: [confidence], misses: 0,
      };
      return [{ kind: "create", incident }, ...this.#maybeConfirm()];
    }

    if (open.status === "confirmed") {
      if (sighting) {
        open.lastSeenAt = capturedAt;
        open.confidence = Math.max(open.confidence, confidence);
        return [{ kind: "update", id: open.id, confidence: open.confidence, lastSeenAt: capturedAt }];
      }
      if (capturedAt - open.lastSeenAt >= this.#config.resolveAfterMs) {
        this.#open = undefined;
        return [{ kind: "resolve", id: open.id, resolvedAt: capturedAt }];
      }
      return [];
    }

    open.recent = [...open.recent, sighting ? confidence : undefined].slice(-this.#config.confirmWindow);
    if (!sighting) {
      open.misses += 1;
      if (open.misses >= this.#config.dismissAfterMisses) {
        this.#open = undefined;
        return [{ kind: "dismiss", id: open.id }];
      }
      return [];
    }
    open.misses = 0;
    open.lastSeenAt = capturedAt;
    open.confidence = Math.max(open.confidence, confidence);
    return [
      { kind: "update", id: open.id, confidence: open.confidence, lastSeenAt: capturedAt },
      ...this.#maybeConfirm(),
    ];
  }

  #maybeConfirm(): TrackerAction[] {
    const open = this.#open;
    if (!open || open.status !== "candidate") return [];
    const hits = open.recent.filter((value): value is number => value !== undefined);
    if (hits.length < this.#config.confirmHits) return [];
    if (Math.max(...hits) < this.#config.confirmThreshold) return [];
    open.status = "confirmed";
    return [{ kind: "confirm", id: open.id }];
  }
}
