# Record & transcribe meetings — design

Date: 2026-10-31
Status: draft, awaiting approval

## Why

Today Meeting Copilot only works from notes the user pastes in. The user runs
Microsoft Teams meetings with about 5 people and wants to press **Record** in
Meeting Copilot itself — not in Teams — and get a transcript automatically,
so there is nothing to type or paste. The transcript then feeds the existing
"analyze → review → approve tasks" flow unchanged.

Success: the user records a real Teams meeting, presses Stop, and a minute or
two later has an English transcript with speaker labels in the notes box,
ready to tidy and analyze.

## How it works (user's view)

1. User presses **Record** in the notes panel. The browser asks for microphone
   permission the first time.
2. While recording, the app shows that it is recording and how long it has
   been running, and offers **Stop**.
3. User presses **Stop**. Only now is the audio uploaded.
4. The app shows **"Transcribing…"** — this may take a minute or two.
5. The transcript appears in the existing notes textarea, one line per speaker
   turn, labelled `Speaker 1: …`, `Speaker 2: …`.
6. User edits it as they like (e.g. replaces "Speaker 2" with a real name) and
   clicks **Analyze notes** as today. Everything after this point is unchanged.

## Decisions made by the user

- **Microphone only.** The user joins Teams on laptop speakers (no headphones)
  for version 1, so the mic hears everyone. No tab/system-audio capture.
- **Upload after Stop, not live.** No streaming/realtime transcription.
- **Transcription service: Mistral, model `voxtral-small-transcribe-3-0`**
  (Voxtral Small Transcribe 3). The key is already in `backend/.env` as
  `MISTRAL_API_KEY`. (Claude cannot take audio input, so a separate
  speech-to-text service is required; Claude still does task extraction.)
- **English** meetings.
- **Speaker labels are wanted** (diarization). Generic labels are fine; the
  user renames speakers by hand.
- **The recording is discarded** once transcribed. Only the text is kept
  (and only in the notes box, as today — it is not saved to the database).
- **Waiting a minute or two** on a "Transcribing…" state is acceptable.
- **Meetings average 30 minutes.**
- **The recording must survive a tab crash or reload mid-meeting.** See
  "Crash-safe recording" below.

## Decisions made by Claude (user may override)

- Pin the dated model name `voxtral-small-transcribe-3-0` rather than
  `voxtral-small-transcribe-latest`, so behaviour doesn't change silently.
  Make it overridable with a `MISTRAL_TRANSCRIBE_MODEL` env var, mirroring
  `ANTHROPIC_MODEL`.
- The browser sends audio to **our backend**, which calls Mistral. The Mistral
  key never reaches the browser.
- New endpoint `POST /api/transcribe` (multipart upload, field `audio`) →
  `{"transcript": "...", "transcriber": "mistral" | "mock"}`.
- Same pattern as the analyzer: a `Transcriber` boundary selected by a
  `TRANSCRIBER` env var (`mistral` default | `mock`). The mock returns a fixed
  sample transcript with speaker labels and makes no network calls. pytest,
  Playwright and CI all run with the mock; no Mistral key in CI.
- Audio is held in memory only for the length of the request — never written
  to disk, never logged. Logs contain error types/status only, as the
  Anthropic analyzer does today.
- **If the notes box already has text** when a transcript arrives, append the
  transcript below it (separated by a blank line) rather than overwrite it, so
  nothing the user typed is lost.
- Error messages follow the existing `{"detail": ...}` shape and show in the
  existing error banner: missing key, auth failure, rate limit, timeout,
  file too large, empty/no-speech result, mic permission denied, browser has
  no recording support.
- **If transcription fails, the recording stays saved in the browser** (see
  crash-safe recording) with a **Retry** button — losing a meeting to a
  network blip would be the worst outcome. It is deleted only after a
  successful transcription or when the user explicitly discards it. It never
  leaves the browser except to be transcribed.
