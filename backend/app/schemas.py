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


class AnalyzedItem(ActionItem):
    # Additive field, set by the API (not the model): id of an already-saved task
    # that this item duplicates, or None if it is new.
    duplicate_of: int | None = None


class AnalyzeResponse(BaseModel):
    action_items: list[AnalyzedItem]
    # Additive field: which analyzer produced the result ("mock" or "anthropic").
    analyzer: str


# --- Saved (approved) tasks -------------------------------------------------

class TaskCreate(ActionItem):
    """An approved action item the user wants to keep."""
    task: str = Field(..., min_length=1, max_length=500)
    owner: str = Field("Unassigned", max_length=200)
    deadline: str = Field("No deadline", max_length=200)
    completed: bool = False


class TaskCreateRequest(BaseModel):
    tasks: list[TaskCreate] = Field(..., min_length=1, max_length=200)


class TaskUpdate(BaseModel):
    """Partial update; only the fields a user can change after approval."""
    owner: str | None = Field(None, max_length=200)
    deadline: str | None = Field(None, max_length=200)
    completed: bool | None = None


class Task(TaskCreate):
    id: int
    created_at: str
