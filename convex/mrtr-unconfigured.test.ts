/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "convex-mcp-gateway/test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema.js";

// The counterpart to the MRTR tests in convex/mcp.test.ts, which run
// with MCP_MRTR_SECRET set from vitest.config.mts.
//
// `convex/http.ts` reads that variable at module scope and only passes
// the `mrtr` option when it is present, so this file blanks it before
// the module map first evaluates http.ts. It lives in its own file for
// the same reason MCP_ALLOWED_ORIGINS does: vitest isolates test files,
// so the rest of the suite keeps the configured behaviour it asserts.
//
// What is being proven is the direction of the failure. A deployment
// that forgot to configure the seal must not end up with an UNGUARDED
// destructive tool; it must end up with one that refuses to run. Those
// are the two possible ways to be misconfigured and only one of them is
// survivable.
vi.stubEnv("MCP_MRTR_SECRET", "");

const modules = import.meta.glob(["./**/*.ts", "!**/*.test.ts"]);

function newTest() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

const ADMIN = { authorization: "Bearer test-dev-token" };

describe("notes_purge without MCP_MRTR_SECRET", () => {
  test("refuses to run rather than deleting unconfirmed", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("notes", { title: "keep me", body: "b" });
    });

    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "notes_purge",
        ...ADMIN,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "notes_purge",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {
              elicitation: { form: {} },
            },
          },
        },
      }),
    });

    const body = (await res.json()) as {
      result?: { isError?: boolean; resultType?: string };
      error?: { code: number };
    };

    // -32603 naming MRTR specifically, NOT the `input_required` a
    // configured mount answers with. Asserting only "the note survived"
    // would pass either way, because a configured gateway also declines
    // to delete on the first call: it asks. The distinction between
    // "asks first" and "cannot ask at all" is the whole test.
    expect(body.error?.code).toBe(-32603);
    expect(body.result?.resultType).toBeUndefined();
    const survived = await t.run(
      async (ctx) => (await ctx.db.query("notes").collect()).length,
    );
    expect(survived).toBe(1);
  });
});
