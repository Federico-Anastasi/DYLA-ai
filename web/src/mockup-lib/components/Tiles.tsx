import { Icon } from "../icons";

// Row of navigation tiles (schema type 'tiles'), the top-level landing page: icon + title + a
// "See all" link through to a list page.
export function Tiles({
  items,
  onNavigate,
}: {
  items: { label: string; icon?: string; linkLabel?: string; target: string }[];
  onNavigate: (target?: string) => void;
}) {
  return (
    <div className="mk-tiles">
      {items.map((it, i) => (
        <div className="mk-tile" key={i}>
          <span className="mk-tile-icon">
            <Icon name={it.icon || "flag"} size={22} />
          </span>
          <div className="mk-tile-label">{it.label}</div>
          <button type="button" className="mk-tile-link" onClick={() => onNavigate(it.target)}>
            {it.linkLabel || "See all"}
          </button>
        </div>
      ))}
    </div>
  );
}
