import type { Content, Message, Space } from "spectrum-ts";
import { isVcardAttachment, parseLocationVcard } from "./location.js";
import type { InboundMessage, NativeShareKind } from "./types.js";

const MAX_VCARD_BYTES = 64 * 1024;

/** Reads the iMessage balloon bundle id from a Spectrum custom payload, if present. */
function balloonBundleId(content: Content): string | undefined {
  if (content.type !== "custom") return undefined;
  const raw = content.raw as { raw?: { content?: { balloonBundleId?: unknown } } } | undefined;
  const id = raw?.raw?.content?.balloonBundleId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Classifies a native iMessage share balloon. Find My live sharing and Maps
 * app-extension pins arrive as balloons whose location stays inside the extension,
 * so they never carry coordinates we can read.
 */
export function nativeShareKind(bundleId: string | undefined): NativeShareKind | undefined {
  if (!bundleId) return undefined;
  if (/findmy/i.test(bundleId)) return "find_my";
  if (/maps/i.test(bundleId)) return "maps_balloon";
  return undefined;
}

async function normalizeContent(content: Content): Promise<InboundMessage["content"]> {
  if (content.type === "text") return { type: "text", text: content.text };
  if (content.type === "attachment") {
    const name = content.name || undefined;
    const mimeType = content.mimeType || undefined;
    // Older iOS "Send My Current Location" arrives as a vCard (CL.loc.vcf) whose
    // URL carries maps.apple.com/?ll=<lat>,<lng>. Read it and surface a location.
    if (isVcardAttachment(name, mimeType) && (content.size === undefined || content.size <= MAX_VCARD_BYTES)) {
      try {
        const bytes = await content.read();
        const location = parseLocationVcard(bytes.subarray(0, MAX_VCARD_BYTES).toString("utf8"));
        if (location) return { type: "location", ...location };
      } catch {
        // Unreadable attachment: fall through to a plain attachment.
      }
    }
    return { type: "attachment", name, mimeType };
  }
  return { type: "other", shareKind: nativeShareKind(balloonBundleId(content)) };
}

export async function normalizeSpectrumMessage(space: Space, message: Message): Promise<InboundMessage | null> {
  if (message.direction !== "inbound") return null;
  if (!message.sender?.id) throw new Error(`Inbound message ${message.id} has no sender ID`);
  const content = await normalizeContent(message.content);
  if (content.type !== "text") {
    // PII-free: logs only the content kind and native share type, never text or coordinates.
    console.info(JSON.stringify({
      level: "info", message: "inbound_nontext", messageId: message.id, kind: content.type,
      shareKind: content.type === "other" ? content.shareKind : undefined,
      balloonBundleId: balloonBundleId(message.content),
    }));
  }
  return {
    messageId: message.id,
    spaceId: space.id,
    senderId: message.sender.id,
    receivedAt: message.timestamp.toISOString(),
    content,
  };
}
