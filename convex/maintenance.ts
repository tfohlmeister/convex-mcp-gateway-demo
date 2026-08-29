import { McpGateway } from "convex-mcp-gateway";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

const DAY = 24 * 60 * 60 * 1000;
/** How long an audit row is kept. Short for a demo; pick your own. */
const AUDIT_RETENTION = 7 * DAY;
/** How long an idle MCP session row survives before it is dropped. */
const SESSION_IDLE = 1 * DAY;

/**
 * Drain the component's four growing tables.
 *
 * The gateway never prunes on its own, and three of these tables grow
 * with traffic rather than with data: sessions, MRTR bookkeeping, tasks
 * and the audit log. A deployment without this cron keeps every row
 * forever.
 *
 * The audit table is the one that matters here, and not only for size.
 * A tool registered `taskSupport: "required"` is refused for an
 * unauthenticated caller BEFORE `authorize` runs, and that refusal is
 * recorded with the arguments the caller sent. So anyone who can reach
 * `/mcp/` can write one audit row per request, sized by their own
 * request body, without ever holding a token. Retention is what bounds
 * that; on a deployment that has no reason to serve anonymous callers,
 * `requireAuth` on the mount is the stronger answer.
 *
 * ```sh
 * pnpm convex:run maintenance:runPrune
 * ```
 */
export const runPrune = internalMutation({
  args: {},
  returns: v.object({
    audit: v.number(),
    sessions: v.number(),
    mrtr: v.number(),
    tasks: v.number(),
  }),
  handler: async (ctx) => {
    // `pruneAuditEntries` deletes a bounded batch per call (~200 rows,
    // to stay inside Convex's per-mutation limits) and returns the
    // count, so the caller drains it. The other three drain themselves.
    let audit = 0;
    for (;;) {
      const deleted = await gateway.pruneAuditEntries(ctx, AUDIT_RETENTION);
      audit += deleted;
      if (deleted === 0) break;
    }
    const sessions = await gateway.pruneSessions(ctx, SESSION_IDLE);
    const mrtr = await gateway.pruneMrtrRedemptions(ctx);
    const tasks = await gateway.pruneTasks(ctx);
    return { audit, sessions, mrtr, tasks };
  },
});
