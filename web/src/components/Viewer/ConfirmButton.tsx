import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";

// Avoids window.confirm() (a native dialog: it blocks the whole tab, looks nothing like
// the rest of the theme, and in some contexts — browser automation, for instance — can
// hang forever waiting for an answer). Two clicks within a few seconds = confirmed;
// otherwise the button falls back to its normal state.
//
// "icon" variant: pass "icon" and the button ALWAYS shows the icon (never text, e.g.
// delete = trash icon) — only the title and the styling change between the normal and
// the "armed" state.
export default function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = "mini-btn",
  icon,
  iconSize = 14,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  icon?: string;
  iconSize?: number;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const click = () => {
    if (armed) {
      if (timer.current) clearTimeout(timer.current);
      setArmed(false);
      onConfirm();
    } else {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
    }
  };

  if (icon) {
    return (
      <button
        type="button"
        className={`${className} ${armed ? "confirm-armed" : ""}`}
        title={armed ? confirmLabel : label}
        onClick={click}
      >
        <Icon name={icon} size={iconSize} />
      </button>
    );
  }

  return (
    <a className={`${className} ${armed ? "confirm-armed" : ""}`} onClick={click}>
      {armed ? confirmLabel : label}
    </a>
  );
}
