import { useRef, useState } from "react";
import { useAgenda } from "../../hooks/useAgenda";
import { BUCKET_LABEL, BUCKET_ORDER, showBucket } from "../../lib/agendaBuckets";
import { Icon } from "../icons";
import Dictation, { type DictationHandle } from "./Dictation";
import AgendaItemRow from "./AgendaItemRow";

/**
 * The personal agenda panel, at the top of the home page above the project grid. It cuts across
 * projects: it never receives a current "project", it loads its own state through useAgenda. See
 * CLAUDE.md for the AgendaDoc/AgendaItem contract.
 *
 * The agenda-* class names below still match web/src/styles/app.css, which has not been renamed:
 * translating them here would silently drop the styling.
 */
export default function AgendaPanel({ onOpenChat }: { onOpenChat: (name: string) => void }) {
  const {
    doc,
    loading,
    error,
    setDone,
    moveToTomorrow,
    remove,
    addQuick,
    addProposed,
    patch,
  } = useAgenda();

  const [draft, setDraft] = useState("");
  const [doneOpen, setDoneOpen] = useState(false);
  const dictationRef = useRef<DictationHandle>(null);

  if (loading) return null; // no bulky spinner on the home page: it appears quietly and fills in
  if (error) return <div className="agenda-panel agenda-panel-errore">{error}</div>;
  if (!doc) return null;

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    addQuick(t);
    setDraft("");
  };

  const interpret = () => {
    const t = draft.trim();
    if (!t) return;
    dictationRef.current?.interpretText(t);
    setDraft("");
  };

  const saveText = (id: string, text: string) => patch(id, { text });

  return (
    <div className="agenda-panel">
      <div className="agenda-panel-head">
        <h2>Agenda</h2>
      </div>

      <div className="agenda-quick-add">
        <input
          className="agenda-quick-add-input"
          placeholder="Add an activity… (Enter to save)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button
          type="button"
          className="mini-btn"
          disabled={!draft.trim()}
          title="Work out the date and the projects with AI, without saving straight away"
          onClick={interpret}
        >
          interpret
        </button>
      </div>

      <Dictation
        ref={dictationRef}
        transcriptionReady={doc.transcription_ready}
        onConfirm={addProposed}
      />

      <div className="agenda-buckets">
        {BUCKET_ORDER.filter((b) => b !== "done").map((bucket) => {
          const items = doc.buckets[bucket];
          if (!showBucket(bucket, items)) return null;
          return (
            <div key={bucket} className={`agenda-bucket agenda-bucket-${bucket}`}>
              <div className="agenda-bucket-title">{BUCKET_LABEL[bucket]}</div>
              {!items.length ? (
                <div className="agenda-bucket-empty muted">Nothing scheduled for today.</div>
              ) : (
                items.map((it) => (
                  <AgendaItemRow
                    key={it.id}
                    item={it}
                    onOpenChat={onOpenChat}
                    onToggleDone={(id, done) => setDone(id, done)}
                    onPushToTomorrow={moveToTomorrow}
                    onRemove={remove}
                    onSaveText={saveText}
                  />
                ))
              )}
            </div>
          );
        })}

        {!!doc.buckets.done.length && (
          <div className="agenda-bucket agenda-bucket-done">
            <button
              type="button"
              className="agenda-bucket-title agenda-bucket-title-toggle"
              onClick={() => setDoneOpen((v) => !v)}
            >
              <Icon name={doneOpen ? "chevron-down" : "chevron-right"} size={13} />
              {BUCKET_LABEL.done} ({doc.buckets.done.length})
            </button>
            {doneOpen &&
              doc.buckets.done.map((it) => (
                <AgendaItemRow
                  key={it.id}
                  item={it}
                  onOpenChat={onOpenChat}
                  onToggleDone={(id, done) => setDone(id, done)}
                  onPushToTomorrow={moveToTomorrow}
                  onRemove={remove}
                  onSaveText={saveText}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
