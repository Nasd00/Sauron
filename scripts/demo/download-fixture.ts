import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPLAY_FIXTURE_PATH } from "./cameras.js";

export const REPLAY_FIXTURE_URL =
  "https://usgs-ocapsv2-public-input-media.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/atoms/video/20020810-Highcastledetail_DAS.mp4";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const destination = resolve(repositoryRoot, REPLAY_FIXTURE_PATH);
const temporary = `${destination}.partial`;

async function existingFixture(): Promise<boolean> {
  try {
    return (await stat(destination)).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  if (!force && await existingFixture()) {
    console.log(`Fixture already exists: ${REPLAY_FIXTURE_PATH}`);
    return;
  }

  console.log("Downloading the public-domain USGS replay fixture...");
  const response = await fetch(REPLAY_FIXTURE_URL);
  if (!response.ok) throw new Error(`Fixture download failed: HTTP ${response.status}`);

  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  console.log(`Saved ${REPLAY_FIXTURE_PATH}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
