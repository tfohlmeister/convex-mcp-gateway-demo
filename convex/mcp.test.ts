/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "convex-mcp-gateway/test";
import { createFunctionHandle } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { api, components } from "./_generated/api.js";
import { instructions } from "./mcp.js";
import schema from "./schema.js";

// `!**/*.test.ts` keeps this file out of the module map it is building.
// Everything else in convex/ is loaded, so `t.fetch` routes through the
// real convex/http.ts rather than a stand-in.
const modules = import.meta.glob(["./**/*.ts", "!**/*.test.ts"]);

/**
 * A fresh in-memory deployment with the gateway component mounted under
 * the same name `convex/convex.config.ts` gives it, so the
 * `components.mcpGateway` reference resolves in the test the way it
 * does in the app.
 *
 * Nothing here registers tools. The catalog reaches the registry only
 * through the declarative `tools` option in convex/http.ts, which the
 * gateway reconciles on `initialize`. `mcp:registerDefaults` is
 * deliberately never called in this file: if the reconcile broke, every
 * tools/list assertion below would come back empty.
 */
function newTest() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

type Harness = ReturnType<typeof newTest>;
type AuthHeaders = Record<string, string>;

// Matches vitest.config.mts, which sets MCP_DEV_BEARER_TOKEN before
// convex/http.ts is imported. The demo's resolveIdentity maps the bare
// token to `dev-user` (groups: ["admin"]) and the `-readonly` suffix to
// `dev-reader` (no groups), which is what makes the allow, deny and
// forbid paths all reachable without an IdP.
const DEV_TOKEN = "test-dev-token";
const ANON: AuthHeaders = {};
const READER: AuthHeaders = { authorization: `Bearer ${DEV_TOKEN}-readonly` };
const ADMIN: AuthHeaders = { authorization: `Bearer ${DEV_TOKEN}` };

// ---------------------------------------------------------------
// Everything below drives the mounted /mcp/ route with a real Request,
// so the assertions run against the real router, the gateway's
// JSON-RPC envelope and Convex's own argument validators rather than a
// hand-built stub.
// ---------------------------------------------------------------

