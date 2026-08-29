import { mcpCallerValidator } from "convex-mcp-gateway";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const noteValidator = v.object({
  _id: v.id("notes"),
  _creationTime: v.number(),
  title: v.string(),
  body: v.string(),
  author: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
});

export const list = query({
  args: {},
  returns: v.array(noteValidator),
  handler: async (ctx) => await ctx.db.query("notes").collect(),
});

export const get = query({
  args: { id: v.string() },
  returns: v.union(noteValidator, v.null()),
  handler: async (ctx, args) => {
    // The id arrives as a raw string from an expanded resource template
    // URI (`note://<id>`), so it has to be normalized before use. A
    // malformed id is a miss, not a crash.
    const id = ctx.db.normalizeId("notes", args.id);
    return id === null ? null : await ctx.db.get(id);
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    body: v.string(),
    // Filled server-side by the gateway when called as the `notes_create`
    // MCP tool (see `identityArg` in convex/mcp.ts). Optional so the
    // React UI can call this mutation directly with no MCP identity.
    caller: v.optional(mcpCallerValidator),
  },
  returns: v.id("notes"),
  handler: async (ctx, args) =>
    await ctx.db.insert("notes", {
      title: args.title,
      body: args.body,
      ...(args.caller !== undefined ? { author: args.caller.subject } : {}),
    }),
});

export const update = mutation({
  args: { id: v.id("notes"), title: v.string(), body: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error(`Note ${args.id} not found`);
    await ctx.db.patch(args.id, { title: args.title, body: args.body });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return null;
  },
});

/**
 * Notes written by one MCP subject, newest first.
 *
 * Exposed as the `notes_by_author` tool, which mirrors both arguments
 * into `Mcp-Param-*` HTTP headers via `x-mcp-header` (see convex/mcp.ts).
 * Nothing here knows about that: header mirroring is a transport concern
 * the gateway validates before dispatch, so this stays an ordinary query.
 */
export const byAuthor = query({
  args: { author: v.string(), limit: v.number() },
  returns: v.array(noteValidator),
  handler: async (ctx, args) =>
    await ctx.db
      .query("notes")
      .withIndex("by_author", (q) => q.eq("author", args.author))
      .order("desc")
      // Floor before clamping. The `type: "integer"` in the tool's schema
      // is advisory: the gateway only enforces it against the mirrored
      // header, and only on 2026-07-28 requests. A session-based caller
      // can send `limit: 25.5` straight through, and `.take()` rejects a
      // non-integer with an opaque tool-execution error.
      .take(Math.min(Math.max(Math.floor(args.limit), 1), 100)),
});

/**
 * Delete every note.
 *
 * Exposed as `notes_purge`, whose `beforeCall` hook requires an explicit
 * confirmation round before this ever runs (see convex/mcp.ts). Nothing
 * here knows about that: the negotiation is the gateway's job.
 *
 * `confirmationKey` is filled by the gateway with the confirmed
 * continuation's idempotency key, never by the client, and it is what
 * makes a retry safe. A tool with side effects has to persist that key
 * around them itself; the gateway guarantees the key is stable per
 * confirmation, not that your mutation is idempotent.
 */
