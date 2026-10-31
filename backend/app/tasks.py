"""Persistence for approved tasks (SQLite, Python standard library only).

The database file defaults to backend/data/tasks.db and can be moved with TASKS_DB.
Each request opens its own short-lived connection; SQLite serializes writes
across connections, so no extra locking is needed.
"""
import os
import sqlite3
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from .schemas import Task, TaskCreate, TaskUpdate

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "tasks.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task       TEXT    NOT NULL,
    owner      TEXT    NOT NULL,
    deadline   TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('commitment', 'suggestion')),
    completed  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
)
"""
COLUMNS = "id, task, owner, deadline, kind, completed, created_at"


def db_path() -> Path:
    return Path(os.getenv("TASKS_DB", str(DEFAULT_DB)))


class TaskStore:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    @staticmethod
    def _row(row: sqlite3.Row) -> Task:
        return Task(**{**dict(row), "completed": bool(row["completed"])})

    def all(self) -> list[Task]:
        rows = self.conn.execute(f"SELECT {COLUMNS} FROM tasks ORDER BY id").fetchall()
        return [self._row(r) for r in rows]

    def get(self, task_id: int) -> Task | None:
        row = self.conn.execute(f"SELECT {COLUMNS} FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return self._row(row) if row else None

    def create_many(self, items: list[TaskCreate]) -> list[Task]:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        ids = []
        with self.conn:  # one transaction: all saved or none
            for item in items:
                cur = self.conn.execute(
                    "INSERT INTO tasks (task, owner, deadline, kind, completed, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (item.task, item.owner, item.deadline, item.kind, int(item.completed), now),
                )
                ids.append(cur.lastrowid)
        return [t for t in (self.get(i) for i in ids) if t]

    def update(self, task_id: int, changes: TaskUpdate) -> Task | None:
        fields = changes.model_dump(exclude_unset=True, exclude_none=True)
        if fields:
            assignments = ", ".join(f"{name} = ?" for name in fields)  # names come from the schema, not the client
            values = [int(v) if isinstance(v, bool) else v for v in fields.values()]
            with self.conn:
                self.conn.execute(f"UPDATE tasks SET {assignments} WHERE id = ?", (*values, task_id))
        return self.get(task_id)

    def delete(self, task_id: int) -> bool:
        with self.conn:
            return self.conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,)).rowcount > 0


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # FastAPI may open the connection (dependency) and use it (endpoint) on different
    # worker threads. That is safe here: each connection serves exactly one request,
    # sequentially, and is closed afterwards.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(SCHEMA)
    return conn


def get_store() -> Iterator[TaskStore]:
    """FastAPI dependency: one connection per request, always closed."""
    conn = connect()
    try:
        yield TaskStore(conn)
    finally:
        conn.close()
