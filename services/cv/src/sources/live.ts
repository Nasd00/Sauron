import type { FrameSource, SampledFrame } from "./types.js";
import { abortableSleep, type Sleep } from "./timing.js";
import { DEFAULT_SAMPLING_INTERVAL_MS } from "./replay.js";

export type LiveFrameSourceOptions = {
  cameraId: string;
  snapshotUrl: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  clock?: () => number;
  sleep?: Sleep;
};

type ActiveRun = {
  controller: AbortController;
  promise: Promise<void>;
};

export class LiveFrameSource implements FrameSource {
  readonly #cameraId: string;
  readonly #snapshotUrl: string;
  readonly #intervalMs: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  readonly #sleep: Sleep;
  #active?: ActiveRun;

  constructor(options: LiveFrameSourceOptions) {
    if (!options.cameraId.trim()) throw new Error("Live cameraId is required");
    new URL(options.snapshotUrl);

    const intervalMs = options.intervalMs ?? DEFAULT_SAMPLING_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Live intervalMs must be a positive finite number");
    }

    this.#cameraId = options.cameraId;
    this.#snapshotUrl = options.snapshotUrl;
    this.#intervalMs = intervalMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async start(onFrame: (frame: SampledFrame) => Promise<void>): Promise<void> {
    if (this.#active) throw new Error("Live source is already running");

    const controller = new AbortController();
    const active: ActiveRun = { controller, promise: Promise.resolve() };
    active.promise = this.#poll(onFrame, controller.signal);
    this.#active = active;

    try {
      await active.promise;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  async stop(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.controller.abort();
    await active.promise.catch(error => {
      if (!active.controller.signal.aborted) throw error;
    });
  }

  async #poll(
    onFrame: (frame: SampledFrame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const startedAt = this.#clock();
      const response = await this.#fetch(this.#snapshotUrl, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error(`Live snapshot request failed: HTTP ${response.status}`);
      }

      await onFrame({
        cameraId: this.#cameraId,
        capturedAt: this.#clock(),
        image: new Uint8Array(await response.arrayBuffer()),
      });

      const delay = Math.max(0, this.#intervalMs - (this.#clock() - startedAt));
      if (delay > 0) await this.#sleep(delay, signal);
    }
  }
}
