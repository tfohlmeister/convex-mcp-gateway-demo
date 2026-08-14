import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  notes: defineTable({
    title: v.string(),
    body: v.string(),
    /**
     * Subject of the MCP caller that created the note. The gateway fills
     * it via `identityArg` (see convex/mcp.ts), so a client cannot spoof
     * it. Optional because the React UI writes straight to Convex with no
     * MCP identity, and so rows predating the field stay valid.
     */
    author: v.optional(v.string()),
  })
    .index("by_title", ["title"])
    // Backs `notes.byAuthor`, the tool that demonstrates `x-mcp-header`.
    .index("by_author", ["author"]),

  /**
   * One row per completed purge, keyed by the confirmation's idempotency
   * key. This is the point of the MRTR demo: the gateway hands the same
   * key to every retry of one confirmed continuation, so `notes.purge`
   * recognises a replay and reports the original outcome instead of
   * deleting a second time. Without a record like this, "the client lost
   * our response and asked again" is indistinguishable from "the user
   * confirmed a second purge".
   */
  purges: defineTable({
    key: v.string(),
    deleted: v.number(),
  }).index("by_key", ["key"]),
});
