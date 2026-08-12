import { mcpCallerValidator } from "convex-mcp-gateway";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const noteValidator = v.object({
  _id: v.id("notes"),
  _creationTime: v.number(),
  title: v.string(),
  body: v.string(),
  author: v.optional(v.string()),
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
