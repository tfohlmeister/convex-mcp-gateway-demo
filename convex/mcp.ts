import {
  McpGateway,
  completeCall,
  defineMcpMutation,
  defineMcpQuery,
  defineMcpResource,
  defineMcpResourceTemplate,
  inputRequired,
  mcpCallerValidator,
  type McpResourceRegistration,
  type McpResourceTemplateProvider,
  type McpToolRegistration,
} from "convex-mcp-gateway";
import { v } from "convex/values";
import { api, components } from "./_generated/api.js";
import { internalMutation, query } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

/**
 * Server-level guidance handed to the model on `initialize`, so the
 * client does not have to infer the deny-by-default policy from the
 * individual tool descriptions.
 */
export const instructions = [
  "A small notes store exposed over MCP.",
  "",
  "Only `notes_count` is public. Everything else needs a Bearer token,",
  "and the write tools additionally need the `admin` group. Reading an",
  "individual note through `note://{id}` is admin-only as well.",
  "Prefer the `notes://all` resource over `notes_list` when you just",
  "need the current contents; it is cheaper and read-only.",
].join("\n");

/**
 * The declarative tool catalog. `convex/http.ts` passes this to
 * `gateway.handleMcpRequest({ tools })`, so the gateway reconciles the
 * component registry on every `initialize`. Editing this array takes
 * effect on the next client connect, with no registration mutation to
 * run by hand. The reconcile is change-detected, so an unchanged list
 * costs one cheap lookup per connect rather than a rewrite.
 *
 * The `McpToolRegistration[]` annotation is required because the array
 * is exported from a Convex module: without it the inferred type reads
 * `api.*` from the tool `fn`s while `api` includes this module, and
 * codegen hits a circular reference. Per-tool type safety is unaffected.
 */
