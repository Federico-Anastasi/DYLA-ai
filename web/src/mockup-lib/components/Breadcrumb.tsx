// Schema type 'breadcrumb': the "A / B / current C" navigation trail. In the standard theme it is
// never mounted at all — the caller intercepts it and derives the automatic "Back" link that
// PageTitle shows instead (see MockupView.tsx). Here the component stays a pure dumb render.
export function Breadcrumb({
  items,
  onNavigate,
}: {
  items: { label: string; page?: string }[];
  onNavigate: (page?: string) => void;
}) {
  return (
    <div className="mk-breadcrumb">
      {items.map((it, i) => (
        <span className="mk-crumb" key={i}>
          {i > 0 && <span className="mk-crumb-sep">/</span>}
          {it.page && i < items.length - 1 ? (
            <button type="button" className="mk-crumb-link" onClick={() => onNavigate(it.page)}>
              {it.label}
            </button>
          ) : (
            <span className="mk-crumb-current">{it.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}
