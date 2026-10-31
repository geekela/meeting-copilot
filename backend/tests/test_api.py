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


def test_analyze_endpoint_contract():
    res = client.post("/api/analyze", json={"notes": NOTES})
    assert res.status_code == 200
    body = res.json()
    assert len(body["action_items"]) == 3
    assert set(body["action_items"][0]) == {"task", "owner", "deadline"}


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
