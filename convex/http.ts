import {
  completeRead,
  declineRead,
  HandleMcpRequestOptions,
  inputRequired,
  McpGateway,
  type McpAuthorizerHandler,
  type McpBeforeResourceReadHandler,
  type McpHostCallbackCtx,
  type McpIdentityResolver,
  type McpResourceAuthorizerHandler,
  type McpServerInfo,
  type McpTasksOptions,
} from "convex-mcp-gateway";
import { httpRouter } from "convex/server";
import { api, components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { instructions, resources, resourceTemplates, tools } from "./mcp.js";

const gateway = new McpGateway(components.mcpGateway);

/**
 * Multi-round-trip requests on `resources/read`, new in gateway 0.9.0.
 * The tool-side equivalent is `notes_purge`'s `beforeCall`; this is the
 * read-side counterpart, and it is **mount-level** rather than
 * per-resource: a provider can serve many URIs and the gateway cannot
 * know which one owns a URI without calling it, so the gate sits where
 * the URI is known and nothing has run yet. Branch on `uri` inside.
 *
 * Returning `null` falls through to the ordinary read path, so every URI
 * except the one gated below behaves exactly as before.
 */
const beforeResourceRead: McpBeforeResourceReadHandler = async (
  ctx,
  { uri, inputResponses },
) => {
  if (uri !== "notes://export") return null;
  const ask = async () => {
    // The tool-side `beforeCall` gets `runQuery` named on its context;
    // this read-side hook is still typed as the loose host context, so
    // it needs one narrowing. It is the same context at runtime, which
    // is what makes the cast safe rather than hopeful.
    const runQuery = ctx.runQuery as McpHostCallbackCtx["runQuery"];
    const notes = (await runQuery(api.notes.list, {})) as Array<{
      title: string;
    }>;
    return inputRequired(
      {
        confirm: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Export every note as one document?",
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean" } },
              required: ["confirm"],
            },
          },
        },
      },
      undefined,
      {
        // The read-side counterpart of `notes_purge`'s fallback, and the
        // shape `completeRead` exists for: a redacted answer instead of
        // a refusal. Titles, never bodies.
        //
        // Same trigger caveat as there, and it decides how much may be
        // in this answer: the gateway can only read per-request
        // capabilities on 2026-07-28, so EVERY session-era read lands
        // here too, including one from a client that declared
        // elicitation. This fallback is therefore what a 2025-era admin
        // sees instead of the confirmation round.
        //
        // Titles are defensible for exactly that audience and no wider:
        // `authorizeResource` already requires the `admin` group for
        // this URI, and an admin can read any single note through
        // `note://{id}` anyway. The gate is about handing over every
        // body in one document, and that is still gated. Do not widen a
        // fallback past what its caller could already reach.
        onUnsupported: completeRead([
          {
            uri,
            mimeType: "text/plain",
            text: [
              `${notes.length} notes, titles only. The full export needs a`,
              "confirmation round, which requires MCP 2026-07-28 and a",
              "client that declares the `elicitation` capability.",
              "",
              ...notes.map((note) => `# ${note.title}`),
            ].join("\n"),
          },
        ]),
      },
    );
  };
  if (inputResponses === undefined) return await ask();
  // `inputResponses` is client-controlled, so validate every field before
  // acting on it. A malformed answer asks again rather than serving.
  const confirm = inputResponses.confirm as
    | { action?: string; content?: { confirm?: unknown } }
    | undefined;
  if (confirm === undefined) return await ask();
  if (confirm.action !== "accept" || confirm.content?.confirm !== true) {
    return declineRead("Export was not confirmed");
  }
  return null;
};

// Upstream OIDC issuer + pre-registered client id, both env-driven so
// this demo runs against any IdP. Examples:
//   OIDC_ISSUER=https://your-tenant.eu.auth0.com
//   OIDC_CLIENT_ID=abc123...
// When unset (the default for `pnpm local:start`), the OAuth bridge
// routes still mount but return empty metadata: public tools work,
// auth-gated tools return 401.
const OIDC_ISSUER = process.env.OIDC_ISSUER ?? "";
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "";
// Userinfo endpoint path. Defaults to the OIDC standard
// `/api/oidc/userinfo` (Pocket-ID), but Auth0/Authentik/Keycloak
// expose it elsewhere, override with OIDC_USERINFO_PATH.
const OIDC_USERINFO_PATH =
  process.env.OIDC_USERINFO_PATH ?? "/api/oidc/userinfo";

