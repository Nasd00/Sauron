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

export type RegisterOptions = {
  geocoder: Geocoder;
  store: Pick<MessagingStore, "replaceWatch">;
  radiusKm: number;
  now?: () => number;
  id?: () => string;
};

export async function registerPhotonUser<U extends { id: string }>(
  directory: SpectrumUserDirectory<U>,
  input: { phone: string; place: string },
  options: RegisterOptions,
): Promise<{ phone: string; spaceId: string; watch: Watch }> {
  const phone = normalizePhone(input.phone);
  const query = input.place.trim();
  if (!query) throw new RegistrationError("place is required");
  // Geocode before touching Spectrum so a bad place never opens a conversation.
  const place = await options.geocoder.geocode(query);
  if (!place) throw new RegistrationError(WATCH_NOT_FOUND_REPLY);

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
    radiusKm: options.radiusKm,
    active: true,
    createdAt: (options.now ?? Date.now)(),
  };
  await options.store.replaceWatch(watch);
  await space.send(watchConfirmation(watch));
  return { phone, spaceId: space.id, watch };
}
