import { defineApp } from "convex/server";
import mcpGateway from "convex-mcp-gateway/convex.config";

const app = defineApp();
// Component owns no HTTP routes; the host mounts them via
// gateway.handleMcpRequest in convex/http.ts so JWT validation runs in
// the host's auth context.
app.use(mcpGateway);

export default app;