/** Open an MCP session and return its id. Also runs the tool reconcile. */
async function openSession(t: Harness, headers: AuthHeaders = ANON) {
  const res = await t.fetch("/mcp/", {
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
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function rpc(
  t: Harness,
  sessionId: string,
  body: object,
  headers: AuthHeaders = ANON,
): Promise<Response> {
  return await t.fetch("/mcp/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

type Envelope<T> = { result?: T; error?: { code: number; message: string } };

/**
 * Open a session as one caller and issue a single request as that same
 * caller. The demo has no OAuth config, so denials come back inside a
 * 200 JSON-RPC envelope rather than as an HTTP 401.
 */
async function once<T>(
  t: Harness,
  headers: AuthHeaders,
  body: object,
): Promise<Envelope<T>> {
  const session = await openSession(t, headers);
  const res = await rpc(t, session, body, headers);
  expect(res.status).toBe(200);
  return (await res.json()) as Envelope<T>;
}

type ToolEntry = {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, unknown> };
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

async function listTools(
  t: Harness,
  headers: AuthHeaders,
): Promise<ToolEntry[]> {
  const body = await once<{ tools: ToolEntry[] }>(t, headers, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  return body.result!.tools;
}

async function toolNames(t: Harness, headers: AuthHeaders): Promise<string[]> {
  return (await listTools(t, headers)).map((tool) => tool.name).sort();
}

type CallResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

async function callTool(
  t: Harness,
  headers: AuthHeaders,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Envelope<CallResult>> {
  return await once<CallResult>(t, headers, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

type ReadResult = {
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
};

async function readResource(
  t: Harness,
  headers: AuthHeaders,
  uri: string,
): Promise<Envelope<ReadResult>> {
  return await once<ReadResult>(t, headers, {
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri },
  });
}

/** The component's own audit reader, newest row first. */
async function auditRows(t: Harness) {
  return await t.run(async (ctx) =>
    ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
  );
}

/** Seed a note directly, bypassing MCP, so reads have something to find. */
async function seedNote(t: Harness, title = "Seeded", body = "seeded body") {
  return await t.run(async (ctx) => ctx.db.insert("notes", { title, body }));
}

// =================================================================
// Declarative catalog. convex/http.ts passes `tools` to
// handleMcpRequest, so `initialize` reconciles the registry by itself.
// These two tests are the regression guard: nothing in this file ever
// calls mcp:registerDefaults, so an empty result here means the
// reconcile stopped working.
// =================================================================

describe("declarative catalog (no registerDefaults anywhere)", () => {
  test("initialize alone populates the registry", async () => {
    const t = newTest();
    const session = await openSession(t);

    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as { result: { tools: ToolEntry[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
    // An anonymous caller only sees the public tool, which is also proof
    // the registry was filled: it would be empty without the reconcile.
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "notes_count",
    ]);
  });

  test("a tools/call succeeds straight after initialize", async () => {
    const t = newTest();
    const body = await callTool(t, ANON, "notes_count");
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(false);
  });
});

// =================================================================
// initialize: the server-level guidance the host hands the model.
// =================================================================

describe("initialize", () => {
  test("the bare /mcp path is mounted too", async () => {
    const t = newTest();
    // claude.ai strips the trailing slash before POSTing, so /mcp is the
    // path real clients hit. Every other test in this file drives /mcp/,
    // which would leave a dropped route mount invisible.
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...ADMIN,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(res.status).toBe(200);
    const session = res.headers.get("mcp-session-id");
    expect(session).toBeTruthy();

    const listed = await t.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session!,
        ...ADMIN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const body = (await listed.json()) as { result: { tools: ToolEntry[] } };
    expect(body.result.tools).toHaveLength(11);
  });

  test("returns the instructions declared in convex/mcp.ts", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const body = (await res.json()) as {
      result: { instructions?: string; capabilities: Record<string, unknown> };
    };
    expect(body.result.instructions).toBe(instructions);
    // Guards against the constant being reduced to an empty string:
    // `toBe(instructions)` alone would still pass in that case.
    expect(body.result.instructions).toContain("notes_count");
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result.capabilities).toHaveProperty("resources");
  });
});

// =================================================================
// Authorization matrix. The host's `authorize` in convex/http.ts reads
// `metadata.public` and `metadata.roles`, so visibility in tools/list
// and the outcome of tools/call must move together for each identity.
// =================================================================

describe("tools/list per identity", () => {
  test("anonymous sees only the public tool", async () => {
    const t = newTest();
    expect(await toolNames(t, ANON)).toEqual(["notes_count"]);
  });

  test("dev-reader sees the read tools but no writes", async () => {
    const t = newTest();
    expect(await toolNames(t, READER)).toEqual([
      "notes_by_author",
      "notes_count",
      "notes_list",
      "notes_search",
      "notes_whoami",
    ]);
  });

  test("dev-user (admin) sees the whole catalog", async () => {
    const t = newTest();
    expect(await toolNames(t, ADMIN)).toEqual([
      "notes_bulkTag",
      "notes_by_author",
      "notes_count",
      "notes_create",
      "notes_delete",
      "notes_list",
      "notes_purge",
      "notes_reindex",
      "notes_search",
      "notes_update",
      "notes_whoami",
    ]);
  });

  test("every advertised tool carries a description", async () => {
    const t = newTest();
    // The description is what the model reads to decide whether to call
    // a tool, so an empty one is a real defect even though the wire
    // shape stays valid.
    for (const tool of await listTools(t, ADMIN)) {
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  test("an unrecognized bearer token is treated as anonymous", async () => {
    const t = newTest();
    // resolveIdentity returns null for anything but the two dev tokens
    // (there is no OIDC_ISSUER in the test env), so a wrong token must
    // fall back to the anonymous catalog rather than resolve to anyone.
    const bogus = { authorization: "Bearer wrong-token" };
    expect(await toolNames(t, bogus)).toEqual(["notes_count"]);
    expect((await callTool(t, bogus, "notes_list")).error?.code).toBe(-32001);
  });

  test("an empty bearer token never reaches resolveIdentity", async () => {
    const t = newTest();
    // The gateway skips resolution entirely for an empty token, so an
    // `Authorization: Bearer ` header stays anonymous no matter what
    // convex/http.ts would have made of the empty string. Pinned here
    // because it is a gateway property the demo relies on and would
    // otherwise only notice after an upgrade.
    const empty = { authorization: "Bearer " };
    expect(await toolNames(t, empty)).toEqual(["notes_count"]);
    const denied = await callTool(t, empty, "notes_create", {
      title: "x",
      body: "y",
    });
    expect(denied.error?.code).toBe(-32001);
  });
});

describe("tools/call per identity", () => {
  test("anonymous may call the public tool", async () => {
    const t = newTest();
    await seedNote(t);
    const body = await callTool(t, ANON, "notes_count");
    expect(body.result?.structuredContent).toEqual({ total: 1 });
  });

  test("anonymous is rejected with -32001 on a gated tool", async () => {
    const t = newTest();
    const body = await callTool(t, ANON, "notes_list");
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32001);
  });

  test("dev-reader may call an auth-only tool", async () => {
    const t = newTest();
    await seedNote(t, "Visible", "to any authenticated caller");
    const body = await callTool(t, READER, "notes_list");
    expect(body.error).toBeUndefined();
    expect(body.result?.content[0]?.text).toContain("Visible");
  });

  test("dev-reader is rejected with -32003 on a role-gated tool", async () => {
    const t = newTest();
    const body = await callTool(t, READER, "notes_create", {
      title: "nope",
      body: "nope",
    });
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message).toContain("admin");
    // The denial happens before dispatch, so nothing was written.
    const notes = await t.run(async (ctx) => ctx.db.query("notes").collect());
    expect(notes).toHaveLength(0);
  });

  test("dev-user can create, update and delete a note", async () => {
    const t = newTest();
    const created = await callTool(t, ADMIN, "notes_create", {
      title: "First",
      body: "body",
    });
    expect(created.error).toBeUndefined();
    const id = JSON.parse(created.result!.content[0]!.text!) as string;

    const updated = await callTool(t, ADMIN, "notes_update", {
      id,
      title: "Second",
      body: "new body",
    });
    expect(updated.error).toBeUndefined();
    expect(
      await t.run(async (ctx) => (await ctx.db.query("notes").collect())[0]),
    ).toMatchObject({ title: "Second", body: "new body" });

    const removed = await callTool(t, ADMIN, "notes_delete", { id });
    expect(removed.error).toBeUndefined();
    expect(
      await t.run(async (ctx) => ctx.db.query("notes").collect()),
    ).toHaveLength(0);
  });
});

// =================================================================
// Tool execution failures. An authorized call whose handler rejects is
// not a protocol error: it comes back as an ordinary result with
// isError set. The generic wire text is deliberate, so an accidental
// exception cannot leak internals to the model.
// =================================================================

describe("tool execution failures", () => {
  test("a throwing handler answers isError with no internal detail", async () => {
    const t = newTest();
    const id = await seedNote(t);
    await t.run(async (ctx) => ctx.db.delete(id));

    // notes.update throws `Note <id> not found` for a missing row.
    const body = await callTool(t, ADMIN, "notes_update", {
      id,
      title: "gone",
      body: "gone",
    });
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).not.toContain("not found");

    // The real message is kept, but only in the audit log.
    const row = (await auditRows(t)).find(
      (entry) => entry.toolName === "notes_update",
    );
    expect(row).toMatchObject({ outcome: "error", errorCode: -32000 });
    expect(row?.errorMessage).toContain("not found");
  });

  test("the Convex argument validator rejects a malformed call", async () => {
    const t = newTest();
    // `body` is required by notes.create. The gateway does not pre-check
    // arguments, so this is Convex's own validator refusing the call,
    // which is the property that makes driving the HTTP route worth more
    // than calling the component directly.
    const body = await callTool(t, ADMIN, "notes_create", {
      title: "only a title",
    });
    expect(body.result?.isError).toBe(true);

    const row = (await auditRows(t)).find(
      (entry) => entry.toolName === "notes_create",
    );
    expect(row?.outcome).toBe("error");
    expect(row?.errorMessage).toContain("body");
    expect(
      await t.run(async (ctx) => ctx.db.query("notes").collect()),
    ).toHaveLength(0);
  });
});

// =================================================================
// identityArg. The gateway fills the named argument from the resolved
// caller at the request boundary: the client never sees it in the
// schema and cannot influence it by sending one.
// =================================================================

describe("identityArg (caller injection)", () => {
  test("the caller arg is absent from the advertised inputSchema", async () => {
    const t = newTest();
    const tools = await listTools(t, ADMIN);

    const whoami = tools.find((tool) => tool.name === "notes_whoami");
    expect(whoami).toBeDefined();
    // `caller` is its only declared argument, so stripping it must leave
    // an empty property bag rather than an absent one.
    expect(whoami!.inputSchema.properties).toEqual({});

    // notes_create declares `caller` as an optional arg so the React UI
    // can call the same mutation without one; it must be hidden too.
    const create = tools.find((tool) => tool.name === "notes_create");
    expect(create).toBeDefined();
    expect(create!.inputSchema.properties ?? {}).not.toHaveProperty("caller");
    expect(create!.inputSchema.properties ?? {}).toHaveProperty("title");
  });

  test("a client-supplied caller is discarded, the resolved subject wins", async () => {
    const t = newTest();
    const body = await callTool(t, ADMIN, "notes_whoami", {
      caller: { subject: "attacker", claims: { groups: ["admin"] } },
    });
    expect(body.error).toBeUndefined();
    expect(body.result?.structuredContent).toEqual({
      subject: "dev-user",
      // Claim names only, sorted. dev-user carries sub + groups.
      claims: ["groups", "sub"],
    });
  });

  test("the injected identity follows the token, not the tool", async () => {
    const t = newTest();
    const body = await callTool(t, READER, "notes_whoami");
    expect(body.result?.structuredContent).toEqual({
      subject: "dev-reader",
      claims: ["sub"],
    });
  });

  test("notes_create stores the injected author, not the client's", async () => {
    const t = newTest();
    const body = await callTool(t, ADMIN, "notes_create", {
      title: "Authored",
      body: "body",
      caller: { subject: "attacker" },
    });
    expect(body.error).toBeUndefined();

    const notes = await t.run(async (ctx) => ctx.db.query("notes").collect());
    expect(notes).toHaveLength(1);
    expect(notes[0]!.author).toBe("dev-user");
  });
});

// =================================================================
// Protocol metadata (title / annotations / _meta). These travel the
// declarative reconcile through replaceTools, whose Convex validator
// rejects unknown fields, so a field that loses its validator entry
// fails here rather than in production.
// =================================================================

describe("tool protocol metadata", () => {
  test("notes_count advertises title, annotations and _meta", async () => {
    const t = newTest();
    const tools = await listTools(t, ANON);
    expect(tools).toEqual([
      expect.objectContaining({
        name: "notes_count",
        description: "Return the total number of notes. Public.",
        title: "Count notes",
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: { "convex-mcp-gateway-demo/category": "notes" },
      }),
    ]);
  });

  test("the write tools advertise their behavioural hints", async () => {
    const t = newTest();
    const tools = await listTools(t, ADMIN);
    const hints = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations;

    // These are what a client uses to decide whether a call needs
    // confirmation, so a flipped hint is a user-visible defect.
    expect(hints("notes_create")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(hints("notes_update")).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
    });
    expect(hints("notes_delete")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(hints("notes_whoami")).toEqual({ readOnlyHint: true });
  });

  test("a tool that declares no _meta carries none on the wire", async () => {
    const t = newTest();
    const listed = (await listTools(t, ADMIN)).find(
      (tool) => tool.name === "notes_list",
    );
    expect(listed).toMatchObject({
      title: "List notes",
      annotations: { readOnlyHint: true },
    });
    expect(listed).not.toHaveProperty("_meta");
    expect(listed).not.toHaveProperty("securitySchemes");
  });

  test("a tool declaring none of them has none of the keys", async () => {
    const t = newTest();
    // Registered out-of-band after the reconcile has stamped its
    // fingerprint, so the next initialize leaves it alone. The demo's
    // own catalog gives every tool a title, so this is the only way to
    // cover the "declares nothing" shape end to end.
    await openSession(t);
    await t.run(async (ctx) => {
      const functionHandle = await createFunctionHandle(api.notes.count);
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "bare_tool",
        description: "No title, no annotations, no _meta.",
        kind: "query",
        functionHandle,
        inputSchema: { type: "object" },
      });
    });

    const listed = (await listTools(t, ADMIN)).find(
      (tool) => tool.name === "bare_tool",
    );
    expect(listed).toBeDefined();
    // An empty protocolMetadata object must not leak `title: undefined`
    // style keys onto the wire; strict clients reject those.
    for (const key of ["title", "annotations", "_meta", "securitySchemes"]) {
      expect(listed).not.toHaveProperty(key);
    }
  });
});

// =================================================================
// Typed returns: a tool declaring `returns:` gets both an outputSchema
// in tools/list and a structuredContent block in tools/call.
// =================================================================

describe("typed returns (outputSchema / structuredContent)", () => {
  test("notes_count advertises an outputSchema", async () => {
    const t = newTest();
    const listed = (await listTools(t, ANON)).find(
      (tool) => tool.name === "notes_count",
    );
    expect(listed?.outputSchema).toEqual({
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
      additionalProperties: false,
    });
  });

  test("notes_count ships structuredContent alongside the text content", async () => {
    const t = newTest();
    await seedNote(t, "One");
    await seedNote(t, "Two");

    const body = await callTool(t, ANON, "notes_count");
    // Text JSON for legacy clients ...
    expect(body.result?.content[0]?.type).toBe("text");
    expect(body.result?.content[0]?.text).toContain('"total": 2');
    // ... and the typed block per MCP 2025-06-18.
    expect(body.result?.structuredContent).toEqual({ total: 2 });
  });

  test("a tool without `returns` has neither outputSchema nor structuredContent", async () => {
    const t = newTest();
    const listed = (await listTools(t, ADMIN)).find(
      (tool) => tool.name === "notes_create",
    );
    // Absent entirely, not null and not {}.
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("outputSchema");

    const body = await callTool(t, ADMIN, "notes_create", {
      title: "Untyped",
      body: "body",
    });
    expect(body.result).toBeDefined();
    expect(body.result).not.toHaveProperty("structuredContent");
  });
});

// =================================================================
// Resources: one concrete resource readable by any authenticated
// caller, one RFC 6570 template gated on the admin group.
// =================================================================

describe("resources", () => {
  test("resources/list needs auth and returns notes://all", async () => {
    const t = newTest();

    const anon = await once(t, ANON, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
    });
    expect(anon.error?.code).toBe(-32001);

    const body = await once<{ resources: Array<Record<string, unknown>> }>(
      t,
      READER,
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
    );
    // Pinned in full: the descriptive fields are what a client shows the
    // user, and they reach the wire through the same declarative path as
    // the tool metadata above.
    expect(body.result?.resources).toEqual([
      {
        uri: "notes://all",
        name: "notes-all",
        title: "All notes",
        description: "Every note in the store, as JSON.",
        mimeType: "application/json",
        annotations: { audience: ["assistant"], priority: 0.5 },
        icons: [
          {
            src: "https://example.com/icons/notes-48.png",
            mimeType: "image/png",
            sizes: ["48x48"],
          },
          {
            src: "https://example.com/icons/notes-dark.svg",
            mimeType: "image/svg+xml",
            sizes: ["any"],
            theme: "dark",
          },
        ],
      },
      {
        uri: "notes://export",
        name: "notes-export",
        title: "Bulk export",
        description:
          "Every note as one flat text export. Asks for confirmation first.",
        mimeType: "text/plain",
      },
      {
        uri: "notes://stats",
        name: "notes-stats",
        title: "Store statistics",
        description: "How many notes exist. Readable without a token.",
        mimeType: "application/json",
        annotations: { audience: ["assistant"], priority: 0.2 },
      },
    ]);
  });

  test("resources/templates/list returns the note template", async () => {
    const t = newTest();
    const body = await once<{
      resourceTemplates: Array<Record<string, unknown>>;
    }>(t, READER, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/templates/list",
    });
    expect(body.result?.resourceTemplates).toEqual([
      {
        uriTemplate: "note://{id}",
        name: "note",
        title: "Note by id",
        description: "Read a single note by its id.",
        mimeType: "application/json",
        icons: [{ src: "https://example.com/icons/note.png", sizes: ["96x96"] }],
      },
    ]);
  });

  test("resources/read notes://all returns every note as JSON", async () => {
    const t = newTest();
    await seedNote(t, "Readable", "content");

    const body = await readResource(t, ADMIN, "notes://all");
    const entry = body.result!.contents[0]!;
    expect(entry.uri).toBe("notes://all");
    expect(entry.mimeType).toBe("application/json");
    const parsed = JSON.parse(entry.text) as Array<{ title: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.title).toBe("Readable");
  });

  test("the note://{id} template expands to a single note", async () => {
    const t = newTest();
    const id = await seedNote(t, "Single", "just this one");

    const body = await readResource(t, ADMIN, `note://${id}`);
    const entry = body.result!.contents[0]!;
    expect(entry.uri).toBe(`note://${id}`);
    const parsed = JSON.parse(entry.text) as { _id: string; title: string };
    expect(parsed._id).toBe(id);
    expect(parsed.title).toBe("Single");
  });

  test("reading an id that no longer exists is a not-found, not a crash", async () => {
    const t = newTest();
    const id = await seedNote(t);
    await t.run(async (ctx) => ctx.db.delete(id));

    // Well-formed id, no row: the template handler returns null and the
    // gateway turns that into the standard not-found error.
    const gone = await readResource(t, ADMIN, `note://${id}`);
    expect(gone.result).toBeUndefined();
    expect(gone.error?.code).toBe(-32602);

    // A malformed id takes the same path via normalizeId returning null.
    const malformed = await readResource(t, ADMIN, "note://not-an-id");
    expect(malformed.error?.code).toBe(-32602);
  });

  test("anonymous reads are refused before the handler runs", async () => {
    const t = newTest();
    await seedNote(t, "Private");

    const body = await readResource(t, ANON, "notes://all");
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32001);
  });

  test("dev-reader may read notes://all but not note://{id}", async () => {
    const t = newTest();
    const id = await seedNote(t, "Shared");

    const all = await readResource(t, READER, "notes://all");
    expect(all.error).toBeUndefined();
    expect(all.result!.contents[0]!.text).toContain("Shared");

    const single = await readResource(t, READER, `note://${id}`);
    expect(single.result).toBeUndefined();
    expect(single.error?.code).toBe(-32003);
    expect(single.error?.message).toContain("admin");
  });
});

// =================================================================
// Audit log. Tool rows are written inside the component by
// dispatch.runTool; resource rows are written by the host because
// convex/http.ts opts in with `auditResources: { read: true }`.
// =================================================================

describe("audit log", () => {
  test("tool calls land as entryType 'tool' with outcome and subject", async () => {
    const t = newTest();
    await callTool(t, ANON, "notes_count");
    await callTool(t, ANON, "notes_list");
    await callTool(t, READER, "notes_create", { title: "x", body: "y" });

    const rows = await auditRows(t);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.entryType === "tool")).toBe(true);

    expect(
      rows.find((row) => row.toolName === "notes_count"),
    ).toMatchObject({
      outcome: "allowed",
      toolKind: "query",
      identitySubject: null,
    });
    expect(rows.find((row) => row.toolName === "notes_list")).toMatchObject({
      outcome: "denied",
      errorCode: -32001,
      identitySubject: null,
    });
    expect(rows.find((row) => row.toolName === "notes_create")).toMatchObject({
      outcome: "denied",
      errorCode: -32003,
      identitySubject: "dev-reader",
    });
  });

  test("resource operations land as entryType 'resource'", async () => {
    const t = newTest();
    const id = await seedNote(t, "Audited");
    await readResource(t, READER, "notes://all");
    await readResource(t, READER, `note://${id}`);
    await readResource(t, ADMIN, `note://${id}`);

    const rows = (await auditRows(t)).filter(
      (row) => row.entryType === "resource",
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.resourceOperation === "read")).toBe(true);

    expect(rows.find((row) => row.resourceUri === "notes://all")).toMatchObject(
      { outcome: "allowed", identitySubject: "dev-reader" },
    );
    const single = rows.filter((row) => row.resourceUri === `note://${id}`);
    expect(single).toHaveLength(2);
    expect(
      single.find((row) => row.identitySubject === "dev-reader"),
    ).toMatchObject({ outcome: "denied", errorCode: -32003 });
    expect(
      single.find((row) => row.identitySubject === "dev-user"),
    ).toMatchObject({ outcome: "allowed" });
    // Reads are recorded by URI and outcome only, never by content.
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("Audited");
    }
  });

  test("notes_create declares auditArgs: false, so no args are stored", async () => {
    const t = newTest();
    await callTool(t, ADMIN, "notes_create", {
      title: "Confidential",
      body: "do not persist me",
    });

    const rows = await auditRows(t);
    const row = rows.find((entry) => entry.toolName === "notes_create");
    expect(row).toMatchObject({
      outcome: "allowed",
      identitySubject: "dev-user",
    });
    expect(row!.args).toBeNull();
    expect(JSON.stringify(row)).not.toContain("Confidential");
    expect(JSON.stringify(row)).not.toContain("do not persist me");
  });

  test("notes_update redacts body but keeps the other fields", async () => {
    const t = newTest();
    const id = await seedNote(t);
    await callTool(t, ADMIN, "notes_update", {
      id,
      title: "New title",
      body: "sensitive body",
    });

    const rows = await auditRows(t);
    const row = rows.find((entry) => entry.toolName === "notes_update");
    expect(row?.args).toEqual({
      id,
      title: "New title",
      body: "[redacted]",
    });
  });

  test("mcp:recentAudit surfaces the rows to the app", async () => {
    const t = newTest();
    await callTool(t, ANON, "notes_count");

    const rows = await t.query(api.mcp.recentAudit, {});
    expect(rows.map((row) => row.toolName)).toContain("notes_count");
  });
});

