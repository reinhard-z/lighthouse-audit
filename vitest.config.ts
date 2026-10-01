/**
 * Two test projects (SPEC.md §13):
 * - "workers": routing, provider, MCP, validation and normalization tests in
 *   workerd via @cloudflare/vitest-pool-workers, using wrangler.jsonc.
 * - "node": repository checks and operational CLI tests, which need Node.
 * No test calls Google: every provider response is a synthetic fixture.
 */
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Wrangler also loads a developer's gitignored .dev.vars, which
            // enables audits and holds a real key. These bindings override it,
            // so tests see the committed kill-switch value and never a real key
            // (an empty key counts as missing).
            miniflare: { bindings: { AUDITS_ENABLED: "false", PSI_API_KEY: "" } },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/repository.test.ts", "tests/scripts.test.ts"],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["tests/repository.test.ts", "tests/scripts.test.ts"],
        },
      },
    ],
  },
});
