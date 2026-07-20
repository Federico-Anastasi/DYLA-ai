import { Icon } from "../icons";

// Legend of coloured icons (schema type 'legend'). Typical use: priority stars above a table —
// grey = not prioritised, red = urgent, green = prioritised, blue = out of SLA.
export function Legend({ title, items }: { title?: string; items: { label: string; color: "grey" | "red" | "green" | "blue" }[] }) {
  return (
    <div className="mk-legend">
      {title && <span className="mk-legend-title">{title}</span>}
      {items.map((it, i) => (
        <span className="mk-legend-item" key={i}>
          <span className={`mk-legend-dot mk-legend-${it.color}`}>
            <Icon name="star" size={13} />
          </span>
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}
