"""Analysis boundary.

Every analyzer implements `analyze(notes) -> list[ActionItem]`.
Implementations are selected via the ANALYZER env var (anthropic [default] | mock)
without touching the API contract or the frontend.
"""
import os
import re
from typing import Protocol

from .schemas import ActionItem


class Analyzer(Protocol):
    name: str

    def analyze(self, notes: str) -> list[ActionItem]: ...


class AnalyzerError(Exception):
    """Expected analysis failure with a safe, user-facing message and HTTP status."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


NAME = r"(?P<owner>(?!(?:we|i|you|they|he|she|it|everyone|someone|nobody)\b)[A-Za-z][a-z]+)"
# Commitments: "Alice will ...", "bob to ...", "Carol needs to ...", "ari takes care of ..."
OWNER_PATTERN = re.compile(rf"^{NAME}\s+(?:will|to|needs to|should|must)\s+(?P<task>.+)$", re.I)
# Third-person verbs ("jules sends out invitations") -> imperative ("Send out invitations").
THIRD_PERSON = {
    "takes care of": "take care of", "handles": "handle", "sends": "send", "books": "book",
    "prepares": "prepare", "organizes": "organize", "organises": "organise", "writes": "write",
    "drafts": "draft", "updates": "update", "schedules": "schedule", "calls": "call",
    "contacts": "contact", "emails": "email", "reviews": "review", "follows up": "follow up",
    "is responsible for": "handle", "is in charge of": "handle",
}
VERB_PATTERN = re.compile(
    rf"^{NAME}\s+(?P<verb>{'|'.join(sorted(map(re.escape, THIRD_PERSON), key=len, reverse=True))})\s+(?P<task>.+)$",
    re.I,
)
# Suggestions: "sam mentioned a nice restaurant", "Mark says he would like to get drinks"
SUGGESTION_PATTERN = re.compile(
    rf"^{NAME}\s+(?:mentioned|suggested|proposed|recommended)\s+(?P<task>.+)$", re.I
)
WISH_PATTERN = re.compile(
    rf"^{NAME}\s+(?:says?\s+(?:he|she|they)\s+)?(?:would like to|wants to|wishes to|'d like to)\s+(?P<task>.+)$",
    re.I,
)
# "Action: ...", "TODO: ...", "AI: ..." (no explicit owner)
PREFIX_PATTERN = re.compile(r"^(?:action(?: item)?|todo|ai)\s*[:\-]\s*(?P<task>.+)$", re.I)
# Deadline phrase introduced by by/before/due/on, cut from the end of the task.
DEADLINE_PATTERN = re.compile(
    r"\s+(?:by|before|due(?: by)?|on)\s+(?P<deadline>"
    r"(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)"
    r"|tomorrow|today|eod|end of (?:day|week|month)"
    r"|\d{4}-\d{2}-\d{2}"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?"
    r")\b",
    re.I,
)


class MockAnalyzer:
    """Deterministic, line-based extraction. Intentionally simple."""

    name = "mock"

    def analyze(self, notes: str) -> list[ActionItem]:
        items: list[ActionItem] = []
        for raw in re.split(r"[\n]+|(?<=[.!?])\s+", notes):
            line = raw.strip().lstrip("-*• ").rstrip(".!")
            if not line:
                continue

            owner, kind = "Unassigned", "commitment"
            if m := OWNER_PATTERN.match(line):
                owner, task = m["owner"], m["task"]
            elif m := VERB_PATTERN.match(line):
                owner, task = m["owner"], f"{THIRD_PERSON[m['verb'].lower()]} {m['task']}"
            elif m := SUGGESTION_PATTERN.match(line):
                owner, task, kind = m["owner"], f"Consider {m['task']}", "suggestion"
            elif m := WISH_PATTERN.match(line):
                owner, task, kind = m["owner"], m["task"], "suggestion"
            elif m := PREFIX_PATTERN.match(line):
                task = m["task"]
            else:
                continue  # not an action item
            owner = owner[:1].upper() + owner[1:]

            deadline = "No deadline"
            if d := DEADLINE_PATTERN.search(task):
                deadline = d["deadline"]
                task = task[: d.start()] + task[d.end():]

            task = task.strip(" ,")
            items.append(ActionItem(task=task[:1].upper() + task[1:], owner=owner, deadline=deadline, kind=kind))
        return items


def get_analyzer() -> Analyzer:
    kind = os.getenv("ANALYZER", "anthropic")
    if kind == "mock":
        return MockAnalyzer()
    if kind == "anthropic":
        # Imported lazily so mock mode never loads the SDK or touches the network.
        from .anthropic_analyzer import AnthropicAnalyzer

        return AnthropicAnalyzer()
    raise AnalyzerError(500, f"Unknown ANALYZER setting: {kind!r} (use 'mock' or 'anthropic').")
