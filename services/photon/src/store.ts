import type { Db } from "@tempmhacks/shared/db";
import type { InboundReceipt, Watch } from "@tempmhacks/shared";
import type { InboundMessage, MessagingStore } from "./types.js";

function receiptOf(message: InboundMessage): InboundReceipt {
  const receivedAt = Date.parse(message.receivedAt);
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
    throw new Error(`Invalid inbound timestamp: ${message.receivedAt}`);
  }
  return {
    messageId: message.messageId,
    spaceId: message.spaceId,
    senderId: message.senderId,
    receivedAt,
    contentType: message.content.type,
  };
}

export function createMessagingStore(db: Db): MessagingStore {
  return {
    claimInbound: message => db.inbound.claim(receiptOf(message)),
    getActiveWatch: async senderId => db.watches.getActiveForSender(senderId),
    replaceWatch: watch => db.watches.create(watch),
    deactivateWatches: senderId => db.watches.stopForSender(senderId),
  };
}

export class MemoryMessagingStore implements MessagingStore {
  readonly messageIds = new Set<string>();
  readonly watches: Watch[] = [];

  async claimInbound(message: InboundMessage): Promise<boolean> {
    if (this.messageIds.has(message.messageId)) return false;
    this.messageIds.add(message.messageId);
    return true;
  }

  async getActiveWatch(senderId: string): Promise<Watch | undefined> {
    return this.watches.find(watch => watch.senderId === senderId && watch.active);
  }

  async replaceWatch(watch: Watch): Promise<void> {
    for (const existing of this.watches) {
      if (existing.senderId === watch.senderId) existing.active = false;
    }
    this.watches.push({ ...watch, active: true });
  }

  async deactivateWatches(senderId: string): Promise<void> {
    for (const watch of this.watches) if (watch.senderId === senderId) watch.active = false;
  }
}
