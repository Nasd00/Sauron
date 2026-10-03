import type { Content, Message, Space } from "spectrum-ts";
import type { InboundMessage } from "./types.js";

function normalizeContent(content: Content): InboundMessage["content"] {
  if (content.type === "text") return { type: "text", text: content.text };
  if (content.type === "attachment") {
    return {
      type: "attachment",
      name: content.name || undefined,
      mimeType: content.mimeType || undefined,
    };
  }
  return { type: "other" };
}

export function normalizeSpectrumMessage(space: Space, message: Message): InboundMessage | null {
  if (message.direction !== "inbound") return null;
  if (!message.sender?.id) throw new Error(`Inbound message ${message.id} has no sender ID`);
  return {
    messageId: message.id,
    spaceId: space.id,
    senderId: message.sender.id,
    receivedAt: message.timestamp.toISOString(),
    content: normalizeContent(message.content),
  };
}
