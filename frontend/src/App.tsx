import { useState } from "react";
import { analyzeNotes, type ActionItem } from "./api";
import "./App.css";

const SAMPLE = `Weekly sync - Q4 planning
Alice will send the revised proposal to the client by Friday.
Bob to update the budget spreadsheet before next week.
Action: schedule a follow-up workshop.
Sam mentioned a nice vegan restaurant for the team dinner.
We discussed the timeline and everyone agreed it looks fine.`;

// Frontend-only state layered on top of the API contract.
// `id` is a client-side key so edits target one item; it is never sent to the backend.
// Every extracted task starts as "pending" until the user approves or removes it.
type ReviewStatus = "pending" | "approved";
type EditableItem = ActionItem & { id: number; status: ReviewStatus; completed: boolean };
type Removed = { item: EditableItem; index: number };

export default function App() {
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<EditableItem[] | null>(null);
  const [lastRemoved, setLastRemoved] = useState<Removed | null>(null);
  const [analyzer, setAnalyzer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    // Drop the previous results so they are never mistaken for the new analysis.
    setItems(null);
    setAnalyzer(null);
    setLastRemoved(null);
    try {
      const result = await analyzeNotes(notes);
      // Each analysis replaces previous edits with a fresh set awaiting review.
      setItems(result.action_items.map((item, i) => ({ ...item, id: i, status: "pending", completed: false })));
      setAnalyzer(result.analyzer);
    } catch (e) {
      setItems(null);
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  // Immutable update: copy only the matching item, leave all others untouched.
  function updateItem(id: number, changes: Partial<Pick<EditableItem, "owner" | "completed" | "status">>) {
    setItems((prev) => prev && prev.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  function approveAll() {
    setItems((prev) => prev && prev.map((item) => ({ ...item, status: "approved" })));
  }

  function removeItem(id: number) {
    if (!items) return;
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    setLastRemoved({ item: items[index], index });
    setItems(items.filter((item) => item.id !== id));
  }

  function undoRemove() {
    if (!lastRemoved || !items) return;
    const next = [...items];
    next.splice(Math.min(lastRemoved.index, next.length), 0, lastRemoved.item);
    setItems(next);
    setLastRemoved(null);
  }

  const approved = items?.filter((i) => i.status === "approved") ?? [];
  const pendingCount = (items?.length ?? 0) - approved.length;
  const doneCount = approved.filter((i) => i.completed).length;

  return (
    <main className="container">
      <h1>AI Meeting Copilot</h1>
      <p className="subtitle">Paste your meeting notes to extract action items, then approve or remove each one.</p>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Paste meeting notes here..."
        rows={10}
      />
      <div className="actions">
        <button onClick={handleAnalyze} disabled={loading || !notes.trim()}>
          {loading ? "Analyzing..." : "Analyze"}
        </button>
        <button className="secondary" onClick={() => setNotes(SAMPLE)} disabled={loading}>
          Load sample
        </button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {items && (
        <section>
          <div className="results-header">
            <h2>
              Action items
              {analyzer && <span className="badge">via {analyzer}</span>}
            </h2>
            {pendingCount > 0 && (
              <button className="secondary small" onClick={approveAll}>
                Approve all ({pendingCount})
              </button>
            )}
          </div>
          <p className="summary" data-testid="summary">
            {approved.length} approved · {pendingCount} to review · {doneCount}/{approved.length} done
          </p>

          {lastRemoved && (
            <div className="undo" role="status">
              Removed “{lastRemoved.item.task}”.
              <button className="link" onClick={undoRemove}>Undo</button>
            </div>
          )}

          {items.length === 0 ? (
            <p className="empty">
              {lastRemoved ? "All tasks removed." : "No action items found in these notes."}
            </p>
          ) : (
            <table>
              <thead>
                <tr><th>Done</th><th>Task</th><th>Owner</th><th>Deadline</th><th>Review</th></tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    data-status={item.status}
                    className={[item.status, item.completed ? "completed" : ""].join(" ").trim()}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={item.completed}
                        disabled={item.status !== "approved"}
                        title={item.status !== "approved" ? "Approve the task first" : undefined}
                        onChange={() => updateItem(item.id, { completed: !item.completed })}
                        aria-label={`Mark "${item.task}" as completed`}
                      />
                    </td>
                    <td className="task">
                      {item.task}
                      {item.kind === "suggestion" && <span className="tag">suggestion</span>}
                    </td>
                    <td>
                      <input
                        className="owner-input"
                        value={item.owner}
                        onChange={(e) => updateItem(item.id, { owner: e.target.value })}
                        aria-label={`Owner of "${item.task}"`}
                      />
                    </td>
                    <td>{item.deadline}</td>
                    <td className="review">
                      {item.status === "pending" ? (
                        <button className="small approve" onClick={() => updateItem(item.id, { status: "approved" })}
                          aria-label={`Approve "${item.task}"`}>
                          Approve
                        </button>
                      ) : (
                        <span className="approved-label">✓ Approved</span>
                      )}
                      <button className="small ghost" onClick={() => removeItem(item.id)}
                        aria-label={`Remove "${item.task}"`}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
