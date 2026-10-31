import logging
import os
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env automatically, whatever directory uvicorn is started from.
# Variables already set in the shell take precedence over the file.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .analyzer import Analyzer, AnalyzerError, get_analyzer
from .schemas import AnalyzeRequest, AnalyzeResponse

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


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest, analyzer: Analyzer = Depends(get_analyzer)) -> AnalyzeResponse:
    if not req.notes.strip():
        raise HTTPException(status_code=422, detail="Notes must not be blank.")
    try:
        items = analyzer.analyze(req.notes)
    except AnalyzerError:
        raise
    except Exception as exc:  # unexpected bug: log the type only, return a generic message
        logger.exception("Unexpected analyzer failure: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Analysis failed unexpectedly.") from exc
    return AnalyzeResponse(action_items=items, analyzer=analyzer.name)
