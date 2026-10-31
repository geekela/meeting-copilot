# Record & Transcribe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Record button in the notes panel that captures the mic, survives tab crashes, and on Stop sends the audio to Mistral Voxtral Small Transcribe, putting a speaker-labelled transcript into the notes box.

**Architecture:** Backend gets a `Transcriber` boundary mirroring `Analyzer` (`mistral` default | `mock`, chosen by `TRANSCRIBER`), exposed as `POST /api/transcribe` (multipart). Frontend records with `MediaRecorder`, writes each chunk to IndexedDB as it arrives, and uploads the stitched blob on Stop or from a recovery notice after a reload.

**Tech Stack:** FastAPI + httpx (already installed) + python-multipart; React 19 + TypeScript; IndexedDB (no library); Playwright with Chrome's fake media device.

**Spec:** `docs/superpowers/specs/2026-10-31-record-and-transcribe-design.md`

## Global Constraints

- Model: `voxtral-small-transcribe-3-0`, overridable by `MISTRAL_TRANSCRIBE_MODEL`. Key: `MISTRAL_API_KEY` (already in `backend/.env`).
- Mistral API: `POST https://api.mistral.ai/v1/audio/transcriptions`, `Authorization: Bearer <key>`, form fields `file`, `model`, `language=en`, `diarize=true`, `timestamp_granularities=segment` (diarize without segment granularity is a 422). Response `segments[]` have `text`, `start`, `end`, `speaker_id`.
- The Mistral key never reaches the browser. Audio is never written to disk or logged on the server; logs carry error kind/status only.
- pytest, Playwright and CI never call Mistral: `TRANSCRIBER=mock` everywhere tests run.
- Mic constraints: `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`.
- Recording cap 90 min, warning from 80 min, auto-stop at 90. No splitting across requests.
- Notes limit 60,000 characters (backend and frontend). Anthropic analyzer timeout 90s.
- Transcript format: one line per speaker turn, `Speaker N: text`, N numbered 1.. in order of first appearance. Appended below existing notes with a blank line; never overwrites.
- If the live check shows the pinned model can't label speakers, rejects the key, or rejects the audio: **stop and report to the user**. Do not switch model or drop speaker labels.
- Commit to a feature branch, not `main`.

## Review Focus

1. **Mic permission denied / no mic** — expect a clear message in the error banner, no stuck "recording" state. Test in Task 5.
2. **Reload mid-recording** — the recovery notice appears with the right minute count and Transcribe works. Test in Task 5.
3. **Transcription fails (network/Mistral 5xx)** — the recording stays stored, Retry resends it, a later success clears it. Test in Task 5.
4. **Silent or empty recording** — backend returns 422 "No speech was detected in the recording." rather than an empty transcript. Test in Task 1.
5. **Notes box already has text** — transcript is appended after a blank line; typed notes survive. Test in Task 5.

---

### Task 1: Transcriber boundary (mock + Mistral) — backend

**Files:**
- Create: `backend/app/transcriber.py`
- Test: `backend/tests/test_transcriber.py`

**Interfaces:**
- Produces:
  - `class TranscriberError(Exception)` with `status_code: int`, `message: str` (same shape as `AnalyzerError`).
  - `class Transcriber(Protocol)`: `name: str`; `transcribe(audio: bytes, filename: str, content_type: str) -> str`.
  - `MOCK_TRANSCRIPT: str` — `"Speaker 1: Alice will send the revised proposal by Friday.\nSpeaker 2: Bob will update the budget spreadsheet."`
  - `class MockTranscriber` (`name = "mock"`), returns `MOCK_TRANSCRIPT` for any non-empty audio.
  - `class MistralTranscriber(client: httpx.Client | None = None, model: str | None = None)` (`name = "mistral"`).
  - `format_segments(segments: list[dict]) -> str`.
  - `get_transcriber() -> Transcriber` reading `TRANSCRIBER` (`mistral` default | `mock`; anything else → `TranscriberError(500, ...)`).

- [ ] **Step 1: Write failing tests** in `backend/tests/test_transcriber.py`:

