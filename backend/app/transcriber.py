"""Transcription boundary.

Every transcriber implements `transcribe(audio, filename, content_type) -> str`
and returns plain text, one line per speaker turn ("Speaker 1: ...").
Implementations are selected via the TRANSCRIBER env var (mistral [default] | mock).
Audio and transcript text are never logged or written to disk.
"""
import logging
import os
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

MISTRAL_URL = "https://api.mistral.ai/v1/audio/transcriptions"
DEFAULT_MODEL = "voxtral-small-transcribe-3-0"
# Uploading and transcribing up to 90 minutes of audio can take a while.
TIMEOUT_SECONDS = 300.0

MOCK_TRANSCRIPT = (
    "Speaker 1: Alice will send the revised proposal by Friday.\n"
    "Speaker 2: Bob will update the budget spreadsheet."
)


class TranscriberError(Exception):
    """Expected transcription failure with a safe, user-facing message and HTTP status."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class Transcriber(Protocol):
    name: str

    def transcribe(self, audio: bytes, filename: str, content_type: str) -> str: ...


def format_segments(segments: list[dict]) -> str:
    """Merge consecutive segments by speaker; number speakers 1..N by first appearance."""
    labels: dict[str, str] = {}
    turns: list[tuple[str | None, list[str]]] = []
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        speaker = seg.get("speaker_id")
        if turns and turns[-1][0] == speaker:
            turns[-1][1].append(text)
        else:
            turns.append((speaker, [text]))
        if speaker is not None and speaker not in labels:
            labels[speaker] = f"Speaker {len(labels) + 1}"
    lines = []
    for speaker, texts in turns:
        body = " ".join(texts)
        lines.append(f"{labels[speaker]}: {body}" if speaker is not None else body)
    return "\n".join(lines)


class MockTranscriber:
    """Offline stand-in: returns a fixed transcript, never touches the network."""

    name = "mock"

    def transcribe(self, audio: bytes, filename: str, content_type: str) -> str:
        return MOCK_TRANSCRIPT


class MistralTranscriber:
    name = "mistral"

    def __init__(self, client: httpx.Client | None = None, model: str | None = None,
                 api_key: str | None = None):
        self.model = model or os.getenv("MISTRAL_TRANSCRIBE_MODEL") or DEFAULT_MODEL
        self.api_key = api_key if api_key is not None else os.getenv("MISTRAL_API_KEY", "")
        if not self.api_key:
            raise TranscriberError(503, "Mistral transcriber is not configured: MISTRAL_API_KEY is missing.")
        self.client = client or httpx.Client(timeout=TIMEOUT_SECONDS)

    def transcribe(self, audio: bytes, filename: str, content_type: str) -> str:
        try:
            response = self.client.post(
                MISTRAL_URL,
                headers={"Authorization": f"Bearer {self.api_key}"},
                data={
                    "model": self.model,
                    "language": "en",
                    "diarize": "true",
                    "timestamp_granularities": "segment",
                },
                files={"file": (filename, audio, content_type)},
            )
        except httpx.TimeoutException:
            raise self._fail(504, "Transcription timed out. Please retry.", "timeout")
        except httpx.TransportError:
            raise self._fail(502, "Could not connect to the Mistral API.", "connection")

        status = response.status_code
        if status == 401:
            raise self._fail(502, "Mistral authentication failed. Check MISTRAL_API_KEY.", "auth")
        if status == 429:
            raise self._fail(429, "Mistral rate limit reached. Please retry shortly.", "rate_limit")
        if status >= 400:
            raise self._fail(502, f"Mistral API error (HTTP {status}).", f"status_{status}")

        try:
            segments = response.json()["segments"]
            transcript = format_segments(segments)
        except (ValueError, KeyError, TypeError, AttributeError):
            raise self._fail(502, "Mistral returned an unexpected response.", "invalid_output")

        if not transcript.strip():
            raise self._fail(422, "No speech was detected in the recording.", "no_speech")
        logger.info("Mistral transcription ok: model=%s segments=%d", self.model, len(segments))
        return transcript

    def _fail(self, status: int, message: str, kind: str) -> TranscriberError:
        logger.warning("Mistral transcription failed: kind=%s model=%s", kind, self.model)
        return TranscriberError(status, message)


def get_transcriber() -> Transcriber:
    kind = os.getenv("TRANSCRIBER", "mistral")
    if kind == "mock":
        return MockTranscriber()
    if kind == "mistral":
        return MistralTranscriber()
    raise TranscriberError(500, f"Unknown TRANSCRIBER setting: {kind!r} (use 'mock' or 'mistral').")