export const tools: McpToolRegistration[] = [
  defineMcpQuery({
    name: "notes_list",
    description: "List all notes (requires authentication).",
    fn: api.notes.list,
    args: {},
    title: "List notes",
    annotations: { readOnlyHint: true },
  }),
  defineMcpQuery({
    name: "notes_whoami",
    description:
      "Return the authenticated caller. The gateway injects the identity " +
      "into the `caller` argument server-side; clients never send it.",
    fn: api.notes.whoami,
    args: { caller: mcpCallerValidator },
    returns: v.object({ subject: v.string(), claims: v.array(v.string()) }),
    // Names the argument the gateway fills with the resolved caller. It
    // is stripped from the advertised inputSchema, a client-supplied
    // value is discarded, and a call with no resolved identity is
    // rejected as -32001 Unauthorized.
    identityArg: "caller",
    title: "Who am I",
    annotations: { readOnlyHint: true },
  }),
  defineMcpMutation({
    name: "notes_create",
    description: "Create a new note (requires admin role).",
    fn: api.notes.create,
    args: {
      title: v.string(),
      body: v.string(),
      caller: v.optional(mcpCallerValidator),
    },
    // The created note records who made it, taken from the injected
    // identity rather than anything the client sent.
    identityArg: "caller",
    title: "Create note",
    annotations: { readOnlyHint: false, destructiveHint: false },
    metadata: { roles: ["admin"], auditArgs: false },
  }),
  defineMcpMutation({
    name: "notes_update",
    description: "Update an existing note (requires admin role).",
    fn: api.notes.update,
    args: { id: v.id("notes"), title: v.string(), body: v.string() },
    title: "Update note",
    annotations: { readOnlyHint: false, idempotentHint: true },
    metadata: {
      roles: ["admin"],
      auditArgs: { redact: ["body"] },
    },
  }),
  defineMcpMutation({
    name: "notes_delete",
    description: "Delete a note (requires admin role).",
    fn: api.notes.remove,
    args: { id: v.id("notes") },
    title: "Delete note",
    annotations: { readOnlyHint: false, destructiveHint: true },
    metadata: { roles: ["admin"] },
  }),
  /**
   * The one hand-written entry in this array, and the only way to use
   * `x-mcp-header` today.
   *
   * MCP 2026-07-28 lets a server mirror selected tool arguments into
   * `Mcp-Param-<Name>` HTTP headers so intermediaries (load balancers,
   * gateways, rate limiters) can route and inspect a call without parsing
   * the JSON-RPC body. On a 2026-07-28 request the gateway re-validates
   * that every mirrored header matches the body before authorization or
   * dispatch, so a proxy routing on the header and Convex executing on
   * the body cannot disagree. A mismatch is `-32020`, and a client that
   * omits a required `Mcp-Param-*` is rejected the same way.
   *
   * That guarantee is scoped to the modern protocol. This endpoint also
   * serves session-based 2025-era clients, and those never send routing
   * headers, so nothing is validated for them. An intermediary that
   * enforces policy on `Mcp-Param-*` must therefore also require the
   * `MCP-Protocol-Version` header to name a revision that mandates
   * header validation, and reject the request otherwise. The transport
   * spec says exactly this. A deployment that cannot do that should stop
   * serving the legacy era instead of relying on the headers.
   *
   * `defineMcpQuery` cannot express this: it derives `inputSchema` from
   * the Convex validators, which never emit the annotation. So the
   * registration is written out by hand. It still goes through the same
   * declarative `tools` array, which is typed `McpToolRegistration[]`;
   * `gateway.register(...)` would be the wrong tool here, because the
   * imperative path clears the declarative fingerprint and the next
   * request's sync would drop the tool again.
   *
   * Constraints the gateway enforces at sync time, with the tool named in
   * the error: the annotation must be reachable through a chain of
   * `properties` keys only (never via `items`, `anyOf`/`oneOf`/`allOf`,
   * `if`/`then`/`else` or `$ref`), names must be case-insensitively
   * unique, and only string, integer and boolean properties qualify.
   */
  {
    name: "notes_by_author",
    description:
      "List notes written by one MCP subject. Mirrors both arguments " +
      "into Mcp-Param-Author and Mcp-Param-Limit headers.",
    kind: "query",
    fn: api.notes.byAuthor,
    functionReference: api.notes.byAuthor,
    inputSchema: {
      type: "object",
      properties: {
        author: {
          type: "string",
          description: "MCP subject that created the notes.",
          // Routing keys are the point of this mechanism: a real
          // deployment shards or rate-limits per tenant or per user
          // without the proxy ever reading the body.
          "x-mcp-header": "Author",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of notes to return.",
          // Integers are compared numerically, so a client sending
          // `Mcp-Param-Limit: 25.0` for a body value of 25 is accepted.
          "x-mcp-header": "Limit",
        },
      },
      required: ["author", "limit"],
      additionalProperties: false,
    },
    title: "Notes by author",
    annotations: { readOnlyHint: true },
    // Any authenticated caller may pass any subject here. That exposes
    // nothing new in this demo, because `notes_list` already hands the
    // whole table to the same callers, but do not copy the shape into a
    // deployment where it would: there, drop the argument and declare
    // `identityArg` so the gateway fills the subject server-side and a
    // client cannot ask about anyone else.
    //
    // The two do not combine usefully. Header validation runs before the
    // gateway strips an identity-injected argument, so mirroring one
    // into a header would make the client send a value that is checked
    // and then thrown away. Routing headers are for values the client
    // legitimately supplies.
  },
  /**
   * MRTR (multi round-trip requests) plus MCP elicitation, on the most
   * destructive operation in the demo.
   *
   * The gateway runs `beforeCall` BEFORE dispatch, so `notes.purge` does
   * not execute until this hook returns `null`. A first call answers
   * `resultType: "input_required"` carrying an HMAC-sealed
   * `requestState`; the client asks its user, then re-sends that state
   * with the answer. The seal is what makes the round trip safe: the
   * gateway will not accept a continuation it did not mint, aimed at a
   * different tool, or carrying different arguments.
   *
   * `mrtrArgs.idempotencyKey` names the argument the gateway fills with
   * the confirmed continuation's key. It is stripped from the advertised
   * `inputSchema`, so a client can neither see nor spoof it, and it is
   * stable across retries of the SAME confirmation. `notes.purge`
   * persists it around the delete, which is what turns "the response got
   * lost, ask again" into a replay rather than a second purge.
   *
   * Declining is handled entirely here: `completeCall` finishes the
   * request without ever dispatching, so the refusal is structural
   * rather than a check inside the mutation that could be forgotten.
   */
  defineMcpMutation({
    name: "notes_purge",
    description:
      "Delete every note. Asks for confirmation first and will not run " +
      "without it.",
    fn: api.notes.purge,
    args: {
      // Gateway-only: filled with the confirmed continuation's
      // idempotency key. Absent from tools/list, unspoofable.
      confirmationKey: v.optional(v.string()),
    },
    returns: v.object({ deleted: v.float64(), replayed: v.boolean() }),
    mrtrArgs: { idempotencyKey: "confirmationKey" },
    beforeCall: async (ctx, { inputResponses, round }) => {
      // The hook runs in the HOST, not in the component, so it can read
      // the database and tell the user what they are about to lose. The
      // gateway types this ctx as `{ auth } & Record<string, unknown>`,
      // so `runQuery` needs narrowing before use.
      const { runQuery } = ctx as unknown as {
        runQuery: (
          ref: typeof api.notes.count,
          args: Record<string, never>,
        ) => Promise<{ total: number }>;
      };
      const ask = async () => {
        const { total } = await runQuery(api.notes.count, {});
        return inputRequired(
          {
            confirm: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: `Delete all ${total} notes? This cannot be undone.`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    confirm: {
                      type: "boolean",
                      description: "Confirm deleting every note.",
                    },
                  },
                  required: ["confirm"],
                },
              },
            },
          },
          // Opaque host state, sealed into `requestState` and handed
          // back on the continuation. Carried here to show the channel;
          // it is not trusted input on the way back, it is verified.
          { askedAt: Date.now(), noteCount: total },
        );
      };
      // Discriminate on `round`, not on `inputResponses`: a state-only
      // retry is a continuation, not a first call.
      if (round === undefined) return await ask();
      // `inputResponses` is client-controlled. The seal proves the round
      // belongs to this call; it says nothing about the answer's shape.
      const answer = inputResponses?.confirm as
        | { action?: string; content?: { confirm?: unknown } }
        | undefined;
      if (answer === undefined) return await ask(); // no answer yet: ask again
      if (answer.action !== "accept" || answer.content?.confirm !== true) {
        // Declined or cancelled: finish WITHOUT dispatching. The
        // mutation never runs, gateway-side by construction.
        return completeCall({
          content: [{ type: "text", text: "Nothing was deleted." }],
          isError: false,
        });
      }
      return null; // accepted: dispatch, with confirmationKey injected
    },
    title: "Purge all notes",
    annotations: { readOnlyHint: false, destructiveHint: true },
    metadata: { roles: ["admin"] },
  }),
  /**
   * MCP Tasks. `taskSupport: true` lets a modern client send
   * `tools/call` with a `task` request and poll `tasks/get` for the
   * result instead of holding the request open.
   *
   * The mount in convex/http.ts passes `tasks: {}`, i.e. no `execute`,
   * so the component's built-in scheduled executor runs this tool once
   * after the HTTP request returns. That is durable across restarts and
   * deliberately does not retry: a mutation that already committed must
   * not run twice.
   *
   * Tasks exist only on `2026-07-28`. A session-based client calling
   * this tool gets the ordinary synchronous result, with no task and no
   * error, so the same catalog serves both eras.
   */
  defineMcpMutation({
    name: "notes_reindex",
    description:
      "Walk every note and report a per-author tally. Task-capable: a " +
      "modern client may poll for the result.",
    fn: api.notes.reindex,
    args: {},
    returns: v.object({
      scanned: v.float64(),
      authors: v.array(
        v.object({ author: v.string(), notes: v.float64() }),
      ),
    }),
    taskSupport: true,
    title: "Reindex notes",
    annotations: { readOnlyHint: false, idempotentHint: true },
    metadata: { roles: ["admin"] },
  }),
  /**
   * Bounded JSON Schema 2020-12 `$ref` and composition.
   *
   * The filter is either one condition or a conjunction of them, and the
   * schema says so with `$defs` + `$ref` + `anyOf` instead of inlining
   * the leaf twice.
   *
   * The gateway RESOLVES those references at registration and advertises
   * the expanded, self-contained form: what a client receives here has
   * no `$ref` and no `$defs` left in it. That is the point. The host
   * gets to factor a shared shape out once, and a client that cannot
   * follow a reference still sees a complete schema. Resolution is
   * bounded in depth and total work, so a cyclic or hostile schema
   * cannot hang the request; it is rejected at sync time with the tool
   * named.
   *
   * Written out by hand for the same reason as `notes_by_author`:
   * `defineMcpQuery` derives `inputSchema` from the Convex validators,
   * which inline everything and never emit `$defs`. The Convex function
   * still validates the argument, so the two agree on what is legal;
   * only the advertised description is factored differently.
   */
  {
    name: "notes_search",
    description:
      "Find notes by substring, either on one field or on several at once.",
    kind: "query",
    fn: api.notes.search,
    functionReference: api.notes.search,
    inputSchema: {
      type: "object",
      $defs: {
        condition: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["title", "body"] },
            contains: { type: "string", minLength: 1 },
          },
          required: ["field", "contains"],
          additionalProperties: false,
        },
      },
      properties: {
        filter: {
          description: "One condition, or an `all` conjunction of them.",
          anyOf: [
            { $ref: "#/$defs/condition" },
            {
              type: "object",
              properties: {
                all: {
                  type: "array",
                  minItems: 1,
                  items: { $ref: "#/$defs/condition" },
                },
              },
              required: ["all"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["filter"],
      additionalProperties: false,
    },
    title: "Search notes",
    annotations: { readOnlyHint: true },
  },
  defineMcpQuery({
    name: "notes_count",
    description: "Return the total number of notes. Public.",
    fn: api.notes.count,
    args: {},
    // Typed return -> claude.ai / Inspector get a typed
    // structuredContent block alongside the text content.
    // Compile-checked against api.notes.count's actual return type.
    returns: v.object({ total: v.float64() }),
    title: "Count notes",
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { "convex-mcp-gateway-demo/category": "notes" },
    metadata: { public: true },
  }),
];

/**
 * Concrete MCP resources, passed to `handleMcpRequest({ resources })`.
 * Unlike a tool, a resource is read-only content the client can pull
 * without deciding to "act". Reads always require an authenticated
 * caller; the gateway rejects anonymous ones before `read` runs.
 */
export const resources: McpResourceRegistration[] = [
  defineMcpResource({
    uri: "notes://all",
    name: "notes-all",
    title: "All notes",
    description: "Every note in the store, as JSON.",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.5 },
    read: async (ctx, { uri }) => {
      const notes = await ctx.runQuery(api.notes.list, {});
      return [
        { uri, mimeType: "application/json", text: JSON.stringify(notes) },
      ];
    },
  }),
];

/**
 * RFC 6570 resource templates, passed to
 * `handleMcpRequest({ resourceTemplates })`. A template is advertised
 * through `resources/templates/list`; the client expands it and reads
 * the concrete URI through the ordinary `resources/read`, which the
 * gateway routes back into this handler.
 */
export const resourceTemplates: McpResourceTemplateProvider[] = [
  defineMcpResourceTemplate({
    uriTemplate: "note://{id}",
    name: "note",
    title: "Note by id",
    description: "Read a single note by its id.",
    mimeType: "application/json",
    read: async (ctx, { uri, params }) => {
      const note = await ctx.runQuery(api.notes.get, { id: params.id });
      // null means "no such resource": the gateway turns it into the
      // standard not-found error instead of an empty read.
      if (!note) return null;
      return [
        { uri, mimeType: "application/json", text: JSON.stringify(note) },
      ];
    },
  }),
];

/**
 * Imperative alternative to the declarative `tools` option above:
 * populate the registry from a mutation instead of on `initialize`.
 * Hosts that pass `tools` to `handleMcpRequest` (as this demo does) do
 * not need it. Kept as a runnable illustration of the dynamic-catalog
 * path:
 *
 * ```sh
 * pnpm convex:run mcp:registerDefaults
 * ```
 */
export const registerDefaults = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Bridge mode (optional): when MCP_AUTH_SERVER_URL is set, the
    // gateway advertises THIS deployment as the authorization server
    // and runs the DCR + AS-metadata wrap so browser MCP clients
    // (claude.ai et al.) speak to your IdP through us. Without it the
    // gateway still works, just no OAuth discovery for browser
    // clients. Resource = origin only; some clients bail silently
    // when the resource URL includes a path beyond origin.
    if (process.env.MCP_AUTH_SERVER_URL) {
      await gateway.setOAuthConfig(ctx, {
        authServerUrl: process.env.MCP_AUTH_SERVER_URL,
        resourceUrl:
          process.env.MCP_RESOURCE_URL ?? process.env.MCP_AUTH_SERVER_URL,
      });
    }
    await gateway.register(ctx, tools);
    return null;
  },
});

/**
 * OAuth config is the one piece the declarative catalog does not cover:
 * it is deployment state, not part of the tool list. Run once after
 * deploying with MCP_AUTH_SERVER_URL set.
 *
 * ```sh
 * pnpm convex:run mcp:configureOAuth
 * ```
 */
export const configureOAuth = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!process.env.MCP_AUTH_SERVER_URL) {
      throw new Error(
        "MCP_AUTH_SERVER_URL is not set; nothing to configure. See .env.example.",
      );
    }
    await gateway.setOAuthConfig(ctx, {
      authServerUrl: process.env.MCP_AUTH_SERVER_URL,
      resourceUrl:
        process.env.MCP_RESOURCE_URL ?? process.env.MCP_AUTH_SERVER_URL,
    });
    return null;
  },
});

/**
 * Audit log inspector exposed to convex run / the UI panel. Wraps
 * gateway.listAuditEntries. Covers both tool calls and, because
 * `auditResources` is enabled in http.ts, resource operations.
 */
export const recentAudit = query({
  args: {},
  handler: async (ctx) => {
    return await gateway.listAuditEntries(ctx, { limit: 20 });
  },
});
