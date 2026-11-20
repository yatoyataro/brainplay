import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    channel: "msedge",
  },
  webServer: [
    {
      command:
        "node -e \"require('node:fs').rmSync('.wrangler/e2e-state',{recursive:true,force:true})\" && npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state && npx wrangler dev --port 8787 --local --persist-to .wrangler/e2e-state",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run preview -- --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
