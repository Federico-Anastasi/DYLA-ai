import { useState } from "react";
import { useChatStore } from "../../store/chatStore";
import { formatDate } from "../../lib/agendaBuckets";
import { Icon } from "../icons";
import ConfirmButton from "../Viewer/ConfirmButton";
import type { AgendaItem } from "../../types";

// Compact row for a single agenda item. The text is edited inline (click -> input), and the other
// actions (push to tomorrow, remove) only appear on hover, so the list stays quiet when there are
// many items.
export default function AgendaItemRow({
  item,
  onOpenChat,
  onToggleDone,
  onPushToTomorrow,
  onRemove,
  onSaveText,
}: {
  item: AgendaItem;
  onOpenChat: (name: string) => void;
  onToggleDone: (id: string, done: boolean) => void;
  onPushToTomorrow: (id: string) => void;
  onRemove: (id: string) => void;
  onSaveText: (id: string, text: string) => void;
}) {
  // The existing project names only decide whether the chip is clickable: a project that is
  // mentioned but does not (any longer) exist stays a neutral chip instead of a broken link.
  const projectNames = useChatStore((s) => s.projects.map((p) => p.name));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  const done = item.status === "done";

  const commitText = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== item.text) onSaveText(item.id, t);
    else setDraft(item.text);
  };

  return (
    <div className={`agenda-item ${done ? "agenda-item-done" : ""}`}>
      <input
        type="checkbox"
        className="agenda-item-check"
        checked={done}
        onChange={(e) => onToggleDone(item.id, e.target.checked)}
        title={done ? "mark as to do" : "mark as done"}
      />

      {editing ? (
        <input
          className="agenda-item-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(item.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="agenda-item-text" onClick={() => !done && setEditing(true)}>
          {item.text}
        </span>
      )}

      {item.priority === "high" && <span className="agenda-item-priority" title="high priority" />}

      {!!item.projects?.length && (
        <span className="agenda-item-projects">
          {item.projects.map((p) => {
            const exists = projectNames.includes(p);
            return (
              <span
                key={p}
                className={`agenda-chip-project ${exists ? "agenda-chip-clickable" : ""}`}
                onClick={exists ? () => onOpenChat(p) : undefined}
                title={exists ? `open ${p}` : p}
              >
                {p}
              </span>
            );
          })}
        </span>
      )}

      {item.due && (
        <span className="agenda-item-date">
          {formatDate(item.due)}
          {/* The time sits next to the date rather than in its own column: in the
              "today" and "tomorrow" bands the date is implied and the time is what
              the eye is actually looking for. */}
          {item.time && <span className="agenda-item-time">{item.time}</span>}
        </span>
      )}

      <span className="agenda-item-actions">
        {!done && (
          <button
            type="button"
            className="icon-btn"
            title="push to tomorrow"
            onClick={() => onPushToTomorrow(item.id)}
          >
            <Icon name="chevron-right" size={13} />
          </button>
        )}
        <ConfirmButton
          className="icon-btn danger"
          icon="trash-2"
          iconSize={13}
          label="remove"
          confirmLabel="sure?"
          onConfirm={() => onRemove(item.id)}
        />
      </span>
    </div>
  );
}
