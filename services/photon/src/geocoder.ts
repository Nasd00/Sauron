import type { Geocoder, GeocodeResult } from "./types.js";

type NominatimResult = { display_name?: unknown; lat?: unknown; lon?: unknown };

export type NominatimOptions = {
  baseUrl?: string;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

/** Small, cached geocoder for end-user-triggered MVP queries. */
export class NominatimGeocoder implements Geocoder {
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #cache = new Map<string, GeocodeResult | null>();
  #lastRequestAt = -Infinity;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: NominatimOptions) {
    if (!options.userAgent.trim()) throw new Error("GEOCODER_USER_AGENT is required");
    this.#baseUrl = options.baseUrl ?? "https://nominatim.openstreetmap.org/search";
    this.#userAgent = options.userAgent;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  }

  async geocode(query: string): Promise<GeocodeResult | null> {
    const key = query.trim().toLocaleLowerCase();
    if (!key) return null;
    if (this.#cache.has(key)) return this.#cache.get(key) ?? null;

    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, 1000 - (this.#now() - this.#lastRequestAt));
      if (delay) await this.#wait(delay);
      const url = new URL(this.#baseUrl);
      url.searchParams.set("q", query.trim());
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      const response = await this.#fetch(url, {
        headers: { "accept": "application/json", "user-agent": this.#userAgent },
        signal: AbortSignal.timeout(5000),
      });
      this.#lastRequestAt = this.#now();
      if (!response.ok) throw new Error(`Geocoder returned HTTP ${response.status}`);
      const values = await response.json() as NominatimResult[];
      const first = values[0];
      const latitude = Number(first?.lat);
      const longitude = Number(first?.lon);
      const result = first && typeof first.display_name === "string"
        && Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { label: first.display_name, latitude, longitude }
        : null;
      this.#cache.set(key, result);
      return result;
    } finally {
      release();
    }
  }
}
