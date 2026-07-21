import { useEffect, useMemo, useState } from "react";
import { apiClient, ApiError, exportUrl } from "../../api/client";
import { useReloadableDoc } from "../../hooks/useReloadableDoc";
import { useToastStore } from "../../store/toastStore";
import type { Design, DesignDoc, DesignFormat } from "../../types";
import { Icon } from "../icons";
import ConfirmButton from "./ConfirmButton";

// Native editor for design.json — graphic artefacts where the agent writes free HTML/CSS
// per artboard (see schemas/design.schema.json). Same shared conventions as DiagramView: the
// JSON is the source of truth, saved via PUT (useReloadableDoc for load/dirty/stale), a
// 404 gets its own empty state with a "New design" button. UNLIKE every canvas-based view
// (DataModelView, DiagramView), there is no second rendering engine here: the artboard
// preview on the right is the real design.html export (server/design_export.py) shown in
// an iframe. The left side edits `html` directly as raw text — no template/slot form,
// no syntax highlighting, just a big monospace textarea.

const FORMATS: DesignFormat[] = ["ig-square", "ig-portrait", "ig-story", "li-landscape", "custom"];
const FORMAT_LABEL: Record<DesignFormat, string> = {
  "ig-square": "IG square · 1080×1080",
  "ig-portrait": "IG portrait · 1080×1350",
  "ig-story": "IG story · 1080×1920",
  "li-landscape": "LinkedIn · 1200×627",
  custom: "Custom size",
};

function formatBadge(d: Design): string {
  if (d.format === "custom") return `custom ${d.width ?? "?"}×${d.height ?? "?"}`;
  return d.format;
}

const STARTER_HTML =
  "<style>\n  /* your styles */\n</style>\n<div style=\"width: 100%; height: 100%;\"></div>";

