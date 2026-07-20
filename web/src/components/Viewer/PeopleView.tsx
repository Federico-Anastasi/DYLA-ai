import { Fragment, useEffect, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { useReloadableDoc } from "../../hooks/useReloadableDoc";
import { useToastStore } from "../../store/toastStore";
import { slugify } from "../../lib/slug";
import type { PeopleDoc } from "../../types";
import { Icon } from "../icons";
import ConfirmButton from "./ConfirmButton";
import WrapCell from "./WrapCell";

type Org = "client" | "us" | "third_party";
const ORG_ORDER: Org[] = ["client", "us", "third_party"];
const ORG_LABEL: Record<Org, string> = { client: "Client", us: "Us", third_party: "Third parties" };

// Same unique-id scheme as DataModelView (not shared: here the base is the person's name,
// not a fixed "new_table"). The backend rejects duplicate ids, so the guarantee has to be
// made right here.
function uniqueId(existing: string[], base: string): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()));
  const b = base || "person";
  if (!taken.has(b.toLowerCase())) return b;
  let n = 2;
  while (taken.has(`${b}-${n}`.toLowerCase())) n++;
  return `${b}-${n}`;
}

export default function PeopleView({
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
    useReloadableDoc<PeopleDoc>(project, "people", tick);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  if (loadError) return <div className="viewer-empty">People load error: {loadError}</div>;
  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  const mutate = (fn: (d: PeopleDoc) => PeopleDoc) => {
    setDoc((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.putDoc(project, "people", doc);
      setDirty(false);
      useToastStore.getState().push("People saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save error");
    } finally {
      setSaving(false);
    }
  };

  const patch = (id: string, patch: Partial<PeopleDoc["people"][number]>) =>
    mutate((d) => {
      const p = d.people.find((x) => x.id === id);
      if (p) Object.assign(p, patch);
      return d;
    });

  const addPerson = (org: Org) =>
    mutate((d) => {
      const id = uniqueId(d.people.map((p) => p.id), slugify("New person"));
      d.people.push({ id, name: "New person", role: "", organization: org, area: "", contact: "", notes: "" });
      return d;
    });

  const removePerson = (id: string) =>
    mutate((d) => {
      d.people = d.people.filter((p) => p.id !== id);
      return d;
    });

  return (
    <div className="doc-table-wrap">
      {stale && (
        <div className="stale-banner">
          <Icon name="triangle-alert" size={15} />
          <span>The document changed on disk (updated in the meantime). Unsaved changes here were left untouched.</span>
          <ConfirmButton label="reload from disk" confirmLabel="you'll lose your changes: confirm" onConfirm={reloadDiscardingChanges} />
        </div>
      )}

      <table className="doc-table people-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Area</th>
            <th>Contact</th>
            <th>Notes</th>
            <th className="th-actions" />
          </tr>
        </thead>
        <tbody>
          {ORG_ORDER.map((org) => {
            const list = doc.people.filter((p) => p.organization === org);
            return (
              <Fragment key={org}>
                <tr className="epic-header">
                  <td colSpan={5}>{ORG_LABEL[org]}</td>
                  <td className="row-actions">
                    <button type="button" className="ghost-btn small" onClick={() => addPerson(org)}>
                      <Icon name="plus" size={13} />
                      <span>person</span>
                    </button>
                  </td>
                </tr>
                {!list.length && (
                  <tr>
                    <td colSpan={6} className="muted">Nobody in this group yet.</td>
                  </tr>
                )}
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input className="cell-input" value={p.name} onChange={(e) => patch(p.id, { name: e.target.value })} />
                    </td>
                    <td>
                      <input className="cell-input" value={p.role} onChange={(e) => patch(p.id, { role: e.target.value })} />
                    </td>
                    <td>
                      <input className="cell-input" value={p.area ?? ""} onChange={(e) => patch(p.id, { area: e.target.value })} />
                    </td>
                    <td>
                      <input className="cell-input" value={p.contact ?? ""} onChange={(e) => patch(p.id, { contact: e.target.value })} />
                    </td>
                    <td className="wrap-cell">
                      <WrapCell value={p.notes ?? ""} onChange={(v) => patch(p.id, { notes: v })} placeholder="Notes…" />
                    </td>
                    <td className="row-actions">
                      <ConfirmButton
                        className="icon-btn danger"
                        icon="trash-2"
                        iconSize={13}
                        label="delete person"
                        confirmLabel="sure?"
                        onConfirm={() => removePerson(p.id)}
                      />
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>

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
