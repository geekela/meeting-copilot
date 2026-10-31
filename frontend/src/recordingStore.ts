// Crash-safe storage for the one in-progress (or not yet transcribed) recording.
// Chunks are written to IndexedDB as they arrive, so a crash or reload loses at
// most one chunk. The connection is opened per operation and closed right after,
// so nothing holds the database open between saves.

const DB_NAME = "meeting-copilot";
const META = "meta";
const CHUNKS = "chunks";
const META_KEY = "current";

export type StoredRecording = {
  startedAt: number;
  lastChunkAt: number;
  mimeType: string;
  blob: Blob;
};

type Meta = Omit<StoredRecording, "blob">;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META);
      req.result.createObjectStore(CHUNKS, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs `work` in one read-write transaction and resolves when it commits. */
async function write(work: (meta: IDBObjectStore, chunks: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META, CHUNKS], "readwrite");
      work(tx.objectStore(META), tx.objectStore(CHUNKS));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function requestValue<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Starts a new stored recording, replacing any previous one. */
export function beginRecording(startedAt: number, mimeType: string): Promise<void> {
  return write((meta, chunks) => {
    chunks.clear();
    meta.put({ startedAt, lastChunkAt: startedAt, mimeType } satisfies Meta, META_KEY);
  });
}

export async function appendChunk(chunk: Blob, at: number): Promise<void> {
  // Read the meta in the same transaction so lastChunkAt is updated atomically with the chunk.
  await write((meta, chunks) => {
    chunks.add(chunk);
    const get = meta.get(META_KEY);
    get.onsuccess = () => {
      if (get.result) meta.put({ ...(get.result as Meta), lastChunkAt: at }, META_KEY);
    };
  });
}

/** The stored recording with its chunks stitched in order, or null if there is none. */
export async function loadRecording(): Promise<StoredRecording | null> {
  const db = await openDb();
  try {
    const tx = db.transaction([META, CHUNKS], "readonly");
    const [meta, chunks] = await Promise.all([
      requestValue(tx.objectStore(META).get(META_KEY)) as Promise<Meta | undefined>,
      requestValue(tx.objectStore(CHUNKS).getAll()) as Promise<Blob[]>,
    ]);
    if (!meta) return null;
    // Drop codec parameters ("audio/webm;codecs=opus" -> "audio/webm") for the upload.
    const blob = new Blob(chunks, { type: meta.mimeType.split(";")[0] });
    return blob.size > 0 ? { ...meta, blob } : null;
  } finally {
    db.close();
  }
}

export function clearRecording(): Promise<void> {
  return write((meta, chunks) => {
    meta.clear();
    chunks.clear();
  });
}

// --- One recording at a time, across tabs ------------------------------------
// The tab that records holds a Web Lock for as long as it records. The browser
// releases it when that tab stops, closes, reloads or crashes.

const LOCK = "meeting-copilot-recording";

/** Takes the recording lock if no other tab holds it. Returns its release function, or null. */
export function holdRecordingLock(): Promise<(() => void) | null> {
  if (!navigator.locks) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    void navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      // Held until the returned function is called.
      return new Promise<void>((release) => resolve(() => release()));
    });
  });
}

/** True while another tab is recording (so its stored recording is live, not left over). */
export async function recordingInOtherTab(): Promise<boolean> {
  if (!navigator.locks) return false;
  const { held = [] } = await navigator.locks.query();
  return held.some((l) => l.name === LOCK);
}
