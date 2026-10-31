import { expect, test, type Page } from "@playwright/test";
import { API_URL } from "../playwright.config";

// Runs against the mock analyzer by default; E2E_LIVE=1 runs the same checks against Claude.
const ANALYZER = process.env.E2E_LIVE === "1" ? "anthropic" : "mock";

const NOTES = `Weekly sync - Q4 planning
Alice will send the revised proposal to the client by Friday.
Bob to update the budget spreadsheet before next week.
We discussed the timeline and everyone agreed it looks fine.`;

const CASUAL_NOTES = `ari takes care of booking venue
sam mentioned a nice vegan food restaurant
jules sends out invitations

mark says he would like to get drinks`;

const notesBox = (page: Page) => page.getByPlaceholder("Paste meeting notes here...");
const analyzeButton = (page: Page) => page.getByRole("button", { name: "Analyze" });
const review = (page: Page) => page.getByTestId("review-table").locator("tbody tr");
const saved = (page: Page) => page.getByTestId("saved-table").locator("tbody tr");
const savedSummary = (page: Page) => page.getByTestId("saved-summary");
const byOwner = (rows: ReturnType<typeof review>, owner: string) =>
  rows.filter({ has: rows.page().locator(`input[aria-label^="Owner"]`).and(rows.page().locator(`[value="${owner}"]`)) });

async function analyze(page: Page, notes: string) {
  await notesBox(page).fill(notes);
  await analyzeButton(page).click();
}

test.beforeEach(async ({ page, request }) => {
  // Start every test with no saved tasks.
  const tasks: { id: number }[] = await (await request.get(`${API_URL}/api/tasks`)).json();
  await Promise.all(tasks.map((t) => request.delete(`${API_URL}/api/tasks/${t.id}`)));
  await page.goto("/");
  await expect(page.getByText("No saved tasks yet.")).toBeVisible();
});

test("page loads and Analyze needs notes", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "AI Meeting Copilot" })).toBeVisible();
  await expect(analyzeButton(page)).toBeDisabled();
  await notesBox(page).fill("   ");
  await expect(analyzeButton(page)).toBeDisabled();
  await notesBox(page).fill("Alice will call the client.");
  await expect(analyzeButton(page)).toBeEnabled();
});

test("extracts action items end to end", async ({ page }) => {
  const response = page.waitForResponse("**/api/analyze");
  await analyze(page, NOTES);
  const body = await (await response).json();

  await expect(page.locator(".badge")).toHaveText(`via ${ANALYZER}`);
  await expect(review(page)).toHaveCount(body.action_items.length);

  const alice = byOwner(review(page), "Alice");
  await expect(alice).toHaveCount(1);
  await expect(alice.locator(".task")).toContainText(/proposal/i);
  await expect(alice.locator(".deadline-input")).toHaveValue(/friday/i);

  const bob = byOwner(review(page), "Bob");
  await expect(bob).toHaveCount(1);
  await expect(bob.locator(".task")).toContainText(/budget/i);
  await expect(bob.locator(".deadline-input")).toHaveValue(/next week/i);
});

test("casual notes produce four tasks to review, including suggestions", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  await expect(review(page)).toHaveCount(4);
  for (const name of ["Ari", "Sam", "Jules", "Mark"]) {
    await expect(byOwner(review(page), name)).toHaveCount(1);
  }
  await expect(review(page).filter({ has: page.locator(".tag", { hasText: "suggestion" }) })).toHaveCount(2);
  await expect(savedSummary(page)).toHaveText("0 saved · 0/0 done");
});

test("approved tasks are saved and survive a page reload", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  await expect(review(page)).toHaveCount(4);

  // Edit the owner before approving: the edited value is what gets saved.
  const ari = byOwner(review(page), "Ari");
  await ari.locator(".owner-input").fill("Ariana");
  await byOwner(review(page), "Ariana").getByRole("button", { name: /^Approve/ }).click();
  await byOwner(review(page), "Jules").getByRole("button", { name: /^Approve/ }).click();

  await expect(review(page)).toHaveCount(2);
  await expect(saved(page)).toHaveCount(2);
  await expect(savedSummary(page)).toHaveText("2 saved · 0/2 done");

  await page.reload();
  await expect(saved(page)).toHaveCount(2);
  await expect(byOwner(saved(page), "Ariana")).toHaveCount(1);
  await expect(byOwner(saved(page), "Jules")).toHaveCount(1);
  await expect(page.getByTestId("review-table")).toHaveCount(0); // unreviewed items are not kept
});

test("Approve all saves every task in one go", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  const post = page.waitForRequest((r) => r.url().endsWith("/api/tasks") && r.method() === "POST");
  await page.getByRole("button", { name: "Approve all (4)" }).click();
  expect((await post).postDataJSON().tasks).toHaveLength(4);

  await expect(saved(page)).toHaveCount(4);
  await expect(page.getByText("Nothing left to review.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve all/ })).toHaveCount(0);
  await page.reload();
  await expect(saved(page)).toHaveCount(4);
});

test("discarded tasks are not saved and can be restored", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  await byOwner(review(page), "Mark").getByRole("button", { name: /^Discard/ }).click();
  await expect(review(page)).toHaveCount(3);
  await expect(page.getByRole("status")).toContainText("Discarded");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(review(page)).toHaveCount(4);
  await expect(review(page).last().locator(".owner-input")).toHaveValue("Mark"); // original position
  await expect(saved(page)).toHaveCount(0);
});

