// Mirrors backend/app/schemas.py — keep in sync with the Pydantic models.
export interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
  kind: "commitment" | "suggestion";
}

export interface AnalyzeResponse {
  action_items: ActionItem[];
  analyzer: string; // "mock" | "anthropic"
}

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8001";

export async function analyzeNotes(notes: string): Promise<AnalyzeResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  } catch {
    throw new Error("Cannot reach the backend. Is it running on port 8001?");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail : `Request failed (${res.status})`;
    throw new Error(detail);
  }
  return (await res.json()) as AnalyzeResponse;
}
