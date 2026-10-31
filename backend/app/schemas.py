"""API contract. The frontend depends only on these shapes."""
from typing import Literal

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    notes: str = Field(..., min_length=1, max_length=20_000)


class ActionItem(BaseModel):
    task: str
    owner: str = "Unassigned"
    deadline: str = "No deadline"
    # "commitment": someone took on or was assigned the task.
    # "suggestion": an idea, recommendation or wish that might become a task; the user decides.
    kind: Literal["commitment", "suggestion"] = "commitment"


class ExtractedActionItems(BaseModel):
    """What an analyzer produces. Also used as Claude's structured-output schema."""
    action_items: list[ActionItem]


class AnalyzeResponse(ExtractedActionItems):
    # Additive field: which analyzer produced the result ("mock" or "anthropic").
    analyzer: str
