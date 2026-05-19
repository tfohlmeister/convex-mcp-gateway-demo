import {
  HandleMcpRequestOptions,
  McpGateway,
  type McpAuthorizerHandler,
  type McpIdentityResolver,
} from "convex-mcp-gateway";
import { httpRouter } from "convex/server";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";

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
 * Validate Bearer tokens by hitting the IdP's userinfo endpoint. The
 * IdP issues opaque access tokens which Convex's local JWT validation
 * can't verify; userinfo asks the IdP "is this token still valid, and
 * who does it belong to?".
 */
const resolveIdentity: McpIdentityResolver = async (token) => {
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

const http = httpRouter();

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    resolveIdentity,
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
