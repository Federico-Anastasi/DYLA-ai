// Structural mockup rules that depend ONLY on the theme (standard/compact/plain), pulled out
// of MockupView.tsx so they can be tested without mounting components (same principle as
// mockupLabels.ts). Every function here has a 1:1 Python mirror in server/mockup_export.py,
// named in the comments — the two implementations must stay identical in their results.
import type { MockupTheme } from "../mockup-lib";

// Where a grid puts its actions column (schema type 'grid', props.actions) — decided by the
// THEME, not by the JSON (see schemas/mockup.schema.json, c_grid.props.actions):
// - standard: first column (checkbox + icons ahead of the status column).
// - compact: no actions column at all; row navigation goes solely through a kind='id-link'
//   column, which still uses actions[0].target as its destination.
// - plain: last column (the historical default, no reference layout behind it).
// Python mirror: _grid_actions_position in server/mockup_export.py.
export function gridActionsPosition(theme: MockupTheme): "start" | "end" | "none" {
  if (theme === "compact") return "none";
  if (theme === "standard") return "start";
  return "end";
}

// The compact theme's automatic two-column record view: if the page body (after hoisting any
// 'actions' block up to the title) starts with 'state-progress', that block — and, when it
// comes immediately after, the following 'section' (a secondary card, e.g. "Messages") — get
// isolated into a narrow left column; everything else (main) goes into the wide right column.
// Outside the compact theme, or when the body does not start with 'state-progress', there is
// no split (side empty, main = the whole input). Driven SOLELY by component order, with no
// dedicated schema prop. Python mirror: build_mockup_html in server/mockup_export.py (same
// rule, same two conditions).
export function splitRecordViewSide<T extends { type: string }>(
  theme: MockupTheme,
  components: T[]
): { side: T[]; main: T[] } {
  if (theme !== "compact" || components[0]?.type !== "state-progress") {
    return { side: [], main: components };
  }
  const side: T[] = [components[0]];
  let rest = components.slice(1);
  if (rest[0]?.type === "section") {
    side.push(rest[0]);
    rest = rest.slice(1);
  }
  return { side, main: rest };
}
