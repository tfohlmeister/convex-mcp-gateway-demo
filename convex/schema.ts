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
});
