import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("notes"),
      _creationTime: v.number(),
      title: v.string(),
      body: v.string(),
    }),
  ),
  handler: async (ctx) => await ctx.db.query("notes").collect(),
});

export const create = mutation({
  args: { title: v.string(), body: v.string() },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
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

export const count = query({
  args: {},
  returns: v.object({ total: v.number() }),
  handler: async (ctx) => {
    const all = await ctx.db.query("notes").collect();
    return { total: all.length };
  },
});

export const whoami = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.auth.getUserIdentity();
  },
});
