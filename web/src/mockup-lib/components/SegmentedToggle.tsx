// Pill selector (schema type 'segmented'), e.g. "By activity" / "By owner". The active option is a
// filled pill in the primary colour and the others are plain links — not the usual bordered switch.
// It comes from the compact theme but every theme can use it.
export function SegmentedToggle({
  options,
  active = 0,
  onNavigate,
}: {
  options: { label: string; target?: string }[];
  active?: number;
  onNavigate: (target?: string) => void;
}) {
  return (
    <div className="mk-segmented">
      {options.map((o, i) => (
        <button
          key={i}
          type="button"
          className={`mk-segmented-item${i === active ? " active" : ""}`}
          onClick={() => onNavigate(o.target)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