function uniqueId(existing: string[], base: string): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`.toLowerCase())) n++;
  return `${base}-${n}`;
}

function nextDesignId(existing: string[]): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()));
  let n = 1;
  while (taken.has(`design-${n}`)) n++;
  return `design-${n}`;
}

function newDesign(existing: string[], format: DesignFormat): Design {
  return { id: nextDesignId(existing), format, html: STARTER_HTML };
}

// Server error format for a missing document, mirrored from server/main.py::get_doc
// ("{doc}.json not found for project '{name}'"), shared by every document kind — see the
// identical helper in DiagramView.
function looksMissing(message: string | null): boolean {
  return !!message && /not found/i.test(message);
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const swatch = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
  return (
    <label className="ds-field ds-color-field">
      <span className="muted">{label}</span>
      <span className="ds-color-input">
        <input type="color" value={swatch} onChange={(e) => onChange(e.target.value)} />
        <input
          type="text"
          value={value}
          placeholder="#rrggbb"
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}

export default function DesignView({
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
    useReloadableDoc<DesignDoc>(project, "design", tick);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveNonce, setSaveNonce] = useState(0);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [brandOpen, setBrandOpen] = useState(true);
  const [addFormat, setAddFormat] = useState<DesignFormat>("ig-square");

  const [idText, setIdText] = useState("");
  const [idError, setIdError] = useState<string | null>(null);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // Project changed: forget the current selection, like DiagramView resets activeId on
  // [project].
  useEffect(() => {
    setActiveId(null);
  }, [project]);

  // Keep a valid activeId once the document loads or a design is added/removed.
  useEffect(() => {
    if (!doc) return;
    setActiveId((cur) => (cur && doc.designs.some((d) => d.id === cur) ? cur : doc.designs[0]?.id ?? null));
  }, [doc]);

  useEffect(() => {
    setIdText(activeId ?? "");
    setIdError(null);
  }, [activeId]);

  // Cache-bust tied both to `tick` (the file may have changed on disk between turns) and
  // to a local counter bumped right after a save, plus the anchor so the preview scrolls
  // to the selected artboard. Declared BEFORE the early returns below: a hook after a
  // conditional return crashes with React #310 the moment the document finishes loading,
  // because the render suddenly has one hook more than the previous one.
  const previewSrc = useMemo(() => {
    const base = exportUrl(project, "design.html", true);
    const busted = `${base}${base.includes("?") ? "&" : "?"}_r=${tick}-${saveNonce}`;
    const activeDesign = doc?.designs.find((d) => d.id === activeId) ?? null;
    return activeDesign ? `${busted}#${encodeURIComponent(activeDesign.id)}` : busted;
  }, [project, tick, saveNonce, doc, activeId]);

  if (loadError && !looksMissing(loadError)) {
    return <div className="viewer-empty">Designs load error: {loadError}</div>;
  }

  if (loadError) {
    // looksMissing(loadError): design.json does not exist yet for this project.
    const createDocument = async () => {
      setCreating(true);
      setError(null);
      const today = new Date().toISOString().slice(0, 10);
      const skeleton: DesignDoc = {
        meta: { project, title: `${project} — designs`, date: today, status: "draft" },
        brand: { name: "", colors: { primary: "#2a6f6f", background: "#ffffff", text: "#1a1a1a" } },
        designs: [],
      };
      try {
        await apiClient.putDoc(project, "design", skeleton);
        useToastStore.getState().push("Design document created");
        onSaved();
        reloadDiscardingChanges();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not create the document");
      } finally {
        setCreating(false);
      }
    };
    return (
      <div className="viewer-empty ds-empty">
        <p>No social designs yet for this project.</p>
        <button type="button" className="mini-btn primary" disabled={creating} onClick={createDocument}>
          <Icon name="plus" size={13} />
          <span>{creating ? "creating…" : "New design"}</span>
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  const mutate = (fn: (d: DesignDoc) => DesignDoc) => {
    setDoc((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };
  const mutateActive = (fn: (d: Design) => void) => {
    mutate((doc) => {
      const d = doc.designs.find((x) => x.id === activeId);
      if (d) fn(d);
      return doc;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.putDoc(project, "design", doc);
      setDirty(false);
      setSaveNonce((n) => n + 1);
      useToastStore.getState().push("Design saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save error");
    } finally {
      setSaving(false);
    }
  };

  // ---- design-level actions (list) ----

  const addDesign = () => {
    const d = newDesign(doc.designs.map((x) => x.id), addFormat);
    mutate((doc) => { doc.designs.push(d); return doc; });
    setActiveId(d.id);
  };

  const duplicateDesign = (id: string) => {
    const src = doc.designs.find((d) => d.id === id);
    if (!src) return;
    const copy: Design = structuredClone(src);
    copy.id = uniqueId(doc.designs.map((d) => d.id), `${src.id}-copy`);
    mutate((doc) => {
      const idx = doc.designs.findIndex((d) => d.id === id);
      doc.designs.splice(idx + 1, 0, copy);
      return doc;
    });
    setActiveId(copy.id);
  };

  const deleteDesign = (id: string) => {
    const remaining = doc.designs.filter((d) => d.id !== id);
    mutate((doc) => { doc.designs = doc.designs.filter((d) => d.id !== id); return doc; });
    if (activeId === id) setActiveId(remaining[0]?.id ?? null);
  };

  const moveDesign = (fromIdx: number, toIdx: number) =>
    mutate((doc) => {
      if (toIdx < 0 || toIdx >= doc.designs.length) return doc;
      const [d] = doc.designs.splice(fromIdx, 1);
      doc.designs.splice(toIdx, 0, d);
      return doc;
    });

  const commitId = () => {
    if (!activeId) return;
    const value = idText.trim();
    if (!value) { setIdError("id required"); return; }
    if (value.toLowerCase() !== activeId.toLowerCase() && doc.designs.some((d) => d.id.toLowerCase() === value.toLowerCase())) {
      setIdError("id already used");
      return;
    }
    setIdError(null);
    if (value === activeId) return;
    mutate((doc) => {
      const d = doc.designs.find((x) => x.id === activeId);
      if (d) d.id = value;
      return doc;
    });
    setActiveId(value);
  };

  // ---- brand ----

  const patchBrand = (patch: Partial<DesignDoc["brand"]>) =>
    mutate((doc) => { doc.brand = { ...doc.brand, ...patch }; return doc; });
  const patchColors = (patch: Partial<DesignDoc["brand"]["colors"]>) =>
    mutate((doc) => { doc.brand = { ...doc.brand, colors: { ...doc.brand.colors, ...patch } }; return doc; });

  const active = doc.designs.find((d) => d.id === activeId) ?? null;

  return (
    <div className="ds-editor">
      {stale && (
        <div className="stale-banner">
          <Icon name="triangle-alert" size={15} />
          <span>The document changed on disk (updated in the meantime). Unsaved changes here were left untouched.</span>
          <ConfirmButton label="reload from disk" confirmLabel="you'll lose your changes: confirm" onConfirm={reloadDiscardingChanges} />
        </div>
      )}

      <div className="table-toolbar">
        <span className="spacer" />
        {error && <span className="error-text">{error}</span>}
        {dirty && !error && <span className="vh-dirty">unsaved changes</span>}
        <button className="mini-btn primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "saving…" : "save"}
        </button>
      </div>

      <div className="ds-body">
        <div className="ds-sidebar">
          <div className="ds-brand">
            <div className="ds-brand-header" onClick={() => setBrandOpen((v) => !v)}>
              <Icon name={brandOpen ? "chevron-down" : "chevron-right"} size={13} />
              <span>Brand</span>
            </div>
            {brandOpen && (
              <div className="ds-brand-body">
                <div className="ds-brand-row">
                  <label className="ds-field">
                    <span className="muted">Name</span>
                    <input value={doc.brand.name} onChange={(e) => patchBrand({ name: e.target.value })} />
                  </label>
                  <label className="ds-field">
                    <span className="muted">Handle</span>
                    <input
                      value={doc.brand.handle ?? ""}
                      placeholder="@handle"
                      onChange={(e) => patchBrand({ handle: e.target.value || undefined })}
                    />
                  </label>
                </div>
                <div className="ds-brand-row">
                  <ColorField label="Primary" value={doc.brand.colors.primary} onChange={(v) => patchColors({ primary: v })} />
                  <ColorField label="Accent" value={doc.brand.colors.accent ?? ""} onChange={(v) => patchColors({ accent: v || undefined })} />
                </div>
                <div className="ds-brand-row">
                  <ColorField label="Background" value={doc.brand.colors.background} onChange={(v) => patchColors({ background: v })} />
                  <ColorField label="Text" value={doc.brand.colors.text} onChange={(v) => patchColors({ text: v })} />
                </div>
                <div className="ds-brand-row">
                  <label className="ds-field ds-field-block">
                    <span className="muted">Voice</span>
                    <input
                      value={doc.brand.voice ?? ""}
                      placeholder="e.g. warm, local, no corporate speak"
                      onChange={(e) => patchBrand({ voice: e.target.value || undefined })}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          <div className="ds-list-head">
            <span className="muted">Designs</span>
            <span className="spacer" />
          </div>
          <div className="ds-add-row">
            <select value={addFormat} onChange={(e) => setAddFormat(e.target.value as DesignFormat)}>
              {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
            </select>
            <button type="button" className="ghost-btn small" onClick={addDesign}>
              <Icon name="plus" size={12} />
              <span>add design</span>
            </button>
          </div>

          {!doc.designs.length ? (
            <div className="viewer-empty ds-list-empty">No designs in this document yet. Use "add design" above.</div>
          ) : (
            <div className="ds-list">
              {doc.designs.map((d, i) => (
                <div
                  key={d.id}
                  className={`ds-item ${d.id === activeId ? "active" : ""}`}
                  onClick={() => setActiveId(d.id)}
                >
                  <span className="ds-item-id">{d.title ? `${d.id} — ${d.title}` : d.id}</span>
                  <span className="ds-badge">{formatBadge(d)}</span>
                  <span className="ds-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="icon-btn" title="move up" disabled={i === 0} onClick={() => moveDesign(i, i - 1)}>
                      <Icon name="arrow-up" size={12} />
                    </button>
                    <button type="button" className="icon-btn" title="move down" disabled={i === doc.designs.length - 1} onClick={() => moveDesign(i, i + 1)}>
                      <Icon name="arrow-down" size={12} />
                    </button>
                    <button type="button" className="icon-btn" title="duplicate" onClick={() => duplicateDesign(d.id)}>
                      <Icon name="file-text" size={12} />
                    </button>
                    <ConfirmButton className="icon-btn danger" icon="trash-2" iconSize={12} label="delete design" confirmLabel="confirm" onConfirm={() => deleteDesign(d.id)} />
                  </span>
                </div>
              ))}
            </div>
          )}

          {active && (
            <div className="ds-form">
              <div className="ds-form-head">
                <label className="ds-field">
                  <span className="muted">Id</span>
                  <input
                    value={idText}
                    onChange={(e) => setIdText(e.target.value)}
                    onBlur={commitId}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
                  {idError && <span className="error-text">{idError}</span>}
                </label>
                <label className="ds-field">
                  <span className="muted">Title</span>
                  <input
                    value={active.title ?? ""}
                    onChange={(e) => mutateActive((d) => { d.title = e.target.value || undefined; })}
                  />
                </label>
                <label className="ds-field">
                  <span className="muted">Format</span>
                  <select
                    value={active.format}
                    onChange={(e) => {
                      const format = e.target.value as DesignFormat;
                      mutateActive((d) => {
                        d.format = format;
                        if (format !== "custom") { delete d.width; delete d.height; }
                        else { d.width = d.width ?? 1080; d.height = d.height ?? 1080; }
                      });
                    }}
                  >
                    {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
                  </select>
                </label>
                {active.format === "custom" && (
                  <>
                    <label className="ds-field">
                      <span className="muted">Width (px)</span>
                      <input
                        type="number"
                        min={100}
                        max={4000}
                        value={active.width ?? 1080}
                        onChange={(e) => mutateActive((d) => { d.width = Number(e.target.value) || undefined; })}
                      />
                    </label>
                    <label className="ds-field">
                      <span className="muted">Height (px)</span>
                      <input
                        type="number"
                        min={100}
                        max={4000}
                        value={active.height ?? 1080}
                        onChange={(e) => mutateActive((d) => { d.height = Number(e.target.value) || undefined; })}
                      />
                    </label>
                  </>
                )}
              </div>

              <label className="ds-field ds-field-block">
                <span className="muted">Notes (not rendered — working note for you)</span>
                <textarea
                  rows={2}
                  value={active.notes ?? ""}
                  onChange={(e) => mutateActive((d) => { d.notes = e.target.value || undefined; })}
                />
              </label>

              <label className="ds-field ds-field-block">
                <span className="muted">HTML</span>
                <textarea
                  className="ds-html-editor"
                  spellCheck={false}
                  rows={16}
                  value={active.html}
                  onChange={(e) => mutateActive((d) => { d.html = e.target.value; })}
                />
                <span className="muted ds-html-count">{active.html.length.toLocaleString()} characters</span>
              </label>
            </div>
          )}
        </div>

        <div className="ds-preview">
          <iframe key={previewSrc} src={previewSrc} title="design preview" />
        </div>
      </div>
    </div>
  );
}
