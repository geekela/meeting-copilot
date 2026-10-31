import { useState } from "react";
import { analyzeNotes, type ActionItem } from "./api";
import "./App.css";

const SAMPLE = `Weekly sync - Q4 planning
Alice will send the revised proposal to the client by Friday.
Bob to update the budget spreadsheet before next week.
Action: schedule a follow-up workshop.
We discussed the timeline and everyone agreed it looks fine.`;

// Frontend-only state layered on top of the API contract.
// `id` is a client-side key so edits target one item; it is never sent to the backend.
type EditableItem = ActionItem & { id: number; completed: boolean };

export default function App() {
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<EditableItem[] | null>(null);
  const [analyzer, setAnalyzer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    try {
      const result = await analyzeNotes(notes);
      // Each analysis replaces previous edits with a fresh editable set.
      setItems(result.action_items.map((item, i) => ({ ...item, id: i, completed: false })));
      setAnalyzer(result.analyzer);
    } catch (e) {
      setItems(null);
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  // Immutable update: copy only the matching item, leave all others untouched.
  function updateItem(id: number, changes: Partial<Pick<EditableItem, "owner" | "completed">>) {
    setItems((prev) => prev && prev.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  return (
    <main className="container">
      <h1>AI Meeting Copilot</h1>
      <p className="subtitle">Paste your meeting notes to extract action items.</p>

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
          <h2>
            Action items ({items.filter((i) => i.completed).length}/{items.length} completed)
            {analyzer && <span className="badge">via {analyzer}</span>}
          </h2>
          {items.length === 0 ? (
            <p className="empty">No action items found in these notes.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Done</th><th>Task</th><th>Owner</th><th>Deadline</th></tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={item.completed ? "completed" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={item.completed}
                        onChange={() => updateItem(item.id, { completed: !item.completed })}
                        aria-label={`Mark "${item.task}" as completed`}
                      />
                    </td>
                    <td className="task">{item.task}</td>
                    <td>
                      <input
                        className="owner-input"
                        value={item.owner}
                        onChange={(e) => updateItem(item.id, { owner: e.target.value })}
                        aria-label={`Owner of "${item.task}"`}
                      />
                    </td>
                    <td>{item.deadline}</td>
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
