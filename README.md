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

## End-to-end tests

Playwright drives the real UI in Chromium. The suite starts its own backend
(port 8011) and frontend (port 5184), so it doesn't clash with your dev servers.

```bash
cd frontend
npx playwright install chromium   # first time only
npm run test:e2e                  # mock analyzer: offline, free
npm run test:e2e:live             # real Claude via backend/.env (paid API calls)
```

Requires the backend virtualenv at `backend/.venv` (see above).

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests:
backend `pytest`, frontend lint + build, and the Playwright e2e suite. CI always uses the
mock analyzer, so it needs no secrets and makes no paid API calls.