/**
 * DEMO ONLY. A single hard-coded Bearer token, off unless
 * MCP_DEV_BEARER_TOKEN is explicitly set.
 *
 * Without it the local flow in the README cannot reach a single
 * auth-gated tool or any resource: no IdP runs next to
 * `pnpm local:start`, so `resolveIdentity` below returns null for every
 * token and everything except `notes_count` answers 401. This makes
 * `identityArg`, the role checks, and the resource reads explorable on
 * a laptop.
 *
 * Never set this on a deployment reachable from the internet. It grants
 * the `admin` group to anyone who knows the string.
 */
const DEV_BEARER_TOKEN = process.env.MCP_DEV_BEARER_TOKEN ?? "";

/**
 * Comma-separated origin allowlist, e.g.
 *   MCP_ALLOWED_ORIGINS=https://claude.ai,https://claude.com
 *
 * MCP requires servers to validate the `Origin` header against DNS
 * rebinding. The gateway does it only when `allowedOrigins` is set, and a
 * request whose `Origin` is present but not on the list gets 403 before
 * identity resolution, authorization, auditing or dispatch, on both
 * protocol eras.
 *
 * Unset by default so the local walkthrough keeps working: curl and the
 * Inspector send no `Origin` at all, and the React UI talks to Convex
 * directly rather than through `/mcp/`, so nothing here would exercise it
 * locally. Set it for any deployment a browser MCP client connects to.
 *
 * Note this is NOT `cors`. CORS decides what a browser is allowed to
 * read; `allowedOrigins` decides what this endpoint is willing to serve.
 * Deriving one from the other means the permissive `cors: true` below
 * would silently switch the gate off.
 */
/**
 * HMAC key that seals MRTR continuation state, at least 32 characters.
 * Backs `notes_purge`'s confirmation round.
 *
 * Deliberately has no default. Without it the `mrtr` option is not
 * passed, and the gateway then FAILS the confirmation-gated tool closed
 * rather than dispatching it unconfirmed: a destructive call must not
 * become unguarded just because a deployment forgot to configure the
 * gate. Set it with `pnpm local:mrtrsecret` for the local walkthrough.
 *
 * It must also be stable. Rotating it invalidates every continuation in
 * flight, so a user mid-confirmation is asked again rather than having
 * their answer silently accepted under a new key.
 */
const MRTR_SECRET = process.env.MCP_MRTR_SECRET ?? "";

const ALLOWED_ORIGINS: string[] = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin: string) => origin.trim())
  .filter(Boolean);

/**
 * Validate Bearer tokens by hitting the IdP's userinfo endpoint. The
 * IdP issues opaque access tokens which Convex's local JWT validation
 * can't verify; userinfo asks the IdP "is this token still valid, and
 * who does it belong to?".
 */
