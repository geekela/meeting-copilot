import { useCallback, useEffect, useRef, useState } from "react";
import { appendChunk, beginRecording, loadRecording, type StoredRecording } from "./recordingStore";

// Mistral accepts at most 60 minutes per transcription request.
export const MAX_RECORDING_MS = 60 * 60_000;
export const WARN_AT_MS = 50 * 60_000;
// How often a chunk is saved to IndexedDB: the most audio a crash can lose.
export const CHUNK_MS = Number(import.meta.env.VITE_RECORDER_CHUNK_MS ?? 10_000);
// Speech at 32 kbps: about 15 MB for an hour.
export const AUDIO_BITS_PER_SECOND = 32_000;

export type RecorderStatus = "idle" | "recording";

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
 * time limit) it waits for the last chunk to be saved, then calls `onFinished`
 * with the stored recording.
 */
export function useRecorder(onFinished: (rec: StoredRecording) => void) {
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
    let stream: MediaStream;
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
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const startedAt = Date.now();
    try {
      await beginRecording(startedAt, recorder.mimeType || "audio/webm");
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Could not save the recording in this browser.");
    }

    // Saves run one after another, in order.
    let saving = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) saving = saving.then(() => appendChunk(e.data, Date.now()));
    };
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) stop();
    }, 1000);
    recorder.onstop = async () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setStatus("idle");
      await saving.catch(() => undefined);
      const stored = await loadRecording().catch(() => null);
      if (stored) onFinishedRef.current(stored);
    };

    recorderRef.current = recorder;
    setElapsedMs(0);
    setStatus("recording");
    recorder.start(CHUNK_MS);
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