// ---------------------------------------------------------------
// MCP 2026-07-28: stateless requests, and the routing headers that
// `notes_by_author` declares via `x-mcp-header`.
// ---------------------------------------------------------------

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** One stateless request. No initialize, no session id, no state. */
async function modern(
  t: Harness,
  method: string,
  params: Record<string, unknown> = {},
  headers: AuthHeaders = ANON,
  // What the client says it can do. The gateway refuses to open an MRTR
  // round a client could not answer (-32021), so a test that drives one
  // has to declare elicitation the way a real client does.
  capabilities: Record<string, unknown> = {},
): Promise<Response> {
  return await modernAt(t, "/mcp/", method, params, headers, capabilities);
}

/** `modern`, against a named mount. Only `/mcp-public/` needs it. */
async function modernAt(
  t: Harness,
  path: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: AuthHeaders = ANON,
  capabilities: Record<string, unknown> = {},
): Promise<Response> {
  // 2026-07-28 mirrors the request's "subject" into Mcp-Name, and which
  // field that is depends on the method: the tool for a call, the URI
  // for a read, the task id for a poll. A mismatch is -32020 before
  // anything else runs.
  const subject =
    method === "resources/read"
      ? params.uri
      : method === "tasks/get" ||
          method === "tasks/update" ||
          method === "tasks/cancel"
        ? params.taskId
        : params.name;
  const name = typeof subject === "string" ? subject : undefined;
  return await t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          ...MODERN_META,
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    }),
  });
}