```python
def test_format_segments_merges_turns_and_numbers_speakers_by_first_appearance():
    segs = [
        {"text": " Hi all.", "speaker_id": "spk_b"},
        {"text": "Let's start.", "speaker_id": "spk_b"},
        {"text": "Sounds good.", "speaker_id": "spk_a"},
        {"text": "First item.", "speaker_id": "spk_b"},
    ]
    assert format_segments(segs) == "Speaker 1: Hi all. Let's start.\nSpeaker 2: Sounds good.\nSpeaker 1: First item."

def test_format_segments_without_speaker_id_has_no_label():
    assert format_segments([{"text": "Hello.", "speaker_id": None}]) == "Hello."

def test_mistral_sends_diarize_request_and_formats(monkeypatch):
    # Use httpx.MockTransport: assert URL == https://api.mistral.ai/v1/audio/transcriptions,
    # Authorization == "Bearer test-key", form has model=voxtral-small-transcribe-3-0, language=en,
    # diarize=true, timestamp_granularities=segment, and a "file" part; return
    # {"segments": [{"text": "Hi.", "speaker_id": "s0", "start": 0, "end": 1}]} -> "Speaker 1: Hi."

def test_missing_key_is_503(monkeypatch):   # MISTRAL_API_KEY="" -> TranscriberError 503, message mentions MISTRAL_API_KEY
def test_401_maps_to_502_auth_message():     # "Mistral authentication failed. Check MISTRAL_API_KEY."
def test_429_maps_to_429():                  # "Mistral rate limit reached. Please retry shortly."
def test_timeout_maps_to_504():              # httpx.TimeoutException -> 504 "Transcription timed out. Please retry."
def test_other_status_maps_to_502():         # 500 -> 502 "Mistral API error (HTTP 500)."
def test_empty_transcript_is_422():          # segments [] or all blank -> 422 "No speech was detected in the recording."
def test_get_transcriber_selects_mock(monkeypatch)  # TRANSCRIBER=mock -> MockTranscriber; "bogus" -> TranscriberError 500
```

Write these as real tests (a small local `MockTransport` helper is fine; no new test dependency).

- [ ] **Step 2: Run** `cd backend && .venv/bin/pytest tests/test_transcriber.py -q` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `backend/app/transcriber.py`.** Use `httpx.Client(timeout=300.0)`; send `files={"file": (filename, audio, content_type)}` and the form fields above. Map errors most-specific first, logging `kind` and model only (never audio/transcript). `format_segments`: strip each text, merge consecutive segments with the same `speaker_id`, map ids to `Speaker 1..N` by first appearance; segments with `speaker_id is None` get no prefix. If the joined result is blank → `TranscriberError(422, "No speech was detected in the recording.")`. Lazy-construct the client so `mock` mode never needs a key.

- [ ] **Step 4: Run** the same command — Expected: all PASS.

- [ ] **Step 5: Commit** `feat(backend): add Mistral/mock transcriber boundary`

---

### Task 2: `POST /api/transcribe` endpoint, config, live smoke check

**Files:**
- Modify: `backend/app/main.py` (exception handler + route), `backend/app/schemas.py` (add `TranscribeResponse`), `backend/requirements.txt` (add `python-multipart`, pinned to current release), `backend/.env.example`, `backend/tests/conftest.py`, `.github/workflows/ci.yml` (top-level env `TRANSCRIBER: mock`)
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: Task 1's `get_transcriber`, `Transcriber`, `TranscriberError`, `MOCK_TRANSCRIPT`.
- Produces: `POST /api/transcribe`, multipart field `audio` → `200 {"transcript": str, "transcriber": "mistral" | "mock"}`; errors as `{"detail": str}`. `MAX_AUDIO_BYTES = 50 * 1024 * 1024`.

- [ ] **Step 1: Failing tests** in `test_api.py`:
  - `test_transcribe_endpoint_contract`: post `files={"audio": ("rec.webm", b"\x1aE\xdf\xa3fake", "audio/webm")}` → 200, body `== {"transcript": MOCK_TRANSCRIPT, "transcriber": "mock"}`.
  - `test_transcribe_rejects_empty_upload`: zero bytes → 422, detail `"The recording is empty."`.
  - `test_transcribe_rejects_oversized_upload`: override `MAX_AUDIO_BYTES` via monkeypatch to 10 and send 11 bytes → 413, detail `"The recording is too large to transcribe."`.
  - `test_transcriber_error_passes_through`: dependency override raising `TranscriberError(429, "x")` → 429, `{"detail": "x"}`.
  - `test_unexpected_transcriber_failure_is_502`: override raising `RuntimeError` → 502 `"Transcription failed unexpectedly."`.
