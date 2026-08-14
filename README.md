# convex-mcp-gateway demo

Runnable notes app demonstrating
[`convex-mcp-gateway`](https://github.com/tfohlmeister/convex-mcp-gateway):
a Convex-backed notes table is exposed as MCP tools, gated by an
`authorize` callback, with the audit log visible in the React UI.

## What's wired up

### Tools

Ten MCP tools declared in [`convex/mcp.ts`](./convex/mcp.ts) and handed
to `handleMcpRequest({ tools })`. The gateway reconciles the registry on
every `initialize` and before every stateless 2026-07-28 request, so
editing the array takes effect on the next client connect. **There is no
registration step to run by hand.**

| Tool           | Kind     | Visibility    | What it shows                                  |
| -------------- | -------- | ------------- | ---------------------------------------------- |
| `notes_count`  | query    | public        | `metadata.public` bypass, typed `returns`, and client-facing `title` / `annotations` / `_meta` |
| `notes_list`   | query    | auth required | identity gate                                  |
| `notes_whoami` | query    | auth required | `identityArg`: the gateway injects the caller server-side |
| `notes_create` | mutation | role `admin`  | role check, `auditArgs: false`, and `identityArg` stamping the note's author |
| `notes_update` | mutation | role `admin`  | nested-path arg redaction (`redact: ["body"]`) |
| `notes_delete` | mutation | role `admin`  | mutation through the authorizer                |
| `notes_by_author` | query | auth required | `x-mcp-header`: two arguments mirrored into `Mcp-Param-*` routing headers (see below) |
| `notes_purge`  | mutation | role `admin`  | **MRTR + elicitation**: confirms before deleting, and replay-safe (see below) |
| `notes_reindex` | mutation | role `admin` | **MCP Tasks**: a modern client may poll instead of waiting |
| `notes_search` | query    | auth required | **bounded `$ref`**: a `$defs` schema the gateway resolves for the client |

`notes_by_author` takes the subject as an ordinary argument, so any
authenticated caller can ask about any author. That exposes nothing extra
here, because `notes_list` already hands the same callers the whole
table, but do not copy the shape into a deployment where it would: drop
the argument and declare `identityArg`, so the gateway fills the subject
server-side. The two features do not combine, and the reason is in the
comment above the registration in `convex/mcp.ts`.

### Confirmation before a destructive call (MRTR)

`notes_purge` deletes every note, so it asks first. The `beforeCall` hook
in `convex/mcp.ts` runs **before** dispatch: the first call answers
`resultType: "input_required"` with an MCP elicitation and an
HMAC-sealed `requestState`, and `notes.purge` does not execute until the
client sends that state back with an answer.

Three properties are worth reading the code for:

- **A decline never dispatches.** The hook returns `completeCall(...)`
  and the mutation is not called at all, so the refusal is structural
  rather than a check inside the mutation that someone could forget.
- **The seal is not a formality.** It binds the continuation to the tool
  and the arguments it was minted for, so a state cannot be re-pointed at
  another tool or another purge.
- **One confirmation authorises one purge.** The gateway injects the
  continuation's idempotency key into `confirmationKey`, which the
  mutation persists in the `purges` table around the delete. A client
  that lost the response and retries gets the original answer back
  instead of emptying a store the user has refilled since.

Requires `MCP_MRTR_SECRET`. Without it the tool **fails closed**: it
refuses with `-32603` rather than running unconfirmed, which is the
behaviour `convex/mrtr-unconfigured.test.ts` pins down.

### Long-running calls (MCP Tasks)

The mount passes `tasks: {}`, so a `2026-07-28` client that declares the
`io.modelcontextprotocol/tasks` capability may send `tools/call` with a
`task` request for `notes_reindex` and poll `tasks/get` for the result.
Without `execute`, the component's built-in scheduled executor runs the
tool once after the HTTP request returns: durable across restarts, and
deliberately no retries, because a mutation that already committed must
not run twice.

The same tool called without a `task` request just returns its answer,
which is what keeps one catalog serving both protocol eras.

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
pnpm local:mrtrsecret     # optional, needed for notes_purge's confirmation
pnpm dev                  # http://localhost:5173, UI runs against local
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
`WWW-Authenticate` header, RFC 6750 compliant.

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

#### Trying the confirmation round

`pnpm local:mrtrsecret` sets `MCP_MRTR_SECRET`, without which
`notes_purge` refuses with `-32603` instead of running unconfirmed. With
it set, a first call answers `input_required` and a sealed
`requestState`; sending that state back with

```json
{ "confirm": { "action": "accept", "content": { "confirm": true } } }
```

runs the purge, and `{ "action": "decline" }` finishes the call without
the mutation ever executing. The Inspector's `--method tools/call` does
not model the round trip, so this is easiest to watch from a client that
supports elicitation, or from the tests in `convex/mcp.test.ts`, which
drive both paths end to end and assert the store afterwards.

#### Stateless MCP 2026-07-28

Everything above speaks the session-based protocol: `initialize` first,
then an `Mcp-Session-Id` on every follow-up. The same endpoint also
answers the 2026-07-28 revision, which has none of that. Each request
carries its own protocol version and client capabilities in
`params._meta`, mirrors its method into `Mcp-Method`, and stands alone.

Start with `server/discover` instead of `initialize`:

```sh
curl -sS -X POST http://127.0.0.1:3311/mcp/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

You get `supportedVersions`, the server capabilities, the same
`instructions` the legacy `initialize` returns, and the cache hints
`ttlMs: 0` / `cacheScope: "private"` (the catalog is identity-filtered,
so it must never be shared between callers). No `Mcp-Session-Id` comes
back, and none is expected on the next call.

`accept` must list **both** `application/json` and `text/event-stream`;
the spec requires it and the gateway answers `406` otherwise.

#### Routing headers (`x-mcp-header`)

`notes_by_author` is the one hand-written registration in
`convex/mcp.ts`. Its `inputSchema` marks both arguments with
`x-mcp-header`, so a conforming client mirrors them into HTTP headers
and an intermediary can route or rate-limit on them without parsing the
JSON-RPC body. On a 2026-07-28 request the gateway re-validates that
every mirrored header matches the body **before** authorization or
dispatch, so a proxy acting on the header and Convex executing on the
body cannot disagree.

That guarantee stops at the protocol boundary. This endpoint also serves
session-based 2025-era clients, which never send routing headers, so
nothing is validated for them: a legacy `tools/call` reaches
`notes_by_author` with no `Mcp-Param-*` at all. An intermediary enforcing
policy on these headers must also require `MCP-Protocol-Version` to name
a revision that mandates header validation, and reject anything else.
The transport spec calls this out; it is easy to miss.

```sh
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"notes_by_author","arguments":{"author":"dev-user","limit":25},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                 "io.modelcontextprotocol/clientCapabilities":{}}}}'

