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
  "On MCP 2026-07-28, `notes_bulkTag` never answers inline: it hands",
  "back a task handle, so poll `tasks/get` for its tally. On an older",
  "revision it cannot run at all.",
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
      // the database and tell the user what they are about to lose.
      // `ctx.runQuery` is named on the callback context, so only the
      // result needs a type; it is deliberately loose in the gateway,
      // because `api.*` references are generated per project.
      const ask = async () => {
        const { total } = (await ctx.runQuery(api.notes.count, {})) as {
          total: number;
        };
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
          {
            // The fallback for a client whose capabilities cannot carry
            // this round. Without it the gateway fails the call closed
            // with a protocol error, which is safe but tells the model
            // nothing it can act on.
            //
            // Read the trigger carefully before copying this. It is not
            // only "the client did not declare elicitation": the gateway
            // has per-request capabilities on 2026-07-28 ONLY, and
            // treats a session-era call as one it cannot vouch for. So
            // this fallback also replaces the `-32601` that a
            // 2025-era client used to get, INCLUDING one that declared
            // elicitation at `initialize`. The message therefore names
            // both ways to get here, and it is an ERROR result rather
            // than a friendly note: on the session protocol this tool
            // can never run, and reporting that as a successful call
            // would make it a permanent silent no-op.
            //
            // What a fallback never does is wave the gate through: it
            // COMPLETES the call before dispatch, so the mutation is as
            // un-run as after a decline.
            //
            // No `structuredContent`, though this tool declares an
            // `outputSchema`: there was no purge, so there is no
            // `{ deleted, replayed }` to report, and inventing one would
            // tell the model a delete happened. Same shape the decline
            // branch below returns.
            onUnsupported: completeCall({
              content: [
                {
                  type: "text",
                  text:
                    "Nothing was deleted: this purge needs a confirmation " +
                    "round, which requires MCP 2026-07-28 and a client " +
                    "that declares the `elicitation` capability.",
                },
              ],
              isError: true,
            }),
          },
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
   * MCP Tasks, at the `"optional"` level.
   *
   * SEP-2663 gives the client no per-call say: it declares the
   * `io.modelcontextprotocol/tasks` extension once in its capabilities
   * and then handles whichever result arrives. So the SERVER decides,
   * and this level is what hands that decision to the host: the mount in
   * convex/http.ts passes a `tasks.shouldCreate` that answers "inline"
   * for a small store and "task" for one large enough to be worth
   * polling. Omitting the callback would make every eligible call a
   * task.
   *
   * The mount passes no `execute`, so the component's built-in scheduled
   * executor runs this tool once after the HTTP request returns. That is
   * durable across restarts and deliberately does not retry: a mutation
   * that already committed must not run twice.
   *
   * Tasks exist only on `2026-07-28`, and only for an authenticated
   * caller, because a task is owner-bound. A caller who clears this
   * tool's own `admin` bar but cannot have a task (a session-era client,
   * or one that never declared the extension) gets the ordinary
   * synchronous result instead, with no task and no error, which is what
   * lets one catalog serve both eras. An anonymous caller never gets
   * that far: `authorize` answers `-32001` first.
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
    taskSupport: "optional",
    title: "Reindex notes",
    annotations: { readOnlyHint: false, idempotentHint: true },
    metadata: { roles: ["admin"] },
  }),
  /**
   * The other task level: `"required"`, for work that has no synchronous
   * answer to give.
   *
   * `"optional"` above still runs inline whenever a task is impossible
   * (a legacy client, an anonymous caller) or unwanted (`shouldCreate`
   * said no). `"required"` says that inline is never a valid outcome for
   * this tool, and the gateway then refuses instead of dispatching:
   *
   * - a modern client that did not declare the tasks extension is
   *   answered `-32021 MissingRequiredClientCapability`, whose
   *   `data.requiredCapabilities` names exactly what to add,
   * - an anonymous caller is challenged, because a task is owner-bound,
   * - a session-era client is answered `-32602` naming the protocol
   *   revision it would need.
   *
   * Refusing is the point. Dispatching such a call anyway would run the
   * side effect the level exists to defer, and then hand the client a
   * result it did not ask for and may not be able to read.
   */
  defineMcpMutation({
    name: "notes_bulkTag",
    description:
      "Label every note. Runs only as an MCP task; poll tasks/get for " +
      "the tally.",
    fn: api.notes.bulkTag,
    args: { tag: v.string() },
    returns: v.object({ tagged: v.float64(), alreadyTagged: v.float64() }),
    taskSupport: "required",
    title: "Bulk-tag notes",
    annotations: { readOnlyHint: false, idempotentHint: true },
    metadata: { roles: ["admin"] },
  }),
  /**
   * JSON Schema 2020-12 `$defs` + `$ref` + `anyOf`, kept as authored.
   *
   * The filter is either one condition or a conjunction of them, and the
   * schema says so by naming the leaf once instead of inlining it twice.
   *
   * What a client receives is exactly this document, `$schema`, `$defs`
   * and both `$ref`s included, as SEP-1613 asks. The gateway keeps a
   * second, resolved view for its own purposes (validating the
   * `x-mcp-header` annotations, bounding the work a hostile schema can
   * cause), and that resolution is where a cyclic or oversized schema is
   * rejected at sync time with the tool named. The client never sees
   * that view. Up to gateway 0.11.0 it did, and a tool that declared its
   * dialect at all took the whole mount down, because a Convex document
   * cannot carry a field name starting with `$`; the registry now stores
   * the authored form JSON-encoded beside the resolved one.
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
      // Declaring the dialect is the SEP-1613 point of the pass-through:
      // a `$`-prefixed keyword now survives the registry instead of
      // failing the write from inside Convex.
      $schema: "https://json-schema.org/draft/2020-12/schema",
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
 * without deciding to "act".
 *
 * A read normally requires an authenticated caller, and the gateway
 * rejects anonymous ones before `read` runs. The exception is a mount
 * that sets `anonymousResources` (convex/http.ts mounts one at
 * `/mcp-public/`), which is why every `read` handler here takes
 * `identity` as NULLABLE. Narrow it before use: a handler that reads
 * `identity.subject` unconditionally compiles on a mount that never
 * serves anonymous callers and breaks on the one that does.
 */
