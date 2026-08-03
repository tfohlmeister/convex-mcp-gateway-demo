# convex-mcp-gateway demo

Runnable notes app demonstrating
[`convex-mcp-gateway`](https://github.com/tfohlmeister/convex-mcp-gateway):
a Convex-backed notes table is exposed as MCP tools, gated by an
`authorize` callback, with the audit log visible in the React UI.

## What's wired up

### Tools

Six MCP tools declared in [`convex/mcp.ts`](./convex/mcp.ts) and handed
to `handleMcpRequest({ tools })`. The gateway reconciles the registry on
every `initialize`, so editing the array takes effect on the next client
connect. **There is no registration step to run by hand.**

| Tool           | Kind     | Visibility    | What it shows                                  |
| -------------- | -------- | ------------- | ---------------------------------------------- |
| `notes_count`  | query    | public        | `metadata.public` bypass, typed `returns`, and client-facing `title` / `annotations` / `_meta` |
| `notes_list`   | query    | auth required | identity gate                                  |
| `notes_whoami` | query    | auth required | `identityArg`: the gateway injects the caller server-side |
| `notes_create` | mutation | role `admin`  | role check, `auditArgs: false`, and `identityArg` stamping the note's author |
| `notes_update` | mutation | role `admin`  | nested-path arg redaction (`redact: ["body"]`) |
| `notes_delete` | mutation | role `admin`  | mutation through the authorizer                |

### Resources

Read-only content alongside the tools, also declared in
`convex/mcp.ts`. Both require an authenticated caller.

| URI           | Kind     | Access             |
| ------------- | -------- | ------------------ |
| `notes://all` | concrete | any authenticated caller |
| `note://{id}` | RFC 6570 template | role `admin` |

Resource reads are audited (`auditResources: { read: true }`): URI,
operation, identity and outcome are recorded, never the contents.

### Authorization

Two callbacks in [`convex/http.ts`](./convex/http.ts):

- `authorize` gates tools. Reads `metadata.public`, then requires an
  identity, then checks the `groups` claim against `metadata.roles`.
- `authorizeResource` gates resources, with the same role bar for
  reading a single note.

Identity comes from the userinfo endpoint of any OIDC issuer you
configure, or from the local dev token described below.

`initializeInstructions` hands the model a short description of this
policy on connect, so it does not have to infer it per tool.

### UI

The React app (`src/`) writes directly to Convex (no audit row) and
shows the audit log live, so every MCP tool call and resource read
appears on the right as it happens. Each note shows its author: a
subject for notes created over MCP, or "UI (no MCP identity)" for ones
typed into the browser.

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
pnpm local:devtoken       # optional, see "Trying the auth-gated parts"
pnpm dev                  # http://localhost:5173 — UI runs against local
```

`pnpm local:start` keeps running; open a second terminal for the
other commands. Stop with `Ctrl-C`.

No registration command: the tool and resource catalogs are declarative
and reconcile themselves on the first MCP `initialize`.

Drive the MCP endpoint directly with the official Inspector:

```sh
npx -y @modelcontextprotocol/inspector --cli \
  http://127.0.0.1:3311/mcp/ --transport http --method tools/list
```

This lists the public tools only (no Bearer = anonymous). The
auth-gated ones return `-32001 Unauthorized` with a
`WWW-Authenticate` header — RFC 6750 compliant.

#### Trying the auth-gated parts

No IdP runs next to the local backend, so without help every token
resolves to nobody and only `notes_count` is reachable. `pnpm
local:devtoken` sets `MCP_DEV_BEARER_TOKEN=local-dev-token` on the
deployment, which switches on two hard-coded identities:

| Bearer token               | Subject      | Groups  | Can do                                        |
| -------------------------- | ------------ | ------- | --------------------------------------------- |
| `local-dev-token`          | `dev-user`   | `admin` | everything, including `note://{id}`           |
| `local-dev-token-readonly` | `dev-reader` | none    | read-only tools and `notes://all`; writes and `note://{id}` are refused |

```sh
npx -y @modelcontextprotocol/inspector --cli \
  http://127.0.0.1:3311/mcp/ --transport http --method tools/list \
  --header "Authorization: Bearer local-dev-token"
```

> **Local only.** `MCP_DEV_BEARER_TOKEN` hands the `admin` group to
> anyone who knows the string. Never set it on a deployment reachable
> from the internet. It is off unless you set it.

### C. Convex Cloud (optional)

If you want to exercise the OAuth bridge end-to-end with claude.ai or
another browser MCP client, deploy to a real Convex project:

```sh
cp .env.example .env.local
# fill in OIDC_ISSUER + OIDC_CLIENT_ID, optionally MCP_AUTH_SERVER_URL
npx convex dev            # auto-populates CONVEX_* in .env.local
pnpm convex:run mcp:configureOAuth   # only when using the OAuth bridge
pnpm dev
```

`configureOAuth` is the one thing the declarative catalog does not
cover: OAuth config is deployment state, not part of the tool list. Run
it once after deploying with `MCP_AUTH_SERVER_URL` set.

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
