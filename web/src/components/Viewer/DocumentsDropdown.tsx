import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiClient, fileUrl } from "../../api/client";
import { useToastStore } from "../../store/toastStore";
import { Icon } from "../icons";
import type { ProjectSource, ProjectDocument } from "../../types";
import TranscriptionsSection from "./TranscriptionsSection";
import { previewHow, type Selection } from "./viewerTypes";

// Input documents can number in the dozens or hundreds (emails, attachments, exports,
// spreadsheets): one tab per file doesn't hold up. Here they all sit behind a single
// button, with the list in a dropdown that carries the metadata you need to recognise them
// (kind, size, date) and the actions that simply didn't exist before: uploading many at
// once and removing them.

const PANEL_W = 460;
const GAP = 6;
const MARGIN = 8; // minimum breathing room from the window edges

// The panel lives in a portal on document.body, NOT inside the bar: `.doc-tabbar` has
// `overflow-x: auto` so the tabs can scroll, and an absolutely positioned child gets
// clipped by its 48px of height — the dropdown would open cut in half. Same reason (and
// same fix) as the popover in AnchorButton.
function panelPosition(btn: DOMRect): { top: number; left: number } {
  return {
    top: btn.bottom + GAP,
    left: Math.min(Math.max(MARGIN, btn.left), window.innerWidth - PANEL_W - MARGIN),
  };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString("en-GB", {
    day: "2-digit", month: "2-digit", year: "2-digit",
  });
}

const KIND_LABEL: Record<ProjectDocument["kind"], string> = {
  brief: "Brief",
  docs: "Client documents",
  meetings: "Meetings",
};

export type Target = "brief" | "docs" | "meetings";

// How the destination reads in the picker: "into Documents", "as the Brief".
const TARGET_LABEL: Record<Target, string> = {
  docs: "into Documents",
  meetings: "into Meetings",
  brief: "as the Brief",
};

