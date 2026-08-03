import { NotesPanel } from "./components/NotesPanel";
import { AuditPanel } from "./components/AuditPanel";

export function App() {
  const url = import.meta.env.VITE_CONVEX_URL as string;
  // Cloud deployments serve HTTP actions from the .convex.site twin of
  // the deployment URL. A local backend uses a separate port instead,
  // where that swap does nothing, so honour an explicit override first
  // (`pnpm local:start` writes it into .env.local).
  const siteUrl =
    (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined) ??
    url.replace(".convex.cloud", ".convex.site");

  return (
    <div className="app">
      <header className="app-header">
        <h1>convex-mcp-gateway playground</h1>
        <p className="hint">
          UI writes go straight to Convex (no audit row). MCP tool calls hit{" "}
          <code>{siteUrl}/mcp</code> and show up on the right.
        </p>
      </header>
      <main className="grid">
        <section className="col">
          <h2>Notes</h2>
          <NotesPanel />
        </section>
        <section className="col">
          <h2>Recent audit log</h2>
          <AuditPanel />
        </section>
      </main>
    </div>
  );
}
