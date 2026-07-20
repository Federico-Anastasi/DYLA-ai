import { useEffect, useRef } from "react";

// A textarea that grows in height and wraps — used in the free-text cells of doc-table
// tables (dev_task, description): no inner scrollbar, the row grows with its content.
// Shared by the views that edit dev task rows (see EstimateView).
export default function WrapCell({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const t = taRef.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = t.scrollHeight + "px";
    }
  };
  useEffect(() => { resize(); }, [value]);
  return (
    <textarea
      ref={taRef}
      className="wrap-input"
      rows={1}
      value={value}
      placeholder={placeholder}
      onChange={(e) => { onChange(e.target.value); resize(); }}
    />
  );
}