export const resources: McpResourceRegistration[] = [
  defineMcpResource({
    uri: "notes://all",
    name: "notes-all",
    title: "All notes",
    description: "Every note in the store, as JSON.",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.5 },
    // Advertised verbatim in `resources/list`. The gateway never fetches
    // an icon; the spec leaves the cross-domain and SVG precautions to
    // the client that decides to display it.
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
    read: async (ctx, { uri }) => {
      const notes = await ctx.runQuery(api.notes.list, {});
      return [
        { uri, mimeType: "application/json", text: JSON.stringify(notes) },
      ];
    },
  }),
  defineMcpResource({
    uri: "notes://export",
    name: "notes-export",
    title: "Bulk export",
    description:
      "Every note as one flat text export. Asks for confirmation first.",
    mimeType: "text/plain",
    // The read itself is ordinary. What makes this resource interesting
    // is the mount-level `beforeResourceRead` hook in http.ts, which
    // holds the read back for a confirmation round before this ever runs
    // (gateway 0.9.0). The provider stays MCP-unaware, exactly as the
    // Convex functions behind an MRTR-gated tool do.
    read: async (ctx, { uri }) => {
      const notes = (await ctx.runQuery(api.notes.list, {})) as Array<{
        title: string;
        body: string;
      }>;
      return [
        {
          uri,
          mimeType: "text/plain",
          text: notes.map((n) => `# ${n.title}\n${n.body}`).join("\n\n"),
        },
      ];
    },
  }),
  defineMcpResource({
    uri: "notes://stats",
    name: "notes-stats",
    title: "Store statistics",
    description: "How many notes exist. Readable without a token.",
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.2 },
    // Host-side metadata, never advertised to a client. The
    // `/mcp-public/` mount's authorizer reads it as the opt-in for
    // anonymous reads, which is why this handler has to deal with a null
    // caller. It carries no note contents on purpose: a count is what an
    // unauthenticated client may know.
    metadata: { public: true },
    read: async (ctx, { uri, identity }) => {
      const { total } = (await ctx.runQuery(api.notes.count, {})) as {
        total: number;
      };
      return [
        {
          uri,
          mimeType: "application/json",
          // `identity` is null on the anonymous mount and a caller
          // everywhere else. Stamping it either way keeps the two mounts
          // distinguishable from the client side, and is the narrowing
          // the nullable type asks for.
          text: JSON.stringify({ total, caller: identity?.subject ?? null }),
        },
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
    // Persisted with the template row, unlike a concrete resource's, so
    // a registry-only template still lists its full descriptor.
    icons: [{ src: "https://example.com/icons/note.png", sizes: ["96x96"] }],
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