- **Microphone settings:** request the mic with `echoCancellation`,
  `noiseSuppression` and `autoGainControl` **off**. Echo cancellation exists
  to remove sound coming from the speakers — which here is every other
  participant — so leaving it on could silently record only the user.
  Verify on the real setup (Teams on speakers) before calling it done.
- **Recording cap:** 90 minutes (3× the average meeting), with a visible
  warning from 80 minutes and an automatic stop at 90. If Mistral's per-request
  limit turns out lower, lower the cap to fit it — no splitting audio into
  several requests (speaker labels would restart in each piece).
- **If the pinned model can't deliver** (no speaker labels, rejects the key,
  rejects the audio after conversion), stop and come back to the user rather
  than switching model or dropping speaker labels.
- Add `python-multipart` to `backend/requirements.txt` (FastAPI needs it for
  file uploads).
- Add an empty `MISTRAL_API_KEY=` (and the optional model/transcriber lines)
  to `backend/.env.example`, and document the feature in the README.
- Record in whatever compressed format the browser's MediaRecorder produces
  (WebM/Opus in Chrome), assuming Mistral accepts it; convert only if it
  doesn't.

## Crash-safe recording (user requirement)

While recording, the audio is saved to browser storage (IndexedDB) in small
pieces as it goes (e.g. every ~10 seconds, via MediaRecorder's timeslice), so
at most a few seconds are lost if the tab crashes, is closed or is reloaded.

When the app loads and finds an unfinished or untranscribed recording, it
shows a notice — e.g. "You have an unsaved recording (23 min) from 14:05" —
with **Transcribe** and **Discard**. Transcribe stitches the saved pieces
together and continues exactly as if the user had pressed Stop.

The stored recording is deleted after a successful transcription or an
explicit Discard. One stored recording at a time is enough. Also show the
browser's "leave this page?" warning while a recording is in progress.

## Notes length limit (Claude's call)

Notes are capped at 20,000 characters (`AnalyzeRequest.notes` in
`backend/app/schemas.py`, `MAX_NOTES` in `App.tsx`). A 30-minute meeting with
five people is roughly 25,000–30,000 characters, so the limit must rise.
Raise it to **60,000** in both places (fits about an hour). Check that the
Anthropic analyzer copes with notes that long: raise its 30-second timeout as
needed (e.g. to 90s); `max_tokens=16000` is plenty for the task list. The
analyze flow itself doesn't change — no chunking.

## Goals

- One-click record → transcript in the notes box, with speaker labels.
- Works in Chrome on the user's laptop against the local dev servers.
- Fully testable offline (mock transcriber), CI stays free.

## Non-goals (version 1)

- Capturing Teams audio directly (tab/system audio) or headphone setups.
- Live/realtime transcript while the meeting runs.
- Mapping speaker labels to real names automatically.
- Saving recordings or transcripts to the database / meeting history
  (the browser-side crash store is temporary, not history).
- Splitting long recordings across several transcription requests.
- Languages other than English; uploading an existing audio file.

## Anti-goals (would be a failure even if it "works")

- The Mistral key exposed to the browser or committed to git.
- Audio or transcript text written to logs or disk on the server.
- Tests or CI calling Mistral or costing money.
- A long recording lost because one request failed.
- The existing paste-and-analyze flow changing or breaking.

## Left to the builder

- Calling Mistral via the official `mistralai` Python SDK or plain HTTP
  (`httpx` is already installed) — check Mistral's API reference for the
  transcription endpoint, the exact diarization parameter, accepted audio
  formats and upload size/duration limits. The model is in Public Preview
  (released 2026-10-20), so verify against the live docs rather than memory.
- How diarized segments are merged into "Speaker N: …" lines.
- Exact UI layout and styling of the record controls, within the existing
  visual style of the notes panel.
- Timeouts for the transcription request (long uploads need far more than
  the analyzer's 30s).
- How Playwright fakes the microphone, and how IndexedDB recovery is tested.
