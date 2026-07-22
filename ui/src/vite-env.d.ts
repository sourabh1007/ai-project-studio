/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Absolute API base injected by the Electron preload in the desktop app. */
  __CW_API_BASE__?: string;
}