export default function DocumentsDropdown({
  project,
  source,
  tick,
  selection,
  onSelect,
  onRefresh,
}: {
  project: string;
  source: ProjectSource;
  tick: number;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<ProjectDocument[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Where uploaded files end up. The default follows the project's source (on projects
  // that start from discovery the useful destination is almost always the meetings), but
  // it stays derived rather than copied into state: the source arrives from the server
  // after the first render, and a default pinned at mount time would stay wrong forever.
  // State only holds the user's explicit choice.
  const [chosenTarget, setChosenTarget] = useState<Target | null>(null);
  // Guards against an out-of-order response: switch project quickly (or fire upload/remove
  // back to back) and an earlier listDocuments call can resolve AFTER a later one, painting
  // the previous project's file list over the current one. Only the latest request commits.
  const requestId = useRef(0);
  const target = chosenTarget ?? (source === "discovery" ? "meetings" : "docs");
  // The possible destinations, in the order that makes sense for this project. "brief" is
  // only there when the brief is an input document: on projects that start from discovery
  // we write the brief ourselves and uploading one would make no sense.
  const destinations: Target[] =
    source === "discovery" ? ["meetings", "docs"] : ["docs", "brief"];

  const load = () => {
    const id = ++requestId.current;
    return apiClient
      .listDocuments(project)
      .then((d) => { if (id === requestId.current) setDocs(d); })
      .catch(() => { if (id === requestId.current) setDocs([]); });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, tick]);

  // The position is computed before paint, otherwise the panel appears for one frame in
  // the top-left corner and then jumps into place.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const btn = btnRef.current?.getBoundingClientRect();
      if (btn) setPos(panelPosition(btn));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Click outside: the dropdown closes. Without this it stays open over the viewer and
  // gets in the way exactly while you're reading the document you just opened.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is in a portal: it isn't inside boxRef, so it has to be checked separately.
      if (!boxRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const upload = async (files: FileList | File[] | null, where: Target) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    // The brief is a single document: uploading two at once is almost certainly a
    // selection mistake, and the backend would refuse it anyway.
    if (where === "brief" && list.length > 1) {
      useToastStore.getState().push("The brief is a single document: pick just one", "error");
      return;
    }
    setBusy(true);
    try {
      await apiClient.uploadDocuments(project, list, where);
      useToastStore.getState().push(
        list.length === 1 ? `"${list[0].name}" uploaded` : `${list.length} documents uploaded`,
      );
      await load();
      onRefresh();
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (doc: ProjectDocument) => {
    if (!confirm(`Remove "${doc.name}"? The file gets deleted from the project.`)) return;
    try {
      await apiClient.deleteDocument(project, doc.file);
      useToastStore.getState().push(`"${doc.name}" removed`);
      await load();
      onRefresh();
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Removal failed", "error");
    }
  };

  const openDoc = (doc: ProjectDocument) => {
    onSelect({
      kind: "file",
      file: doc.file,
      how: previewHow(doc.file),
      label: doc.kind === "brief" ? "Project brief" : doc.name,
    });
    setOpen(false);
  };

  const visible = (docs ?? []).filter((d) =>
    d.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const groups: ProjectDocument["kind"][] = ["brief", "meetings", "docs"];
  const count = docs?.length ?? 0;

  return (
    <div className="docs-dropdown" ref={boxRef}>
      <button
        ref={btnRef}
        type="button"
        className={`doc-tab ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Project input documents"
      >
        <Icon name="folder" size={13} />
        Documents
        {count > 0 && <span className="docs-count">{count}</span>}
      </button>

      {open && pos && createPortal(
        <div className="docs-panel" ref={panelRef} style={{ top: pos.top, left: pos.left }}>
          <div className="docs-panel-head">
            <input
              className="docs-filter"
              placeholder="Search…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
            />
            <select
              className="docs-target"
              value={target}
              onChange={(e) => setChosenTarget(e.target.value as Target)}
              title="Where uploaded files end up"
            >
              {destinations.map((t) => (
                <option key={t} value={t}>{TARGET_LABEL[t]}</option>
              ))}
            </select>
            <label className={`mini-btn primary ${busy ? "disabled" : ""}`}>
              <Icon name="upload" size={12} />
              {busy ? "uploading…" : "upload"}
              <input
                ref={fileInput}
                type="file"
                multiple={target !== "brief"}
                onChange={(e) => upload(e.target.files, target)}
              />
            </label>
          </div>

          {/* A recording isn't a document to file away: it's raw material you turn into
              one. It sits here because the transcript lands in "Meetings", in the list
              right below. */}
          <TranscriptionsSection
            project={project}
            onOpen={(file) => {
              onSelect({ kind: "file", file, how: previewHow(file), label: file.split("/").pop()! });
              setOpen(false);
            }}
            onRefresh={() => {
              load();
              onRefresh();
            }}
          />

          <div
            className="docs-list"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              upload(e.dataTransfer.files, target);
            }}
          >
            {docs == null && <div className="docs-empty">loading…</div>}
            {docs != null && count === 0 && (
              <div className="docs-empty">
                No documents. Drag files here or use "upload".
              </div>
            )}
            {docs != null && count > 0 && visible.length === 0 && (
              <div className="docs-empty">No document matches "{filter}".</div>
            )}

            {groups.map((g) => {
              const items = visible.filter((d) => d.kind === g);
              if (!items.length) return null;
              return (
                <div key={g} className="docs-group">
                  <div className="docs-group-head">{KIND_LABEL[g]}</div>
                  {items.map((d) => (
                    <div
                      key={d.file}
                      className={`docs-row ${
                        selection?.kind === "file" && selection.file === d.file ? "active" : ""
                      }`}
                    >
                      <button type="button" className="docs-row-main" onClick={() => openDoc(d)}>
                        <span className="docs-ext">{d.ext || "?"}</span>
                        <span className="docs-name">{d.name}</span>
                        <span className="docs-meta">
                          {fmtSize(d.size)} · {fmtDate(d.modified)}
                        </span>
                        {/* A file the agent can't read stays downloadable but never makes
                            it into its answers: better to say so here than find out later. */}
                        {!d.readable && (
                          <span className="docs-flag" title="Dyla can't read this format">
                            not readable
                          </span>
                        )}
                      </button>
                      <a
                        className="docs-row-act"
                        href={fileUrl(project, d.file, true)}
                        title="Download"
                      >
                        <Icon name="download" size={12} />
                      </a>
                      <button
                        type="button"
                        className="docs-row-act danger"
                        title="Remove"
                        onClick={() => remove(d)}
                      >
                        <Icon name="trash-2" size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
