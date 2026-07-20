import { useRef, useState } from "react";

export default function ChatInput({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(() => { if (ref.current) ref.current.style.height = "auto"; });
  };

  return (
    <form
      id="chat-form"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <textarea
        id="chat-input"
        ref={ref}
        rows={2}
        placeholder="Write… (Enter to send, Shift+Enter for a new line)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="submit" id="send-btn" disabled={busy}>Send</button>
    </form>
  );
}
