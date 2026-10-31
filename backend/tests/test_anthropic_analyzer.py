"""AnthropicAnalyzer tests. A fake client stands in for the SDK: no network, no paid calls."""
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.analyzer import AnalyzerError, MockAnalyzer, get_analyzer
from app.anthropic_analyzer import AnthropicAnalyzer
from app.main import app
from app.schemas import ActionItem, ExtractedActionItems

client = TestClient(app)
REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


class FakeMessages:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


def fake_client(result=None, error=None):
    return SimpleNamespace(messages=FakeMessages(result, error))


def parsed(items, stop_reason="end_turn"):
    return SimpleNamespace(parsed_output=ExtractedActionItems(action_items=items), stop_reason=stop_reason)


def status_error(cls, code, message="error"):
    return cls(message, response=httpx2.Response(code, request=REQUEST), body=None)


def test_returns_structured_items_and_sends_expected_request():
    items = [ActionItem(task="Send proposal", owner="Alice", deadline="next Friday")]
    fake = fake_client(parsed(items))
    analyzer = AnthropicAnalyzer(client=fake, model="claude-haiku-5-5")

    assert analyzer.analyze("Alice will send the proposal by next Friday.") == items
    call = fake.messages.calls[0]
    assert call["model"] == "claude-haiku-5-5"
    assert call["output_format"] is ExtractedActionItems
    # Notes are wrapped as data, separate from the system instructions.
    assert call["messages"][0]["content"].startswith("<meeting_notes>")
    assert "Alice will send" not in call["system"]


def test_model_configurable_via_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
    assert AnthropicAnalyzer(client=fake_client()).model == "claude-sonnet-5-5"
    monkeypatch.delenv("ANTHROPIC_MODEL")
    assert AnthropicAnalyzer(client=fake_client()).model == "claude-haiku-5-5"


def test_empty_result_is_valid():
    assert AnthropicAnalyzer(client=fake_client(parsed([]))).analyze("Just chatting.") == []


def test_workspace_header_configured_from_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")  # dummy; no request is sent
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_test123")
    assert AnthropicAnalyzer().client.default_headers["anthropic-workspace-id"] == "wrkspc_test123"

    monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID")
    assert "anthropic-workspace-id" not in AnthropicAnalyzer().client.default_headers


def test_missing_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(AnalyzerError) as exc:
        AnthropicAnalyzer()
    assert exc.value.status_code == 503


@pytest.mark.parametrize(
    "error, status",
    [
        (status_error(anthropic.AuthenticationError, 401), 502),
        (status_error(anthropic.RateLimitError, 429), 429),
        (status_error(anthropic.BadRequestError, 400, "Your credit balance is too low"), 402),
        (status_error(anthropic.NotFoundError, 404), 502),
        (status_error(anthropic.InternalServerError, 500), 502),
        (anthropic.APITimeoutError(request=REQUEST), 504),
        (anthropic.APIConnectionError(request=REQUEST), 502),
    ],
)
def test_api_errors_map_to_clear_http_status(error, status):
    with pytest.raises(AnalyzerError) as exc:
        AnthropicAnalyzer(client=fake_client(error=error)).analyze("notes")
    assert exc.value.status_code == status


def test_invalid_model_output():
    try:
        ExtractedActionItems.model_validate({"action_items": [{"owner": "Alice"}]})  # missing task
    except ValidationError as e:
        bad_output = e
    with pytest.raises(AnalyzerError) as exc:
        AnthropicAnalyzer(client=fake_client(error=bad_output)).analyze("notes")
    assert exc.value.status_code == 502

    no_output = SimpleNamespace(parsed_output=None, stop_reason="end_turn")
    with pytest.raises(AnalyzerError):
        AnthropicAnalyzer(client=fake_client(no_output)).analyze("notes")


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_unusable_stop_reasons(stop_reason):
    with pytest.raises(AnalyzerError):
        AnthropicAnalyzer(client=fake_client(parsed([], stop_reason))).analyze("notes")


# --- Endpoint-level: mode switching and error surfacing ---

def test_mock_mode_never_constructs_anthropic_client(monkeypatch):
    monkeypatch.setenv("ANALYZER", "mock")
    monkeypatch.setattr(anthropic, "Anthropic", lambda *a, **k: pytest.fail("network client created"))
    assert isinstance(get_analyzer(), MockAnalyzer)
    res = client.post("/api/analyze", json={"notes": "Bob to update the budget by Friday."})
    assert res.status_code == 200
    assert res.json()["analyzer"] == "mock"


def test_anthropic_mode_success_through_endpoint():
    items = [ActionItem(task="Update budget", owner="Bob", deadline="Friday")]
    app.dependency_overrides[get_analyzer] = lambda: AnthropicAnalyzer(client=fake_client(parsed(items)))
    try:
        res = client.post("/api/analyze", json={"notes": "Bob to update the budget by Friday."})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 200
    assert res.json() == {"action_items": [{**items[0].model_dump(), "duplicate_of": None}], "analyzer": "anthropic"}


def test_anthropic_mode_without_key_returns_error_not_mock(monkeypatch):
    monkeypatch.setenv("ANALYZER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = client.post("/api/analyze", json={"notes": "Alice will send the deck by Friday."})
    assert res.status_code == 503
    assert "ANTHROPIC_API_KEY" in res.json()["detail"]


def test_anthropic_failure_surfaces_through_endpoint():
    error = status_error(anthropic.RateLimitError, 429)
    app.dependency_overrides[get_analyzer] = lambda: AnthropicAnalyzer(client=fake_client(error=error))
    try:
        res = client.post("/api/analyze", json={"notes": "Alice will send the deck."})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 429
    assert "rate limit" in res.json()["detail"].lower()


def test_unknown_analyzer_setting(monkeypatch):
    monkeypatch.setenv("ANALYZER", "gpt")
    assert client.post("/api/analyze", json={"notes": "x"}).status_code == 500
