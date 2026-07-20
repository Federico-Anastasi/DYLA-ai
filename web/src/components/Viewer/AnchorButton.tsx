import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../../store/chatStore";
import type { Anchor } from "../../types";
import { Icon } from "../icons";

const POPOVER_W = 300;
const GAP = 6;
const MARGIN = 8; // minimum breathing room from the window edges

// The popover lives in a portal on document.body, NOT next to the button: in the data
// model the button sits inside a 24x24 SVG <foreignObject>, which clips everything that
// spills past its edges — an absolutely positioned popover in there opens invisible.
// With the portal the same dialog works everywhere (estimate rows, viewer header, ER boxes).
function popoverPosition(btn: DOMRect, popH: number): { top: number; left: number } {
  const below = btn.bottom + GAP;
  const fitsBelow = below + popH <= window.innerHeight - MARGIN;
  return {
    top: fitsBelow ? below : Math.max(MARGIN, btn.top - GAP - popH),
    // right-aligned with the button, but never off-screen
    left: Math.min(
      Math.max(MARGIN, btn.right - POPOVER_W),
      window.innerWidth - POPOVER_W - MARGIN,
    ),
  };
}

// Note: the prop CANNOT be called "ref" — React reserves that name in the JSX runtime
// (function components included), and passing a string in there triggers the old
// "string ref" machinery and crashes with "Function components cannot have string refs".
export default function AnchorButton({ project, file, anchorRef, label }: { project: string; file: string; anchorRef: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const sendPrompt = useChatStore((s) => s.sendPrompt);

  // Position after the first paint: we need the popover's real height to decide whether
  // to open it below or above the button.
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !popRef.current) return;
    setPos(popoverPosition(btnRef.current.getBoundingClientRect(), popRef.current.offsetHeight));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    // The position is computed when the popover opens: if the page moves underneath,
    // close it instead of leaving the popover detached from its button.
    const onMove = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  const close = () => { setOpen(false); setPos(null); };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    const anchor: Anchor = { file, ref: anchorRef, label };
    sendPrompt(project, t, anchor);
    setText("");
    close();
  };

  return (
    <div className="anchor-wrap">
      <button
        type="button"
        ref={btnRef}
        className="ask-btn"
        title="ask Dyla"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="message-circle" size={13} />
      </button>
      {open && createPortal(
        <div
          className="ask-popover"
          ref={popRef}
          // invisible until it has been positioned: avoids the flash in the top-left corner
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="ask-label" title={label}>{label}</div>
          <textarea
            autoFocus
            rows={3}
            placeholder="Ask a question about this item…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              if (e.key === "Escape") close();
            }}
          />
          <div className="ask-popover-actions">
            <button className="mini-btn" onClick={close}>cancel</button>
            <button className="mini-btn primary" onClick={send}>ask</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
