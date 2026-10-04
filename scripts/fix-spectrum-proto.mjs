import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@photon-ai/proto-complete/dist/photon");
const targets = [
  resolve(root, "node_modules/@photon-ai/proto/dist/photon"),
  resolve(root, "node_modules/@spectrum-ts/core/node_modules/@photon-ai/proto/dist/photon"),
];

if (existsSync(source)) {
  for (const target of targets) {
    // Only patch real installs: creating a bare dist/ makes Node resolve a package with no exports map.
    if (!existsSync(resolve(target, "../../package.json"))) continue;
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }
}
