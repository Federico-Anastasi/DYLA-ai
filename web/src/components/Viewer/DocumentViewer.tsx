import { useState } from "react";
import { exportUrl, fileUrl, previewUrl } from "../../api/client";
import { Icon } from "../icons";
import type { VersionsMap } from "../../hooks/useProjectPanel";
import AnchorButton from "./AnchorButton";
import PeopleView from "./PeopleView";
import DataModelView from "./DataModelView";
import QuestionsView from "./QuestionsView";
import IframeView from "./IframeView";
import MarkdownFileView from "./MarkdownFileView";
import MockupView from "./MockupView";
import BriefView from "./BriefView";
import EstimateView from "./EstimateView";
import TestPlanView from "./TestPlanView";
import VersionsModal from "./VersionsModal";
import { previewHow, type Selection } from "./viewerTypes";
import type { EstimateTotals } from "../../lib/totals";

const DOC_FILE: Record<string, string> = {
  brief: "brief.json",
  estimate: "estimate.json",
  data_model: "data_model.json",
  mockup: "mockup.json",
  test_plan: "test_plan.json",
  deck: "deck.json",
  questions: "questions.json",
  people: "people.json",
};
// The format each document downloads in. The brief comes out as Word because that's how
// the client receives it and comments on it; the deck as PowerPoint for the same reason.
const DOC_EXPORT: Record<string, string> = {
  brief: "brief.docx",
  estimate: "estimate.xlsx",
  data_model: "data_model.html",
  mockup: "mockup.html",
  test_plan: "test_plan.xlsx",
  deck: "deck.pptx",
};

// Day sums are floats (in steps of 0.25): without rounding, 60.4 + 15.2 prints
// 75.60000000000001 in the header recap.
function fmtDays(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// The central workbench: it renders ONLY the content of the selected document (the
// input/output tabs now live in DocumentTabsBar, above it, in ProjectView — selection and
// onSelect are lifted up there). onDirtyChange bubbles up the "unsaved changes" state of
// the editable doc currently open: ProjectView needs it to decide whether the end-of-turn
// auto-open may replace the current view or should only highlight the tab (see
// pickAutoOpenDoc in lib/documentTabs.ts).
export default function DocumentViewer({
  project,
  selection,
  onSelect,
  tick,
  versions,
  onSaved,
  onDirtyChange,
}: {
  project: string;
  selection: Selection;
  onSelect: (s: Selection) => void;
  tick: number;
  versions: VersionsMap;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [versionsFile, setVersionsFile] = useState<string | null>(null);
  // Estimate recap next to the title: published by EstimateView, which is what loads the
  // document.
  const [estimateTotals, setEstimateTotals] = useState<EstimateTotals | null>(null);

  const file = selection ? (selection.kind === "file" ? selection.file : DOC_FILE[selection.doc]) : null;
  const title = selection?.label ?? null;
  // Questions and people have no export: they're our own working files, we don't deliver them.
  const downloadUrl =
    selection?.kind === "file"
      ? fileUrl(project, selection.file, true)
      : selection && DOC_EXPORT[selection.doc]
        ? exportUrl(project, DOC_EXPORT[selection.doc])
        : null;

  return (
    <div id="doc-viewer">
      <div id="viewer-content">
        {!selection ? (
          <div className="viewer-empty">
            <p>No document open.</p>
            <p className="muted">Upload a brief or generate a deliverable from the bar above to start working.</p>
          </div>
        ) : (
          <>
            <div className="viewer-head">
              <span className="vh-title">{title}</span>
              {selection.kind === "doc" && selection.doc === "estimate" && estimateTotals && (
                <span className="vh-recap">
                  <strong>{fmtDays(estimateTotals.grandTotal)} days</strong>
                  {" | "}Dev {fmtDays(estimateTotals.devTotal)} (E2E {fmtDays(estimateTotals.e2eTotal)})
                  {" - "}Cont {estimateTotals.contingencyPct}%
                </span>
              )}
              {file && <AnchorButton project={project} file={file} anchorRef="" label={`${title} (whole document)`} />}
              {downloadUrl && (
                <a className="mini-btn" href={downloadUrl}><Icon name="download" size={13} />download</a>
              )}
              {file && (versions[file]?.length ?? 0) > 0 && (
                <a className="mini-btn" onClick={() => setVersionsFile(file)}><Icon name="history" size={13} />history</a>
              )}
            </div>
            <div className="viewer-body">
              {selection.kind === "file" && selection.how === "md" && (
                <MarkdownFileView project={project} file={selection.file} tick={tick} anchor={selection.anchor} />
              )}
              {selection.kind === "file" && selection.how === "iframe" && (
                // The anchor in PDFs is "page=N": the browser's viewer reads it from the fragment.
                <IframeView
                  src={`${fileUrl(project, selection.file)}${selection.anchor ? `#${selection.anchor}` : ""}`}
                  tick={tick}
                />
              )}
              {selection.kind === "file" && selection.how === "xlsx" && (
                <IframeView src={previewUrl(project, selection.file)} tick={tick} />
              )}
              {selection.kind === "file" && !selection.how && (
                <div className="viewer-empty">No preview available for this file. Use "download".</div>
              )}
              {selection.kind === "doc" && selection.doc === "estimate" && (
                <EstimateView key={project} project={project} tick={tick} onSaved={onSaved} onDirtyChange={onDirtyChange} onTotals={setEstimateTotals} />
              )}
              {selection.kind === "doc" && selection.doc === "data_model" && (
                <DataModelView key={project} project={project} tick={tick} onSaved={onSaved} onDirtyChange={onDirtyChange} />
              )}
              {selection.kind === "doc" && selection.doc === "mockup" && (
                <MockupView key={project} project={project} tick={tick} />
              )}
              {selection.kind === "doc" && selection.doc === "brief" && (
                <BriefView key={project} project={project} tick={tick} anchor={selection.anchor} />
              )}
              {selection.kind === "doc" && selection.doc === "questions" && (
                <QuestionsView key={project} project={project} tick={tick} onSaved={onSaved} onDirtyChange={onDirtyChange} />
              )}
              {selection.kind === "doc" && selection.doc === "people" && (
                <PeopleView key={project} project={project} tick={tick} onSaved={onSaved} onDirtyChange={onDirtyChange} />
              )}
              {selection.kind === "doc" && selection.doc === "test_plan" && (
                <TestPlanView key={project} project={project} tick={tick} onSaved={onSaved} onDirtyChange={onDirtyChange} />
              )}
              {/* The deck is shown the way the client will see it: the HTML export is
                  already the navigable presentation, a second React rendering would add
                  nothing. */}
              {selection.kind === "doc" && selection.doc === "deck" && (
                <IframeView src={exportUrl(project, "deck.html", true)} tick={tick} />
              )}
            </div>
          </>
        )}
      </div>

      {versionsFile && (
        <VersionsModal
          project={project}
          file={versionsFile}
          versions={versions}
          onOpenFile={(f) => {
            onSelect({ kind: "file", file: f, how: previewHow(f), label: `${versionsFile} (version)` });
            setVersionsFile(null);
          }}
          onRestored={onSaved}
          onClose={() => setVersionsFile(null)}
        />
      )}
    </div>
  );
}
