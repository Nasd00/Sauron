import { Type, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import type { Observation } from "@tempmhacks/shared";

export const DEFAULT_DETECTOR_MODEL = "gemini-flash-latest";

export type Detection = {
  /** 0..1: how likely the frame shows smoke from a fire or open flames. */
  confidence: number;
  /** Normalized 0..1 fractions of the frame, when the model localized the smoke. */
  bbox?: Observation["bbox"];
  description: string;
};

export interface Detector {
  detect(image: Uint8Array): Promise<Detection>;
}

export type GeminiDetectorOptions = {
  generate: (params: GenerateContentParameters) => Promise<GenerateContentResponse>;
  model?: string;
};

const PROMPT = `You are a wildfire and structure-fire spotter reviewing one frame from a fixed outdoor camera.
Decide whether the frame shows smoke produced by something burning (vegetation, buildings, vehicles,
vegetation ignited by lava) or visible open flames.
Do not count clouds, fog, mist, rain, dust, haze, glare, lens dirt, vehicle exhaust, chimney steam,
or white steam plumes from volcanic vents or cooling towers with no fire beneath them.
Give confidence as a probability from 0 to 1. When you see smoke or flames, give box_2d around the
main plume as [ymin, xmin, ymax, xmax] on a 0-1000 scale. Keep description under 20 words.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    smoke_or_fire: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
    description: { type: Type.STRING },
  },
  required: ["smoke_or_fire", "confidence", "description"],
};

export function parseDetection(text: string | undefined): Detection {
  if (!text?.trim()) throw new Error("Detector returned an empty response");
  const raw = JSON.parse(text) as {
    smoke_or_fire?: unknown; confidence?: unknown; box_2d?: unknown; description?: unknown;
  };
  const reported = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : 0;
  // A "no smoke" verdict caps confidence, whatever number came with it.
  const confidence = raw.smoke_or_fire === true ? clamp(reported) : Math.min(clamp(reported), 0.2);
  return {
    confidence,
    bbox: raw.smoke_or_fire === true ? toBbox(raw.box_2d) : undefined,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toBbox(box: unknown): Observation["bbox"] {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(v => typeof v === "number" && Number.isFinite(v))) {
    return undefined;
  }
  const [ymin, xmin, ymax, xmax] = (box as number[]).map(v => clamp(v / 1000));
  if (xmax <= xmin || ymax <= ymin) return undefined;
  return { x: xmin, y: ymin, width: xmax - xmin, height: ymax - ymin };
}

export function createGeminiDetector(options: GeminiDetectorOptions): Detector {
  return {
    async detect(image) {
      const response = await options.generate({
        model: options.model ?? DEFAULT_DETECTOR_MODEL,
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: Buffer.from(image).toString("base64") } },
            { text: PROMPT },
          ],
        }],
        config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
      });
      return parseDetection(response.text);
    },
  };
}
