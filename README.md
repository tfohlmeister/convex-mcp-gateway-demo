# convex-mcp-gateway demo

Runnable notes app demonstrating
[`convex-mcp-gateway`](https://github.com/tfohlmeister/convex-mcp-gateway):
a Convex-backed notes table is exposed as MCP tools, gated by an
`authorize` callback, with the audit log visible in the React UI.

## What's wired up

### Tools

Eleven MCP tools declared in [`convex/mcp.ts`](./convex/mcp.ts) and handed
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
| `notes_reindex` | mutation | role `admin` | **MCP Tasks, `"optional"`**: the mount's `shouldCreate` decides per call whether to defer |
| `notes_bulkTag` | mutation | role `admin` | **MCP Tasks, `"required"`**: never answers inline, refuses a client that cannot poll |
| `notes_search` | query    | auth required | **authored JSON Schema**: `$schema`, `$defs` and `$ref` reach the client as written |

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

A client that cannot answer the round is a different case, and the hook
handles it with an `onUnsupported` fallback: an ordinary result instead
of a protocol error. A fallback **completes the call before dispatch**,
so it is not a way around the gate; the mutation is just as un-run as
after a decline.

**Know what actually triggers it before you copy this.** The gateway
reads per-request client capabilities on `2026-07-28` only, and treats a
session-era call as one whose capabilities it cannot vouch for. So the
fallback replaces the `-32601` that a 2025-era client used to get,
*including* one that declared `elicitation` at `initialize`. That is why
this fallback returns `isError: true` and names both requirements:
`notes_purge` can never run on the session protocol, and reporting that
as a successful call would turn it into a permanent silent no-op.

### Long-running calls (MCP Tasks)

A `2026-07-28` client declares the tasks extension once, in its
capabilities, under `extensions`:

```json
{ "extensions": { "io.modelcontextprotocol/tasks": {} } }
```

and from then on handles whichever result arrives. SEP-2663 gives it no
per-call say, so the **server** decides, and the two tools here show the
two levels that decision comes in:

- **`notes_reindex` is `"optional"`.** The mount passes a
  `tasks.shouldCreate` (in `convex/http.ts`) that answers inline under 25
  notes and hands back a task handle from 25 on. The gateway knows the tool
  *can* defer; only the host knows whether *this* call is worth
  deferring. Omit the callback and every eligible call becomes a task.
- **`notes_bulkTag` is `"required"`.** It has no synchronous answer to
  give, so it never runs inline. A client that did not declare the
  extension is refused with `-32021` and a `data.requiredCapabilities`
  naming exactly what to add; a session-era client is refused with
  `-32602` naming the revision it would need; an anonymous caller is
  challenged, because a task is owner-bound. Dispatching any of them
  anyway would run the side effect the level exists to defer.

Without `execute`, the component's built-in scheduled executor runs the
tool once after the HTTP request returns: durable across restarts, and
deliberately no retries, because a mutation that already committed must
not run twice.

A task-creating `tools/call` answers a **flat** result, and `tasks/get`
polls it:

| Field | On `tools/call` | On `tasks/get` |
| ----- | --------------- | -------------- |
| `resultType` | `"task"` | `"complete"` |
| `taskId`, `status` | yes | yes |
| `createdAt`, `lastUpdatedAt` | ISO-8601 | ISO-8601 |
| `ttlMs` | lifetime **left**, not an expiry | recounted per poll |
| `result` / `error` | no | on a terminal status |

`tasks/cancel` acknowledges with an empty `{ "resultType": "complete" }`
and is idempotent; the status it settled to comes from the next
`tasks/get`, and a terminal status never changes afterwards.

A completed task's `result` is the same `CallToolResult` the tool would
have returned synchronously, `structuredContent` included. The split
worth knowing: a tool that *ran* and reported a problem is a **completed**
task carrying `isError: true`, while `failed` means no result was ever
produced, which includes a tool that crashed part-way and one an argument
validator rejected before it started.

### Resources

Read-only content alongside the tools, also declared in
`convex/mcp.ts`. On the main `/mcp/` mount every read needs an
authenticated caller; the `/mcp-public/` mount below is the exception.

| URI              | Kind     | Access             |
| ---------------- | -------- | ------------------ |
| `notes://all`    | concrete | any authenticated caller |
| `notes://export` | concrete | role `admin`, **after confirmation** |
| `notes://stats`  | concrete | any authenticated caller, and anonymously on `/mcp-public/` |
| `note://{id}`    | RFC 6570 template | role `admin` |

Resource reads are audited (`auditResources: { read: true }`): URI,
operation, identity and outcome are recorded, never the contents.

`notes://all` and `note://{id}` carry `icons`, advertised verbatim in
`resources/list` and `resources/templates/list`. The gateway never
fetches one; a client decides whether to display it.

### Confirmation before a read (MRTR on `resources/read`)

The read-side counterpart of `notes_purge`. `notes://export` serves every
note as one document, so the mount-level `beforeResourceRead` hook in
`convex/http.ts` holds the read back for a confirmation round first:

1. The first read answers `resultType: "input_required"` with a sealed
   `requestState` and an `elicitation/create` request. No content.
2. An accepted continuation falls through to the ordinary read path and
   the provider serves the export.
3. A decline refuses with `-32003`, and the provider never runs.

The hook is **mount-level**, not per-resource: one provider can serve
many URIs and the gateway cannot tell which owns a URI without calling
it, so the gate sits where the URI is known and nothing has run yet.
Every other URI returns `null` from the hook and reads in one round.

Without `MCP_MRTR_SECRET` the read fails closed rather than serving the
export ungated, the same direction of failure `notes_purge` has.

A client that cannot answer the round gets the read's `onUnsupported`
fallback: `completeRead` with the note **titles only**. That is the shape
the fallback exists for, a redacted answer rather than a refusal, and the
bodies stay behind the confirmation.

The same trigger caveat applies, so every session-era read lands there
too. What bounds the answer is who can reach it: this URI already
requires the `admin` group, and an admin can read any single note through
`note://{id}` anyway. A fallback must not hand out more than its caller
could already reach.

### Resources without a token (`/mcp-public/`)

A second mount in `convex/http.ts`, and the only one that sets
`anonymousResources: true`. It serves exactly one resource without a
Bearer token:

```sh
curl -sS -X POST http://127.0.0.1:3321/mcp-public/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: resources/read' \
  -H 'mcp-name: notes://stats' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{
        "uri":"notes://stats","_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Five things about it are worth copying, and one is worth not copying:

- **The identity a read handler receives is nullable.** `notes://stats`
  narrows it (`identity?.subject ?? null`) and stamps the result either
  way. A handler that reads `identity.subject` unconditionally compiles
  fine against a mount without the option and breaks against this one.
- **`resource_anonymous` is a fourth authorizer mode**, and the only one
  whose `identity` is `null`. Both authorizers here handle it **first**
  and deny by default, because the branches under it end in
  `{ allowed: true }`.
- **The opt-in is `metadata: { public: true }` on the registration**, the
  same convention `authorize` uses for public tools, rather than a URI
  list in the policy. A new resource is then private until its own
  registration says otherwise, instead of until someone remembers to
  update a second file.
- **The gateway asks per candidate**, so that denial is also what filters
  an anonymous `resources/list` down to this one entry. An anonymous
  caller the policy grants *nothing* is challenged with `-32001` instead
  of handed an empty result, so a client whose token merely expired
  learns to re-authenticate. That is why `resources/templates/list` is
  refused here while `resources/list` answers.
- **Tools are unaffected.** `authorize` still applies, so this mount
  serves one anonymous resource and one public tool, not an open door.
- **What not to copy:** the two mounts must pass the *same* `tools`,
  `resources` and `resourceTemplates` arrays. The component keeps a
  single registry with a single catalog fingerprint, so two mounts
  advertising different lists would each re-sync (and delete the other's
  entries) on every modern request. Mounts differ by their options, never
  by their catalog.

`anonymousResources` cannot be combined with `beforeResourceRead`, so
this mount has no confirmation round, and `notes://export` is therefore
refused here outright rather than served without its gate. That refusal
is written into `authorizePublicResource`; forgetting it is exactly how a
second mount quietly drops a guarantee the first one makes.

### Authorization

Three callbacks in [`convex/http.ts`](./convex/http.ts):

- `authorize` gates tools on both mounts. Reads `metadata.public`, then
  requires an identity, then checks the `groups` claim against
  `metadata.roles`.
- `authorizeResource` gates resources on `/mcp/`, with the same role bar
  for reading a single note.
- `authorizePublicResource` gates them on `/mcp-public/`: resources
  marked `metadata: { public: true }` anonymously, everything else
  delegated to the callback above.

Identity comes from the userinfo endpoint of any OIDC issuer you
configure, or from the local dev token described below.

`initializeInstructions` hands the model a short description of this
policy on connect, so it does not have to infer it per tool.

### Retention

Four component tables grow with traffic rather than with data: sessions,
MRTR bookkeeping, tasks and the audit log. The gateway never prunes them
itself, so `convex/maintenance.ts` drains all four and `convex/crons.ts`
runs it daily.

The audit table is the one to think about before deploying this
anywhere. A tool registered `taskSupport: "required"` is refused for an
unauthenticated caller **before** `authorize` runs, and that refusal is
recorded together with the arguments the caller sent. So anyone who can
reach `/mcp/` can write one audit row per request, sized by their own
request body, without ever holding a token. Retention bounds it; a
deployment with no reason to serve anonymous callers should set
`requireAuth` on the mount instead, and that is the stronger answer.

```sh
pnpm convex:run maintenance:runPrune
```

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
                          # writes .env.local, runs on :3320 / :3321
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
  http://127.0.0.1:3321/mcp/ --transport http --method tools/list
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
  http://127.0.0.1:3321/mcp/ --transport http --method tools/list \
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

#### Driving a task

`notes_bulkTag` only ever answers with a task handle, which makes it the
shortest way to see the SEP-2663 round trip. The extension has to be
declared in the request's client capabilities, under `extensions`:

```sh
curl -sS -X POST http://127.0.0.1:3321/mcp/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer local-dev-token' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/call' \
  -H 'mcp-name: notes_bulkTag' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"notes_bulkTag","arguments":{"tag":"reviewed"},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{"extensions":{
        "io.modelcontextprotocol/tasks":{}}}}}}'
```

That returns `resultType: "task"` with a `taskId` and `status:
"working"`. Poll it (the id also goes into `Mcp-Name`):

```sh
curl -sS -X POST http://127.0.0.1:3321/mcp/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer local-dev-token' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tasks/get' \
  -H "mcp-name: $TASK_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{
        "taskId":"'"$TASK_ID"'","_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{"extensions":{
        "io.modelcontextprotocol/tasks":{}}}}}}'
```

Drop the `extensions` block from either request and the answer is
`-32021` at HTTP 400, listing the capability to add. Send the same
`tools/call` without `mcp-protocol-version: 2026-07-28` (the session
era) and it is `-32602`: there are no tasks there, and this tool has no
inline answer to fall back to.

#### Stateless MCP 2026-07-28

Everything above speaks the session-based protocol: `initialize` first,
then an `Mcp-Session-Id` on every follow-up. The same endpoint also
answers the 2026-07-28 revision, which has none of that. Each request
carries its own protocol version and client capabilities in
`params._meta`, mirrors its method into `Mcp-Method`, and stands alone.

Start with `server/discover` instead of `initialize`:

```sh
curl -sS -X POST http://127.0.0.1:3321/mcp/ \
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

curl -sS -X POST http://127.0.0.1:3321/mcp/ \
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
