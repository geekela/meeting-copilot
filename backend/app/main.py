import logging
import os
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env automatically, whatever directory uvicorn is started from.
# Variables already set in the shell take precedence over the file.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
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


# An hour at 32 kbps is about 15 MB; leave headroom for other encoders.
MAX_AUDIO_BYTES = 50 * 1024 * 1024
AUDIO_FILENAMES = {"audio/ogg": "recording.ogg", "audio/mp4": "recording.m4a", "audio/wav": "recording.wav"}


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
async def transcribe(request: Request, transcriber: Transcriber = Depends(get_transcriber)) -> TranscribeResponse:
    # The recording is the raw request body, read into memory: unlike a multipart
    # upload it is never spooled to a temp file, and it is never logged.
    content_type = (request.headers.get("content-type") or "audio/webm").split(";")[0].strip().lower()
    if not content_type.startswith("audio/"):
        raise HTTPException(status_code=415, detail="Send the recording as audio.")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_AUDIO_BYTES:  # stop reading early instead of buffering everything
            raise HTTPException(status_code=413, detail="The recording is too large to transcribe.")
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=422, detail="The recording is empty.")
    filename = AUDIO_FILENAMES.get(content_type, "recording.webm")
    try:
        # The transcriber makes a blocking HTTP call; keep it off the event loop.
        text = await run_in_threadpool(transcriber.transcribe, data, filename, content_type)
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
