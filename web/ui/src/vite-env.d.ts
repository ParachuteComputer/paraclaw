/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly VITE_PARACHUTE_AGENT_WEB_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
