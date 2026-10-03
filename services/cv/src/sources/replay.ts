import { spawn } from "node:child_process";
import type { FrameSource, SampledFrame } from "./types.js";
import { abortableSleep, type Sleep } from "./timing.js";

export const DEFAULT_SAMPLING_INTERVAL_MS = 2_000;

export type ReplayReadRequest = {
  videoPath: string;
  intervalMs: number;
  signal: AbortSignal;
};

export type ReplayFrameReader = (request: ReplayReadRequest) => AsyncIterable<Uint8Array>;

export type ReplayFrameSourceOptions = {
  cameraId: string;
  videoPath: string;
  intervalMs?: number;
  ffmpegPath?: string;
  reader?: ReplayFrameReader;
  clock?: () => number;
  sleep?: Sleep;
};

type ActiveRun = {
  controller: AbortController;
  promise: Promise<void>;
};

export class JpegFrameParser {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames: Uint8Array[] = [];

    while (this.#buffer.length > 0) {
      const start = this.#buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - 1));
        break;
      }

      const end = this.#buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.#buffer = this.#buffer.subarray(start);
        break;
      }

      frames.push(Uint8Array.from(this.#buffer.subarray(start, end + 2)));
      this.#buffer = this.#buffer.subarray(end + 2);
    }

    return frames;
  }
}

async function* readFfmpegFrames(
  request: ReplayReadRequest,
  ffmpegPath: string,
): AsyncIterable<Uint8Array> {
  const frameRate = `1000/${request.intervalMs}`;
  const child = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", request.videoPath,
    "-vf", `fps=${frameRate}`,
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });

  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", error => {
      reject(new Error(`Unable to start FFmpeg at ${ffmpegPath}: ${error.message}`, { cause: error }));
    });
    child.once("close", resolve);
  });

  const stopChild = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  request.signal.addEventListener("abort", stopChild, { once: true });

  const parser = new JpegFrameParser();
  try {
    for await (const chunk of child.stdout) {
      for (const frame of parser.push(chunk)) yield frame;
    }

    const exitCode = await completion;
    if (!request.signal.aborted && exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}: ${stderr.trim() || "no diagnostic output"}`);
    }
  } finally {
    request.signal.removeEventListener("abort", stopChild);
    stopChild();
    await completion.catch(() => undefined);
  }
}

export class ReplayFrameSource implements FrameSource {
  readonly #cameraId: string;
  readonly #videoPath: string;
  readonly #intervalMs: number;
  readonly #reader: ReplayFrameReader;
  readonly #clock: () => number;
  readonly #sleep: Sleep;
  #active?: ActiveRun;

  constructor(options: ReplayFrameSourceOptions) {
    if (!options.cameraId.trim()) throw new Error("Replay cameraId is required");
    if (!options.videoPath.trim()) throw new Error("Replay videoPath is required");

    const intervalMs = options.intervalMs ?? DEFAULT_SAMPLING_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Replay intervalMs must be a positive finite number");
    }

    this.#cameraId = options.cameraId;
    this.#videoPath = options.videoPath;
    this.#intervalMs = intervalMs;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#reader = options.reader ?? (request => readFfmpegFrames(
      request,
      options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
    ));
  }

  async start(onFrame: (frame: SampledFrame) => Promise<void>): Promise<void> {
    if (this.#active) throw new Error("Replay source is already running");

    const controller = new AbortController();
    const active: ActiveRun = { controller, promise: Promise.resolve() };
    active.promise = this.#consume(onFrame, controller.signal);
    this.#active = active;

    try {
      await active.promise;
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  async stop(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.controller.abort();
    await active.promise;
  }

  async #consume(
    onFrame: (frame: SampledFrame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let capturedAt = this.#clock();
    const frames = this.#reader({
      videoPath: this.#videoPath,
      intervalMs: this.#intervalMs,
      signal,
    });

    for await (const image of frames) {
      if (signal.aborted) break;
      const delay = Math.max(0, capturedAt - this.#clock());
      if (delay > 0) await this.#sleep(delay, signal);
      if (signal.aborted) break;

      await onFrame({ cameraId: this.#cameraId, capturedAt, image });
      capturedAt += this.#intervalMs;
    }
  }
}
