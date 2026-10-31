import { defineConfig, devices } from "@playwright/test";

// End-to-end tests start their own backend + frontend on dedicated ports,
// so they never collide with (or reuse) your normal dev servers on 8001/5174.
//
//   npm run test:e2e        -> offline mock analyzer, no API calls, free
//   npm run test:e2e:live   -> real Claude via backend/.env (paid API calls)
const LIVE = process.env.E2E_LIVE === "1";
const API_PORT = 8011;
const WEB_PORT = 5184;
const WEB_URL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: LIVE ? 60_000 : 15_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `../backend/.venv/bin/python -m uvicorn app.main:app --app-dir ../backend --port ${API_PORT}`,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        // Values set here win over backend/.env (load_dotenv never overrides).
        ANALYZER: LIVE ? "anthropic" : "mock",
        CORS_ORIGINS: WEB_URL,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: false,
      env: { VITE_API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
