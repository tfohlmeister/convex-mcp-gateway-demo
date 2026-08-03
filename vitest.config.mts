import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions run on an edge-style runtime, and `convex-test`
    // needs the same globals (Request/Response/crypto) the real backend
    // provides. Matches the component repo's own vitest setup.
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
    server: { deps: { inline: ["convex-test"] } },
    // `convex/http.ts` reads MCP_DEV_BEARER_TOKEN at module scope to
    // decide whether the demo's dev identities exist. Setting it here
    // is what makes `dev-user` and `dev-reader` reachable from the
    // tests; without it every auth-gated call would answer 401.
    env: { MCP_DEV_BEARER_TOKEN: "test-dev-token" },
  },
});
