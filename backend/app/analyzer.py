"""Analysis boundary.

Every analyzer implements `analyze(notes) -> list[ActionItem]`.
Implementations are selected via the ANALYZER env var (mock | anthropic)
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


# "Alice will ...", "Bob to ...", "Carol needs to ...", "Dan should ..."
OWNER_PATTERN = re.compile(
    r"^(?P<owner>[A-Z][a-z]+)\s+(?:will|to|needs to|should|must)\s+(?P<task>.+)$"
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

            owner = "Unassigned"
            if m := OWNER_PATTERN.match(line):
                owner, task = m["owner"], m["task"]
            elif m := PREFIX_PATTERN.match(line):
                task = m["task"]
            else:
                continue  # not an action item

            deadline = "No deadline"
            if d := DEADLINE_PATTERN.search(task):
                deadline = d["deadline"]
                task = task[: d.start()] + task[d.end():]

            task = task.strip(" ,")
            items.append(ActionItem(task=task[:1].upper() + task[1:], owner=owner, deadline=deadline))
        return items


def get_analyzer() -> Analyzer:
    kind = os.getenv("ANALYZER", "mock")
    if kind == "mock":
        return MockAnalyzer()
    if kind == "anthropic":
        # Imported lazily so mock mode never loads the SDK or touches the network.
        from .anthropic_analyzer import AnthropicAnalyzer

        return AnthropicAnalyzer()
    raise AnalyzerError(500, f"Unknown ANALYZER setting: {kind!r} (use 'mock' or 'anthropic').")
