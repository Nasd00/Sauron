import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, mergeConfig } from "vite";
// Preserve upstream templates, Cesium assets and provider middleware.
// @ts-expect-error The pinned upstream configuration is JavaScript.
import referenceConfig from "./reference/server/standalone/vite.config.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const referenceRoot = fileURLToPath(new URL("./reference/", import.meta.url));

export default defineConfig(async context => {
  const env = loadEnv(context.mode, projectRoot, "");
  for (const [key, value] of Object.entries(env)) process.env[key] ??= value;
  process.env.CESIUM_ION_TOKEN ??= env.VITE_CESIUM_ION_TOKEN;
  process.env.GOOGLE_MAPS_API_KEY ??= env.VITE_GOOGLE_MAPS_API_KEY;
  for (const key of ["GOOGLE_MAPS_API_KEY", "CESIUM_ION_TOKEN"]) {
    if (["undefined", "null"].includes(process.env[key] ?? "")) delete process.env[key];
  }
  const upstream = typeof referenceConfig === "function"
    ? await referenceConfig(context) : referenceConfig;
  const dbOrigin = new URL(env.VITE_SPACETIMEDB_URI || "http://127.0.0.1:3000").origin;
  const photonOrigin = env.VITE_PHOTON_URL ? new URL(env.VITE_PHOTON_URL).origin : "";
  const upstreamCsp = upstream.server?.headers?.["Content-Security-Policy"] as string;
  const headers = { ...upstream.server?.headers,
    "Content-Security-Policy": upstreamCsp.replace("connect-src 'self'", `connect-src 'self' ${dbOrigin} ${photonOrigin}`.trimEnd()),
  };
  const config = mergeConfig(upstream, {
    root: referenceRoot,
    define: {
      "import.meta.env.GOOGLE_MAPS_API_KEY": JSON.stringify(process.env.GOOGLE_MAPS_API_KEY || ""),
      "import.meta.env.CESIUM_ION_TOKEN": JSON.stringify(process.env.CESIUM_ION_TOKEN || ""),
    },
    envDir: projectRoot,
    build: { outDir: "../dist", emptyOutDir: true },
    server: { fs: { allow: [projectRoot] }, headers },
    preview: { headers },
  });
  config.define = { ...config.define,
    "import.meta.env.GOOGLE_MAPS_API_KEY": JSON.stringify(process.env.GOOGLE_MAPS_API_KEY || ""),
    "import.meta.env.CESIUM_ION_TOKEN": JSON.stringify(process.env.CESIUM_ION_TOKEN || ""),
  };
  return config;
});
