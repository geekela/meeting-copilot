"""Test setup: runs before app.main is imported, so backend/.env never takes effect.

load_dotenv() does not override variables that already exist, so pinning them here
keeps the suite on the offline mock analyzer/transcriber and away from the real API keys.
"""
import os
import tempfile
from pathlib import Path

import pytest

os.environ["ANALYZER"] = "mock"
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["ANTHROPIC_WORKSPACE_ID"] = ""
os.environ["TRANSCRIBER"] = "mock"
os.environ["MISTRAL_API_KEY"] = ""

# Never touch the real backend/data/tasks.db from tests.
_TEST_DB = Path(tempfile.mkdtemp(prefix="meeting-copilot-tests-")) / "tasks.db"
os.environ["TASKS_DB"] = str(_TEST_DB)


@pytest.fixture(autouse=True)
def _fresh_tasks_db():
    """Every test starts with an empty task table."""
    _TEST_DB.unlink(missing_ok=True)
    yield
    _TEST_DB.unlink(missing_ok=True)