/** A `notes_by_author` call, with whatever routing headers are passed. */
async function byAuthor(
  t: Harness,
  routing: AuthHeaders,
  args: { author: string; limit: number } = { author: "dev-user", limit: 25 },
) {
  return await modern(
    t,
    "tools/call",
    { name: "notes_by_author", arguments: args },
    { ...ADMIN, ...routing },
  );
}

describe("stateless 2026-07-28 requests", () => {
  test("server/discover answers without an initialize or a session", async () => {
    const t = newTest();
    const res = await modern(t, "server/discover");

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as Envelope<{
      supportedVersions: string[];
      instructions?: string;
      resultType?: string;
      cacheScope?: string;
    }>;
    expect(body.result?.supportedVersions).toContain("2026-07-28");
    expect(body.result?.resultType).toBe("complete");
    // Identity-filtered catalogs must never be shared between callers.
    expect(body.result?.cacheScope).toBe("private");
    // The same `instructions` the legacy initialize returns.
    expect(body.result?.instructions).toBe(instructions);
  });

  test("tools/list works with no session and still filters by identity", async () => {
    const t = newTest();
    const anonRes = await modern(t, "tools/list");
    const adminRes = await modern(t, "tools/list", {}, ADMIN);

    const names = async (res: Response) =>
      ((await res.json()) as Envelope<{ tools: { name: string }[] }>).result!.tools.map(
        (tool) => tool.name,
      );
    expect(await names(anonRes)).toEqual(["notes_count"]);
    expect(await names(adminRes)).toContain("notes_by_author");
  });
});

