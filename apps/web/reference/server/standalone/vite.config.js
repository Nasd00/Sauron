import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { broadcastPagePlugin } from './broadcast-page.js';
import { standaloneVoiceTools } from './voiceTools.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load an optional dev TLS keypair from HTTPS_KEY_FILE / HTTPS_CERT_FILE. */
function loadDevHttps() {
  const keyFile = process.env.HTTPS_KEY_FILE;
  const certFile = process.env.HTTPS_CERT_FILE;
  if (!keyFile || !certFile) return undefined;
  try {
    return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
  } catch (error) {
    console.warn('[dev-https] failed to read cert/key:', error?.message || error);
    return undefined;
  }
}

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      broadcastPagePlugin(),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.IRIS_ALLOWED_HOSTS),
    https: loadDevHttps(),
    command,
  });
});
