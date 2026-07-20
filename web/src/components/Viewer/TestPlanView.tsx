import { Fragment, useEffect, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { useReloadableDoc } from "../../hooks/useReloadableDoc";
import { useToastStore } from "../../store/toastStore";
import type { TestCaseOutcome, TestPlanDoc } from "../../types";
import { Icon } from "../icons";
import ConfirmButton from "./ConfirmButton";
import WrapCell from "./WrapCell";

const OUTCOMES: TestCaseOutcome[] = ["to_run", "ok", "ko", "blocked"];
const OUTCOME_LABEL: Record<TestCaseOutcome, string> = {
  to_run: "to run",
  ok: "OK",
  ko: "KO",
  blocked: "blocked",
};

// Groups cases by epic, keeping the order in which each epic first appears in the
// document — the /testplan skill writes the cases in the epic order of the estimate, so
// there's no reason to reshuffle them here.
function groupByEpic(cases: TestPlanDoc["cases"]): { epic: string; cases: TestPlanDoc["cases"] }[] {
  const order: string[] = [];
  const byEpic = new Map<string, TestPlanDoc["cases"]>();
  for (const c of cases) {
    if (!byEpic.has(c.epic)) {
      byEpic.set(c.epic, []);
      order.push(c.epic);
    }
    byEpic.get(c.epic)!.push(c);
  }
  return order.map((epic) => ({ epic, cases: byEpic.get(epic)! }));
}

export default function TestPlanView({
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
    useReloadableDoc<TestPlanDoc>(project, "test_plan", tick);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  if (loadError) return <div className="viewer-empty">Test plan load error: {loadError}</div>;
  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  const mutate = (fn: (d: TestPlanDoc) => TestPlanDoc) => {
    setDoc((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.putDoc(project, "test_plan", doc);
      setDirty(false);
      useToastStore.getState().push("Test plan saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save error");
    } finally {
      setSaving(false);
    }
  };

  const patch = (id: string, patchObj: Partial<TestPlanDoc["cases"][number]>) =>
    mutate((d) => {
      const c = d.cases.find((x) => x.id === id);
      if (c) Object.assign(c, patchObj);
      return d;
    });

  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allIds = doc.cases.map((c) => c.id);
  const allExpanded = allIds.length > 0 && allIds.every((id) => expanded.has(id));
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(allIds));

  const total = doc.cases.length;
  const counts: Record<TestCaseOutcome, number> = { to_run: 0, ok: 0, ko: 0, blocked: 0 };
  doc.cases.forEach((c) => counts[c.outcome ?? "to_run"]++);
  const executed = total - counts.to_run;
  const pct = total ? Math.round((executed / total) * 100) : 0;

  const groups = groupByEpic(doc.cases);

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
        <button type="button" className="ghost-btn" disabled={!allIds.length} onClick={toggleAll}>
          <Icon name={allExpanded ? "chevron-down" : "chevron-right"} size={14} />
          <span>{allExpanded ? "collapse all" : "expand all"}</span>
        </button>
        <div className="tb-summary">
          <span className="tb-count">{total} cases</span>
          <span className="tb-count tb-count-ok">ok {counts.ok}</span>
          <span className="tb-count tb-count-ko">ko {counts.ko}</span>
          <span className="tb-count tb-count-blocked">blocked {counts.blocked}</span>
          <span className="tb-count tb-count-to_run">to run {counts.to_run}</span>
          <span className="tb-count tb-count-pct">{pct}% executed</span>
        </div>
        <span className="spacer" />
      </div>

      {!total ? (
        <div className="viewer-empty">No test cases in this document.</div>
      ) : (
        <table className="doc-table tb-table">
          <thead>
            <tr>
              <th>Case</th>
              <th>Type</th>
              <th>Steps</th>
              <th>Outcome</th>
              <th className="th-actions" />
            </tr>
          </thead>
          <tbody>
            {groups.map(({ epic, cases }) => (
              <Fragment key={epic}>
                <tr className="epic-header">
                  <td colSpan={5}>{epic}</td>
                </tr>
                {cases.map((c) => {
                  const isOpen = expanded.has(c.id);
                  const outcome = c.outcome ?? "to_run";
                  return (
                    <Fragment key={c.id}>
                      <tr className="task-row">
                        <td>
                          <div className="cell-flex">
                            <button
                              type="button"
                              className="icon-btn row-expand-btn"
                              title={isOpen ? "collapse" : "expand"}
                              onClick={() => toggle(c.id)}
                            >
                              <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={13} />
                            </button>
                            <span>{c.id} — {c.title}</span>
                          </div>
                        </td>
                        <td>{c.type ?? "—"}</td>
                        {/* steps is required by schemas/test_plan.schema.json, but a case
                            written before the field was mandatory could still be missing
                            it: fall back to an empty list rather than crashing (same
                            convention as EstimateView's dev_tasks fallback). */}
                        <td className="num">{(c.steps ?? []).length}</td>
                        <td>
                          <span className={`tb-outcome-badge tb-outcome-${outcome}`}>{OUTCOME_LABEL[outcome]}</span>
                        </td>
                        <td className="row-actions" />
                      </tr>

                      {isOpen && (
                        <tr className="dev-task-row">
                          <td colSpan={5}>
                            <div className="tb-detail">
                              {c.preconditions && (
                                <div className="tb-detail-block">
                                  <span className="tb-detail-label">Preconditions</span>
                                  <p>{c.preconditions}</p>
                                </div>
                              )}

                              <div className="tb-detail-block">
                                <span className="tb-detail-label">Steps</span>
                                <ol className="tb-steps">
                                  {(c.steps ?? []).map((s) => (
                                    <li key={s.n}>
                                      <span className="tb-step-action">{s.action}</span>
                                      {s.expected && <span className="tb-step-expected"> → {s.expected}</span>}
                                    </li>
                                  ))}
                                </ol>
                              </div>

                              {c.expected_result && (
                                <div className="tb-detail-block">
                                  <span className="tb-detail-label">Expected result</span>
                                  <p>{c.expected_result}</p>
                                </div>
                              )}

                              {c.brief_ref && (
                                <p className="tb-reference muted">Brief reference: {c.brief_ref}</p>
                              )}

                              <div className="tb-detail-fields">
                                <label className="tb-field">
                                  <span className="muted">Outcome</span>
                                  <select
                                    className={`tb-outcome-select tb-outcome-${outcome}`}
                                    value={outcome}
                                    onChange={(e) => patch(c.id, { outcome: e.target.value as TestCaseOutcome })}
                                  >
                                    {OUTCOMES.map((o) => (
                                      <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>
                                    ))}
                                  </select>
                                </label>
                                <label className="tb-field">
                                  <span className="muted">Tester</span>
                                  <input
                                    className="cell-input"
                                    value={c.tester ?? ""}
                                    onChange={(e) => patch(c.id, { tester: e.target.value })}
                                  />
                                </label>
                                <label className="tb-field">
                                  <span className="muted">Execution date</span>
                                  <input
                                    className="cell-input"
                                    type="date"
                                    value={c.run_at ?? ""}
                                    onChange={(e) => patch(c.id, { run_at: e.target.value })}
                                  />
                                </label>
                              </div>
                              <div className="tb-detail-block">
                                <span className="tb-detail-label">Notes</span>
                                <WrapCell
                                  value={c.notes ?? ""}
                                  onChange={(v) => patch(c.id, { notes: v })}
                                  placeholder="Execution notes…"
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
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
