import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@tower/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 60000 },
});
