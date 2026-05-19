import { NotesPanel } from "./components/NotesPanel";
import { AuditPanel } from "./components/AuditPanel";

export function App() {
  const url = import.meta.env.VITE_CONVEX_URL as string;
  const siteUrl = url.replace(".convex.cloud", ".convex.site");

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
