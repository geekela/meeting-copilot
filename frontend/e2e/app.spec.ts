import { expect, test, type Page } from "@playwright/test";

// Runs against the mock analyzer by default; E2E_LIVE=1 runs the same checks against Claude.
const ANALYZER = process.env.E2E_LIVE === "1" ? "anthropic" : "mock";

const NOTES = `Weekly sync - Q4 planning
Alice will send the revised proposal to the client by Friday.
Bob to update the budget spreadsheet before next week.
We discussed the timeline and everyone agreed it looks fine.`;

const notesBox = (page: Page) => page.getByPlaceholder("Paste meeting notes here...");
const analyzeButton = (page: Page) => page.getByRole("button", { name: "Analyze" });
const rows = (page: Page) => page.locator("tbody tr");

async function analyze(page: Page, notes: string) {
  await notesBox(page).fill(notes);
  await analyzeButton(page).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
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
  await expect(rows(page)).toHaveCount(body.action_items.length);

  const alice = rows(page).filter({ has: page.locator('input[value="Alice"]') });
  await expect(alice).toHaveCount(1);
  await expect(alice.locator(".task")).toContainText(/proposal/i);
  await expect(alice.locator("td").nth(3)).toContainText(/friday/i);

  const bob = rows(page).filter({ has: page.locator('input[value="Bob"]') });
  await expect(bob).toHaveCount(1);
  await expect(bob.locator(".task")).toContainText(/budget/i);
  await expect(bob.locator("td").nth(3)).toContainText(/next week/i);
});

test("items can be completed and reassigned once approved", async ({ page }) => {
  await analyze(page, NOTES);
  await expect(rows(page).first()).toBeVisible();
  const total = await rows(page).count();
  const first = rows(page).first();

  // Pending tasks cannot be ticked off.
  await expect(first.getByRole("checkbox")).toBeDisabled();
  await first.getByRole("button", { name: /^Approve/ }).click();
  await first.getByRole("checkbox").check();
  await expect(page.getByTestId("summary")).toHaveText(`1 approved · ${total - 1} to review · 1/1 done`);
  await expect(first).toHaveClass(/completed/);

  const owner = rows(page).last().locator(".owner-input");
  await owner.fill("Carla");
  await expect(owner).toHaveValue("Carla");
});

const CASUAL_NOTES = `ari takes care of booking venue
sam mentioned a nice vegan food restaurant
jules sends out invitations

mark says he would like to get drinks`;

test("casual notes produce four tasks to review, including suggestions", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator('tr[data-status="pending"]')).toHaveCount(4);
  for (const name of ["Ari", "Sam", "Jules", "Mark"]) {
    await expect(page.locator(`input[value="${name}"]`)).toHaveCount(1);
  }
  const suggestions = rows(page).filter({ has: page.locator(".tag", { hasText: "suggestion" }) });
  await expect(suggestions).toHaveCount(2);
  await expect(page.getByTestId("summary")).toHaveText("0 approved · 4 to review · 0/0 done");
});

test("tasks can be approved, removed and restored", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  await expect(rows(page)).toHaveCount(4);

  const ari = rows(page).filter({ has: page.locator('input[value="Ari"]') });
  await ari.getByRole("button", { name: /^Approve/ }).click();
  await expect(ari).toHaveAttribute("data-status", "approved");
  await expect(ari.getByText("✓ Approved")).toBeVisible();

  const mark = rows(page).filter({ has: page.locator('input[value="Mark"]') });
  await mark.getByRole("button", { name: /^Remove/ }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('input[value="Mark"]')).toHaveCount(0);
  await expect(page.getByTestId("summary")).toHaveText("1 approved · 2 to review · 0/1 done");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).last().locator(".owner-input")).toHaveValue("Mark"); // back in its original place
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("Approve all approves every pending task", async ({ page }) => {
  await analyze(page, CASUAL_NOTES);
  await page.getByRole("button", { name: "Approve all (4)" }).click();
  await expect(page.locator('tr[data-status="approved"]')).toHaveCount(4);
  await expect(page.getByRole("button", { name: /Approve all/ })).toHaveCount(0);
  await expect(page.getByTestId("summary")).toHaveText("4 approved · 0 to review · 0/4 done");
});

test("removing every task shows an empty message", async ({ page }) => {
  await analyze(page, "Alice will call the client.");
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().getByRole("button", { name: /^Remove/ }).click();
  await expect(page.getByText("All tasks removed.")).toBeVisible();
});

test("previous results are cleared while a new analysis runs", async ({ page }) => {
  await analyze(page, NOTES);
  await expect(rows(page).first()).toBeVisible();

  // Hold the second request until we have checked the loading state.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/analyze", async (route) => {
    await held;
    await route.continue();
  });

  await analyze(page, "Dan will ship the release tomorrow.");
  await expect(page.getByRole("button", { name: "Analyzing..." })).toBeDisabled();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator(".badge")).toHaveCount(0);

  release();
  await expect(page.locator(".badge")).toHaveText(`via ${ANALYZER}`);
  await expect(rows(page).first()).toBeVisible();
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
  await expect(rows(page)).toHaveCount(0);
});

test("shows the backend's error message on failure", async ({ page }) => {
  await page.route("**/api/analyze", (route) =>
    route.fulfill({ status: 502, json: { detail: "The model declined to analyze these notes." } }),
  );
  await analyze(page, NOTES);
  await expect(page.getByRole("alert")).toHaveText("The model declined to analyze these notes.");
});