test("saved tasks can be completed, reassigned and deleted, and changes persist", async ({ page }) => {
  await analyze(page, NOTES);
  await page.getByRole("button", { name: /Approve all/ }).click();
  await expect(saved(page).first()).toBeVisible();
  const total = await saved(page).count();

  await saved(page).first().getByRole("checkbox").check();
  await expect(saved(page).first()).toHaveClass(/completed/);
  await expect(savedSummary(page)).toHaveText(`${total} saved · 1/${total} done`);

  const owner = saved(page).last().locator(".owner-input");
  await owner.fill("Carla");
  await owner.press("Enter");
  await expect(byOwner(saved(page), "Carla")).toHaveCount(1);

  await page.reload();
  await expect(saved(page).first().getByRole("checkbox")).toBeChecked();
  await expect(saved(page).last().locator(".owner-input")).toHaveValue("Carla");

  // Delete, then undo restores it with the same content and status.
  await saved(page).first().getByRole("button", { name: /^Delete/ }).click();
  await expect(saved(page)).toHaveCount(total - 1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(saved(page)).toHaveCount(total);
  await expect(saved(page).locator('input[type="checkbox"]:checked')).toHaveCount(1);

  await saved(page).last().getByRole("button", { name: /^Delete/ }).click();
  await expect(saved(page)).toHaveCount(total - 1);
  await page.reload();
  await expect(saved(page)).toHaveCount(total - 1);
});

test("deadlines can be written before approving and edited after saving", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  const ari = byOwner(review(page), "Ari");
  const deadline = ari.locator(".deadline-input");
  await expect(deadline).toHaveValue(""); // "No deadline" shows as an empty field
  await expect(deadline).toHaveAttribute("placeholder", "No deadline");
  await deadline.fill("next Friday");
  await ari.getByRole("button", { name: /^Approve/ }).click();

  const savedAri = byOwner(saved(page), "Ari");
  await expect(savedAri.locator(".deadline-input")).toHaveValue("next Friday");

  // Edit after saving: saved on Enter, persists across reload.
  await savedAri.locator(".deadline-input").fill("end of Q3");
  await savedAri.locator(".deadline-input").press("Enter");
  await page.reload();
  await expect(byOwner(saved(page), "Ari").locator(".deadline-input")).toHaveValue("end of Q3");

  // Clearing the field stores "No deadline".
  const patch = page.waitForRequest((r) => r.method() === "PATCH");
  await byOwner(saved(page), "Ari").locator(".deadline-input").fill("");
  await byOwner(saved(page), "Ari").locator(".deadline-input").press("Enter");
  expect((await patch).postDataJSON()).toEqual({ deadline: "No deadline" });
  await page.reload();
  await expect(byOwner(saved(page), "Ari").locator(".deadline-input")).toHaveValue("");
});

test("a failed save keeps the task in review and shows the error", async ({ page }) => {
  await analyze(page, "Alice will call the client.");
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, json: { detail: "Database is unavailable." } })
      : route.continue(),
  );
  await review(page).first().getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByRole("alert")).toHaveText("Database is unavailable.");
  await expect(review(page)).toHaveCount(1);
  await expect(saved(page)).toHaveCount(0);
});

test("a failed update rolls the saved task back", async ({ page }) => {
  await analyze(page, "Alice will call the client.");
  await page.getByRole("button", { name: /Approve all/ }).click();
  await expect(saved(page)).toHaveCount(1);
  await page.route("**/api/tasks/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: { detail: "Could not save the change." } })
      : route.continue(),
  );
  await saved(page).first().getByRole("checkbox").click();
  await expect(page.getByRole("alert")).toHaveText("Could not save the change.");
  await expect(saved(page).first().getByRole("checkbox")).not.toBeChecked();
});

test("previous results are cleared while a new analysis runs", async ({ page }) => {
  await analyze(page, NOTES);
  await expect(review(page).first()).toBeVisible();

  // Hold the second request until we have checked the loading state.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/analyze", async (route) => {
    await held;
    await route.continue();
  });

  await analyze(page, "Dan will ship the release tomorrow.");
  await expect(page.getByRole("button", { name: "Analyzing..." })).toBeDisabled();
  await expect(page.getByTestId("review-table")).toHaveCount(0);
  await expect(page.locator(".badge")).toHaveCount(0);

  release();
  await expect(page.locator(".badge")).toHaveText(`via ${ANALYZER}`);
  await expect(review(page).first()).toBeVisible();
});

test("shows an empty state when there are no action items", async ({ page }) => {
  await analyze(page, "General discussion, nothing decided.");
  await expect(page.getByText("No action items found in these notes.")).toBeVisible();
});

test("Load sample fills the notes", async ({ page }) => {
  await page.getByRole("button", { name: "Load sample" }).click();
  await expect(notesBox(page)).toHaveValue(/Weekly sync/);
  await expect(analyzeButton(page)).toBeEnabled();
});

test("shows a friendly error when the backend is unreachable", async ({ page }) => {
  await page.route("**/api/analyze", (route) => route.abort());
  await analyze(page, NOTES);
  await expect(page.getByRole("alert")).toHaveText(/cannot reach the backend/i);
  await expect(page.getByTestId("review-table")).toHaveCount(0);
});

test("shows the backend's error message on failure", async ({ page }) => {
  await page.route("**/api/analyze", (route) =>
    route.fulfill({ status: 502, json: { detail: "The model declined to analyze these notes." } }),
  );
  await analyze(page, NOTES);
  await expect(page.getByRole("alert")).toHaveText("The model declined to analyze these notes.");
});