- [ ] **Step 2: Run** `.venv/bin/pytest -q` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** In `conftest.py` set `TRANSCRIBER=mock` and `MISTRAL_API_KEY=""` before app import. Route reads the upload, checks empty/size before calling the transcriber, passes `audio.content_type or "audio/webm"`. Register a `TranscriberError` handler like the `AnalyzerError` one. Add to `.env.example`: `MISTRAL_API_KEY=`, `# TRANSCRIBER: mistral (default) | mock`, `TRANSCRIBER=mistral`, `MISTRAL_TRANSCRIBE_MODEL=voxtral-small-transcribe-3-0`.
- [ ] **Step 4: Run** `.venv/bin/pip install -r requirements.txt && .venv/bin/pytest -q` — Expected: all PASS.
- [ ] **Step 5: Live smoke check (one paid call, well under 1 cent).** In the scratchpad: make two voices with `say -v Samantha -o a.aiff "Alice will send the proposal by Friday."` and `say -v Daniel -o b.aiff "Bob will update the budget."`, join and encode as Chrome would: `ffmpeg -i a.aiff -i b.aiff -filter_complex concat=n=2:v=0:a=1 -c:a libopus -b:a 32k test.webm`. Start the backend with the real `.env` and `curl -F audio=@test.webm;type=audio/webm http://localhost:8001/api/transcribe`.
  Expected: 200 with two different `Speaker N:` labels. Also look up and record in the commit message Mistral's documented max file size/duration for this model. **If** webm is rejected, the key fails, there is only one speaker label, or the duration limit is under 90 min → stop and report to the user (spec rule), with the exact error.
- [ ] **Step 6: Commit** `feat(backend): add /api/transcribe endpoint`

---

### Task 3: Raise notes limit to 60,000 and analyzer timeout to 90s

**Files:**
- Modify: `backend/app/schemas.py:8`, `backend/app/anthropic_analyzer.py` (client `timeout=90.0`), `frontend/src/App.tsx` (`MAX_NOTES = 60_000`)
- Test: `backend/tests/test_api.py`