describe("x-mcp-header routing on notes_by_author", () => {
  test("the annotation reaches the client in tools/list", async () => {
    const t = newTest();
    const res = await modern(t, "tools/list", {}, ADMIN);
    const body = (await res.json()) as Envelope<{
      tools: { name: string; inputSchema: Record<string, any> }[]
    }>;
    const tool = body.result!.tools.find((x) => x.name === "notes_by_author");

    expect(tool!.inputSchema.properties.author["x-mcp-header"]).toBe("Author");
    expect(tool!.inputSchema.properties.limit["x-mcp-header"]).toBe("Limit");
  });

  /**
   * Assert a call actually ran. A failed dispatch comes back as HTTP 200
   * with `result.isError: true` and no top-level `error`, so asserting
   * only on the status would stay green if the query itself blew up.
   */
  async function expectNotes(res: Response, titles: string[]) {
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{
      isError: boolean;
      content: { type: string; text: string }[];
    }>;
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(false);
    const notes = JSON.parse(body.result!.content[0].text) as {
      title: string;
    }[];
    expect(notes.map((note) => note.title)).toEqual(titles);
  }

  /** One note authored by dev-user, written through the gateway. */
  async function seedNote(t: Harness, title: string) {
    const res = await modern(
      t,
      "tools/call",
      { name: "notes_create", arguments: { title, body: "b" } },
      ADMIN,
    );
    expect(res.status).toBe(200);
  }

  test("matching headers are accepted and the query returns its rows", async () => {
    const t = newTest();
    await seedNote(t, "first");

    // Also covers the by_author index and the identityArg stamping that
    // puts `dev-user` on the note in the first place.
    await expectNotes(
      await byAuthor(t, {
        "mcp-param-author": "dev-user",
        "mcp-param-limit": "25",
      }),
      ["first"],
    );
  });

  test("an unrelated author gets no rows", async () => {
    const t = newTest();
    await seedNote(t, "first");

    await expectNotes(
      await byAuthor(
        t,
        { "mcp-param-author": "dev-reader", "mcp-param-limit": "25" },
        { author: "dev-reader", limit: 25 },
      ),
      [],
    );
  });

  test("an integer header is compared numerically, not as a string", async () => {
    const t = newTest();
    await seedNote(t, "first");

    await expectNotes(
      await byAuthor(t, {
        "mcp-param-author": "dev-user",
        "mcp-param-limit": "25.0",
      }),
      ["first"],
    );
  });

  test("a base64 sentinel value is decoded before comparison", async () => {
    const t = newTest();
    await seedNote(t, "first");

    await expectNotes(
      await byAuthor(t, {
        "mcp-param-author": `=?base64?${btoa("dev-user")}?=`,
        "mcp-param-limit": "25",
      }),
      ["first"],
    );
  });

  test("a legacy caller reaches the tool with no routing headers at all", async () => {
    const t = newTest();
    await seedNote(t, "first");

    // Documents the boundary rather than approving of it: header
    // validation is scoped to the modern protocol, so an intermediary
    // enforcing policy on Mcp-Param-* must reject legacy requests
    // itself. Both convex/mcp.ts and the README say so.
    const body = await once<{ isError: boolean }>(t, ADMIN, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "notes_by_author",
        arguments: { author: "dev-user", limit: 25 },
      },
    });
    expect(body.result?.isError).toBe(false);
  });

  test("a non-integer limit from a legacy caller does not blow up", async () => {
    const t = newTest();
    await seedNote(t, "first");

    // `type: "integer"` is only enforced against the mirrored header, so
    // the query has to floor the value itself. Without that, `.take()`
    // rejects 25.5 and the caller gets an opaque execution error.
    const body = await once<{ isError: boolean }>(t, ADMIN, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "notes_by_author",
        arguments: { author: "dev-user", limit: 25.5 },
      },
    });
    expect(body.result?.isError).toBe(false);
  });

  test.each([
    ["a header disagreeing with the body", {
      "mcp-param-author": "someone-else",
      "mcp-param-limit": "25",
    }],
    ["an integer header disagreeing with the body", {
      "mcp-param-author": "dev-user",
      "mcp-param-limit": "26",
    }],
    ["a hex value that Number() would coerce to a match", {
      "mcp-param-author": "dev-user",
      "mcp-param-limit": "0x19",
    }],
    ["a missing declared header", { "mcp-param-limit": "25" }],
    ["no routing headers at all", {}],
  ])("rejects %s with -32020", async (_label, routing) => {
    const t = newTest();
    const res = await byAuthor(t, routing);

    // A proxy routing on the header and Convex executing on the body must
    // never be able to disagree, so this fails before dispatch.
    expect(res.status).toBe(400);
    expect((await res.json()) as Envelope<unknown>).toMatchObject({
      error: { code: -32020 },
    });
  });
});

describe("origin validation is off by default", () => {
  test("an Origin header is not rejected when MCP_ALLOWED_ORIGINS is unset", async () => {
    const t = newTest();
    // The shipped default. convex/origin.test.ts covers the opposite,
    // in its own file so this one keeps testing the default.
    const res = await modern(t, "tools/list", {}, {
      origin: "https://anything.example",
    });

    expect(res.status).toBe(200);
  });
});

// =================================================================
// MRTR: the confirmation round on notes_purge. The value under test is
// that the mutation does not run until an answer arrives, so every
// assertion below also checks the store, not just the envelope.
// =================================================================

/** A client that can show the user a form, which MRTR requires. */
const ELICITING = { elicitation: { form: {} } };

type MrtrEnvelope = Envelope<{
  resultType?: string;
  requestState?: string;
  inputRequests?: Record<string, unknown>;
  content?: { type: string; text: string }[];
  structuredContent?: { deleted: number; replayed: boolean };
  isError?: boolean;
}>;

async function seedNotes(t: Harness, count: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("notes", { title: `note ${i}`, body: "b" });
    }
  });
}

const noteCount = (t: Harness) =>
  t.run(async (ctx) => (await ctx.db.query("notes").collect()).length);

/**
 * The tags on every note, in insertion order. Reading the database
 * rather than the tool's own report is what proves a deferred call
 * actually ran, or, for the refusal paths, that it did not.
 */
const tagsOf = (t: Harness) =>
  t.run(async (ctx) =>
    (await ctx.db.query("notes").collect()).map((note) => note.tags ?? []),
  );

