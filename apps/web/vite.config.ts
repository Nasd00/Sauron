import { fileURLToPath, URL } from "node:url";
import { defineConfig, normalizePath } from "vite";

const cesiumBuild = normalizePath(
  fileURLToPath(new URL("../../node_modules/cesium/Build/Cesium", import.meta.url)),
);

export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify("/"),
  },
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  publicDir: cesiumBuild,
});