- [ ] **Step 1: Failing test** `test_notes_limit_is_60000`: `"a" * 60_000` → 200; `"a" * 60_001` → 422.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_api.py -q` — Expected: FAIL.
- [ ] **Step 3: Change the three values.**
- [ ] **Step 4: Run** `.venv/bin/pytest -q` and `cd frontend && npm run build` — Expected: PASS, build OK.
- [ ] **Step 5: Commit** `feat: raise notes limit to 60k chars for transcripts`

---

### Task 4: Crash-safe recording store + recorder hook — frontend

**Files:**
- Create: `frontend/src/recordingStore.ts`, `frontend/src/useRecorder.ts`
- Modify: `frontend/src/api.ts`, `frontend/src/vite-env.d.ts` (or wherever `ImportMetaEnv` is typed; create if missing)

**Interfaces:**
- Produces (`recordingStore.ts`, DB `meeting-copilot`, one store, one stored recording at a time):
  - `type StoredRecording = { startedAt: number; lastChunkAt: number; mimeType: string; blob: Blob }`
  - `beginRecording(startedAt: number, mimeType: string): Promise<void>` — clears any previous recording.
  - `appendChunk(chunk: Blob, at: number): Promise<void>`
  - `loadRecording(): Promise<StoredRecording | null>` — chunks stitched in order; `null` if none or zero bytes.
  - `clearRecording(): Promise<void>`
- Produces (`useRecorder.ts`):
  - `MAX_RECORDING_MS = 90 * 60_000`, `WARN_AT_MS = 80 * 60_000`, `CHUNK_MS = Number(import.meta.env.VITE_RECORDER_CHUNK_MS ?? 10_000)`, `AUDIO_BITS_PER_SECOND = 32_000`
  - `useRecorder(onFinished: (rec: StoredRecording) => void): { status: "idle" | "recording"; elapsedMs: number; start(): Promise<void>; stop(): void }` — `start` throws `Error` with the user-facing messages below; on Stop or reaching `MAX_RECORDING_MS` it stops the tracks, waits for the final chunk to be stored, then calls `onFinished(await loadRecording())`. Registers a `beforeunload` warning while recording.
  - Error copy: no `MediaRecorder`/`getUserMedia` → `"This browser can't record audio. Use a recent version of Chrome."`; `NotAllowedError` → `"Microphone access was blocked. Allow it in the browser's address bar and try again."`; `NotFoundError` → `"No microphone was found."`
- Produces (`api.ts`): `transcribeAudio(audio: Blob, filename: string): Promise<TranscribeResponse>`, `interface TranscribeResponse { transcript: string; transcriber: string }`. Change `request()` to set `Content-Type: application/json` only when `body` is a string (FormData must set its own boundary).

These have no standalone UI; their tests are the Task 5 Playwright tests. Steps:

- [ ] **Step 1: Implement the three files** per the interfaces. `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`; `new MediaRecorder(stream, { audioBitsPerSecond: AUDIO_BITS_PER_SECOND })`; `recorder.start(CHUNK_MS)`; each `dataavailable` → `appendChunk`. Use the recorder's actual `mimeType` (fallback `audio/webm`).
- [ ] **Step 2: Run** `cd frontend && npm run lint && npm run build` — Expected: no errors.
- [ ] **Step 3: Commit** `feat(frontend): crash-safe recorder and transcribe API client`

---

### Task 5: Record controls, recovery notice, e2e tests

**Files:**
- Create: `frontend/src/RecordControls.tsx`, `frontend/e2e/record.spec.ts`
- Modify: `frontend/src/App.tsx` (render `<RecordControls>` in the notes panel's `.actions`; wire `onTranscript`/`onError`), `frontend/src/App.css`, `frontend/playwright.config.ts`

**Interfaces:**
- Consumes: Task 4 (`useRecorder`, `loadRecording`, `clearRecording`, `transcribeAudio`, constants).
- Produces: `RecordControls({ onTranscript, onError, disabled }: { onTranscript(text: string): void; onError(message: string | null): void; disabled: boolean })`; `appendTranscript(notes: string, transcript: string): string` (exported from `RecordControls.tsx`): `notes.trim() ? notes.trimEnd() + "\n\n" + transcript : transcript`.

UI copy (tests rely on it): buttons **Record**, **Stop**, **Retry**, **Transcribe**, **Discard**; recording indicator `Recording mm:ss`; status `Transcribing… this can take a minute or two.`; from 80 min `Recording stops automatically at 90 minutes.`; recovery notice `You have an unsaved recording (N min) from HH:MM.` (N = round((lastChunkAt − startedAt)/60000), minimum 1; HH:MM local time of `startedAt`). After a successful transcription, `clearRecording()`; on failure keep it and show **Retry**. On mount, `loadRecording()`; if one exists and nothing is recording, show the recovery notice.

- [ ] **Step 1: Playwright config.** Add to `use`: `launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }`. Backend env `TRANSCRIBER: LIVE ? "mistral" : "mock"`; frontend env `VITE_RECORDER_CHUNK_MS: "500"`.
- [ ] **Step 2: Write failing tests** in `frontend/e2e/record.spec.ts` (clear IndexedDB in `beforeEach`):
  - `record, stop, transcript lands in notes`: Record → `Recording 00:0` visible → wait 1.5s → Stop → notes box contains `Speaker 1: Alice will send the revised proposal by Friday.`; Record button enabled again.
  - `transcript is appended below existing notes`: fill `My own note.`; record/stop → value starts with `My own note.\n\nSpeaker 1:`.
  - `reload mid-recording offers recovery`: Record → wait 1.5s → `page.reload()` → `You have an unsaved recording` visible → Transcribe → transcript in notes → reload again → notice gone.
  - `discard removes the stored recording`: as above, Discard → notice gone, still gone after reload.
  - `failed transcription keeps the recording and Retry works`: `page.route("**/api/transcribe", 503 {"detail":"Mistral API error (HTTP 503)."})` once → banner shows it, Retry visible → unroute → Retry → transcript in notes.
  - `mic blocked shows a clear error`: `page.addInitScript` makes `navigator.mediaDevices.getUserMedia` reject with `new DOMException("", "NotAllowedError")` → banner shows the blocked-mic copy; no `Recording` indicator; Record still enabled.
  - `warns at 80 min and stops at 90`: `page.clock.install()` before goto; Record; `page.clock.runFor(80 * 60_000)` → warning copy visible; `runFor(10 * 60_000)` → Transcribing/transcript appears without pressing Stop.
- [ ] **Step 3: Run** `npm run test:e2e -- record.spec.ts` — Expected: FAIL (no Record button).
- [ ] **Step 4: Implement `RecordControls.tsx`**, render it in `App.tsx`, style in `App.css` using the existing button classes (`secondary` for Record, a red-accented variant for the live indicator). Record/Stop disabled while transcribing.
- [ ] **Step 5: Run** `npm run lint && npm run build && npm run test:e2e` — Expected: all e2e (old + new) PASS.
- [ ] **Step 6: Commit** `feat(frontend): record meetings and transcribe into notes`

---

### Task 6: Docs + real-setup check with the user

**Files:**
- Modify: `README.md` (Recording section: Chrome, mic permission, speakers not headphones, `MISTRAL_API_KEY`, `TRANSCRIBER=mock`, cost ≈ $0.004/min, crash recovery; add `/api/transcribe` to the API table)

- [ ] **Step 1: Update README**, commit `docs: document recording and transcription`.
- [ ] **Step 2: Run everything:** `cd backend && .venv/bin/pytest -q`; `cd frontend && npm run lint && npm run build && npm run test:e2e` — Expected: all PASS.
- [ ] **Step 3: Ask the user to do a real check** (the agent can't): start both dev servers, join a Teams call on laptop speakers, record ~2 minutes with at least two people talking, Stop. Pass = transcript shows the other participants' words (not only the user's) with at least two speaker labels. Also reload once mid-recording and confirm recovery. If other voices are missing, report back — do not change the mic constraints without the user.
