import type { ReactNode } from "react";
import { Icon } from "../icons";
import type { MockupTheme } from "./AppShell";

// Page title: NOT a schema component, it is automatic chrome derived from pages[].name (see
// schemas/mockup.schema.json). Standard/plain themes: a "Back" link — its target comes from the
// page's 'breadcrumb' component, if there is one — above a large centred title. Compact theme: the
// title sits on the left; and if the page's FIRST component is of type 'actions', the caller hoists
// it up here as actionsSlot instead of rendering it in the body (the record-view header pattern).
export function PageTitle({
  theme,
  title,
  backTarget,
  onNavigate,
  actionsSlot,
}: {
  theme: MockupTheme;
  title: string;
  backTarget?: string;
  onNavigate?: (target?: string) => void;
  actionsSlot?: ReactNode;
}) {
  if (theme === "compact") {
    return (
      <div className="mk-page-title-row">
        <h1 className="mk-page-title">{title}</h1>
        {actionsSlot && <div className="mk-page-title-actions">{actionsSlot}</div>}
      </div>
    );
  }
  return (
    <div className="mk-page-title-block">
      {backTarget && (
        <button type="button" className="mk-back-link" onClick={() => onNavigate?.(backTarget)}>
          <Icon name="corner-up-left" size={15} />
          <span>Back</span>
        </button>
      )}
      <h1 className="mk-page-title">{title}</h1>
    </div>
  );
}
