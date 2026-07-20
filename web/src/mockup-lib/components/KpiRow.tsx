import { Icon } from "../icons";

// One markup for all three themes: the difference — a flat card versus a card with an accent label,
// a divider and an oversized number like "2 / 5" — is entirely CSS (see .mk-kpi-* in each theme).
const TREND_ICON: Record<string, string> = { up: "trending-up", down: "trending-down", flat: "minus" };

export function KpiRow({ cards }: { cards: { label: string; value: string; trend?: "up" | "down" | "flat" }[] }) {
  return (
    <div className="mk-kpi-row">
      {cards.map((c, i) => (
        <div className="mk-kpi-card" key={i}>
          <div className="mk-kpi-label">{c.label}</div>
          <div className="mk-kpi-value">
            {c.value}
            {c.trend && TREND_ICON[c.trend] && (
              <span className={`mk-kpi-trend mk-trend-${c.trend}`}>
                <Icon name={TREND_ICON[c.trend]} size={14} />
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
