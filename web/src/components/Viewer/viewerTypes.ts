import type { DocKind } from "../../types";

export type PreviewHow = "md" | "iframe" | "xlsx" | null;

// The documents that get their own tab in the viewer. "timeline" is a DocKind (it exists
// as JSON and as an endpoint) but it isn't a deliverable of its own: it's a view of the
// estimate, rendered by EstimateView, so it is never a Selection.
export type ViewerDoc = Exclude<DocKind, "timeline">;

// "anchor" is the spot in the document to jump to when it opens: a chapter slug, or
// "page=N" for PDFs. It gets set by a citation clicked in chat (see ProjectView), not by
// normal navigation.
export type Selection =
  | { kind: "file"; file: string; how: PreviewHow; label: string; anchor?: string }
  | { kind: "doc"; doc: ViewerDoc; label: string; anchor?: string }
  | null;

export function previewHow(f: string): PreviewHow {
  const ext = f.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "txt"].includes(ext)) return "md";
  if (["html", "htm", "pdf", "png", "jpg", "jpeg", "svg"].includes(ext)) return "iframe";
  if (ext === "xlsx") return "xlsx";
  return null;
}
