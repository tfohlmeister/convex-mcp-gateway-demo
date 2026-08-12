/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "convex-mcp-gateway/test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema.js";

// `convex/http.ts` reads MCP_ALLOWED_ORIGINS at module scope to decide
// whether to pass `allowedOrigins` to the gateway at all. This has to be
// set before convex-test's lazy module map first evaluates http.ts, which
// happens on the first t.fetch below, so a top-level stub is early enough.
//
// It lives in its own file rather than in vitest.config.mts for the same
// reason OIDC_ISSUER does: setting it globally would put the whole suite
// into a non-default configuration. Nothing would then exercise the
// shipped default (no origin validation), and the CORS preflight tests in
// convex/oauth.test.ts would silently stop proving that a browser origin
// gets a working preflight out of the box. Vitest isolates test files, so
// the other files keep the gate-off behaviour they assert.
vi.stubEnv("MCP_ALLOWED_ORIGINS", "https://allowed.example");

const modules = import.meta.glob(["./**/*.ts", "!**/*.test.ts"]);

function newTest() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

type Harness = ReturnType<typeof newTest>;

/** A stateless 2026-07-28 tools/list with the given extra headers. */
async function modernList(t: Harness, headers: Record<string, string>) {
  return await t.fetch("/mcp/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: MODERN_META },
    }),
  });
}

/** A legacy initialize with the given extra headers. */
async function legacyInitialize(t: Harness, headers: Record<string, string>) {
  return await t.fetch("/mcp/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
  });
}

describe("origin allowlist (MCP_ALLOWED_ORIGINS)", () => {
  const ALLOWED = { origin: "https://allowed.example" };
  const DISALLOWED = { origin: "https://untrusted.example" };

  test("an allowed origin passes on both protocol eras", async () => {
    const t = newTest();

    expect((await modernList(t, ALLOWED)).status).toBe(200);
    expect((await legacyInitialize(t, ALLOWED)).status).toBe(200);
  });

  test("a disallowed origin gets 403 on both protocol eras", async () => {
    const t = newTest();

    // The legacy half matters most: that is the path every client speaks
    // today, and it had no origin check at all before gateway 0.7.0.
    expect((await modernList(t, DISALLOWED)).status).toBe(403);
    expect((await legacyInitialize(t, DISALLOWED)).status).toBe(403);
  });

  test("a disallowed origin is refused at preflight, with no CORS headers", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "OPTIONS",
      headers: { ...DISALLOWED, "access-control-request-method": "POST" },
    });

    // Answering the preflight with allow-origin and only then 403ing the
    // POST would tell the browser the call is permitted.
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an allowed origin still gets a working preflight", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "OPTIONS",
      headers: { ...ALLOWED, "access-control-request-method": "POST" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("requests carrying no Origin header are unaffected", async () => {
    const t = newTest();

    // Every CLI, the Inspector and the curl walkthrough in the README.
    expect((await modernList(t, {})).status).toBe(200);
  });
});
