import { randomUUID } from "node:crypto";
import type { Watch } from "@tempmhacks/shared";
import type { Geocoder, InboundMessage, MessagingStore } from "./types.js";

export const HELP_REPLY = [
  "WATCH <place> — subscribe to verified incidents near a place",
  "STATUS — show your current watch",
  "STOP — disable alerts",
  "HELP — show commands",
].join("\n");

export const UNKNOWN_REPLY = "I can currently WATCH a place, show STATUS, or STOP alerts.";
export const WATCH_FORMAT_REPLY = "Send WATCH <place>, for example: WATCH Ann Arbor.";
export const WATCH_NOT_FOUND_REPLY = "I couldn’t find that place. Try a more specific city, address, or postal code.";

export type CommandRouterOptions = {
  store: MessagingStore;
  geocoder: Geocoder;
  radiusKm: number;
  now?: () => number;
  id?: () => string;
};

export function createCommandRouter(options: CommandRouterOptions) {
  if (!Number.isFinite(options.radiusKm) || options.radiusKm <= 0) {
    throw new Error("WATCH_RADIUS_KM must be greater than zero");
  }
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;

  return async (message: InboundMessage): Promise<string | undefined> => {
    if (message.content.type !== "text") return undefined;
    const input = message.content.text.trim();

    // Safety/control commands intentionally remain ahead of WATCH and fallback.
    if (/^STOP$/i.test(input)) {
      await options.store.deactivateWatches(message.senderId);
      return "Alerts stopped. Send WATCH <place> to subscribe again.";
    }
    if (/^STATUS$/i.test(input)) {
      const watch = await options.store.getActiveWatch(message.senderId);
      return watch
        ? `Watching ${watch.placeLabel} within ${watch.radiusKm} km.`
        : "No active watch. Send WATCH <place> to subscribe.";
    }
    if (/^HELP$/i.test(input)) return HELP_REPLY;

    const watchMatch = /^WATCH(?:\s+(.*))?$/i.exec(input);
    if (watchMatch) {
      const query = watchMatch[1]?.trim();
      if (!query) return WATCH_FORMAT_REPLY;
      const place = await options.geocoder.geocode(query);
      if (!place) return WATCH_NOT_FOUND_REPLY;
      const watch: Watch = {
        id: id(),
        spaceId: message.spaceId,
        senderId: message.senderId,
        placeLabel: place.label,
        latitude: place.latitude,
        longitude: place.longitude,
        radiusKm: options.radiusKm,
        active: true,
        createdAt: now(),
      };
      await options.store.replaceWatch(watch);
      return `Watching ${watch.placeLabel} within ${watch.radiusKm} km. I’ll message you if a verified incident affects this area. Reply STATUS, STOP, or HELP anytime.`;
    }

    return UNKNOWN_REPLY;
  };
}
