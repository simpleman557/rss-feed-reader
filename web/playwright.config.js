import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end tests: a real Chromium against the real built app and server, with a
// throwaway database seeded by e2e/seed.mjs. Two projects run the same server — a mouse
// desktop and a touch phone — because the app's behavior differs between them (hover vs
// tap, sidebar column vs drawer) and that difference is exactly what these tests guard.
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3101;
const DATA_DIR = path.join(here, "e2e", ".data");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.js",
  // One shared server and database, so run serially; tests don't depend on each other's
  // data (they use unique names and don't assert exact totals that other tests can change).
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: "**/mobile.spec.js",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      testIgnore: "**/desktop.spec.js",
      // Chromium-based phone profile: touch, no hover, 412px wide.
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    // Builds the frontend (the server serves web/dist), reseeds the database from scratch,
    // then starts the real server on its own port with its own data directory.
    command: "npm run build && node e2e/seed.mjs && node ../server/src/index.js",
    url: `http://127.0.0.1:${PORT}/api/categories`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { FEED_READER_DATA_DIR: DATA_DIR, PORT: String(PORT), HOST: "127.0.0.1" },
  },
});
