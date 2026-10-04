import { createHash } from "node:crypto";
import type { InboundMessage, MessagingStore, StructuredLogger } from "./types.js";

export type MessageProcessorOptions = {
  store: MessagingStore;
  route(message: InboundMessage): Promise<string | undefined>;
  logger: StructuredLogger;
};

function senderHash(senderId: string): string {
  return createHash("sha256").update(senderId).digest("hex").slice(0, 12);
}

export function createMessageProcessor(options: MessageProcessorOptions) {
  return async (message: InboundMessage, reply: (text: string) => Promise<unknown>): Promise<void> => {
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
      if (response) await reply(response);
      options.logger.info({
        ...fields,
        deduped: false,
        processingResult: response ? "replied" : "unsupported_content",
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
