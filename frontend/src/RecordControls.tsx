import { useEffect, useState } from "react";
import { transcribeAudio } from "./api";
import { clearRecording, loadRecording, recordingInOtherTab, type StoredRecording } from "./recordingStore";
import { MAX_RECORDING_MS, useRecorder, WARN_AT_MS, type FinishedRecording } from "./useRecorder";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => `${pad(Math.floor(ms / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}`;
const timeOfDay = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
const minutes = (rec: StoredRecording) => Math.max(1, Math.round((rec.lastChunkAt - rec.startedAt) / 60_000));

const SAVE_FAILED =
  "The browser stopped saving the recording, so it ended early. The part that was saved has been transcribed.";

type Props = {
  onTranscript: (text: string) => void;
  onError: (message: string | null) => void;
  disabled: boolean;
};

// A recording that still needs transcribing: found after a reload ("recovered"),
// or kept after a failed upload ("failed").
type Pending = { rec: StoredRecording; source: "recovered" | "failed" };

export default function RecordControls({ onTranscript, onError, disabled }: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  // Record stays off until we know whether a recording is waiting to be transcribed.
  const [checked, setChecked] = useState(false);
  const [otherTab, setOtherTab] = useState(false);

  /** A recording another tab is still making must not be transcribed or discarded here. */
  async function liveElsewhere(): Promise<boolean> {
    if (!(await recordingInOtherTab().catch(() => false))) return false;
    setOtherTab(true);
    setPending(null);
    return true;
  }

  async function send(rec: StoredRecording, source: Pending["source"], warning?: string) {
    if (source === "recovered" && (await liveElsewhere())) return;
    setTranscribing(true);
    onError(null);
    try {
      const result = await transcribeAudio(rec.blob);
      onTranscript(result.transcript);
      setPending(null);
      if (warning) onError(warning);
      await clearRecording().catch(() => undefined);
    } catch (e) {
      // Keep the recording (it is still stored) so nothing is lost.
      setPending({ rec, source: source === "recovered" ? "recovered" : "failed" });
      onError(e instanceof Error ? e.message : "Transcription failed.");
    } finally {
      setTranscribing(false);
    }
  }

  function finished({ recording, saveFailed }: FinishedRecording) {
    if (!recording) {
      onError("Nothing was saved from this recording.");
      return;
    }
    void send(recording, "failed", saveFailed ? SAVE_FAILED : undefined);
  }

  const recorder = useRecorder(finished);
  const recording = recorder.status === "recording";

  useEffect(() => {
    (async () => {
      if (await recordingInOtherTab().catch(() => false)) {
        setOtherTab(true);
        return;
      }
      const rec = await loadRecording().catch(() => null);
      if (rec) setPending((p) => p ?? { rec, source: "recovered" });
    })().finally(() => setChecked(true));
  }, []);

  async function startRecording() {
    onError(null);
    try {
      await recorder.start();
      setOtherTab(false); // this tab holds the recording lock now
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not start recording.");
    }
  }

  async function discard() {
    if (pending?.source === "recovered" && (await liveElsewhere())) return;
    await clearRecording().catch(() => undefined);
    setPending(null);
    onError(null);
  }

  return (
    <div className="recorder">
      <div className="recorder-row">
        {recording ? (
          <>
            <button className="stop" onClick={recorder.stop}>
              <span className="stop-square" aria-hidden="true" />
              Stop
            </button>
            <span className="rec-live">
              <span className="rec-dot" aria-hidden="true" />
              {`Recording ${clock(recorder.elapsedMs)}`}
            </span>
          </>
        ) : (
          <button
            className="secondary"
            onClick={startRecording}
            // One stored recording at a time: transcribe or discard the saved one first.
            disabled={disabled || !checked || recorder.status === "finishing" || transcribing || pending !== null}
          >
            <span className="rec-dot idle" aria-hidden="true" />
            Record
          </button>
        )}
        {transcribing && <span className="rec-status">Transcribing… this can take a minute or two.</span>}
        {pending?.source === "failed" && !transcribing && (
          <>
            <button className="secondary" onClick={() => send(pending.rec, "failed")}>Retry</button>
            <button className="ghost" onClick={discard}>Discard</button>
          </>
        )}
      </div>

      {recording && recorder.elapsedMs >= WARN_AT_MS && (
        <p className="rec-warning">{`Recording stops automatically at ${MAX_RECORDING_MS / 60_000} minutes.`}</p>
      )}

      {otherTab && !recording && (
        <p className="rec-notice" role="status">A recording is in progress in another tab.</p>
      )}

      {pending?.source === "recovered" && !transcribing && (
        <div className="rec-notice" role="status">
          <span>{`You have an unsaved recording (${minutes(pending.rec)} min) from ${timeOfDay(pending.rec.startedAt)}.`}</span>
          <span className="rec-notice-actions">
            <button className="dark" onClick={() => send(pending.rec, "recovered")}>Transcribe</button>
            <button className="ghost" onClick={discard}>Discard</button>
          </span>
        </div>
      )}
    </div>
  );
}
