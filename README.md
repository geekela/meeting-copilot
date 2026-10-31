# Meeting Copilot

Monorepo for the Meeting Copilot app.

| Path | Stack |
|------|-------|
| [`backend/`](backend) | Python API (FastAPI-style app in `app/`, tests in `tests/`) |
| [`frontend/`](frontend) | React + TypeScript + Vite |

## Getting started

### Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then set ANTHROPIC_API_KEY
uvicorn app.main:app --reload --port 8001
```

`backend/.env` is loaded automatically on startup, and the backend uses Claude
(`ANALYZER=anthropic`) by default. Set `ANALYZER=mock` for an offline,
rule-based analyzer that makes no API calls.

Run the tests with `pytest`. They always use the mock analyzer and never call the API.

### Frontend
```bash
cd frontend
npm install
npm run dev            # http://localhost:5174, talks to the backend on :8001
```