curl -sS -X POST http://127.0.0.1:3311/mcp/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer local-dev-token' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/call' \
  -H 'mcp-name: notes_by_author' \
  -H 'mcp-param-author: dev-user' \
  -H 'mcp-param-limit: 25' \
  -d "$BODY"
```

The result is `[]` until `dev-user` has written something. Call
`notes_create` once first (same shape, `mcp-name: notes_create`, no
`Mcp-Param-*` headers) and the note shows up here, because the gateway
stamps the author from the injected identity.

Change one header and rerun to see the binding enforced:

| Change                              | Result                             |
| ----------------------------------- | ---------------------------------- |
| `mcp-param-author: someone-else`    | `-32020`, HTTP 400                 |
| `mcp-param-limit: 26`               | `-32020`, HTTP 400                 |
| drop `mcp-param-author` entirely    | `-32020`, HTTP 400                 |
| `mcp-param-limit: 25.0`             | accepted, integers compare numerically |
| `mcp-param-author: =?base64?ZGV2LXVzZXI=?=` | accepted, the base64 sentinel is decoded first |

`defineMcpQuery` cannot express `x-mcp-header`: it derives `inputSchema`
from the Convex validators, which never emit the annotation. Writing the
registration out by hand is the supported route, and it still goes into
the same declarative `tools` array. Reaching for `gateway.register(...)`
instead would not work here, because the imperative path clears the
declarative fingerprint and the next request's sync drops the tool again.

#### Origin validation

`MCP_ALLOWED_ORIGINS` (comma-separated) turns on the gateway's `Origin`
check. A request whose `Origin` is present but not on the list gets
`403` before identity resolution, authorization, auditing or dispatch,
on both protocol eras:

```sh
npx convex env set MCP_ALLOWED_ORIGINS https://claude.ai,https://claude.com
```

Both hosts, because claude.ai serves the connector from either and the
DCR allowlist in `convex/http.ts` already accepts both. Listing only one
means every preflight from the other fails, and the gate runs before the
preflight branch, so the browser sees a bare `403` with no CORS headers
and no useful error.

It is unset by default, so the curl and Inspector flows above keep
working: they send no `Origin` at all. The React UI does not exercise it
either, because it talks to Convex directly rather than through `/mcp/`.
Set it for any deployment a browser MCP client connects to.

This is not `cors`. CORS decides what a browser may *read*;
`allowedOrigins` decides what the endpoint is willing to *serve*. They
are separate options on purpose: deriving one from the other means the
permissive `cors: true` silently switches the gate off.

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

See [`.env.example`](./.env.example) for the full list. All optional:
the demo runs without any of them, just with the auth-gated tools
returning 401.

| Var                   | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `OIDC_ISSUER`         | Upstream IdP base URL (any OIDC: Auth0, Authentik, Pocket-ID) |
| `OIDC_CLIENT_ID`      | Pre-registered client id at the IdP                            |
| `OIDC_USERINFO_PATH`  | Override if IdP uses `/userinfo` (default: `/api/oidc/userinfo`) |
| `MCP_AUTH_SERVER_URL` | Origin to advertise via OAuth discovery (Convex `.convex.site` URL) |
| `MCP_RESOURCE_URL`    | Resource URL for the discovery doc (defaults to `MCP_AUTH_SERVER_URL`) |
| `MCP_ALLOWED_ORIGINS` | Comma-separated `Origin` allowlist. Unset means no origin validation |
| `MCP_DEV_BEARER_TOKEN` | **Local only.** Enables two hard-coded demo identities |
| `MCP_MRTR_SECRET`     | >=32 chars, seals MRTR continuations. Unset makes `notes_purge` fail closed |

## License

[Apache-2.0](./LICENSE)
