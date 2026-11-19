import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    // The site suite needs a production build and a free port: run it with `npm run test:site`.
    exclude: process.env.E2E ? [] : ["tests/site.e2e.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // Test-only key. Never used outside the suite.
      INGEST_SECRET_KEY: "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLTAwMDA=",
    },
  },
});