/** A `notes_purge` call: first round, or a continuation. */
async function purge(
  t: Harness,
  params: Record<string, unknown> = {},
): Promise<MrtrEnvelope> {
  const res = await modern(
    t,
    "tools/call",
    { name: "notes_purge", arguments: {}, ...params },
    ADMIN,
    ELICITING,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as MrtrEnvelope;
}

describe("MRTR confirmation on notes_purge", () => {
  test("the first call asks instead of deleting", async () => {
    const t = newTest();
    await seedNotes(t, 3);

    const body = await purge(t);

    expect(body.result?.resultType).toBe("input_required");
    expect(body.result?.requestState).toBeTruthy();
    // The elicitation the client is meant to show, with the count read
    // from the database by the hook.
    expect(JSON.stringify(body.result?.inputRequests)).toContain(
      "Delete all 3 notes?",
    );
    // The whole point: nothing was deleted.
    expect(await noteCount(t)).toBe(3);
  });

  test("accepting deletes, and reports how many", async () => {
    const t = newTest();
    await seedNotes(t, 3);
    const asked = await purge(t);

    const done = await purge(t, {
      requestState: asked.result!.requestState,
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
    });

    expect(done.result?.resultType).not.toBe("input_required");
    expect(done.result?.structuredContent).toEqual({
      deleted: 3,
      replayed: false,
    });
    expect(await noteCount(t)).toBe(0);
  });

  test("declining deletes nothing and never dispatches", async () => {
    const t = newTest();
    await seedNotes(t, 3);
    const asked = await purge(t);

    const done = await purge(t, {
      requestState: asked.result!.requestState,
      inputResponses: { confirm: { action: "decline" } },
    });

    expect(done.result?.content?.[0]?.text).toBe("Nothing was deleted.");
    expect(done.result?.isError).toBe(false);
    expect(await noteCount(t)).toBe(3);
    // A decline is not the tool reporting failure, it is the call
    // finishing without one, so no dispatch was audited.
    const audited = await t.query(api.mcp.recentAudit, {});
    expect(
      audited.some(
        (row: { toolName?: string; outcome?: string }) =>
          row.toolName === "notes_purge" && row.outcome === "allowed",
      ),
    ).toBe(false);
  });

  test("a malformed answer asks again rather than guessing", async () => {
    const t = newTest();
    await seedNotes(t, 2);
    const asked = await purge(t);

    const again = await purge(t, {
      requestState: asked.result!.requestState,
      // `accept` with the box unticked is not consent.
      inputResponses: { confirm: { action: "accept", content: { confirm: false } } },
    });

    expect(again.result?.content?.[0]?.text).toBe("Nothing was deleted.");
    expect(await noteCount(t)).toBe(2);
  });

  test("a continuation cannot be replayed against a refilled store", async () => {
    const t = newTest();
    await seedNotes(t, 3);
    const asked = await purge(t);
    const answer = {
      requestState: asked.result!.requestState,
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
    };
    const first = await purge(t, answer);
    expect(first.result?.structuredContent).toEqual({
      deleted: 3,
      replayed: false,
    });

    // The user writes new notes, then the client re-sends the same
    // confirmation because it never saw the response.
    await seedNotes(t, 2);
    const replay = await purge(t, answer);

    // Whatever the gateway answers here, the new notes must survive: one
    // confirmation authorises one purge.
    expect(await noteCount(t)).toBe(2);
    expect(replay.result?.structuredContent?.deleted).not.toBe(2);
  });

  test("a continuation aimed at another tool is refused", async () => {
    const t = newTest();
    await seedNotes(t, 3);
    const asked = await purge(t);

    // The seal binds the state to the tool and arguments it was minted
    // for, so re-pointing it is not a matter of the client's honesty.
    const res = await modern(
      t,
      "tools/call",
      {
        name: "notes_reindex",
        arguments: {},
        requestState: asked.result!.requestState,
        inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
      },
      ADMIN,
      ELICITING,
    );
    const body = (await res.json()) as MrtrEnvelope;

    expect(body.error).toBeDefined();
    expect(await noteCount(t)).toBe(3);
  });

  test("the confirmation key never appears in the advertised schema", async () => {
    const t = newTest();
    const res = await modern(t, "tools/list", {}, ADMIN);
    const body = (await res.json()) as Envelope<{
      tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    }>;
    const tool = body.result!.tools.find((x) => x.name === "notes_purge");

    // A client that could set it could replay someone else's key.
    expect(tool!.inputSchema.properties ?? {}).not.toHaveProperty(
      "confirmationKey",
    );
  });
});

// =================================================================
// MCP Tasks, on the shipped SEP-2663 wire (gateway 2.0.0).
//
// Both levels are in the catalog: `notes_reindex` is `"optional"`, so the
// mount's `shouldCreate` decides per call, and `notes_bulkTag` is
// `"required"`, so it never answers inline. The mount passes no
// `execute`, so the component's built-in scheduled executor runs the tool
// after the HTTP request returns; the tests drive the scheduler
// explicitly.
// =================================================================

/**
 * A client that can poll tasks.
 *
 * The key sits under `extensions`, which is where SEP-2663 put it. A
 * client that declares it anywhere else has not opted in, and the
 * gateway treats it as one that cannot poll: `notes_reindex` answers
 * inline, `notes_bulkTag` answers -32021.
 */
const TASKING = { extensions: { "io.modelcontextprotocol/tasks": {} } };

/**
 * The flat SEP-2663 shapes, in one loose type.
 *
 * `tools/call` answers `resultType: "task"` with the handle's fields
 * beside it, and `tasks/get` answers `resultType: "complete"` with the
 * descriptor's. Neither nests a `task` object any more, which is the
 * 2.0.0 wire change a client notices first.
 */
type TaskEnvelope = Envelope<{
  resultType?: string;
  taskId?: string;
  status?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  ttlMs?: number;
  pollIntervalMs?: number;
  task?: unknown;
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, number>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
  content?: { type: string; text: string }[];
  structuredContent?: { scanned?: number; tagged?: number };
}>;

describe('MCP tasks: the "required" level on notes_bulkTag', () => {
  test("the call defers, and the built-in executor finishes it", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      await seedNotes(t, 3);

      const res = await modern(
        t,
        "tools/call",
        { name: "notes_bulkTag", arguments: { tag: "reviewed" } },
        ADMIN,
        TASKING,
      );
      expect(res.status).toBe(200);
      const created = (await res.json()) as TaskEnvelope;

      // The flat handle. `task` is gone as a nesting level, and the
      // timestamps are ISO-8601 strings rather than milliseconds.
      expect(created.result?.resultType).toBe("task");
      expect(created.result?.task).toBeUndefined();
      const taskId = created.result?.taskId;
      expect(taskId).toBeTruthy();
      expect(created.result?.status).toBe("working");
      expect(created.result?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(created.result?.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Remaining lifetime, not an absolute expiry: a client polling
      // twice is told how much longer it may keep going.
      expect(created.result?.ttlMs).toBeGreaterThan(0);
      expect(created.result?.pollIntervalMs).toBeGreaterThan(0);
      // Nothing has run yet. The executor is scheduled, not inline.
      expect(await tagsOf(t)).toEqual([[], [], []]);

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const polled = await modern(t, "tasks/get", { taskId }, ADMIN, TASKING);
      const body = (await polled.json()) as TaskEnvelope;
      // A poll is `complete`; only a call that CREATES a task carries the
      // `task` discriminator.
      expect(body.result?.resultType).toBe("complete");
      expect(body.result?.status).toBe("completed");
      // The result is the CallToolResult the same call would have
      // returned synchronously, `structuredContent` included, because
      // this tool declares a `returns` validator.
      expect(body.result?.result?.structuredContent).toEqual({
        tagged: 3,
        alreadyTagged: 0,
      });
      expect(body.result?.result?.isError).toBe(false);
      expect(await tagsOf(t)).toEqual([
        ["reviewed"],
        ["reviewed"],
        ["reviewed"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a client that cannot poll is told what to declare", async () => {
    const t = newTest();
    await seedNotes(t, 2);

    // Same caller, same tool, no tasks extension. The tool has no
    // synchronous answer to give, so the gateway refuses rather than
    // running the work and handing back a result nobody asked for.
    const res = await modern(t, "tools/call", {
      name: "notes_bulkTag",
      arguments: { tag: "reviewed" },
    }, ADMIN);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope<never> & {
      error?: { data?: { requiredCapabilities?: Record<string, unknown> } };
    };
    expect(body.error?.code).toBe(-32021);
    // The error names exactly what to add, so a client can fix itself.
    expect(body.error?.data?.requiredCapabilities).toEqual({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    // And nothing ran.
    expect(await tagsOf(t)).toEqual([[], []]);
  });

  test("the session era has no tasks, so the tool refuses there too", async () => {
    const t = newTest();
    await seedNotes(t, 2);

    const body = await callTool(t, ADMIN, "notes_bulkTag", {
      tag: "reviewed",
    });

    // -32602 naming the revision it would need. A legacy client cannot
    // poll at all, so there is nothing to hand it.
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("2026-07-28");
    expect(await tagsOf(t)).toEqual([[], []]);
  });

  test("a cancelled task stays cancelled", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      await seedNotes(t, 2);

      const created = (await (
        await modern(
          t,
          "tools/call",
          { name: "notes_bulkTag", arguments: { tag: "reviewed" } },
          ADMIN,
          TASKING,
        )
      ).json()) as TaskEnvelope;
      const taskId = created.result?.taskId;

      const cancelled = (await (
        await modern(t, "tasks/cancel", { taskId }, ADMIN, TASKING)
      ).json()) as TaskEnvelope;
      // An empty ack, not the task. The status it settled to is read
      // from the next `tasks/get`.
      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result?.resultType).toBe("complete");
      expect(cancelled.result?.status).toBeUndefined();

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const polled = (await (
        await modern(t, "tasks/get", { taskId }, ADMIN, TASKING)
      ).json()) as TaskEnvelope;
      // Terminal states never change, so the scheduled executor firing
      // afterwards cannot resurrect it.
      expect(polled.result?.status).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MCP tasks: the "optional" level on notes_reindex', () => {
  test("shouldCreate keeps a small store inline", async () => {
    const t = newTest();
    await seedNotes(t, 2);

    // The client CAN poll and the tool IS task-capable. The mount's
    // `shouldCreate` still answers inline, because two notes are not
    // worth a round trip. That decision lives in the host: the gateway
    // knows the tool defers, not whether this call is slow.
    const res = await modern(
      t,
      "tools/call",
      { name: "notes_reindex", arguments: {} },
      ADMIN,
      TASKING,
    );
    const body = (await res.json()) as TaskEnvelope;

    expect(body.result?.resultType).not.toBe("task");
    expect(body.result?.taskId).toBeUndefined();
    expect(body.result?.structuredContent?.scanned).toBe(2);
  });

  test("shouldCreate defers once the store is big enough", async () => {
    vi.useFakeTimers();
    try {
      const t = newTest();
      // Matches REINDEX_TASK_THRESHOLD in convex/http.ts.
      await seedNotes(t, 25);

      const created = (await (
        await modern(
          t,
          "tools/call",
          { name: "notes_reindex", arguments: {} },
          ADMIN,
          TASKING,
        )
      ).json()) as TaskEnvelope;
      expect(created.result?.resultType).toBe("task");

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const polled = (await (
        await modern(
          t,
          "tasks/get",
          { taskId: created.result?.taskId },
          ADMIN,
          TASKING,
        )
      ).json()) as TaskEnvelope;
      expect(polled.result?.status).toBe("completed");
      expect(polled.result?.result?.structuredContent?.scanned).toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a client that never declared the extension just gets the answer", async () => {
    const t = newTest();
    await seedNotes(t, 30);

    // Above the threshold, so `shouldCreate` would say "task". It is
    // never asked: a task is only possible for a client that opted in,
    // and an `"optional"` tool answers such a client inline instead of
    // refusing. That is what keeps one catalog serving both eras.
    const body = (await (
      await modern(
        t,
        "tools/call",
        { name: "notes_reindex", arguments: {} },
        ADMIN,
      )
    ).json()) as TaskEnvelope;

    expect(body.error).toBeUndefined();
    expect(body.result?.resultType).not.toBe("task");
    expect(body.result?.structuredContent?.scanned).toBe(30);
  });

  test("a legacy params.task hint is ignored, not refused", async () => {
    const t = newTest();
    await seedNotes(t, 2);

    // Before SEP-2663 shipped, a client asked for a task per call. The
    // field is now a legacy hint: `notes_list` is not task-capable, and
    // the call runs normally instead of erroring.
    const body = (await (
      await modern(
        t,
        "tools/call",
        { name: "notes_list", arguments: {}, task: {} },
        ADMIN,
        TASKING,
      )
    ).json()) as TaskEnvelope;

    expect(body.error).toBeUndefined();
    expect(body.result?.resultType).not.toBe("task");
    expect(body.result?.content?.[0]?.type).toBe("text");
  });
});

// =================================================================
// JSON Schema pass-through on notes_search (SEP-1613, gateway 0.11.0).
// =================================================================

describe("authored JSON Schema on notes_search", () => {
  test("the client receives the document the host wrote", async () => {
    const t = newTest();
    const res = await modern(t, "tools/list", {}, ADMIN);
    const body = (await res.json()) as Envelope<{
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    }>;
    const tool = body.result!.tools.find((x) => x.name === "notes_search");
    const advertised = tool!.inputSchema;

    // The dialect declaration survives the registry. Convex reserves
    // field names starting with `$`, so up to gateway 0.10.0 this single
    // key failed the write from inside Convex and took the whole mount
    // down, `initialize` included; the authored document is now stored
    // JSON-encoded beside the gateway's own resolved view.
    expect(advertised.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    // References reach the client as written, rather than expanded. The
    // resolved copy still exists gateway-side, where it bounds the work
    // a hostile schema can cause and backs the `x-mcp-header` walk; a
    // client just never sees it.
    expect(advertised.$defs).toHaveProperty("condition.properties.field.enum", [
      "title",
      "body",
    ]);
    const schema = advertised as unknown as {
      properties: {
        filter: { anyOf: [Record<string, unknown>, Record<string, unknown>] };
      };
    };
    const [single, conjunction] = schema.properties.filter.anyOf;
    expect(single).toEqual({ $ref: "#/$defs/condition" });
    // The second branch references the same leaf from inside `items`.
    expect(conjunction).toHaveProperty(
      "properties.all.items.$ref",
      "#/$defs/condition",
    );
  });

  test("a single condition dispatches through the anyOf branch", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("notes", { title: "shopping", body: "milk" });
      await ctx.db.insert("notes", { title: "meeting", body: "agenda" });
    });

    const body = await once<{ structuredContent?: unknown; content: { text: string }[] }>(
      t,
      ADMIN,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "notes_search",
          arguments: { filter: { field: "title", contains: "shop" } },
        },
      },
    );

    const found = JSON.parse(body.result!.content[0]!.text) as { title: string }[];
    expect(found.map((n) => n.title)).toEqual(["shopping"]);
  });

  test("an `all` conjunction dispatches through the other branch", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("notes", { title: "shopping", body: "milk" });
      await ctx.db.insert("notes", { title: "shopping", body: "bread" });
    });

    const body = await once<{ content: { text: string }[] }>(t, ADMIN, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "notes_search",
        arguments: {
          filter: {
            all: [
              { field: "title", contains: "shop" },
              { field: "body", contains: "milk" },
            ],
          },
        },
      },
    });

    const found = JSON.parse(body.result!.content[0]!.text) as { body: string }[];
    expect(found.map((n) => n.body)).toEqual(["milk"]);
  });
});

