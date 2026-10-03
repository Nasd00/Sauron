export type SampledFrame = {
  cameraId: string;
  capturedAt: number;
  image: Buffer | Uint8Array;
};

export interface FrameSource {
  start(onFrame: (frame: SampledFrame) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
