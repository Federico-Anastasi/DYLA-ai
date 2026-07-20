// Re-export of the shared Icon (web/src/components/icons.tsx): the mockup library does not define
// an icon set of its own, it reuses the app's (stroke-based, Lucide-like, never emoji). The icons
// used here are mirrored 1:1 — same SVG paths — in server/mockup_export.py, because the HTML export
// is an independent rendering path (it does not run React) that still has to produce visually
// identical markup.
export { Icon } from "../components/icons";
