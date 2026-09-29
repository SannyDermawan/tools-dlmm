import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      // The SDK's ESM build uses a directory import that Node's ESM loader rejects; use the CJS build.
      "@meteora-ag/dlmm": require.resolve("@meteora-ag/dlmm"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
