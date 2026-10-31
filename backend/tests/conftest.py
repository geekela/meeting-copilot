"""Test setup: runs before app.main is imported, so backend/.env never takes effect.

load_dotenv() does not override variables that already exist, so pinning them here
keeps the suite on the offline mock analyzer and away from the real API key.
"""
import os

os.environ["ANALYZER"] = "mock"
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["ANTHROPIC_WORKSPACE_ID"] = ""
