import { useMutation, useQuery } from "convex/react";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Note = {
  _id: Id<"notes">;
  _creationTime: number;
  title: string;
  body: string;
};

export function NotesPanel() {
  const notes = useQuery(api.notes.list);
  const create = useMutation(api.notes.create);
  const remove = useMutation(api.notes.remove);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draftTitle.trim()) return;
    setBusy(true);
    try {
      await create({ title: draftTitle, body: draftBody });
      setDraftTitle("");
      setDraftBody("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notes-panel">
      <form className="card create-form" onSubmit={onSubmit}>
        <input
          placeholder="Title"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
        />
        <textarea
          placeholder="Body"
          value={draftBody}
          rows={3}
          onChange={(e) => setDraftBody(e.target.value)}
        />
        <button type="submit" disabled={busy || !draftTitle.trim()}>
          Create note
        </button>
      </form>

      {notes === undefined ? (
        <p className="muted">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="muted">
          No notes yet. Create one above, or have an MCP client call{" "}
          <code>notes_create</code>.
        </p>
      ) : (
        <ul className="note-list">
          {notes.map((n) => (
            <NoteRow key={n._id} note={n} onDelete={() => remove({ id: n._id })} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({
  note,
  onDelete,
}: {
  note: Note;
  onDelete: () => Promise<unknown>;
}) {
  const update = useMutation(api.notes.update);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);

  // Sync local state when an external change (e.g. an MCP-triggered
  // notes_update) overwrites this row. Stays out of the way while the
  // user is mid-edit because dirty rows compare against current local
  // state instead of the server value.
  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
  }, [note._id, note.title, note.body]);

  const dirty = title !== note.title || body !== note.body;

  const onSave = async () => {
    setSaving(true);
    try {
      await update({ id: note._id, title, body });
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="card note-row">
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        value={body}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="row-actions">
        <span className="muted small">
          {new Date(note._creationTime).toLocaleString()}
        </span>
        <div className="spacer" />
        <button onClick={onSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="danger" onClick={() => onDelete()}>
          Delete
        </button>
      </div>
    </li>
  );
}