// =================================================================
// MRTR on `resources/read`, new in gateway 0.9.0. The tool-side
// counterpart is `notes_purge` above; this is the read side, gated by
// the mount-level `beforeResourceRead` hook in http.ts. What matters is
// that the provider does not run until an answer arrives, so the
// assertions look at the served content, not only at the envelope.
// =================================================================

type ReadEnvelope = Envelope<{
  resultType?: string;
  requestState?: string;
  inputRequests?: Record<string, unknown>;
  contents?: { uri: string; text: string }[];
}>;

/** A `notes://export` read: first round, or a continuation. */
async function readExport(
  t: Harness,
  params: Record<string, unknown> = {},
): Promise<ReadEnvelope> {
  const res = await modern(
    t,
    "resources/read",
    { uri: "notes://export", ...params },
    ADMIN,
    ELICITING,
  );
  return (await res.json()) as ReadEnvelope;
}

describe("MRTR confirmation on the notes://export read", () => {
  test("the first read asks instead of serving", async () => {
    const t = newTest();
    await seedNotes(t, 2);

    const asked = await readExport(t);

    expect(asked.result?.resultType).toBe("input_required");
    expect(asked.result?.requestState).toBeTruthy();
    expect(Object.keys(asked.result?.inputRequests ?? {})).toEqual(["confirm"]);
    // The point of the gate: no content came back with the question.
    expect(asked.result?.contents).toBeUndefined();
  });

  test("an accepted continuation serves the export", async () => {
    const t = newTest();
    await seedNotes(t, 2);
    const asked = await readExport(t);

    const served = await readExport(t, {
      requestState: asked.result!.requestState,
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
    });

    expect(served.result?.resultType).not.toBe("input_required");
    expect(served.result?.contents?.[0]?.uri).toBe("notes://export");
    expect(served.result?.contents?.[0]?.text).toContain("note 0");
  });

  test("a decline refuses the read rather than serving it", async () => {
    const t = newTest();
    await seedNotes(t, 2);
    const asked = await readExport(t);

    const declined = await readExport(t, {
      requestState: asked.result!.requestState,
      inputResponses: { confirm: { action: "decline" } },
    });

    expect(declined.error?.code).toBe(-32003);
    expect(declined.error?.message).toBe("Export was not confirmed");
    expect(declined.result).toBeUndefined();
  });

  test("an ungated resource is untouched by the hook", async () => {
    // The hook returns null for every other URI, so `notes://all` still
    // reads in one round. Without this, a hook that accidentally gated
    // everything would look exactly like a passing suite.
    const t = newTest();
    await seedNotes(t, 1);

    const res = await modern(t, "resources/read", { uri: "notes://all" }, ADMIN);
    const body = (await res.json()) as ReadEnvelope;

    expect(body.result?.resultType).not.toBe("input_required");
    expect(body.result?.contents?.[0]?.uri).toBe("notes://all");
  });
});

// =================================================================
// Anonymous resources on the /mcp-public/ mount (gateway 1.0.0).
//
// The option is per mount, not per resource: the same catalog is served
// by both handlers, and only this one may answer a caller with no token.
// =================================================================

type PublicReadEnvelope = Envelope<{
  contents?: { uri: string; text: string }[];
}>;

