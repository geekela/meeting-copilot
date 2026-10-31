import { useEffect, useState } from "react";
import {
  analyzeNotes,
  deleteTask,
  listTasks,
  saveTasks,
  updateTask,
  type ActionItem,
  type SavedTask,
  type TaskChanges,
} from "./api";
import "./App.css";

const SAMPLE = `Weekly sync - Q4 planning
Alice will send the revised proposal to the client by Friday.
Bob to update the budget spreadsheet before next week.
Action: schedule a follow-up workshop.
Sam mentioned a nice vegan restaurant for the team dinner.
We discussed the timeline and everyone agreed it looks fine.`;

const NO_DEADLINE = "No deadline";
// Deadlines are free text. An empty field means (and is stored as) "No deadline".
const deadlineToInput = (deadline: string) => (deadline === NO_DEADLINE ? "" : deadline);
const inputToDeadline = (value: string) => value.trim() || NO_DEADLINE;

// Extracted items awaiting review live only in the browser.
// `id` is a client-side key; approved items get a backend id once saved.
type Candidate = ActionItem & { id: number };

// What "Undo" can bring back: a discarded candidate, or a deleted saved task.
type Undo =
  | { type: "candidate"; item: Candidate; index: number }
  | { type: "saved"; item: SavedTask };

export default function App() {
  const [notes, setNotes] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [saved, setSaved] = useState<SavedTask[]>([]);
  const [savedLoaded, setSavedLoaded] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [analyzer, setAnalyzer] = useState<string | null>(null);
  const [extractedCount, setExtractedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false); // a save/delete request is in flight
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTasks()
      .then(setSaved)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load saved tasks"))
      .finally(() => setSavedLoaded(true));
  }, []);

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    // Drop the previous results so they are never mistaken for the new analysis.
    setCandidates(null);
    setAnalyzer(null);
    setUndo(null);
    try {
      const result = await analyzeNotes(notes);
      setCandidates(result.action_items.map((item, i) => ({ ...item, id: i })));
      setExtractedCount(result.action_items.length);
      setAnalyzer(result.analyzer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  // --- Review: candidates -> saved -----------------------------------------

  function editCandidate(id: number, changes: Partial<Pick<Candidate, "owner" | "deadline">>) {
    setCandidates((prev) => prev && prev.map((c) => (c.id === id ? { ...c, ...changes } : c)));
  }

  async function approve(toApprove: Candidate[]) {
    if (toApprove.length === 0) return;
    const created = await run(() => saveTasks(toApprove.map(({ id: _id, ...item }) => item)));
    if (!created) return; // error shown; candidates stay so nothing is lost
    const approvedIds = new Set(toApprove.map((c) => c.id));
    setCandidates((prev) => prev && prev.filter((c) => !approvedIds.has(c.id)));
    setSaved((prev) => [...prev, ...created]);
    setUndo(null);
  }

  function discard(id: number) {
    if (!candidates) return;
    const index = candidates.findIndex((c) => c.id === id);
    if (index === -1) return;
    setUndo({ type: "candidate", item: candidates[index], index });
    setCandidates(candidates.filter((c) => c.id !== id));
  }

  // --- Saved tasks -----------------------------------------------------------

  async function changeSaved(id: number, changes: TaskChanges) {
    // Optimistic: show the change immediately, roll back if the backend rejects it.
    const before = saved.find((t) => t.id === id);
    if (!before) return;
    setSaved((prev) => prev.map((t) => (t.id === id ? { ...t, ...changes } : t)));
    const updated = await run(() => updateTask(id, changes));
    setSaved((prev) => prev.map((t) => (t.id === id ? (updated ?? before) : t)));
  }

  async function removeSaved(task: SavedTask) {
    const ok = await run(() => deleteTask(task.id).then(() => true));
    if (!ok) return;
    setSaved((prev) => prev.filter((t) => t.id !== task.id));
    setUndo({ type: "saved", item: task });
  }

  async function handleUndo() {
    if (!undo) return;
    if (undo.type === "candidate") {
      setCandidates((prev) => {
        const next = [...(prev ?? [])];
        next.splice(Math.min(undo.index, next.length), 0, undo.item);
        return next;
      });
      setUndo(null);
      return;
    }
    // Deleted saved task: save it again (it gets a new id, keeps its content and status).
    const { id: _id, created_at: _created, ...item } = undo.item;
    const created = await run(() => saveTasks([item]));
    if (!created) return;
    setSaved((prev) => [...prev, ...created]);
    setUndo(null);
  }

  const doneCount = saved.filter((t) => t.completed).length;

  return (
    <main className="container">
      <h1>AI Meeting Copilot</h1>
      <p className="subtitle">Paste your meeting notes to extract action items, then approve the ones to keep.</p>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Paste meeting notes here..."
        rows={8}
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

      {undo && (
        <div className="undo" role="status">
          {undo.type === "candidate" ? "Discarded" : "Deleted"} “{undo.item.task}”.
          <button className="link" onClick={handleUndo} disabled={busy}>Undo</button>
        </div>
      )}

      {candidates && (
        <section className="review-section" aria-labelledby="review-heading">
          <div className="results-header">
            <h2 id="review-heading">
              To review
              {analyzer && <span className="badge">via {analyzer}</span>}
            </h2>
            {candidates.length > 0 && (
              <button className="secondary small" onClick={() => approve(candidates)} disabled={busy}>
                Approve all ({candidates.length})
              </button>
            )}
          </div>

          {candidates.length === 0 ? (
            <p className="empty">
              {extractedCount === 0
                ? "No action items found in these notes."
                : "Nothing left to review."}
            </p>
          ) : (
            <table data-testid="review-table">
              <thead>
                <tr><th>Task</th><th>Owner</th><th>Deadline</th><th>Review</th></tr>
              </thead>
              <tbody>
                {candidates.map((item) => (
                  <tr key={item.id}>
                    <td className="task">
                      {item.task}
                      {item.kind === "suggestion" && <span className="tag">suggestion</span>}
                    </td>
                    <td>
                      <input
                        className="cell-input owner-input"
                        value={item.owner}
                        onChange={(e) => editCandidate(item.id, { owner: e.target.value })}
                        aria-label={`Owner of "${item.task}"`}
                      />
                    </td>
                    <td className="deadline">
                      <input
                        className="cell-input deadline-input"
                        value={deadlineToInput(item.deadline)}
                        placeholder={NO_DEADLINE}
                        onChange={(e) => editCandidate(item.id, { deadline: inputToDeadline(e.target.value) })}
                        aria-label={`Deadline of "${item.task}"`}
                      />
                    </td>
                    <td className="review">
                      <button className="small approve" onClick={() => approve([item])} disabled={busy}
                        aria-label={`Approve "${item.task}"`}>
                        Approve
                      </button>
                      <button className="small ghost" onClick={() => discard(item.id)} disabled={busy}
                        aria-label={`Discard "${item.task}"`}>
                        Discard
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="saved-section" aria-labelledby="saved-heading">
        <div className="results-header">
          <h2 id="saved-heading">Saved tasks</h2>
        </div>
        <p className="summary" data-testid="saved-summary">
          {saved.length} saved · {doneCount}/{saved.length} done
        </p>
        {!savedLoaded ? (
          <p className="empty">Loading…</p>
        ) : saved.length === 0 ? (
          <p className="empty">No saved tasks yet. Approve extracted tasks to keep them here.</p>
        ) : (
          <table data-testid="saved-table">
            <thead>
              <tr><th>Done</th><th>Task</th><th>Owner</th><th>Deadline</th><th></th></tr>
            </thead>
            <tbody>
              {saved.map((task) => (
                <SavedRow key={`${task.id}:${task.owner}:${task.deadline}`} task={task} busy={busy} onChange={changeSaved} onDelete={removeSaved} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function SavedRow({
  task,
  busy,
  onChange,
  onDelete,
}: {
  task: SavedTask;
  busy: boolean;
  onChange: (id: number, changes: TaskChanges) => void;
  onDelete: (task: SavedTask) => void;
}) {
  // Edit text fields locally and save on blur/Enter, not on every keystroke.
  // The parent keys this row by id+owner+deadline, so a saved change resets local state.
  const [owner, setOwner] = useState(task.owner);
  const [deadline, setDeadline] = useState(deadlineToInput(task.deadline));
  const commitOwner = () => {
    if (owner.trim() && owner !== task.owner) onChange(task.id, { owner });
    else setOwner(task.owner);
  };
  const commitDeadline = () => {
    const next = inputToDeadline(deadline);
    if (next !== task.deadline) onChange(task.id, { deadline: next });
    else setDeadline(deadlineToInput(task.deadline));
  };
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur();

  return (
    <tr className={task.completed ? "completed" : undefined}>
      <td>
        <input
          type="checkbox"
          checked={task.completed}
          disabled={busy}
          onChange={() => onChange(task.id, { completed: !task.completed })}
          aria-label={`Mark "${task.task}" as completed`}
        />
      </td>
      <td className="task">
        {task.task}
        {task.kind === "suggestion" && <span className="tag">suggestion</span>}
      </td>
      <td>
        <input
          className="cell-input owner-input"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          onBlur={commitOwner}
          onKeyDown={blurOnEnter}
          aria-label={`Owner of "${task.task}"`}
        />
      </td>
      <td className="deadline">
        <input
          className="cell-input deadline-input"
          value={deadline}
          placeholder={NO_DEADLINE}
          onChange={(e) => setDeadline(e.target.value)}
          onBlur={commitDeadline}
          onKeyDown={blurOnEnter}
          aria-label={`Deadline of "${task.task}"`}
        />
      </td>
      <td className="review">
        <button className="small ghost" onClick={() => onDelete(task)} disabled={busy}
          aria-label={`Delete "${task.task}"`}>
          Delete
        </button>
      </td>
    </tr>
  );
}
