import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, "worker", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      include: ["tests/worker/**/*.test.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              ROOM_TOKEN_SECRET: "test-secret-key-at-least-32-chars-long!",
            },
          },
        },
      },
    },
  };
});