export const purge = mutation({
  args: { confirmationKey: v.optional(v.string()) },
  returns: v.object({ deleted: v.number(), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const key = args.confirmationKey;
    if (key !== undefined) {
      const prior = await ctx.db
        .query("purges")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      // Same confirmation, seen before: report what it did rather than
      // emptying a store the user has refilled since.
      if (prior) return { deleted: prior.deleted, replayed: true };
    }
    const all = await ctx.db.query("notes").collect();
    for (const note of all) await ctx.db.delete(note._id);
    if (key !== undefined) {
      await ctx.db.insert("purges", { key, deleted: all.length });
    }
    return { deleted: all.length, replayed: false };
  },
});

/**
 * Walk every note and report a per-author tally.
 *
 * Exposed as `notes_reindex` with `taskSupport: "optional"`, so a modern
 * client may run it as an MCP task and poll `tasks/get` instead of
 * holding the request open. Whether it does is the mount's call, made by
 * `tasks.shouldCreate` in convex/http.ts. It is an ordinary mutation:
 * which execution path it took is invisible here, which is the point.
 */
export const reindex = mutation({
  args: {},
  returns: v.object({
    scanned: v.number(),
    authors: v.array(v.object({ author: v.string(), notes: v.number() })),
  }),
  handler: async (ctx) => {
    const all = await ctx.db.query("notes").collect();
    const tally = new Map<string, number>();
    for (const note of all) {
      const author = note.author ?? "(unattributed)";
      tally.set(author, (tally.get(author) ?? 0) + 1);
    }
    return {
      scanned: all.length,
      authors: [...tally.entries()]
        .map(([author, notes]) => ({ author, notes }))
        .sort((a, b) => a.author.localeCompare(b.author)),
    };
  },
});

/**
 * Apply one label to every note that does not carry it yet.
 *
 * Exposed as `notes_bulkTag` with `taskSupport: "required"`, so it never
 * runs inline: the gateway always answers with a task handle and the
 * built-in executor runs this after the HTTP request returned. A client
 * that cannot poll is refused rather than served, which is the difference
 * between `"required"` and the `"optional"` level `notes_reindex` uses.
 *
 * Deliberately idempotent per tag, because a deferred call is one a
 * client can lose the answer to and ask about again.
 */
export const bulkTag = mutation({
  args: { tag: v.string() },
  returns: v.object({ tagged: v.number(), alreadyTagged: v.number() }),
  handler: async (ctx, args) => {
    const all = await ctx.db.query("notes").collect();
    let tagged = 0;
    let alreadyTagged = 0;
    for (const note of all) {
      const tags = note.tags ?? [];
      if (tags.includes(args.tag)) {
        alreadyTagged += 1;
        continue;
      }
      await ctx.db.patch(note._id, { tags: [...tags, args.tag] });
      tagged += 1;
    }
    return { tagged, alreadyTagged };
  },
});

/** One `field contains substring` test, the leaf of a search filter. */
const searchLeaf = v.object({
  field: v.union(v.literal("title"), v.literal("body")),
  contains: v.string(),
});

/**
 * Search notes with either a single condition or a conjunction of them.
 *
 * Exposed as `notes_search`, whose advertised `inputSchema` expresses
 * this shape with `$defs` + `$ref` + `anyOf` rather than by inlining the
 * leaf twice (see convex/mcp.ts). The client receives that document as
 * authored; the gateway resolves the references only for its own view,
 * which is what this tool is here to demonstrate.
 */
export const search = query({
  args: { filter: v.union(searchLeaf, v.object({ all: v.array(searchLeaf) })) },
  returns: v.array(noteValidator),
  handler: async (ctx, args) => {
    const leaves = "all" in args.filter ? args.filter.all : [args.filter];
    const all = await ctx.db.query("notes").collect();
    return all.filter((note) =>
      leaves.every((leaf) =>
        note[leaf.field].toLowerCase().includes(leaf.contains.toLowerCase()),
      ),
    );
  },
});

export const count = query({
  args: {},
  returns: v.object({ total: v.number() }),
  handler: async (ctx) => {
    const all = await ctx.db.query("notes").collect();
    return { total: all.length };
  },
});

/**
 * Report the authenticated MCP caller back to the client.
 *
 * `ctx.auth` is deliberately NOT used here: a dispatched tool runs inside
 * the gateway component, where Convex does not propagate the host's auth
 * context, so `ctx.auth.getUserIdentity()` would always return null. The
 * caller arrives as an ordinary argument that the gateway fills at the
 * request boundary and strips from the advertised input schema.
 */
export const whoami = query({
  args: { caller: mcpCallerValidator },
  returns: v.object({ subject: v.string(), claims: v.array(v.string()) }),
  handler: async (_ctx, args) => ({
    subject: args.caller.subject,
    // Claim *names* only. The values can carry email, groups and other
    // personal data, and this response goes straight to an LLM.
    claims: Object.keys(args.caller.claims ?? {}).sort(),
  }),
});
