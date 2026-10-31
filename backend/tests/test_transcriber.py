import httpx
import pytest

from app.transcriber import (
    MOCK_TRANSCRIPT,
    MistralTranscriber,
    MockTranscriber,
    TranscriberError,
    format_segments,
    get_transcriber,
)

AUDIO = b"\x1aE\xdf\xa3fake-webm"


def mistral_with(handler) -> MistralTranscriber:
    """A MistralTranscriber whose HTTP calls go to `handler` instead of the network."""
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return MistralTranscriber(client=client, api_key="test-key")


def respond(status: int, body: dict | None = None):
    return lambda request: httpx.Response(status, json=body or {})


# --- format_segments ---------------------------------------------------------

def test_format_segments_merges_turns_and_numbers_speakers_by_first_appearance():
    segs = [
        {"text": " Hi all.", "speaker_id": "spk_b"},
        {"text": "Let's start.", "speaker_id": "spk_b"},
        {"text": "Sounds good.", "speaker_id": "spk_a"},
        {"text": "First item.", "speaker_id": "spk_b"},
    ]
    assert format_segments(segs) == (
        "Speaker 1: Hi all. Let's start.\nSpeaker 2: Sounds good.\nSpeaker 1: First item."
    )


def test_format_segments_without_speaker_id_has_no_label():
    assert format_segments([{"text": "Hello.", "speaker_id": None}]) == "Hello."


def test_format_segments_skips_blank_text():
    segs = [{"text": "  ", "speaker_id": "a"}, {"text": "Hi.", "speaker_id": "b"}]
    assert format_segments(segs) == "Speaker 1: Hi."


# --- MistralTranscriber ------------------------------------------------------

def test_mistral_sends_diarize_request_and_formats():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = request.content
        return httpx.Response(200, json={"segments": [{"text": "Hi.", "speaker_id": "s0", "start": 0, "end": 1}]})

    result = mistral_with(handler).transcribe(AUDIO, "rec.webm", "audio/webm")

    assert result == "Speaker 1: Hi."
    assert seen["url"] == "https://api.mistral.ai/v1/audio/transcriptions"
    assert seen["auth"] == "Bearer test-key"
    body = seen["body"]
    for name, value in [
        (b"model", b"voxtral-small-transcribe-3-0"),
        (b"language", b"en"),
        (b"diarize", b"true"),
        (b"timestamp_granularities", b"segment"),
    ]:
        assert b'name="' + name + b'"\r\n\r\n' + value + b"\r\n" in body
    assert b'name="file"; filename="rec.webm"' in body
    assert AUDIO in body


def test_model_can_be_overridden_by_env(monkeypatch):
    monkeypatch.setenv("MISTRAL_TRANSCRIBE_MODEL", "voxtral-other")
    assert MistralTranscriber(client=httpx.Client(), api_key="k").model == "voxtral-other"


def test_missing_key_is_503(monkeypatch):
    monkeypatch.setenv("MISTRAL_API_KEY", "")
    with pytest.raises(TranscriberError) as exc:
        MistralTranscriber()
    assert exc.value.status_code == 503
    assert "MISTRAL_API_KEY" in exc.value.message


def test_401_maps_to_502_auth_message():
    with pytest.raises(TranscriberError) as exc:
        mistral_with(respond(401)).transcribe(AUDIO, "rec.webm", "audio/webm")
    assert (exc.value.status_code, exc.value.message) == (
        502, "Mistral authentication failed. Check MISTRAL_API_KEY.")


def test_429_maps_to_429():
    with pytest.raises(TranscriberError) as exc:
        mistral_with(respond(429)).transcribe(AUDIO, "rec.webm", "audio/webm")
    assert (exc.value.status_code, exc.value.message) == (
        429, "Mistral rate limit reached. Please retry shortly.")


def test_timeout_maps_to_504():
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(TranscriberError) as exc:
        mistral_with(handler).transcribe(AUDIO, "rec.webm", "audio/webm")
    assert (exc.value.status_code, exc.value.message) == (504, "Transcription timed out. Please retry.")


def test_connection_error_maps_to_502():
    def handler(request):
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(TranscriberError) as exc:
        mistral_with(handler).transcribe(AUDIO, "rec.webm", "audio/webm")
    assert (exc.value.status_code, exc.value.message) == (502, "Could not connect to the Mistral API.")


def test_other_status_maps_to_502():
    with pytest.raises(TranscriberError) as exc:
        mistral_with(respond(500)).transcribe(AUDIO, "rec.webm", "audio/webm")
    assert (exc.value.status_code, exc.value.message) == (502, "Mistral API error (HTTP 500).")


@pytest.mark.parametrize("segments", [[], [{"text": "   ", "speaker_id": "a"}]])
def test_empty_transcript_is_422(segments):
    with pytest.raises(TranscriberError) as exc:
        mistral_with(respond(200, {"segments": segments})).transcribe(AUDIO, "rec.webm", "audio/webm")
    assert (exc.value.status_code, exc.value.message) == (422, "No speech was detected in the recording.")


def test_unexpected_response_shape_is_502():
    with pytest.raises(TranscriberError) as exc:
        mistral_with(respond(200, {"text": "no segments key"})).transcribe(AUDIO, "rec.webm", "audio/webm")
    assert exc.value.status_code == 502


# --- Mock + selection --------------------------------------------------------

def test_mock_returns_fixed_transcript():
    assert MockTranscriber().transcribe(AUDIO, "rec.webm", "audio/webm") == MOCK_TRANSCRIPT
    assert MOCK_TRANSCRIPT.startswith("Speaker 1: Alice will send the revised proposal by Friday.")


def test_get_transcriber_selects_mock(monkeypatch):
    monkeypatch.setenv("TRANSCRIBER", "mock")
    assert isinstance(get_transcriber(), MockTranscriber)


def test_get_transcriber_rejects_unknown(monkeypatch):
    monkeypatch.setenv("TRANSCRIBER", "bogus")
    with pytest.raises(TranscriberError) as exc:
        get_transcriber()
    assert exc.value.status_code == 500
