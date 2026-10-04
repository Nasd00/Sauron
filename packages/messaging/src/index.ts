import { attachment, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

/** The Spectrum app instance returned by `await Spectrum(...)`. */
export type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

/**
 * Provider-neutral outbound messaging surface. Today this is iMessage-only, but
 * both the Photon conversation plane and the alerts delivery plane send through
 * this single abstraction so they share one set of Spectrum conventions. When a
 * second provider is added, only the implementation here changes.
 */
export interface OutboundMessenger {
  /** Send plain text into a conversation identified by its Spectrum space id. */
  sendText(spaceId: string, text: string): Promise<string | undefined>;
  /**
   * Send a file (path, URL, or Buffer) into a conversation. Provide name and
   * mimeType when sending raw bytes so the MIME type can be resolved.
   */
  sendAttachment(spaceId: string, input: AttachmentInput, options?: AttachmentOptions): Promise<string | undefined>;
}

export type AttachmentInput = string | Buffer | URL;
export type AttachmentOptions = { name?: string; mimeType?: string; id?: string };

/**
 * iMessage-backed messenger. Resolves the target space by id, then sends.
 * Returns the provider message id on success, or undefined when the provider
 * does not report one.
 */
export function createImessageMessenger(app: SpectrumApp): OutboundMessenger {
  const im = imessage(app);
  return {
    async sendText(spaceId, text) {
      const space = await im.space.get(spaceId);
      const message = await space.send(text);
      return message?.id;
    },
    async sendAttachment(spaceId, input, options) {
      const space = await im.space.get(spaceId);
      const message = await space.send(attachment(input, options));
      return message?.id;
    },
  };
}
