import { expect, test, type Page } from "@playwright/test";

// Recording uses Chrome's fake microphone (see playwright.config.ts) and, by default,
// the backend's mock transcriber, so these tests are offline and free.
const LIVE = process.env.E2E_LIVE === "1";
const MOCK_FIRST_LINE = "Speaker 1: Alice will send the revised proposal by Friday.";

const notesBox = (page: Page) => page.getByPlaceholder("Paste meeting notes here...");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const recoveryNotice = (page: Page) => page.getByText(/You have an unsaved recording \(\d+ min\) from \d{2}:\d{2}\./);

async function clearStoredRecording(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase("meeting-copilot");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
  );
}

async function recordFor(page: Page, ms: number) {
  await button(page, "Record").click();
  await expect(page.getByText(/^Recording \d{2}:\d{2}$/)).toBeVisible();
  // Wait for a few recorder chunks to be stored.
  await page.waitForTimeout(ms);
}

test.skip(LIVE, "Recording tests use the fake mic; run them against the mock transcriber.");

test.beforeEach(async ({ page }) => {
  // Reloading mid-recording triggers the "leave this page?" prompt; accept it.
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await clearStoredRecording(page);
  await page.reload();
  await expect(button(page, "Record")).toBeEnabled();
});

test("record, stop, transcript lands in notes", async ({ page }) => {
  await recordFor(page, 1500);
  await button(page, "Stop").click();
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
  await expect(button(page, "Record")).toBeEnabled();
  // A transcribed recording is not offered for recovery.
  await page.reload();
  await expect(button(page, "Record")).toBeEnabled();
  await expect(recoveryNotice(page)).toHaveCount(0);
});

test("transcript is appended below existing notes", async ({ page }) => {
  await notesBox(page).fill("My own note.");
  await recordFor(page, 1000);
  await button(page, "Stop").click();
  await expect(notesBox(page)).toHaveValue(new RegExp(`^My own note\\.\\n\\n${MOCK_FIRST_LINE}`));
});

test("leaving mid-recording asks for confirmation", async ({ page }) => {
  await recordFor(page, 600);
  const dialog = page.waitForEvent("dialog");
  await page.reload();
  expect((await dialog).type()).toBe("beforeunload");
});

test("reload mid-recording offers recovery, and Transcribe uses it", async ({ page }) => {
  // Note what the page uploads (Playwright can't read Blob request bodies itself).
  await page.addInitScript(() => {
    const w = window as unknown as { __upload?: { head: string; size: number; type: string } };
    const fetch0 = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes("/api/transcribe") && init?.body instanceof Blob) {
        const head = new Uint8Array(await init.body.slice(0, 4).arrayBuffer());
        w.__upload = {
          head: Array.from(head, (b) => b.toString(16).padStart(2, "0")).join(""),
          size: init.body.size,
          type: new Headers(init.headers).get("content-type") ?? "",
        };
      }
      return fetch0(input, init);
    };
  });
  await page.reload();
  await recordFor(page, 1500);
  await page.reload();
  await expect(recoveryNotice(page)).toBeVisible();
  await button(page, "Transcribe").click();
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
  // The stitched chunks are a real WebM file (EBML header), sent as raw audio.
  const upload = await page.evaluate(() => (window as unknown as { __upload: unknown }).__upload);
  expect(upload).toMatchObject({ head: "1a45dfa3", type: expect.stringMatching(/^audio\/webm/) });
  expect((upload as { size: number }).size).toBeGreaterThan(1000);
  await expect(recoveryNotice(page)).toHaveCount(0);
  await page.reload();
  await expect(button(page, "Record")).toBeEnabled();
  await expect(recoveryNotice(page)).toHaveCount(0);
});

test("discard removes the stored recording", async ({ page }) => {
  await recordFor(page, 1500);
  await page.reload();
  await expect(recoveryNotice(page)).toBeVisible();
  await button(page, "Discard").click();
  await expect(recoveryNotice(page)).toHaveCount(0);
  await page.reload();
  await expect(button(page, "Record")).toBeEnabled();
  await expect(recoveryNotice(page)).toHaveCount(0);
  await expect(notesBox(page)).toHaveValue("");
});

test("failed transcription keeps the recording and Retry works", async ({ page }) => {
  await page.route("**/api/transcribe", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Mistral API error (HTTP 503)." }) }),
  );
  await recordFor(page, 1000);
  await button(page, "Stop").click();
  await expect(page.getByRole("alert")).toHaveText("Mistral API error (HTTP 503).");
  await expect(button(page, "Retry")).toBeVisible();
  await expect(notesBox(page)).toHaveValue("");

  // Still there after a reload, too.
  await page.reload();
  await expect(recoveryNotice(page)).toBeVisible();

  await page.unroute("**/api/transcribe");
  await button(page, "Transcribe").click();
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Retry resends the recording after a failure", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/transcribe", (route) => {
    calls += 1;
    if (calls === 1) {
      return route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ detail: "Transcription timed out. Please retry." }) });
    }
    return route.continue();
  });
  await recordFor(page, 1000);
  await button(page, "Stop").click();
  await expect(button(page, "Retry")).toBeVisible();
  await button(page, "Retry").click();
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
  expect(calls).toBe(2);
});

