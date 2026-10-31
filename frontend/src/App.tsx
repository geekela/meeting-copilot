import { useEffect, useState } from "react";
import {
  analyzeNotes,
  deleteTask,
  listTasks,
  saveTasks,
  updateTask,
  type AnalyzedItem,
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
const MAX_NOTES = 60_000; // backend limit (AnalyzeRequest.notes)
// Deadlines are free text. An empty field means (and is stored as) "No deadline".
const deadlineToInput = (deadline: string) => (deadline === NO_DEADLINE ? "" : deadline);
const inputToDeadline = (value: string) => value.trim() || NO_DEADLINE;

// Extracted items awaiting review live only in the browser.
// `id` is a client-side key; approved items get a backend id once saved.
type Candidate = AnalyzedItem & { id: number };

// Adds newly returned tasks to the list; tasks already shown (same id) are not repeated.
function mergeSaved(list: SavedTask[], incoming: SavedTask[]): SavedTask[] {
  const ids = new Set(list.map((t) => t.id));
  return [...list, ...incoming.filter((t) => !ids.has(t.id) && ids.add(t.id))];
}

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
    setSaved((prev) => mergeSaved(prev, created));
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
    setSaved((prev) => mergeSaved(prev, created));
    setUndo(null);
  }

  // A candidate is "already saved" while the task it duplicates is still in the saved list
  // (if that task gets deleted, the candidate becomes approvable again).
  const savedIds = new Set(saved.map((t) => t.id));
  const isAlreadySaved = (c: Candidate) => c.duplicate_of !== null && savedIds.has(c.duplicate_of);
  const newCandidates = candidates?.filter((c) => !isAlreadySaved(c)) ?? [];
  const duplicateCount = (candidates?.length ?? 0) - newCandidates.length;

  const doneCount = saved.filter((t) => t.completed).length;

  const progress = saved.length ? Math.round((doneCount / saved.length) * 100) : 0;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16M4 12h10M4 18h7" />
              <path d="M17 15l2 2 4-4" />
            </svg>
          </span>
          <h1>AI Meeting Copilot</h1>
        </div>
      </header>

      <main className="container">
        <div className="intro">
          <p className="lead">Turn meeting notes into tasks</p>
          <p className="subtitle">Paste your notes, review what Copilot pulled out, and keep only the tasks that matter.</p>
        </div>

        {error && <div className="error" role="alert">{error}</div>}

        <div className="workspace">
          <section className="panel notes-panel" aria-labelledby="notes-heading">
            <div className="panel-header">
              <h2 id="notes-heading"><span className="step">1</span>Meeting notes</h2>
              <span className={`char-count${notes.length > MAX_NOTES ? " over" : ""}`}>
                {notes.length.toLocaleString("en-US")} / {MAX_NOTES.toLocaleString("en-US")}
              </span>
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Paste meeting notes here..."
              aria-labelledby="notes-heading"
              rows={12}
            />
            <div className="actions">
              <button className="primary" onClick={handleAnalyze} disabled={loading || !notes.trim()}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
                </svg>
                {loading ? "Analyzing..." : "Analyze notes"}
              </button>
              <button className="secondary" onClick={() => setNotes(SAMPLE)} disabled={loading}>
                Load sample
              </button>
            </div>
          </section>

          <section className="panel review-section" aria-labelledby="review-heading">
            <div className="panel-header">
              <div>
                <h2 id="review-heading">
                  <span className="step">2</span>To review
                  {analyzer && <span className="badge">via {analyzer}</span>}
                </h2>
                {duplicateCount > 0 && (
                  <p className="summary" data-testid="review-summary">
                    {newCandidates.length === 0
                      ? "All of these tasks are already saved."
                      : `${duplicateCount} already saved · ${newCandidates.length} new`}
                  </p>
                )}
              </div>
              {newCandidates.length > 0 && (
                <button className="dark" onClick={() => approve(newCandidates)} disabled={busy}>
                  Approve all ({newCandidates.length})
                </button>
              )}
            </div>

            {!candidates ? (
              <p className="empty">
                {loading ? "Reading your notes…" : "Analyze your notes to see the tasks Copilot finds."}
              </p>
            ) : candidates.length === 0 ? (
              <p className="empty">
                {extractedCount === 0
                  ? "No action items found in these notes."
                  : "Nothing left to review."}
              </p>
            ) : (
              <div className="table-scroll">
                <table className="review-table" data-testid="review-table">
                  <thead>
                    <tr><th>Task</th><th>Owner</th><th>Deadline</th><th><span className="sr-only">Review</span></th></tr>
                  </thead>
                  <tbody>
                    {candidates.map((item) => {
                      const alreadySaved = isAlreadySaved(item);
                      return (
                      <tr key={item.id} className={alreadySaved ? "duplicate" : undefined}>
                        <td className="task">
                          {item.task}
                          {item.kind === "suggestion" && <span className="tag">suggestion</span>}
                        </td>
                        <td>
                          <input
                            className="cell-input owner-input"
                            value={item.owner}
                            disabled={alreadySaved}
                            onChange={(e) => editCandidate(item.id, { owner: e.target.value })}
                            aria-label={`Owner of "${item.task}"`}
                          />
                        </td>
                        <td className="deadline">
                          <input
                            className="cell-input deadline-input"
                            value={deadlineToInput(item.deadline)}
                            placeholder={NO_DEADLINE}
                            disabled={alreadySaved}
                            onChange={(e) => editCandidate(item.id, { deadline: inputToDeadline(e.target.value) })}
                            aria-label={`Deadline of "${item.task}"`}
                          />
                        </td>
                        <td className="review">
                          {alreadySaved ? (
                            <span className="saved-label" title="This task is already in your saved tasks">
                              Already saved
                            </span>
                          ) : (
                            <button className="approve" onClick={() => approve([item])} disabled={busy}
                              aria-label={`Approve "${item.task}"`}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M5 12l5 5 9-10" />
                              </svg>
                              Approve
                            </button>
                          )}
                          <button className="ghost" onClick={() => discard(item.id)} disabled={busy}
                            aria-label={`Discard "${item.task}"`}>
                            {alreadySaved ? "Dismiss" : "Discard"}
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <section className="panel saved-section" aria-labelledby="saved-heading">
          <div className="panel-header">
            <div>
              <h2 id="saved-heading"><span className="step">3</span>Saved tasks</h2>
              <p className="summary" data-testid="saved-summary">
                {saved.length} saved · {doneCount}/{saved.length} done
              </p>
            </div>
            {saved.length > 0 && (
              <div className="progress" role="progressbar" aria-label="Tasks done"
                aria-valuemin={0} aria-valuemax={saved.length} aria-valuenow={doneCount}>
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
          {!savedLoaded ? (
            <p className="empty">Loading…</p>
          ) : saved.length === 0 ? (
            <p className="empty">No saved tasks yet. Approve extracted tasks to keep them here.</p>
          ) : (
            <div className="table-scroll">
              <table className="saved-table" data-testid="saved-table">
                <thead>
                  <tr><th>Done</th><th>Task</th><th>Owner</th><th>Deadline</th><th><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {saved.map((task) => (
                    <SavedRow key={`${task.id}:${task.owner}:${task.deadline}`} task={task} busy={busy} onChange={changeSaved} onDelete={removeSaved} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {undo && (
        <div className="undo" role="status">
          <span>{undo.type === "candidate" ? "Discarded" : "Deleted"} “{undo.item.task}”.</span>
          <button className="undo-button" onClick={handleUndo} disabled={busy}>Undo</button>
        </div>
      )}
    </>
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
      <td className="done">
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
        <button className="ghost" onClick={() => onDelete(task)} disabled={busy}
          aria-label={`Delete "${task.task}"`}>
          Delete
        </button>
      </td>
    </tr>
  );
}
