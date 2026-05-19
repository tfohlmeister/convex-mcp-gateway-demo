import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function AuditPanel() {
  const entries = useQuery(api.mcp.recentAudit);

  if (entries === undefined) return <p className="muted">Loading…</p>;
  if (entries.length === 0) {
    return (
      <p className="muted">
        No audit entries yet. Trigger an MCP tool call to populate this list.
      </p>
    );
  }

  return (
    <ul className="audit-list">
      {entries.map((e) => (
        <li key={e._id} className={`card audit-row outcome-${e.outcome}`}>
          <header className="audit-head">
            <span className="tool">{e.toolName}</span>
            <span className={`badge badge-${e.outcome}`}>{e.outcome}</span>
            <span className="muted small">{e.durationMs}ms</span>
            <span className="muted small">
              {new Date(e._creationTime).toLocaleTimeString()}
            </span>
          </header>
          <div className="audit-meta">
            <span className="muted small">
              identity: {e.identitySubject ?? "anonymous"}
            </span>
            <span className="muted small">kind: {e.toolKind}</span>
          </div>
          {e.args !== null && e.args !== undefined && (
            <pre className="args">{JSON.stringify(e.args, null, 2)}</pre>
          )}
          {(e.errorCode !== undefined || e.errorMessage !== undefined) && (
            <pre className="error">
              {e.errorCode !== undefined ? `[${e.errorCode}] ` : ""}
              {e.errorMessage}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}
