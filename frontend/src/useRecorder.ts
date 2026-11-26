import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendChunk,
  beginRecording,
  holdRecordingLock,
  loadRecording,
  type StoredRecording,
} from "./recordingStore";

// Mistral accepts at most 60 minutes per transcription request; stop a minute
// early so the encoder's tail and timer jitter never push a file over the limit.
export const MAX_RECORDING_MS = 59 * 60_000;
export const WARN_AT_MS = 50 * 60_000;
// How often a chunk is saved to IndexedDB: the most audio a crash can lose.
export const CHUNK_MS = Number(import.meta.env.VITE_RECORDER_CHUNK_MS ?? 10_000);
// Speech at 32 kbps: about 15 MB for an hour.
export const AUDIO_BITS_PER_SECOND = 32_000;

// "finishing": stopped, waiting for the last chunk to be saved and read back.
export type RecorderStatus = "idle" | "recording" | "finishing";

/** What the recorder hands over when it stops. `recording` is null if nothing was saved. */
export type FinishedRecording = { recording: StoredRecording | null; saveFailed: boolean };

function micError(e: unknown): Error {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("Microphone access was blocked. Allow it in the browser's address bar and try again.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("No microphone was found.");
  return new Error("Could not start the microphone.");
}

/**
 * Records the microphone, saving each chunk as it arrives. On stop (or at the
 * time limit) it waits for the last chunk to be saved, then calls `onFinished`.
 */
export function useRecorder(onFinished: (result: FinishedRecording) => void) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  });

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = useCallback(async () => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser can't record audio. Use a recent version of Chrome.");
    }
    // Only one tab may record: a second one would overwrite the stored recording.
    const releaseLock = await holdRecordingLock();
    if (!releaseLock) throw new Error("A recording is already running in another tab.");

    let stream: MediaStream | null = null;
    let recorder: MediaRecorder;
    let startedAt: number;
    try {
      try {
        // Off on purpose: echo cancellation removes sound from the speakers, which is
        // where everyone else in the meeting is heard.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        throw micError(e);
      }
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined;
      try {
        recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
      } catch {
        throw new Error("Could not start recording.");
      }
      startedAt = Date.now();
      try {
        await beginRecording(startedAt, recorder.mimeType || "audio/webm");
      } catch {
        throw new Error("Could not save the recording in this browser.");
      }
      recorderRef.current = recorder;
      try {
        recorder.start(CHUNK_MS);
      } catch {
        recorderRef.current = null;
        throw new Error("Could not start recording.");
      }
    } catch (e) {
      // Nothing is recording: release the mic and the lock.
      stream?.getTracks().forEach((t) => t.stop());
      releaseLock();
      throw e;
    }
    const tracks = stream.getTracks();

    // Saves run one after another, in order. If one fails, stop rather than keep
    // recording audio that can't be saved; what was saved is still transcribed.
    let saving = Promise.resolve();
    let saveFailed = false;
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0 || saveFailed) return;
      saving = saving
        .then(() => appendChunk(e.data, Date.now()))
        .catch(() => {
          if (!saveFailed) {
            saveFailed = true;
            stop();
          }
        });
    };
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) stop();
    }, 1000);
    recorder.onstop = async () => {
      clearInterval(timer);
      tracks.forEach((t) => t.stop());
      recorderRef.current = null;
      setStatus("finishing");
      await saving;
      const recording = await loadRecording().catch(() => null);
      releaseLock();
      setStatus("idle");
      onFinishedRef.current({ recording, saveFailed });
    };

    setElapsedMs(0);
    setStatus("recording");
  }, [stop]);

  // Ask before leaving the page mid-recording. Stop the mic if the component goes away.
  useEffect(() => {
    if (status !== "recording") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);
  useEffect(() => stop, [stop]);

  return { status, elapsedMs, start, stop };
}
