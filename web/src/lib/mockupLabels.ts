// Pure logic for the MockupView inspector: resolving the readable title of a component and
// the {ref, label} anchor to send to chat when the user clicks the "type" chip on hover.
// Kept apart from the React component so it can be tested without mounting anything.
import type { MockupComponent, MockupPage } from "../types";

export function componentTitle(comp: MockupComponent): string {
  const props = comp.props ?? {};
  switch (comp.type) {
    case "topbar":
      return String(props.title ?? "");
    case "nav":
      return "Navigation menu";
    case "breadcrumb":
      return (props.items ?? []).map((i: any) => i?.label).filter(Boolean).join(" > ");
    case "kpi-row":
      return `KPI (${(props.cards ?? []).length})`;
    case "grid":
      return props.title || "Table";
    case "form":
      return props.title || "Form";
    case "detail":
      return props.title || "Details";
    case "actions":
      return "Actions";
    case "tabs":
      return (props.tabs ?? []).map((t: any) => t?.label).filter(Boolean).join(" / ") || "Tabs";
    case "banner":
      return props.title || String(props.text ?? "").slice(0, 40);
    case "section":
      return props.title || "Section";
    case "filters":
      return "Filters";
    case "legend":
      return props.title || "Legend";
    case "statusbar":
      return props.label || "Status bar";
    case "wizard-steps":
      return (props.steps ?? []).join(" > ") || "Wizard";
    case "state-progress":
      return props.title || "Progress";
    case "segmented":
      return (props.options ?? []).map((o: any) => o?.label).filter(Boolean).join(" / ") || "Selector";
    case "tiles":
      return `Tiles (${(props.items ?? []).length})`;
    case "sidebar-nav":
      return (props.sections ?? []).map((s: any) => s?.label).filter(Boolean).join(" / ") || "Section menu";
    default:
      return comp.id;
  }
}

export function anchorRefFor(pageId: string, componentId: string): string {
  return `${pageId}.${componentId}`;
}

export function anchorLabelFor(page: MockupPage, comp: MockupComponent): string {
  return `page ${page.name} — ${comp.type}: ${componentTitle(comp)}`;
}
