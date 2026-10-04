import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/generated/", import.meta.url));

async function files(directory) {
  const entries = await readdir(directory);
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry);
    return (await stat(path)).isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

for (const path of await files(root)) {
  if (extname(path) !== ".js") continue;
  const source = await readFile(path, "utf8");
  const fixed = source.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_match, before, specifier, after) => {
      if (extname(specifier)) return `${before}${specifier}${after}`;
      return `${before}${specifier}.js${after}`;
    },
  );
  if (fixed !== source) await writeFile(path, fixed);
}
