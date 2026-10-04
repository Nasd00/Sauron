import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Diagnostic only. Confirms the Spectrum credentials can open a DM and send one
// iMessage. This is not part of the running services; it is a one-shot check.
for (const path of [".env", fileURLToPath(new URL("../../../.env", import.meta.url))]) {
  try { loadEnvFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function requiredEither(primary: string, legacy: string): string {
  const value = process.env[primary]?.trim() || process.env[legacy]?.trim();
  if (!value) throw new Error(`${primary} is required (${legacy} is also accepted)`);
  return value;
}

const phone = process.argv[2]?.trim() || process.env.TEAM_PHONE?.trim();
if (!phone) {
  throw new Error("Provide a phone number as the first argument or set TEAM_PHONE in .env (E.164, e.g. +15551234567)");
}
if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
  throw new Error(`Phone must be E.164 format like +15551234567, received: ${phone}`);
}

const text = process.argv[3]?.trim() || "Hello from tempMhacks \u{1F44B} \u2014 Photon send-test diagnostic.";

const app = await Spectrum({
  projectId: requiredEither("SPECTRUM_PROJECT_ID", "PHOTON_PROJECT_ID"),
  projectSecret: requiredEither("SPECTRUM_PROJECT_SECRET", "PHOTON_SECRET"),
  providers: [imessage.config()],
});

try {
  const im = imessage(app);
  const user = await im.user(phone);
  const dm = await im.space.create(user);
  const sent = await dm.send(text);
  console.info(JSON.stringify({
    level: "info",
    message: "send_test_sent",
    phone,
    spaceId: dm.id,
    providerMessageId: sent?.id ?? null,
  }));
} finally {
  await app.stop();
}
