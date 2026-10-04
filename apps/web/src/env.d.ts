/// <reference types="vite/client" />

declare const CESIUM_BASE_URL: string;

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN?: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_SPACETIMEDB_URI?: string;
  readonly VITE_SPACETIMEDB_DATABASE?: string;
  /** Photon service base URL, used to enroll phones from the globe. */
  readonly VITE_PHOTON_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
