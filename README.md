# convex-mcp-gateway demo

Runnable notes app demonstrating
[`convex-mcp-gateway`](https://github.com/tfohlmeister/convex-mcp-gateway):
a Convex-backed notes table is exposed as MCP tools, gated by an
`authorize` callback, with the audit log visible in the React UI.

## What's wired up

Five MCP tools registered via `gateway.register()` in
[`convex/mcp.ts`](./convex/mcp.ts):

| Tool          | Kind     | Visibility         | What it shows                                  |
| ------------- | -------- | ------------------ | ---------------------------------------------- |
| `notes_count` | query    | public             | `metadata.public` bypass + typed `returns`     |
| `notes_list`  | query    | auth required      | identity gate                                  |
| `notes_create`| mutation | role `admin`       | scope/role check + `auditArgs: false`          |
| `notes_update`| mutation | role `admin`       | nested-path arg redaction (`redact: ["body"]`) |
| `notes_delete`| mutation | role `admin`       | mutation through the authorizer                |

The `authorize` callback in [`convex/http.ts`](./convex/http.ts) reads
`metadata.public`, falls back to `ctx.auth.getUserIdentity()`, then
checks `groups` claims against `metadata.roles`. Identity is resolved
by the userinfo endpoint of any OIDC issuer you configure.

The React UI (`src/`) writes directly to Convex (no audit row) and
shows the audit log live, so every MCP tool invocation appears on the
right as it happens.

## Run modes

### A. Code review only

```sh
git clone https://github.com/tfohlmeister/convex-mcp-gateway-demo
cd convex-mcp-gateway-demo
pnpm install
```

Walk `convex/` and `src/`. Nothing more to set up.

### B. Local backend (recommended, no Convex account)

```sh
pnpm install
pnpm local:start          # downloads pinned convex-local-backend binary
                          # writes .env.local, runs on :3310 / :3311
pnpm convex:dev           # codegen + push functions to local backend
pnpm convex:run mcp:registerDefaults
pnpm dev                  # http://localhost:5173 — UI runs against local
```

`pnpm local:start` keeps running; open a second terminal for the
other commands. Stop with `Ctrl-C`.

Drive the MCP endpoint directly with the official Inspector:

```sh
npx -y @modelcontextprotocol/inspector --cli \
  http://127.0.0.1:3311/mcp/ --transport http --method tools/list
```

This lists the public tools only (no Bearer = anonymous). The
auth-gated ones return `-32001 Unauthorized` with a
`WWW-Authenticate` header — RFC 6750 compliant.

### C. Convex Cloud (optional)

If you want to exercise the OAuth bridge end-to-end with claude.ai or
another browser MCP client, deploy to a real Convex project:

```sh
cp .env.example .env.local
# fill in OIDC_ISSUER + OIDC_CLIENT_ID, optionally MCP_AUTH_SERVER_URL
npx convex dev            # auto-populates CONVEX_* in .env.local
pnpm convex:run mcp:registerDefaults
pnpm dev
```

Free tier is comfortably enough for this demo.

## Env vars

See [`.env.example`](./.env.example) for the full list. All
optional — the demo runs without any of them, just with the
auth-gated tools returning 401.

| Var                   | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `OIDC_ISSUER`         | Upstream IdP base URL (any OIDC: Auth0, Authentik, Pocket-ID) |
| `OIDC_CLIENT_ID`      | Pre-registered client id at the IdP                            |
| `OIDC_USERINFO_PATH`  | Override if IdP uses `/userinfo` (default: `/api/oidc/userinfo`) |
| `MCP_AUTH_SERVER_URL` | Origin to advertise via OAuth discovery (Convex `.convex.site` URL) |
| `MCP_RESOURCE_URL`    | Resource URL for the discovery doc (defaults to `MCP_AUTH_SERVER_URL`) |

## License

[Apache-2.0](./LICENSE)
