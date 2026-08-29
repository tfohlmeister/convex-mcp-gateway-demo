import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Daily is plenty for a demo. A deployment reachable from the internet
// wants this more often, because the audit table takes a row from every
// unauthenticated request that reaches a task-only tool.
crons.daily(
  "mcp gateway cleanup",
  { hourUTC: 3, minuteUTC: 0 },
  internal.maintenance.runPrune,
  {},
);

export default crons;
