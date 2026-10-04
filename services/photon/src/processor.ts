import { createHash } from "node:crypto";
import { splitMessage } from "@tempmhacks/shared/text";
import type { InboundMessage, MessagingStore, StructuredLogger } from "./types.js";
import type { RouterReply } from "./router.js";

export type Reply = (text: string) => Promise<unknown>;
export type SendEvidence = (url: string, caption: string) => Promise<unknown>;

export type MessageProcessorOptions = {
  store: MessagingStore;
  route(message: InboundMessage): Promise<RouterReply | undefined>;
  logger: StructuredLogger;
};

function senderHash(senderId: string): string {
  return createHash("sha256").update(senderId).digest("hex").slice(0, 12);
}

export function createMessageProcessor(options: MessageProcessorOptions) {
  return async (
    message: InboundMessage,
    reply: Reply,
    sendEvidence?: SendEvidence,
  ): Promise<void> => {
    const fields = {
      messageId: message.messageId,
      spaceId: message.spaceId,
      senderHash: senderHash(message.senderId),
      contentType: message.content.type,
    };
    const claimed = await options.store.claimInbound(message);
    if (!claimed) {
      options.logger.info({ ...fields, deduped: true, processingResult: "skipped" }, "inbound_message");
      return;
    }
    try {
      const response = await options.route(message);
      if (response) {
        // Long replies go out as a few shorter iMessages, in order.
        for (const chunk of splitMessage(response.text)) await reply(chunk);
        if (response.sendEvidence && response.evidenceUrl && sendEvidence) {
          await sendEvidence(response.evidenceUrl, "Latest camera view");
        }
      }
      options.logger.info({
        ...fields,
        deduped: false,
        processingResult: response ? "replied" : "unsupported_content",
        sentEvidence: Boolean(response?.sendEvidence && response.evidenceUrl),
      }, "inbound_message");
    } catch (error) {
      options.logger.error({
        ...fields,
        deduped: false,
        processingResult: "failed",
        error: error instanceof Error ? error.message : String(error),
      }, "inbound_message");
      throw error;
    }
  };
}
