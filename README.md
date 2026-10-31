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
cp .env.example .env   # then set ANTHROPIC_API_KEY and MISTRAL_API_KEY
uvicorn app.main:app --reload --port 8001
```

`backend/.env` is loaded automatically on startup, and the backend uses Claude
(`ANALYZER=anthropic`) by default. Set `ANALYZER=mock` for an offline,
rule-based analyzer that makes no API calls.

Approved tasks are saved in a SQLite file at `backend/data/tasks.db` (created
automatically, not committed; move it with `TASKS_DB`). API:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/analyze` | Extract candidate tasks from notes |
| `POST` | `/api/transcribe` | Transcribe a recording (raw audio body, e.g. `Content-Type: audio/webm`) into speaker-labelled text |
| `GET` | `/api/tasks` | List saved tasks |
| `POST` | `/api/tasks` | Save approved tasks (`{"tasks": [...]}`, all-or-nothing) |
| `PATCH` | `/api/tasks/{id}` | Update `owner`, `deadline` and/or `completed` |
| `DELETE` | `/api/tasks/{id}` | Delete a saved task |

Tasks are never saved twice: `/api/analyze` marks items that match a saved task
(`duplicate_of`), and `POST /api/tasks` returns the existing task instead of storing a
copy. Matching ignores case, punctuation and articles ("Book the venue." = "book venue").

Run the tests with `pytest`. They always use the mock analyzer and transcriber and a throwaway database, so they never call an API or touch your saved tasks.

### Recording meetings

The **Record** button in the notes panel records your microphone (use Chrome).
Press **Stop** when the meeting ends: the audio goes to Mistral
(`voxtral-small-transcribe-3-0`, about $0.004 per minute) and the transcript is
added to the notes box, one line per speaker (`Speaker 1: …`). Rename speakers
by hand, then analyze as usual.

- **Join Teams on speakers, not headphones.** The app records only the
  microphone, so it hears the other participants through your speakers.
- Needs `MISTRAL_API_KEY` in `backend/.env`. Set `TRANSCRIBER=mock` for an
  offline stand-in that returns a fixed transcript. `MISTRAL_TRANSCRIBE_MODEL`
  overrides the model.
- Recordings stop automatically at **59 minutes**, just under Mistral's 60-minute
  limit per request, with a warning from 50.
- The audio is saved in the browser every 10 seconds while recording. If the
  tab crashes or is reloaded, the app offers to **Transcribe** or **Discard**
  the saved recording when you reopen it. After a failed upload, use **Retry**.
- Only one tab can record at a time.
- The recording is deleted once it is transcribed. Only the text is kept, in
  the notes box. The backend keeps the audio in memory only: it never writes it
  to disk or logs it.

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
npm run test:e2e                  # mock analyzer + transcriber: offline, free
npm run test:e2e:live             # real Claude via backend/.env (paid API calls)
```

Requires the backend virtualenv at `backend/.venv` (see above).

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests:
backend `pytest`, frontend lint + build, and the Playwright e2e suite. CI always uses the
mock analyzer, so it needs no secrets and makes no paid API calls.
