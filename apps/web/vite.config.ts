import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, mergeConfig } from "vite";
// Preserve upstream templates, Cesium assets and provider middleware.
// @ts-expect-error The pinned upstream configuration is JavaScript.
import referenceConfig from "./reference/server/standalone/vite.config.js";
// @ts-expect-error The pinned upstream middleware is JavaScript.
import { apiNotFoundPlugin } from "./reference/server/standalone/api-not-found.js";

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
  // The backend and browser intentionally share the same public database. The
  // repository's server-side names are safe to expose here (URI + database
  // name contain no credential), while a VITE_* override still wins.
  const spacetimeUri = env.VITE_SPACETIMEDB_URI || env.SPACETIMEDB_URI || "http://127.0.0.1:3000";
  const spacetimeDatabase = env.VITE_SPACETIMEDB_DATABASE || env.SPACETIMEDB_DATABASE || "tempmhacks-local";
  const photonUrl = env.VITE_PHOTON_URL || env.MOBILE_PAIRING_BASE_URL || "";
  const dbOrigin = new URL(spacetimeUri).origin;
  const photonOrigin = photonUrl ? new URL(photonUrl).origin : "";
  // One HTTPS tunnel serves Iris and Photon on the phone. Keep the proxy's
  // upstream local so requests never loop back through the public tunnel.
  const photonTarget = `http://127.0.0.1:${process.env.PHOTON_PORT || "3001"}`;
  const tunnelHost = process.env.NGROK_HOST || "starfish-revolving-footman.ngrok-free.dev";
  process.env.IRIS_TRUSTED_PROXY_ORIGIN = "https://" + tunnelHost;
  const allowedHosts = [...new Set([...(upstream.server?.allowedHosts as string[] || []), tunnelHost])];
  const proxy = Object.fromEntries([
    "^/health(?:\\?|$)",
    "^/spectrum/webhook(?:\\?|$)",
    "^/admin/(?:users(?:\\?|$)|incidents(?:/(?:resolve|confirm|dismiss))?(?:\\?|$)|mobile/)",
    "/api/mobile/",
    "/pair/",
    "/.well-known/apple-app-site-association",
  ].map(path => [path, { target: photonTarget, changeOrigin: true }]));
  const upstreamCsp = upstream.server?.headers?.["Content-Security-Policy"] as string;
  const headers = { ...upstream.server?.headers,
    "Content-Security-Policy": upstreamCsp.replace("connect-src 'self'", `connect-src 'self' ${dbOrigin} ${photonOrigin}`.trimEnd()),
  };
  const config = mergeConfig(upstream, {
    root: referenceRoot,
    define: {
      "import.meta.env.GOOGLE_MAPS_API_KEY": JSON.stringify(process.env.GOOGLE_MAPS_API_KEY || ""),
      "import.meta.env.CESIUM_ION_TOKEN": JSON.stringify(process.env.CESIUM_ION_TOKEN || ""),
      "import.meta.env.VITE_SPACETIMEDB_URI": JSON.stringify(spacetimeUri),
      "import.meta.env.VITE_SPACETIMEDB_DATABASE": JSON.stringify(spacetimeDatabase),
      "import.meta.env.VITE_PHOTON_URL": JSON.stringify(photonUrl),
    },
    envDir: projectRoot,
    build: { outDir: "../dist", emptyOutDir: true },
    server: { host: "0.0.0.0", strictPort: true, allowedHosts, proxy, fs: { allow: [projectRoot] }, headers },
    preview: { host: "0.0.0.0", strictPort: true, allowedHosts, proxy, headers },
  });
  // Provider middleware runs before Vite's proxy. Let only the reserved mobile
  // routes through the upstream API catch-all; all other unknown APIs stay 404.
  config.plugins = config.plugins?.map(plugin =>
    plugin && "name" in plugin && plugin.name === "api-not-found"
      ? apiNotFoundPlugin({ passthroughPaths: ["/mobile/"] }) : plugin);
  config.define = { ...config.define,
    "import.meta.env.GOOGLE_MAPS_API_KEY": JSON.stringify(process.env.GOOGLE_MAPS_API_KEY || ""),
    "import.meta.env.CESIUM_ION_TOKEN": JSON.stringify(process.env.CESIUM_ION_TOKEN || ""),
    "import.meta.env.VITE_SPACETIMEDB_URI": JSON.stringify(spacetimeUri),
    "import.meta.env.VITE_SPACETIMEDB_DATABASE": JSON.stringify(spacetimeDatabase),
    "import.meta.env.VITE_PHOTON_URL": JSON.stringify(photonUrl),
  };
  return config;
});
