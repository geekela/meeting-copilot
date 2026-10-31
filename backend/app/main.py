import logging
import os
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env automatically, whatever directory uvicorn is started from.
# Variables already set in the shell take precedence over the file.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .analyzer import Analyzer, AnalyzerError, get_analyzer
from .schemas import (
    AnalyzedItem,
    AnalyzeRequest,
    AnalyzeResponse,
    Task,
    TaskCreateRequest,
    TaskUpdate,
    TranscribeResponse,
)
from .tasks import TaskStore, get_store, task_key
from .transcriber import Transcriber, TranscriberError, get_transcriber

logger = logging.getLogger(__name__)

app = FastAPI(title="AI Meeting Copilot")

app.add_middleware(
    CORSMiddleware,
    # Comma-separated list; the default matches the Vite dev server.
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AnalyzerError)
def analyzer_error_handler(_: Request, exc: AnalyzerError) -> JSONResponse:
    # Same {"detail": ...} shape as HTTPException, so the frontend handles both alike.
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


@app.exception_handler(TranscriberError)
def transcriber_error_handler(_: Request, exc: TranscriberError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


# 90 minutes at 32 kbps is about 22 MB; leave headroom for other encoders.
MAX_AUDIO_BYTES = 50 * 1024 * 1024


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(
    req: AnalyzeRequest,
    analyzer: Analyzer = Depends(get_analyzer),
    store: TaskStore = Depends(get_store),
) -> AnalyzeResponse:
    if not req.notes.strip():
        raise HTTPException(status_code=422, detail="Notes must not be blank.")
    try:
        items = analyzer.analyze(req.notes)
    except AnalyzerError:
        raise
    except Exception as exc:  # unexpected bug: log the type only, return a generic message
        logger.exception("Unexpected analyzer failure: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Analysis failed unexpectedly.") from exc
    return AnalyzeResponse(action_items=mark_duplicates(items, store.keys()), analyzer=analyzer.name)


@app.post("/api/transcribe", response_model=TranscribeResponse)
def transcribe(audio: UploadFile, transcriber: Transcriber = Depends(get_transcriber)) -> TranscribeResponse:
    # Held in memory for this request only: never written to disk or logged.
    data = audio.file.read(MAX_AUDIO_BYTES + 1)
    if not data:
        raise HTTPException(status_code=422, detail="The recording is empty.")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="The recording is too large to transcribe.")
    try:
        text = transcriber.transcribe(data, audio.filename or "recording.webm", audio.content_type or "audio/webm")
    except TranscriberError:
        raise
    except Exception as exc:  # unexpected bug: log the type only
        logger.exception("Unexpected transcriber failure: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Transcription failed unexpectedly.") from exc
    return TranscribeResponse(transcript=text, transcriber=transcriber.name)


def mark_duplicates(items, saved_keys: dict[str, int]) -> list[AnalyzedItem]:
    """Flag items that are already saved; drop repeats within the same result."""
    seen: set[str] = set()
    result = []
    for item in items:
        key = task_key(item.task)
        if key in seen:
            continue
        seen.add(key)
        result.append(AnalyzedItem(**item.model_dump(), duplicate_of=saved_keys.get(key)))
    return result


# --- Saved (approved) tasks -------------------------------------------------

@app.get("/api/tasks", response_model=list[Task])
def list_tasks(store: TaskStore = Depends(get_store)) -> list[Task]:
    return store.all()


@app.post("/api/tasks", response_model=list[Task], status_code=201)
def create_tasks(req: TaskCreateRequest, store: TaskStore = Depends(get_store)) -> list[Task]:
    # Accepts a list so "Approve all" is a single, all-or-nothing request.
    return store.create_many(req.tasks)


@app.patch("/api/tasks/{task_id}", response_model=Task)
def update_task(task_id: int, changes: TaskUpdate, store: TaskStore = Depends(get_store)) -> Task:
    task = store.update(task_id, changes)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return task


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, store: TaskStore = Depends(get_store)) -> None:
    if not store.delete(task_id):
        raise HTTPException(status_code=404, detail="Task not found.")