const resolveIdentity: McpIdentityResolver = async (token) => {
  // Compared before the IdP call so the dev token works with no issuer
  // configured. The `&&` matters: an unset env var must never match an
  // empty or absent token.
  if (DEV_BEARER_TOKEN) {
    if (token === DEV_BEARER_TOKEN) {
      return {
        subject: "dev-user",
        claims: { sub: "dev-user", groups: ["admin"] },
      };
    }
    // A second identity with no groups, so the denial paths are
    // reachable locally too: the write tools answer -32003 Forbidden and
    // `note://{id}` refuses the read, while `notes_list` and
    // `notes://all` still work.
    if (token === `${DEV_BEARER_TOKEN}-readonly`) {
      return { subject: "dev-reader", claims: { sub: "dev-reader" } };
    }
  }
  if (!OIDC_ISSUER) return null;
  const r = await fetch(`${OIDC_ISSUER}${OIDC_USERINFO_PATH}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = (await r.json()) as { sub: string; [k: string]: unknown };
  return { subject: u.sub, claims: u };
};

const authorize: McpAuthorizerHandler = async (_ctx, args) => {
  const meta = (args.toolMetadata ?? {}) as {
    public?: boolean;
    roles?: string[];
  };
  if (meta.public) return { allowed: true };
  if (!args.identity) return { allowed: false, reason: "Unauthorized" };
  if (meta.roles && meta.roles.length > 0) {
    const claims = (args.identity.claims ?? {}) as { groups?: unknown };
    const userGroups = Array.isArray(claims.groups)
      ? (claims.groups as string[])
      : [];
    const missing = meta.roles.filter((r) => !userGroups.includes(r));
    if (missing.length > 0) {
      return {
        allowed: false,
        reason: `Forbidden: needs groups ${missing.join(", ")}`,
      };
    }
  }
  return { allowed: true };
};

/**
 * The resource counterpart of `authorize`. The gateway rejects
 * anonymous callers before this runs, so `args.identity` is non-null.
 *
 * Policy, mirroring the tool side:
 * - listing resources and templates: any authenticated caller
 * - reading `notes://all`: any authenticated caller
 * - reading a single `note://{id}`: `admin` group, same bar as the
 *   write tools
 *
 * List-visibility and read-access are separate decisions: a template
 * read is authorized here on the expanded concrete URI under
 * `resource_read`, not under `resource_templates_list`.
 */
const authorizeResource: McpResourceAuthorizerHandler = async (_ctx, args) => {
  // This mount does not set `anonymousResources`, so the gateway never
  // calls it with an anonymous caller. The branch is written out anyway,
  // and written FIRST, because everything below it ends in
  // `{ allowed: true }`: were the option ever switched on here, an
  // anonymous caller would inherit the policy written for authenticated
  // ones. `/mcp-public/` below is where anonymous reads are decided.
  if (args.mode === "resource_anonymous") {
    return { allowed: false, reason: "Unauthorized" };
  }
  if (args.mode !== "resource_read") return { allowed: true };
  if (args.resourceUri === "notes://all") return { allowed: true };
  // A count carries no note contents, so it is readable by anyone who
  // got this far. The `/mcp-public/` mount goes one step further and
  // serves it without a token at all.
  if (args.resourceUri === "notes://stats") return { allowed: true };

  const claims = (args.identity.claims ?? {}) as { groups?: unknown };
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  if (groups.includes("admin")) return { allowed: true };
  return { allowed: false, reason: "Forbidden: needs group admin" };
};

/**
 * Above this many notes, `notes_reindex` is worth deferring.
 *
 * A demo threshold, not a law: the point is that the number lives in the
 * HOST. The gateway knows a tool is task-capable, it cannot know whether
 * THIS call is going to be slow.
 */
const REINDEX_TASK_THRESHOLD = 25;

/**
 * Whether one eligible call becomes a task, new in gateway 2.0.0.
 *
 * SEP-2663 took the choice away from the client: it declares the tasks
 * extension once and then handles whatever comes back, so a
 * `taskSupport: "optional"` tool needs someone on this side to decide.
 * Omitting this callback makes every eligible call a task, which is what
 * the spec's own conformance scenario expects; returning `false` answers
 * inline, which the spec allows explicitly for a fast operation.
 *
 * Only consulted when a task is possible at all: the tool says
 * `"optional"`, the client declared the extension, and the caller is
 * authenticated. `notes_bulkTag` is `"required"` and never reaches here.
 *
 * A throw would be logged and treated as "yes", because a task is
 * durable and pollable while an inline dispatch of work the host wanted
 * deferred can outlive its request and lose the result.
 */
const shouldCreate: NonNullable<McpTasksOptions["shouldCreate"]> = async (
  ctx,
  call,
) => {
  if (call.toolName !== "notes_reindex") return true;
  const { total } = (await ctx.runQuery(api.notes.count, {})) as {
    total: number;
  };
  return total >= REINDEX_TASK_THRESHOLD;
};

/**
 * The spec's full `Implementation`. Shared by both mounts below so they
 * cannot drift apart; replacing this block replaces it whole, which is
 * why `name` and `version` are restated even though the display fields
 * are the point.
 *
 * `version` tracks the gateway release this demo is written against, not
 * the demo's own package version, because that is the thing a reader
 * needs to match against the docs.
 *
 * `icons` deliberately carries no `sizes`. The array form is what the
 * spec mandates, but SDK builds 1.18.0 through 1.18.2 typed it as a bare
 * string and fail their parse of the entire `InitializeResult` over it,
 * which costs the connection rather than one icon. This block also
 * repeats on every stateless result, so an `https:` src beats inlining a
 * `data:` URI here.
 */
const SERVER_INFO: McpServerInfo = {
  name: "convex-mcp-gateway-playground",
  version: "2.0.0",
  title: "Notes Playground",
  description: "A small notes store exposed over MCP.",
  websiteUrl: "https://github.com/tfohlmeister/convex-mcp-gateway",
  icons: [
    { src: "https://example.com/icons/notes.png", mimeType: "image/png" },
  ],
};

const http = httpRouter();

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    ...(ALLOWED_ORIGINS.length > 0
      ? { allowedOrigins: ALLOWED_ORIGINS }
      : {}),
    resolveIdentity,
    // Declarative catalog: the registry is reconciled from this list on
    // each initialize, so no registerDefaults mutation is needed.
    tools,
    // Read-only content alongside the tools: one concrete resource and
    // one RFC 6570 template.
    resources,
    resourceTemplates,
    authorizeResource,
    // Records URI, operation, identity and outcome for reads. Never the
    // resource contents.
    auditResources: { read: true },
    // Enables the `input_required` round trip that `notes_purge` uses to
    // confirm before deleting. Omitted when unconfigured, which makes
    // that tool fail closed instead of running unconfirmed.
    ...(MRTR_SECRET ? { mrtr: { secret: MRTR_SECRET } } : {}),
    // Gates `notes://export` behind a confirmation round. Passed
    // unconditionally: without `mrtr` above, a hook that asks for input
    // fails the read closed rather than serving it with the gate
    // skipped, which is the behaviour worth demonstrating.
    beforeResourceRead,
    // Opt-in MCP Tasks, advertised in `server/discover` only because
    // this option is present. No `execute`, so the component's built-in
    // scheduled executor runs the tool once after the request returns;
    // hosts needing retries or input rounds pass their own. `shouldCreate`
    // is what decides whether an `"optional"` tool defers at all.
    tasks: { shouldCreate },
    // Server-level guidance surfaced in the initialize result, so the
    // model learns the auth model without reading every description.
    initializeInstructions: instructions,
    serverInfo: SERVER_INFO,
  } satisfies HandleMcpRequestOptions),
);
// Mount both /mcp/ and /mcp, because claude.ai strips the trailing slash
// before POSTing, even when the user typed it explicitly.
for (const path of ["/mcp/", "/mcp"]) {
  http.route({ path, method: "POST", handler: mcpHandler });
  http.route({ path, method: "GET", handler: mcpHandler });
  http.route({ path, method: "DELETE", handler: mcpHandler });
  http.route({ path, method: "OPTIONS", handler: mcpHandler });
}

