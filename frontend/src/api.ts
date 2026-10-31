// Mirrors backend/app/schemas.py — keep in sync with the Pydantic models.
export interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
  kind: "commitment" | "suggestion";
}

/** An extracted item; `duplicate_of` is the id of a saved task it repeats, if any. */
export interface AnalyzedItem extends ActionItem {
  duplicate_of: number | null;
}

export interface AnalyzeResponse {
  action_items: AnalyzedItem[];
  analyzer: string; // "mock" | "anthropic"
}

/** An approved task stored on the backend. */
export interface SavedTask extends ActionItem {
  id: number;
  completed: boolean;
  created_at: string;
}

export type TaskChanges = Partial<Pick<SavedTask, "owner" | "deadline" | "completed">>;

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error("Cannot reach the backend. Is it running on port 8001?");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail : `Request failed (${res.status})`;
    throw new Error(detail);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function analyzeNotes(notes: string): Promise<AnalyzeResponse> {
  return request("/api/analyze", { method: "POST", body: JSON.stringify({ notes }) });
}

export function listTasks(): Promise<SavedTask[]> {
  return request("/api/tasks");
}

/**
 * Saves one or more approved items in a single all-or-nothing request.
 * Returns one task per item; an item that was already saved returns the existing task.
 */
export function saveTasks(tasks: (ActionItem & { completed?: boolean })[]): Promise<SavedTask[]> {
  const body = tasks.map(({ task, owner, deadline, kind, completed }) => ({ task, owner, deadline, kind, completed }));
  return request("/api/tasks", { method: "POST", body: JSON.stringify({ tasks: body }) });
}

export function updateTask(id: number, changes: TaskChanges): Promise<SavedTask> {
  return request(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
}

export function deleteTask(id: number): Promise<void> {
  return request(`/api/tasks/${id}`, { method: "DELETE" });
}
