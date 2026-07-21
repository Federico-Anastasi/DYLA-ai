// Pure logic shared by the workspace (document tab bar + auto-open at the end of a turn):
// the list of documents that get a tab, reading their status (meta.status is optional,
// "draft"|"confirmed" — read leniently) and working out which doc to open automatically when
// several deliverables change within the same turn.
import type { DocKind, ProjectSource, Workflow } from "../types";
import type { ViewerDoc } from "../components/Viewer/viewerTypes";

export type DocStatus = "draft" | "confirmed";

// Documents sit in two groups on the bar: "output" are the deliverables we produce for the
// client, "context" are the working files (open questions, people) that travel with the
// project without ever being handed over.
export type DocGroup = "output" | "context";

// Only the docs that get a tab: the timeline is a DocKind but lives inside the Estimate view
// (see ViewerDoc in components/Viewer/viewerTypes.ts).
export type OutputDocDef = {
  doc: ViewerDoc;
  label: string;
  skill: string;
  workflowKey: keyof Workflow;
  group: DocGroup;
  // When set, the tab only shows up for projects with that source. The brief is the one
  // case: it is a deliverable only when we start from discovery, otherwise it is an input
  // document and belongs in the documents dropdown.
  source?: ProjectSource;
  // false = no "generate" button: the document does not come out of a skill but gets written
  // along the way (questions are collected by /meeting, and so are the people).
  canGenerate?: boolean;
};

// Order = the user's process (discovery, then estimate, then whatever follows): used both to
// render the tab bar and as the tie-break when several docs change in the same turn. Dev
// tasks have no tab of their own: they live inside estimate.json
// (epics[].tasks[].dev_tasks[]), generated and edited by the /dev-tasks skill on that document.
export const OUTPUT_DOCS: OutputDocDef[] = [
  // The backend reports this one as "brief", not "brief.json", and on purpose: the brief
  // can arrive as a PDF, a Word file or the JSON we write ourselves, so the flag answers
  // "is there a brief" rather than naming a file. Asking for the wrong key left the tab
  // permanently greyed out and unclickable on discovery projects.
  { doc: "brief", label: "Brief", skill: "meeting", workflowKey: "brief",
    group: "output", source: "discovery" },
  { doc: "estimate", label: "Estimate", skill: "estimate", workflowKey: "estimate.json", group: "output" },
  { doc: "data_model", label: "Data Model", skill: "data-model",
    workflowKey: "data_model.json", group: "output" },
  { doc: "mockup", label: "Mockup", skill: "mockup", workflowKey: "mockup.json", group: "output" },
  { doc: "diagram", label: "Diagrams", skill: "diagram", workflowKey: "diagram.json", group: "output" },
  { doc: "design", label: "Designs", skill: "design", workflowKey: "design.json", group: "output" },
  { doc: "test_plan", label: "Test plan", skill: "test-plan",
    workflowKey: "test_plan.json", group: "output" },
  { doc: "deck", label: "Deck", skill: "deck", workflowKey: "deck.json", group: "output" },
  { doc: "questions", label: "Questions", skill: "meeting", workflowKey: "questions.json",
    group: "context", canGenerate: false },
  { doc: "people", label: "People", skill: "meeting", workflowKey: "people.json",
    group: "context", canGenerate: false },
];

/** The docs that get a tab for this project. The "context" group only shows up once the file
 * exists: a project that does not use them must not stare at two dead tabs. */
export function docsForProject(
  source: ProjectSource | undefined,
  workflow: Workflow | null,
  group: DocGroup,
): OutputDocDef[] {
  return OUTPUT_DOCS.filter((d) => {
    if (d.group !== group) return false;
    if (d.source && d.source !== (source ?? "brief")) return false;
    if (d.group === "context" && !workflow?.[d.workflowKey]) return false;
    return true;
  });
}

export function labelForDoc(doc: ViewerDoc): string {
  return OUTPUT_DOCS.find((d) => d.doc === doc)?.label ?? doc;
}

export function statusFromMeta(meta: unknown): DocStatus | undefined {
  const s = (meta as { status?: unknown } | null | undefined)?.status;
  return s === "draft" || s === "confirmed" ? s : undefined;
}

export type DocSnapshot = Partial<Record<DocKind, string | null>>;

/** Compares the snapshot of the JSON docs before and after a turn: returns the doc kinds that
 * changed (created or modified). null = doc missing (a 404 at snapshot time); a different
 * string = content changed. It does not try to work out WHAT changed, only WHETHER. */
export function diffChangedDocs(before: DocSnapshot, after: DocSnapshot): ViewerDoc[] {
  return OUTPUT_DOCS.map((d) => d.doc).filter((k) => (before[k] ?? null) !== (after[k] ?? null));
}

/** Picks which doc to open automatically in the viewer when more than one changed in the same
 * turn: it follows the pipeline order (see OUTPUT_DOCS). The input may contain docs without a
 * tab (the timeline): those are ignored, since they cannot be opened. */
export function pickAutoOpenDoc(changed: DocKind[]): ViewerDoc | null {
  for (const d of OUTPUT_DOCS) if (changed.includes(d.doc)) return d.doc;
  return null;
}