const discoveryHandler = httpAction(async (ctx, request) =>
  gateway.serveProtectedResourceMetadata(ctx, request),
);
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "GET",
  handler: discoveryHandler,
});
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "OPTIONS",
  handler: discoveryHandler,
});

// AS metadata wraps the upstream IdP and advertises THIS deployment as
// the authorization server, substituting our own `/oauth/register` so
// claude.ai's DCR lands here instead of upstream. `issuer` override
// matches the upstream's actual token claims, because strict id_token.iss
// validators reject the flow otherwise (see docs/oauth-bridge.md
// "Pitfalls"). Only mounted when OIDC_ISSUER is configured.
if (OIDC_ISSUER) {
  const asMetadataHandler = httpAction(async (ctx, request) =>
    gateway.serveAuthorizationServerMetadata(ctx, request, {
      upstreamIssuer: OIDC_ISSUER,
      overrides: { issuer: OIDC_ISSUER },
    }),
  );
  http.route({
    path: "/.well-known/oauth-authorization-server",
    method: "GET",
    handler: asMetadataHandler,
  });
  http.route({
    path: "/.well-known/oauth-authorization-server",
    method: "OPTIONS",
    handler: asMetadataHandler,
  });

  const dcrHandler = httpAction(async (ctx, request) =>
    gateway.handleClientRegistration(ctx, request, {
      upstreamClientId: OIDC_CLIENT_ID,
      allowedRedirectPatterns: [
        /^https:\/\/claude\.(ai|com)\//,
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
      ],
    }),
  );
  http.route({ path: "/oauth/register", method: "POST", handler: dcrHandler });
  http.route({
    path: "/oauth/register",
    method: "OPTIONS",
    handler: dcrHandler,
  });
}

