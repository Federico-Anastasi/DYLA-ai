import { useEffect, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { useReloadableDoc } from "../../hooks/useReloadableDoc";
import { useToastStore } from "../../store/toastStore";
import type { Question, QuestionsDoc, QuestionStatus } from "../../types";
import { Icon } from "../icons";
import ConfirmButton from "./ConfirmButton";
import WrapCell from "./WrapCell";

const STATUSES: QuestionStatus[] = ["open", "asked", "answered", "closed"];
const STATUS_LABEL: Record<QuestionStatus, string> = {
  open: "open",
  asked: "asked",
  answered: "answered",
  closed: "closed",
};

function hasAnswer(q: Question): boolean {
  return (q.answer ?? "").trim().length > 0;
}

export default function QuestionsView({
  project,
  tick,
  onSaved,
  onDirtyChange,
}: {
  project: string;
  tick: number;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { doc, setDoc, loadError, dirty, setDirty, stale, reloadDiscardingChanges } =
    useReloadableDoc<QuestionsDoc>(project, "questions", tick);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  if (loadError) return <div className="viewer-empty">Questions load error: {loadError}</div>;
  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  const mutate = (fn: (d: QuestionsDoc) => QuestionsDoc) => {
    setDoc((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.putDoc(project, "questions", doc);
      setDirty(false);
      useToastStore.getState().push("Questions saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save error");
    } finally {
      setSaving(false);
    }
  };

  const setStatus = (id: string, status: QuestionStatus) =>
    mutate((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (q) q.status = status;
      return d;
    });

  // The backend rejects the save if the status is answered/closed with no answer text —
  // this keeps the user from ever reaching that 422: if the answer is cleared while the
  // status is already further along, the status falls back to "asked" (which stays valid).
  const setAnswer = (id: string, answer: string) =>
    mutate((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (!q) return d;
      q.answer = answer;
      if (!answer.trim() && (q.status === "answered" || q.status === "closed")) q.status = "asked";
      return d;
    });

  const counts: Record<QuestionStatus, number> = { open: 0, asked: 0, answered: 0, closed: 0 };
  doc.questions.forEach((q) => counts[q.status]++);

  const visible = onlyOpen ? doc.questions.filter((q) => q.status === "open") : doc.questions;

  return (
    <div className="doc-table-wrap">
      {stale && (
        <div className="stale-banner">
          <Icon name="triangle-alert" size={15} />
          <span>The document changed on disk (updated in the meantime). Unsaved changes here were left untouched.</span>
          <ConfirmButton label="reload from disk" confirmLabel="you'll lose your changes: confirm" onConfirm={reloadDiscardingChanges} />
        </div>
      )}

      <div className="table-toolbar">
        <div className="dom-summary">
          {STATUSES.map((s) => (
            <span key={s} className={`dom-count dom-count-${s}`}>
              {STATUS_LABEL[s]} {counts[s]}
            </span>
          ))}
        </div>
        <div className="view-switch">
          <button
            type="button"
            className={`view-switch-btn ${!onlyOpen ? "active" : ""}`}
            onClick={() => setOnlyOpen(false)}
          >
            all
          </button>
          <button
            type="button"
            className={`view-switch-btn ${onlyOpen ? "active" : ""}`}
            onClick={() => setOnlyOpen(true)}
          >
            open only
          </button>
        </div>
        <span className="spacer" />
      </div>

      {!visible.length ? (
        <div className="viewer-empty">No questions match this filter.</div>
      ) : (
        <table className="doc-table dom-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Question</th>
              <th>Area</th>
              <th>Recipient</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Impact</th>
              <th>Answer</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((q) => {
              const canAdvance = hasAnswer(q);
              return (
                <tr key={q.id}>
                  <td>{q.id}</td>
                  <td className="wrap-cell">{q.question}</td>
                  <td>{q.area ?? "—"}</td>
                  <td>{q.addressee ?? "—"}</td>
                  <td>
                    <select
                      className={`dom-status-select dom-status-${q.status}`}
                      value={q.status}
                      onChange={(e) => setStatus(q.id, e.target.value as QuestionStatus)}
                    >
                      {STATUSES.map((s) => (
                        <option
                          key={s}
                          value={s}
                          disabled={(s === "answered" || s === "closed") && !canAdvance}
                        >
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{q.priority ?? "—"}</td>
                  <td>{q.impact ?? "—"}</td>
                  <td className="wrap-cell">
                    <WrapCell
                      value={q.answer ?? ""}
                      onChange={(v) => setAnswer(q.id, v)}
                      placeholder="Write the answer…"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="doc-toolbar">
        <span className="spacer" />
        {error && <span className="error-text">{error}</span>}
        {dirty && !error && <span className="vh-dirty">unsaved changes</span>}
        <button className="mini-btn primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "saving…" : "save"}
        </button>
      </div>
    </div>
  );
}
