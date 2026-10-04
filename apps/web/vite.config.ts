import { fileURLToPath, URL } from "node:url";
import { defineConfig, normalizePath } from "vite";

const cesiumBuild = normalizePath(
  fileURLToPath(new URL("../../node_modules/cesium/Build/Cesium", import.meta.url)),
);
// The evacuation agent (services/evac) serves the API and SSE stream on loopback.
const evacApi = process.env.EVAC_API_URL ?? `http://127.0.0.1:${process.env.EVAC_PORT ?? 8787}`;

export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify("/"),
  },
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  publicDir: cesiumBuild,
  build: {
    // Two pages: the incident globe (index.html) and the evacuation-assist dashboard (evac.html).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        evac: fileURLToPath(new URL("./evac.html", import.meta.url)),
      },
    },
  },
  server: {
    proxy: { "/api": { target: evacApi, changeOrigin: false } },
  },
  preview: {
    proxy: { "/api": { target: evacApi, changeOrigin: false } },
  },
});
