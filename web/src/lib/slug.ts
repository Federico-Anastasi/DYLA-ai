// Slug of a title, used for the anchors of the chapters cited from chat.
// It MUST stay in step with server/ingest.py::slugify: the backend computes the slugs of the
// anchors, the frontend recomputes them on the rendered headings. If the two functions drift
// apart, a citation opens the document but never scrolls to the right spot.
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
