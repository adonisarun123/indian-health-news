import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Scraper unit tests: no database, no network. `npm run test:scraper`. */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  test: {
    include: ["scraper/test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
