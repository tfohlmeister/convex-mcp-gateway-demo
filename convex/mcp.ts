import { McpGateway, defineMcpMutation, defineMcpQuery } from "convex-mcp-gateway";
import { v } from "convex/values";
import { api, components } from "./_generated/api.js";
import { internalMutation, query } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

export const registerDefaults = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Bridge mode (optional): when MCP_AUTH_SERVER_URL is set, the
    // gateway advertises THIS deployment as the authorization server
    // and runs the DCR + AS-metadata wrap so browser MCP clients
    // (claude.ai et al.) speak to your IdP through us. Without it the
    // gateway still works — just no OAuth discovery for browser
    // clients. Resource = origin only; some clients bail silently
    // when the resource URL includes a path beyond origin.
    if (process.env.MCP_AUTH_SERVER_URL) {
      await gateway.setOAuthConfig(ctx, {
        authServerUrl: process.env.MCP_AUTH_SERVER_URL,
        resourceUrl:
          process.env.MCP_RESOURCE_URL ?? process.env.MCP_AUTH_SERVER_URL,
      });
    }
    await gateway.register(ctx, [
      defineMcpQuery({
        name: "notes_list",
        description: "List all notes (requires authentication).",
        fn: api.notes.list,
        args: {},
      }),
      defineMcpMutation({
        name: "notes_create",
        description: "Create a new note (requires admin role).",
        fn: api.notes.create,
        args: { title: v.string(), body: v.string() },
        metadata: { roles: ["admin"], auditArgs: false },
      }),
      defineMcpMutation({
        name: "notes_update",
        description: "Update an existing note (requires admin role).",
        fn: api.notes.update,
        args: { id: v.id("notes"), title: v.string(), body: v.string() },
        metadata: {
          roles: ["admin"],
          auditArgs: { redact: ["body"] },
        },
      }),
      defineMcpMutation({
        name: "notes_delete",
        description: "Delete a note (requires admin role).",
        fn: api.notes.remove,
        args: { id: v.id("notes") },
        metadata: { roles: ["admin"] },
      }),
      defineMcpQuery({
        name: "notes_count",
        description: "Return the total number of notes. Public.",
        fn: api.notes.count,
        args: {},
        // Typed return → claude.ai / Inspector get a typed
        // structuredContent block alongside the text content.
        // Compile-checked against api.notes.count's actual return type.
        returns: v.object({ total: v.float64() }),
        metadata: { public: true },
      }),
    ]);
    return null;
  },
});

/**
 * Audit log inspector exposed to convex run / dashboards. Wraps
 * gateway.listAuditEntries.
 */
export const recentAudit = query({
  args: {},
  handler: async (ctx) => {
    return await gateway.listAuditEntries(ctx, { limit: 20 });
  },
});
