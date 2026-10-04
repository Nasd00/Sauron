import { randomUUID } from "node:crypto";
import type { Watch } from "@tempmhacks/shared";
import { watchConfirmation, WATCH_NOT_FOUND_REPLY } from "./router.js";
import type { Geocoder, MessagingStore } from "./types.js";

/** Bad input from the caller; the server maps this to a 400. */
export class RegistrationError extends Error {}

export function normalizePhone(value: string): string {
  const phone = value.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new RegistrationError("phone must be an E.164 number such as +15551234567");
  }
  return phone;
}

export type SpectrumUserDirectory<U extends { id: string } = { id: string }> = {
  user(phone: string): Promise<U>;
  space: { create(user: U): Promise<{ id: string; send(text: string): Promise<unknown> }> };
};

/** Where to watch: a place name to geocode, or an exact point picked on the web globe. */
export type RegistrationInput = {
  phone: string;
  place?: string;
  point?: { latitude: number; longitude: number; label: string };
  /** Overrides the default watch radius, e.g. from the web app's radius slider. */
  radiusKm?: number;
};

const MIN_RADIUS_KM = 0.5;
const MAX_RADIUS_KM = 100;

/** Validate an /admin/users body. Throws RegistrationError for anything malformed. */
export function parseRegistration(body: unknown): RegistrationInput {
  if (!body || typeof body !== "object") throw new RegistrationError("body must be a JSON object");
  const { phone, place, latitude, longitude, label, radiusKm } = body as Record<string, unknown>;
  if (typeof phone !== "string") throw new RegistrationError("phone is required");
  const input: RegistrationInput = { phone };
  if (radiusKm !== undefined) {
    if (typeof radiusKm !== "number" || !Number.isFinite(radiusKm) || radiusKm < MIN_RADIUS_KM || radiusKm > MAX_RADIUS_KM) {
      throw new RegistrationError(`radiusKm must be between ${MIN_RADIUS_KM} and ${MAX_RADIUS_KM}`);
    }
    input.radiusKm = radiusKm;
  }
  if (latitude !== undefined || longitude !== undefined) {
    if (typeof latitude !== "number" || latitude < -90 || latitude > 90
      || typeof longitude !== "number" || longitude < -180 || longitude > 180) {
      throw new RegistrationError("latitude and longitude must be valid coordinates");
    }
    if (typeof label !== "string" || !label.trim() || label.length > 120) throw new RegistrationError("label is required with coordinates");
    input.point = { latitude, longitude, label: label.trim() };
    return input;
  }
  if (typeof place !== "string") throw new RegistrationError("place, or latitude/longitude/label, is required");
  input.place = place;
  return input;
}

export type RegisterOptions = {
  geocoder: Geocoder;
  store: Pick<MessagingStore, "replaceWatch">;
  radiusKm: number;
  now?: () => number;
  id?: () => string;
};

export async function registerPhotonUser<U extends { id: string }>(
  directory: SpectrumUserDirectory<U>,
  input: RegistrationInput,
  options: RegisterOptions,
): Promise<{ phone: string; spaceId: string; watch: Watch }> {
  const phone = normalizePhone(input.phone);
  let place = input.point;
  if (!place) {
    const query = input.place?.trim();
    if (!query) throw new RegistrationError("place is required");
    // Geocode before touching Spectrum so a bad place never opens a conversation.
    place = await options.geocoder.geocode(query) ?? undefined;
    if (!place) throw new RegistrationError(WATCH_NOT_FOUND_REPLY);
  }

  const user = await directory.user(phone);
  const space = await directory.space.create(user);
  // senderId must match the inbound sender ID so STATUS and STOP find this watch.
  const watch: Watch = {
    id: (options.id ?? randomUUID)(),
    spaceId: space.id,
    senderId: user.id,
    placeLabel: place.label,
    latitude: place.latitude,
    longitude: place.longitude,
    radiusKm: input.radiusKm ?? options.radiusKm,
    active: true,
    createdAt: (options.now ?? Date.now)(),
  };
  await options.store.replaceWatch(watch);
  await space.send(watchConfirmation(watch));
  return { phone, spaceId: space.id, watch };
}
