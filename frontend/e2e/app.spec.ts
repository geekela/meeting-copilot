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

test("items can be completed and reassigned", async ({ page }) => {
  await analyze(page, NOTES);
  await expect(rows(page).first()).toBeVisible();
  const total = await rows(page).count();
  const heading = page.getByRole("heading", { level: 2 });

  await rows(page).first().getByRole("checkbox").check();
  await expect(heading).toContainText(`(1/${total} completed)`);
  await expect(rows(page).first()).toHaveClass("completed");

  const owner = rows(page).last().locator(".owner-input");
  await owner.fill("Carla");
  await expect(owner).toHaveValue("Carla");
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