// =================================================================
// A second mount: resources without a token (gateway 1.0.0).
// =================================================================

/**
 * The resource policy for `/mcp-public/`, the one mount that sets
 * `anonymousResources`.
 *
 * `resource_anonymous` is the fourth authorizer mode, and the reason
 * `McpResourceAuthorizerArgs` is a discriminated union: it is the only
 * mode whose `identity` is `null`, so a policy cannot read a subject
 * without first saying which mode it is in.
 *
 * It is written FIRST and it denies by default, for the same reason the
 * main mount's does: the authenticated branch it falls through to ends in
 * `{ allowed: true }`.
 */
const authorizePublicResource: McpResourceAuthorizerHandler = async (
  ctx,
  args,
) => {
  if (args.mode === "resource_anonymous") {
    // `metadata: { public: true }` on the registration, the same
    // convention `authorize` uses for tools. Matching on metadata rather
    // than on a URI list is what keeps the policy and the catalog from
    // drifting apart: a new resource is private until its registration
    // says otherwise.
    //
    // A template expansion carries no metadata, so it lands in the deny
    // branch. The gateway asks per candidate, so denying here is also
    // what filters an anonymous `resources/list`.
    const meta = (args.resourceMetadata ?? {}) as { public?: boolean };
    return meta.public === true
      ? { allowed: true }
      : { allowed: false, reason: "Unauthorized" };
  }
  // `anonymousResources` cannot be combined with `beforeResourceRead`
  // (the hook's contract passes a principal, and an MRTR continuation
  // must bind to one), so the confirmation round that gates
  // `notes://export` does not exist on this mount. The resource is still
  // in the shared catalog, so it has to be refused HERE. Dropping the
  // gate and serving it anyway is exactly the mistake a second mount
  // invites.
  if (args.resourceUri === "notes://export") {
    return {
      allowed: false,
      reason: "Read notes://export on /mcp/, which asks for confirmation.",
    };
  }
  // Authenticated callers get the same policy as the main mount.
  return await authorizeResource(ctx, args);
};

/**
 * Same catalog, different policy. The `tools`, `resources` and
 * `resourceTemplates` arrays MUST be the ones the main mount passes: the
 * component keeps a single registry with a single catalog fingerprint, so
 * two mounts advertising different lists would each re-sync (and delete
 * the other's entries) on every modern request.
 *
 * What differs is the mount options. Tools are unaffected by
 * `anonymousResources`: `authorize` still denies everything except
 * `notes_count` without a token, so this is a mount that serves one
 * resource and one tool anonymously, not an open door.
 *
 * A mount that serves anonymous callers wants audit retention. A failing
 * anonymous outcome is never recorded, but a succeeding one is, one row
 * per request, so wire `gateway.pruneAuditEntries` into a cron on a
 * deployment that leaves this reachable.
 */
const publicMcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    ...(ALLOWED_ORIGINS.length > 0 ? { allowedOrigins: ALLOWED_ORIGINS } : {}),
    resolveIdentity,
    tools,
    resources,
    resourceTemplates,
    authorizeResource: authorizePublicResource,
    // The opt-in itself. Without it the gateway rejects an anonymous
    // `resources/read` before the authorizer runs, which is the default
    // every other mount here keeps.
    anonymousResources: true,
    auditResources: { read: true },
    ...(MRTR_SECRET ? { mrtr: { secret: MRTR_SECRET } } : {}),
    tasks: { shouldCreate },
    initializeInstructions: instructions,
    serverInfo: SERVER_INFO,
  } satisfies HandleMcpRequestOptions),
);
// Both spellings, for the same reason the main mount uses both: clients
// normalise the trailing slash away before they POST, and Convex routes
// on the exact path.
for (const path of ["/mcp-public/", "/mcp-public"]) {
  for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
    http.route({ path, method, handler: publicMcpHandler });
  }
}

export default http;
