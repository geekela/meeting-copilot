from fastapi.testclient import TestClient

from app.analyzer import MockAnalyzer, get_analyzer
from app.main import app
from app.schemas import ActionItem

client = TestClient(app)

NOTES = """Weekly sync - Q4 planning
Alice will send the revised proposal to the client by Friday.
Bob to update the budget spreadsheet before next week.
Action: schedule a follow-up workshop.
We discussed the timeline and everyone agreed it looks fine."""


def test_extracts_owner_task_deadline():
    items = MockAnalyzer().analyze(NOTES)
    assert items == [
        ActionItem(task="Send the revised proposal to the client", owner="Alice", deadline="Friday"),
        ActionItem(task="Update the budget spreadsheet", owner="Bob", deadline="next week"),
        ActionItem(task="Schedule a follow-up workshop", owner="Unassigned", deadline="No deadline"),
    ]


CASUAL_NOTES = """ari takes care of booking venue
sam mentioned a nice vegan food restaurant
jules sends out invitations

mark says he would like to get drinks"""


def test_casual_notes_yield_commitments_and_suggestions():
    items = MockAnalyzer().analyze(CASUAL_NOTES)
    assert items == [
        ActionItem(task="Take care of booking venue", owner="Ari", kind="commitment"),
        ActionItem(task="Consider a nice vegan food restaurant", owner="Sam", kind="suggestion"),
        ActionItem(task="Send out invitations", owner="Jules", kind="commitment"),
        ActionItem(task="Get drinks", owner="Mark", kind="suggestion"),
    ]


def test_pronouns_and_discussion_are_not_tasks():
    notes = "we would like to finish early. Everyone agreed it looks fine. They mentioned the weather."
    assert MockAnalyzer().analyze(notes) == []


def test_analyze_endpoint_contract():
    res = client.post("/api/analyze", json={"notes": NOTES})
    assert res.status_code == 200
    body = res.json()
    assert len(body["action_items"]) == 3
    assert set(body["action_items"][0]) == {"task", "owner", "deadline", "kind", "duplicate_of"}


def test_no_action_items_returns_empty_list():
    res = client.post("/api/analyze", json={"notes": "General discussion, nothing decided."})
    assert res.status_code == 200
    assert res.json() == {"action_items": [], "analyzer": "mock"}


def test_blank_and_missing_notes_rejected():
    assert client.post("/api/analyze", json={"notes": "   "}).status_code == 422
    assert client.post("/api/analyze", json={"notes": ""}).status_code == 422
    assert client.post("/api/analyze", json={}).status_code == 422


def test_analyzer_failure_returns_502():
    class Broken:
        def analyze(self, notes):
            raise RuntimeError("model unavailable")

    app.dependency_overrides[get_analyzer] = lambda: Broken()
    try:
        res = client.post("/api/analyze", json={"notes": "Alice will do it."})
        assert res.status_code == 502
    finally:
        app.dependency_overrides.clear()


# --- Transcription -----------------------------------------------------------

from app import main as main_module  # noqa: E402
from app.transcriber import MOCK_TRANSCRIPT, TranscriberError, get_transcriber  # noqa: E402

WEBM = ("rec.webm", b"\x1aE\xdf\xa3fake", "audio/webm")


def test_transcribe_endpoint_contract():
    res = client.post("/api/transcribe", files={"audio": WEBM})
    assert res.status_code == 200
    assert res.json() == {"transcript": MOCK_TRANSCRIPT, "transcriber": "mock"}


def test_transcribe_rejects_empty_upload():
    res = client.post("/api/transcribe", files={"audio": ("rec.webm", b"", "audio/webm")})
    assert res.status_code == 422
    assert res.json() == {"detail": "The recording is empty."}


def test_transcribe_rejects_missing_file():
    assert client.post("/api/transcribe").status_code == 422


def test_transcribe_rejects_oversized_upload(monkeypatch):
    monkeypatch.setattr(main_module, "MAX_AUDIO_BYTES", 10)
    res = client.post("/api/transcribe", files={"audio": ("rec.webm", b"x" * 11, "audio/webm")})
    assert res.status_code == 413
    assert res.json() == {"detail": "The recording is too large to transcribe."}


def test_transcriber_error_passes_through():
    class RateLimited:
        name = "x"

        def transcribe(self, audio, filename, content_type):
            raise TranscriberError(429, "x")

    app.dependency_overrides[get_transcriber] = lambda: RateLimited()
    try:
        res = client.post("/api/transcribe", files={"audio": WEBM})
        assert (res.status_code, res.json()) == (429, {"detail": "x"})
    finally:
        app.dependency_overrides.clear()


def test_unexpected_transcriber_failure_is_502():
    class Broken:
        name = "x"

        def transcribe(self, audio, filename, content_type):
            raise RuntimeError("boom")

    app.dependency_overrides[get_transcriber] = lambda: Broken()
    try:
        res = client.post("/api/transcribe", files={"audio": WEBM})
        assert (res.status_code, res.json()) == (502, {"detail": "Transcription failed unexpectedly."})
    finally:
        app.dependency_overrides.clear()


def test_notes_limit_is_60000():
    # Long enough for a ~1 hour transcript.
    assert client.post("/api/analyze", json={"notes": "a" * 60_000}).status_code == 200
    assert client.post("/api/analyze", json={"notes": "a" * 60_001}).status_code == 422
