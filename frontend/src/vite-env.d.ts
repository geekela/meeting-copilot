interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Recorder chunk length in ms (default 10000). Tests shorten it. */
  readonly VITE_RECORDER_CHUNK_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