test("blocked microphone shows a clear error", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await page.reload();
  await button(page, "Record").click();
  await expect(page.getByRole("alert")).toHaveText(
    "Microphone access was blocked. Allow it in the browser's address bar and try again.",
  );
  await expect(page.getByText(/^Recording \d{2}:\d{2}$/)).toHaveCount(0);
  await expect(button(page, "Record")).toBeEnabled();
});

test("warns at 50 minutes and stops by itself at 59", async ({ page }) => {
  await page.clock.install();
  await page.reload();
  await button(page, "Record").click();
  await expect(page.getByText(/^Recording 00:0\d$/)).toBeVisible();
  await page.clock.fastForward(50 * 60_000);
  await expect(page.getByText("Recording stops automatically at 59 minutes.")).toBeVisible();
  await page.clock.fastForward(9 * 60_000);
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
  await expect(button(page, "Record")).toBeEnabled();
});

// --- Failure modes found in review -------------------------------------------

// Delays IndexedDB "open" while window.__slowIdb is true, to widen timing windows.
const slowIdbScript = () => {
  const w = window as unknown as { __slowIdb?: boolean };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory["open"]>) {
    const req = open.apply(this, args);
    if (!w.__slowIdb) return req;
    let held = true;
    req.addEventListener(
      "success",
      (e) => {
        if (!held) return;
        e.stopImmediatePropagation();
        setTimeout(() => {
          held = false;
          req.dispatchEvent(new Event("success"));
        }, 800);
      },
      { capture: true },
    );
    return req;
  };
};

test("Record stays disabled between Stop and transcription", async ({ page }) => {
  await page.addInitScript(slowIdbScript);
  await page.reload();
  await recordFor(page, 1000);
  await page.evaluate(() => ((window as unknown as { __slowIdb: boolean }).__slowIdb = true));
  await button(page, "Stop").click();
  // Starting a new recording here would wipe the one being finished.
  await expect(button(page, "Record")).toBeDisabled({ timeout: 300 });
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
});

test("Record waits until a saved recording has been checked for", async ({ page }) => {
  await page.addInitScript(slowIdbScript);
  await page.addInitScript(() => ((window as unknown as { __slowIdb: boolean }).__slowIdb = true));
  await page.reload();
  await expect(button(page, "Record")).toBeDisabled({ timeout: 300 });
  await expect(button(page, "Record")).toBeEnabled();
});

test("a failed save stops the recording and transcribes what was saved", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __failSaves?: boolean };
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
      if (w.__failSaves) throw new DOMException("disk full", "QuotaExceededError");
      return add.apply(this, args);
    };
  });
  await page.reload();
  await recordFor(page, 1500);
  await page.evaluate(() => ((window as unknown as { __failSaves: boolean }).__failSaves = true));
  await expect(page.getByText(/^Recording \d{2}:\d{2}$/)).toHaveCount(0);
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
  await expect(page.getByRole("alert")).toHaveText(
    "The browser stopped saving the recording, so it ended early. The part that was saved has been transcribed.",
  );
});

test("a recording running in another tab is not offered for recovery", async ({ page }) => {
  await recordFor(page, 1500);
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.getByText("A recording is in progress in another tab.")).toBeVisible();
  await expect(other.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Transcribe", exact: true })).toHaveCount(0);
  await other.getByRole("button", { name: "Record", exact: true }).click();
  await expect(other.getByRole("alert")).toHaveText("A recording is already running in another tab.");
  await other.close();
  await button(page, "Stop").click();
  await expect(notesBox(page)).toHaveValue(new RegExp(`^${MOCK_FIRST_LINE}`));
});

test("says so when nothing was saved from a recording", async ({ page }) => {
  await recordFor(page, 1000);
  await clearStoredRecording(page);
  await button(page, "Stop").click();
  await expect(page.getByRole("alert")).toHaveText("Nothing was saved from this recording.");
  await expect(button(page, "Record")).toBeEnabled();
});

test("a recorder that fails to start leaves no stuck recording", async ({ page }) => {
  await page.addInitScript(() => {
    MediaRecorder.prototype.start = () => {
      throw new DOMException("cannot start", "InvalidStateError");
    };
  });
  await page.reload();
  await button(page, "Record").click();
  await expect(page.getByRole("alert")).toHaveText("Could not start recording.");
  await expect(page.getByText(/^Recording \d{2}:\d{2}$/)).toHaveCount(0);
  await expect(button(page, "Record")).toBeEnabled();
});
