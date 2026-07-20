import { useChatStore } from "../../store/chatStore";
import { Icon } from "../icons";
import type { DocKind, ProjectSource, Workflow } from "../../types";
import type { DocStatusMap } from "../../hooks/useProjectPanel";
import { docsForProject, type OutputDocDef } from "../../lib/documentTabs";
import DocumentsDropdown from "./DocumentsDropdown";
import { previewHow, type Selection } from "./viewerTypes";

// Horizontal document bar, under the project header. From the left: the INPUT documents
// behind a single button with a dropdown (there can be hundreds of them: one tab per file
// didn't hold up), then the DELIVERABLES, then the working files (context, questions,
// people). Clicking a tab opens it in the central viewer.
export default function DocumentTabsBar({
  project,
  source,
  files,
  workflow,
  docStatuses,
  highlighted,
  selection,
  tick,
  onSelect,
  onRefresh,
}: {
  project: string;
  source: ProjectSource;
  files: string[];
  workflow: Workflow | null;
  docStatuses: DocStatusMap;
  highlighted: Set<DocKind>;
  selection: Selection;
  tick: number;
  onSelect: (s: Selection) => void;
  onRefresh: () => void;
}) {
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const has = (f: string) => files.includes(f);
  // An input brief can have any extension: we look for it among the project's files.
  const briefFile = files.find((f) => /^brief\.(md|pdf|docx|txt)$/i.test(f));
  const hasBrief = !!briefFile;

  const generate = (skill: string) => {
    sendPrompt(project, `Run the '${skill}' skill for project ${project}.`);
  };

  const docTab = (out: OutputDocDef) => {
    const exists = !!workflow?.[out.workflowKey];
    const status = docStatuses[out.doc];
    const isActive = selection?.kind === "doc" && selection.doc === out.doc;
    const isChanged = highlighted.has(out.doc);
    const generatable = out.canGenerate !== false;
    return (
      <div
        key={out.doc}
        role="button"
        tabIndex={0}
        className={`doc-tab ${exists ? "" : "missing"} ${isActive ? "active" : ""} ${isChanged ? "changed" : ""}`}
        onClick={() => exists && onSelect({ kind: "doc", doc: out.doc, label: out.label })}
        onKeyDown={(e) => {
          if (exists && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onSelect({ kind: "doc", doc: out.doc, label: out.label });
          }
        }}
      >
        <span className={`dot ${exists ? "done" : ""}`} />
        {out.label}
        {status && <span className={`doc-status-badge ${status}`}>{status}</span>}
        {generatable && (
          <span
            role="button"
            tabIndex={0}
            className="doc-tab-action"
            title={exists ? "regenerate" : "generate"}
            onClick={(e) => {
              e.stopPropagation();
              generate(out.skill);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                generate(out.skill);
              }
            }}
          >
            <Icon name="refresh-cw" size={11} />
          </span>
        )}
      </div>
    );
  };

  const contextDocs = docsForProject(source, workflow, "context");

  return (
    <div className="doc-tabbar">
      <div className="doc-tabbar-group">
        <DocumentsDropdown
          project={project}
          source={source}
          tick={tick}
          selection={selection}
          onSelect={onSelect}
          onRefresh={onRefresh}
        />
        {/* On a project where the brief is supplied, the bar says at a glance whether the
            brief is there, and clicking it opens it: it's the document you consult most
            often, and making you hunt for it in the dropdown every time would be a small
            daily torture. */}
        {source === "brief" && (
          <button
            type="button"
            className={`doc-tab ${hasBrief ? "" : "missing"} ${
              selection?.kind === "file" && selection.file === briefFile ? "active" : ""
            }`}
            disabled={!hasBrief}
            title={hasBrief ? "Open the brief" : "Brief not uploaded yet"}
            onClick={() =>
              briefFile &&
              onSelect({
                kind: "file",
                file: briefFile,
                how: previewHow(briefFile),
                label: "Project brief",
              })
            }
          >
            <span className={`dot ${hasBrief ? "done" : ""}`} />
            Brief
          </button>
        )}
      </div>

      <div className="doc-tabbar-sep" />

      <div className="doc-tabbar-group">
        {docsForProject(source, workflow, "output").map(docTab)}
      </div>

      <div className="doc-tabbar-sep" />

      <div className="doc-tabbar-group">
        <button
          type="button"
          className={`doc-tab ${has("context.md") ? "" : "missing"} ${
            selection?.kind === "file" && selection.file === "context.md" ? "active" : ""
          }`}
          disabled={!has("context.md")}
          onClick={() => onSelect({ kind: "file", file: "context.md", how: "md", label: "Context" })}
        >
          <span className={`dot ${has("context.md") ? "done" : ""}`} />
          Context
        </button>
        {contextDocs.map(docTab)}
      </div>
    </div>
  );
}
