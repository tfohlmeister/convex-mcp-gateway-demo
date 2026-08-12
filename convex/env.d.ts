// Minimal ambient declarations for the env vars the convex/ code
// references via `process.env`. Convex's runtime provides them; the
// component tsconfig doesn't pull in @types/node, so we declare just
// the keys we use. Add new vars to this list when you reference more.
declare const process: {
  env: {
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_USERINFO_PATH?: string;
    MCP_AUTH_SERVER_URL?: string;
    MCP_RESOURCE_URL?: string;
    MCP_DEV_BEARER_TOKEN?: string;
    MCP_ALLOWED_ORIGINS?: string;
  };
};
