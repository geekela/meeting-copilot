import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end tests start their own backend + frontend on dedicated ports,
// so they never collide with (or reuse) your normal dev servers on 8001/5174.
//
//   npm run test:e2e        -> offline mock analyzer + transcriber, no API calls, free
//   npm run test:e2e:live   -> real Claude + Mistral via backend/.env (paid API calls)
const LIVE = process.env.E2E_LIVE === "1";
const API_PORT = 8011;
const WEB_PORT = 5184;
const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;
// Throwaway database so tests never touch backend/data/tasks.db.
const TASKS_DB = join(mkdtempSync(join(tmpdir(), "meeting-copilot-e2e-")), "tasks.db");

export default defineConfig({
  testDir: "./e2e",
  timeout: LIVE ? 60_000 : 15_000,
  // Tests share one task database and reset it before each test, so run them one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A fake microphone (a test tone) that is allowed without a permission prompt.
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `../backend/.venv/bin/python -m uvicorn app.main:app --app-dir ../backend --port ${API_PORT}`,
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      env: {
        // Values set here win over backend/.env (load_dotenv never overrides).
        ANALYZER: LIVE ? "anthropic" : "mock",
        TRANSCRIBER: LIVE ? "mistral" : "mock",
        CORS_ORIGINS: WEB_URL,
        TASKS_DB,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: false,
      // Short recorder chunks so crash-recovery tests don't wait 10s for the first save.
      env: { VITE_API_URL: API_URL, VITE_RECORDER_CHUNK_MS: "500" },
    },
  ],
});