describe("anonymous resources on /mcp-public/", () => {
  test("an anonymous list shows the one resource that allows it", async () => {
    const t = newTest();
    const res = await modernAt(t, "/mcp-public/", "resources/list");
    const body = (await res.json()) as Envelope<{
      resources: { uri: string }[];
    }>;

    // The authorizer is asked per candidate, so denying the rest is also
    // what filters the listing.
    expect(body.result?.resources.map((r) => r.uri)).toEqual([
      "notes://stats",
    ]);
  });

  test("an anonymous read gets content and a null caller", async () => {
    const t = newTest();
    await seedNotes(t, 3);

    const res = await modernAt(t, "/mcp-public/", "resources/read", {
      uri: "notes://stats",
    });
    const body = (await res.json()) as PublicReadEnvelope;

    expect(JSON.parse(body.result!.contents![0]!.text)).toEqual({
      total: 3,
      // The nullable identity, reaching the read handler. A provider that
      // dereferences it without narrowing breaks exactly here.
      caller: null,
    });
  });

  test("the same handler stamps a caller when there is one", async () => {
    const t = newTest();
    await seedNotes(t, 1);

    const res = await modernAt(
      t,
      "/mcp-public/",
      "resources/read",
      { uri: "notes://stats" },
      READER,
    );
    const body = (await res.json()) as PublicReadEnvelope;

    expect(JSON.parse(body.result!.contents![0]!.text)).toEqual({
      total: 1,
      caller: "dev-reader",
    });
  });

  test("anonymous stops at the one allowed URI", async () => {
    const t = newTest();
    await seedNotes(t, 2);

    const res = await modernAt(t, "/mcp-public/", "resources/read", {
      uri: "notes://all",
    });
    const body = (await res.json()) as PublicReadEnvelope;

    // Note contents are not part of the anonymous surface, and the
    // authorizer denies by default rather than by listing what to block.
    expect(body.result?.contents).toBeUndefined();
    // -32001, not the -32003 the export denial below gets: a caller with
    // no token is told to authenticate, one that authenticated and still
    // may not read is told it is forbidden.
    expect(body.error?.code).toBe(-32001);
  });

  test("the gated export is refused here, not served ungated", async () => {
    const t = newTest();
    await seedNotes(t, 2);

    // `anonymousResources` cannot be combined with `beforeResourceRead`,
    // so this mount has no confirmation round. The resource is still in
    // the shared catalog, and an admin token is enough to read it on
    // /mcp/. Serving it here would be the gate silently disappearing.
    const res = await modernAt(
      t,
      "/mcp-public/",
      "resources/read",
      { uri: "notes://export" },
      ADMIN,
    );
    const body = (await res.json()) as PublicReadEnvelope;

    expect(body.result?.contents).toBeUndefined();
    expect(body.error?.code).toBe(-32003);
  });

  test("a template is not part of the anonymous surface", async () => {
    const t = newTest();
    const id = await seedNote(t);

    // A template expansion carries no registry metadata, so it cannot
    // carry the `public` opt-in either, and the policy denies it.
    const read = (await (
      await modernAt(t, "/mcp-public/", "resources/read", {
        uri: `note://${id}`,
      })
    ).json()) as PublicReadEnvelope;
    expect(read.result?.contents).toBeUndefined();
    expect(read.error?.code).toBe(-32001);

    // Listing templates is refused rather than answered empty, and the
    // difference is deliberate: an anonymous caller the policy granted
    // NOTHING, for a reason that reads as "unauthorized", is challenged
    // so a client whose token merely expired learns to re-authenticate.
    // `resources/list` above is answered, not challenged, because that
    // caller does get something.
    const listed = (await (
      await modernAt(t, "/mcp-public/", "resources/templates/list")
    ).json()) as Envelope<{ resourceTemplates: unknown[] }>;
    expect(listed.result).toBeUndefined();
    expect(listed.error?.code).toBe(-32001);
  });

  test("the bare /mcp-public path is mounted too", async () => {
    const t = newTest();
    await seedNotes(t, 1);

    // Clients strip the trailing slash before they POST, and Convex
    // routes on the exact path. The main mount learned this the hard
    // way; a second mount inherits the problem, not the fix.
    const res = await modernAt(t, "/mcp-public", "resources/read", {
      uri: "notes://stats",
    });
    const body = (await res.json()) as PublicReadEnvelope;

    expect(body.error).toBeUndefined();
    expect(JSON.parse(body.result!.contents![0]!.text).total).toBe(1);
  });

  test("the main mount still refuses anonymous reads", async () => {
    const t = newTest();
    await seedNotes(t, 1);

    // The regression guard for the option being mount-scoped: the same
    // URI, the same caller, the other handler.
    const res = await modern(t, "resources/read", { uri: "notes://stats" });
    const body = (await res.json()) as PublicReadEnvelope;

    expect(body.result?.contents).toBeUndefined();
    expect(body.error?.code).toBe(-32001);
  });
});

// =================================================================
// The MRTR fallback for clients that cannot elicit (gateway 0.11.0).
//
// Both hooks ask for a form. Without a fallback the gateway fails such a
// call closed, which is safe but tells a client nothing; `onUnsupported`
// completes it with an ordinary result instead. Neither path runs the
// work.
// =================================================================

describe("clients that cannot answer an input request", () => {
  test("notes_purge explains itself instead of failing closed", async () => {
    const t = newTest();
    await seedNotes(t, 3);

    // No `elicitation` in the declared capabilities.
    const res = await modern(
      t,
      "tools/call",
      { name: "notes_purge", arguments: {} },
      ADMIN,
    );
    const body = (await res.json()) as Envelope<{
      resultType?: string;
      content?: { type: string; text: string }[];
      isError?: boolean;
    }>;

    expect(body.error).toBeUndefined();
    expect(body.result?.resultType).not.toBe("input_required");
    expect(body.result?.content?.[0]?.text).toContain("Nothing was deleted");
    // An error result, not a friendly note. This call did not do what it
    // was asked, and on the session era below it never can.
    expect(body.result?.isError).toBe(true);
    // The whole point: a fallback completes the call BEFORE dispatch.
    expect(await noteCount(t)).toBe(3);
  });

  test("a session-era client lands in the same fallback", async () => {
    const t = newTest();
    await seedNotes(t, 3);

    // The trap worth pinning: this client DOES declare elicitation, at
    // `initialize`. The gateway only reads per-request capabilities on
    // 2026-07-28 and cannot vouch for a session-era one, so the hook's
    // fallback substitutes for the protocol error this used to get.
    // Which means `notes_purge` cannot run at all on this protocol, and
    // the fallback has to say so rather than look like a success.
    const session = await openSession(t, ADMIN);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "notes_purge", arguments: {} },
      },
      ADMIN,
    );
    const body = (await res.json()) as Envelope<{
      content?: { text: string }[];
      isError?: boolean;
    }>;

    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("2026-07-28");
    expect(await noteCount(t)).toBe(3);
  });

  test("the export falls back to titles, never bodies", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("notes", { title: "public title", body: "secret" });
    });

    const res = await modern(t, "resources/read", { uri: "notes://export" }, ADMIN);
    const body = (await res.json()) as PublicReadEnvelope;

    const text = body.result!.contents![0]!.text;
    expect(text).toContain("public title");
    expect(text).toContain("titles only");
    expect(text).not.toContain("secret");
  });

  test("the export fallback also catches session-era reads", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("notes", { title: "public title", body: "secret" });
    });

    // Same trigger as the purge above, on the read side. A session-era
    // admin gets the redacted answer rather than the confirmation round.
    const session = await openSession(t, ADMIN);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: { uri: "notes://export" },
      },
      ADMIN,
    );
    const body = (await res.json()) as PublicReadEnvelope;

    const text = body.result!.contents![0]!.text;
    expect(text).toContain("titles only");
    expect(text).not.toContain("secret");
  });
});
