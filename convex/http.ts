import {
  HandleMcpRequestOptions,
  McpGateway,
  type McpAuthorizerHandler,
  type McpIdentityResolver,
  type McpResourceAuthorizerHandler,
} from "convex-mcp-gateway";
import { httpRouter } from "convex/server";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { instructions, resources, resourceTemplates, tools } from "./mcp.js";

const gateway = new McpGateway(components.mcpGateway);

// Upstream OIDC issuer + pre-registered client id, both env-driven so
// this demo runs against any IdP. Examples:
//   OIDC_ISSUER=https://your-tenant.eu.auth0.com
//   OIDC_CLIENT_ID=abc123...
// When unset (the default for `pnpm local:start`), the OAuth bridge
// routes still mount but return empty metadata — public tools work,
// auth-gated tools return 401.
const OIDC_ISSUER = process.env.OIDC_ISSUER ?? "";
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "";
// Userinfo endpoint path. Defaults to the OIDC standard
// `/api/oidc/userinfo` (Pocket-ID), but Auth0/Authentik/Keycloak
// expose it elsewhere — override with OIDC_USERINFO_PATH.
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
  if (args.mode !== "resource_read") return { allowed: true };
  if (args.resourceUri === "notes://all") return { allowed: true };

  const claims = (args.identity.claims ?? {}) as { groups?: unknown };
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  if (groups.includes("admin")) return { allowed: true };
  return { allowed: false, reason: "Forbidden: needs group admin" };
};

const http = httpRouter();

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
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
    // Server-level guidance surfaced in the initialize result, so the
    // model learns the auth model without reading every description.
    initializeInstructions: instructions,
  } satisfies HandleMcpRequestOptions),
);
// Mount both /mcp/ and /mcp — claude.ai strips the trailing slash
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
// matches the upstream's actual token claims — strict id_token.iss
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

export default http;
