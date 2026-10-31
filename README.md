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
cp .env.example .env   # then fill in your keys
pytest
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```
