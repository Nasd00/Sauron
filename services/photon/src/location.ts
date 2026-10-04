/**
 * Pure parsing of a shared location. The supported share is an Apple Maps link
 * (blue dot → Share → Messages), which carries `coordinate=<lat>,<lng>`. A typed
 * `LOC <lat>,<lng>` or bare pair is a testing fallback, and a legacy iOS location
 * vCard is also understood. All branches are validated against WGS84 bounds.
 */

export type ParsedLocation = { latitude: number; longitude: number };

const COORD = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

function inBounds(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
  );
}

function pair(latText: string, lngText: string): ParsedLocation | undefined {
  const latitude = Number(latText);
  const longitude = Number(lngText);
  return inBounds(latitude, longitude) ? { latitude, longitude } : undefined;
}

/**
 * Attempts to parse a location from free text. Returns undefined when the text is
 * not a location share, so the caller can fall through to other routing.
 */
export function parseSharedLocation(input: string): ParsedLocation | undefined {
  const text = input.trim();
  if (!text) return undefined;

  // Explicit command: "LOC 42.28,-83.74" or "LOCATION 42.28 -83.74".
  const command = new RegExp(String.raw`^LOC(?:ATION)?\s+${COORD}\s*[, ]\s*${COORD}$`, "i").exec(text);
  if (command) return pair(command[1]!, command[2]!);

  // Apple/Google Maps URLs: ...?ll=42.28,-83.74, ...?coordinate=42.28,-83.74
  // (newer Apple Maps place links), or .../@42.28,-83.74,... Commas may be
  // URL-encoded (%2C), so decode them first.
  const decoded = text.replace(/%2C/gi, ",");
  const url = /[?&](?:ll|q|sll|center|coordinate)=(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/.exec(decoded)
    ?? /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(decoded);
  if (url) return pair(url[1]!, url[2]!);

  // Bare coordinate pair as the entire message: "42.28, -83.74".
  const bare = new RegExp(String.raw`^${COORD}\s*,\s*${COORD}$`).exec(text);
  if (bare) return pair(bare[1]!, bare[2]!);

  return undefined;
}

/**
 * Parses iMessage's native "Send My Current Location" attachment (CL.loc.vcf /
 * "Current Location.loc.vcf"). It is a vCard whose URL property points at
 * maps.apple.com with `ll=<lat>,<lng>`. vCard values may escape commas (`\,`) and
 * fold long lines (CRLF + whitespace), so both are normalized before parsing.
 */
export function parseLocationVcard(vcard: string): ParsedLocation | undefined {
  const unfolded = vcard.replace(/\r?\n[ \t]/g, "");
  const unescaped = unfolded.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\:/g, ":");
  const match = /[?&]ll=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(unescaped);
  return match ? pair(match[1]!, match[2]!) : undefined;
}

/** True when an attachment looks like a vCard (where native location shares live). */
export function isVcardAttachment(name?: string, mimeType?: string): boolean {
  return /\.vcf$/i.test(name ?? "") || /vcard/i.test(mimeType ?? "");
}

/**
 * Result of interpreting inbound text as a location share.
 * - `location`: coordinates were read. `isCurrentLocation` is true for an Apple Maps
 *   "My Location" (blue dot) share; `label` is a human-readable place name if any.
 * - `unreadable`: the text is clearly a map share, but it carries no coordinates we
 *   can read (e.g. a Google Maps or Apple Maps short link).
 */
export type LocationShare =
  | { kind: "location"; location: ParsedLocation; isCurrentLocation: boolean; label?: string }
  | { kind: "unreadable"; reason: "short_link" | "no_coordinates" };

const MAP_LINK = /https?:\/\/(?:maps\.apple\.com|maps\.apple|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\S*/i;
const SHORT_LINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.apple\/p)\//i;

function queryParam(url: string, key: string): string | undefined {
  try {
    const value = new URL(url).searchParams.get(key);
    return value?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Shortens a full street address to its first part ("123 Main St"). */
function shortAddress(address: string): string {
  return address.split(",")[0]!.trim();
}

/** Classifies text as a readable location share, an unreadable map share, or neither. */
export function classifyLocationShare(input: string): LocationShare | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const location = parseSharedLocation(text);
  const link = MAP_LINK.exec(text)?.[0];

  if (location) {
    if (!link) return { kind: "location", location, isCurrentLocation: false };
    const name = queryParam(link, "name");
    const address = queryParam(link, "address");
    const isCurrentLocation = name?.toLowerCase() === "my location";
    const label = isCurrentLocation
      ? (address ? shortAddress(address) : undefined)
      : (name ?? (address ? shortAddress(address) : undefined));
    return { kind: "location", location, isCurrentLocation, label };
  }

  if (link) {
    return { kind: "unreadable", reason: SHORT_LINK.test(link) ? "short_link" : "no_coordinates" };
  }
  return undefined;
}
