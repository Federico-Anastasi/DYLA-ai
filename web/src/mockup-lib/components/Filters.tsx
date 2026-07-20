import { useState } from "react";
import { Icon } from "../icons";
import type { MockupTheme } from "./AppShell";

// Filter bar (schema type 'filters'). Standard/plain themes: a collapsible "Filters" block with a
// chevron and a magnifier, where 'collapsible' (default true) makes it start closed. Compact theme:
// the chip filters are ALWAYS visible — 'collapsible' is ignored — with a search box and a Search
// button before the chip row when search_label is present (small-caps label + italic value).
export function Filters({
  theme,
  fields,
  collapsible = true,
  searchLabel,
}: {
  theme: MockupTheme;
  fields: { label: string; value: string }[];
  collapsible?: boolean;
  searchLabel?: string;
}) {
  const [open, setOpen] = useState(!collapsible);

  if (theme === "compact") {
    return (
      <div className="mk-filters mk-filters-compact">
        {searchLabel && (
          <div className="mk-filters-search">
            <input type="text" className="mk-filters-search-input" placeholder={searchLabel} />
            <button type="button" className="mk-btn mk-btn-action mk-btn-small">
              Search
            </button>
          </div>
        )}
        <div className="mk-filter-chips">
          {fields.map((f, i) => (
            <div className="mk-filter-chip" key={i}>
              <span className="mk-filter-chip-label">{f.label}</span>
              <span className="mk-filter-chip-value">{f.value}</span>
              <Icon name="chevron-down" size={13} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`mk-filters mk-filters-standard${open ? " mk-filters-open" : ""}`}>
      <button type="button" className="mk-filters-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="mk-chevron">
          <Icon name="chevron-down" size={14} />
        </span>
        <Icon name="search" size={15} />
        <span>Filters</span>
      </button>
      {open && (
        <div className="mk-filters-body">
          {fields.map((f, i) => (
            <div className="mk-filter-field" key={i}>
              <label>{f.label}</label>
              <div className="mk-filter-value">{f.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
