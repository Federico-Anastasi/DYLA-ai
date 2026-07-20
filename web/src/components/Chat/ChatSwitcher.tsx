// Chat selector in the panel header: the active chat plus a dropdown with the others (title,
// tokens, date), create, inline rename, delete. It lives here rather than in the ProjectView header
// because it is a concept of the single conversation, not of the project — the project's TOTAL
// cost and tokens stay in the ProjectView header (see ProjectView.tsx).
import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../../store/chatStore";
import type { ChatMeta } from "../../types";
import { formatTokens, totalTokens } from "../../lib/tokens";
import { Icon } from "../icons";
import ConfirmButton from "../Viewer/ConfirmButton";

const DEFAULT_CHAT_ID = "c1";

export default function ChatSwitcher({ project }: { project: string }) {
  const chats = useChatStore((s) => s.chats[project]) ?? [];
  const activeChatId = useChatStore((s) => s.activeChatId[project]) ?? DEFAULT_CHAT_ID;
  const selectChat = useChatStore((s) => s.selectChat);
  const newChat = useChatStore((s) => s.newChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const removeChat = useChatStore((s) => s.removeChat);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = chats.find((c) => c.id === activeChatId);

  // The header shows what the conversation weighs now, not the running total: on a local
  // model the question you actually have is "how much room is left", and the cumulative
  // counter answers a different one — it keeps growing by the size of the whole prompt
  // every turn, so it passes the context window long before the chat is anywhere near
  // full. The total is still there, one click away, in the menu below.
  const used = active?.context_tokens ?? 0;
  const limit = useChatStore((s) => s.model?.context) ?? null;
  const share = limit ? used / limit : 0;
  const label = limit ? `${formatTokens(used)} / ${formatTokens(limit)}` : `${formatTokens(used)} tok`;

  const startRename = (c: ChatMeta) => {
    setEditingId(c.id);
    setDraft(c.title);
  };
  const commitRename = (id: string) => {
    const t = draft.trim();
    setEditingId(null);
    if (t) renameChat(project, id, t);
  };

  return (
    <div className="chat-switcher" ref={boxRef}>
      <button type="button" className="chat-switcher-btn" onClick={() => setOpen((v) => !v)} title="switch chat">
        <span className="chat-switcher-title">{active?.title ?? "Chat"}</span>
        <span
          className={`chat-switcher-tokens${share >= 0.8 ? " full" : ""}`}
          title={limit
            ? `Context used by this conversation, out of the ${formatTokens(limit)} the engine was loaded with`
            : "Size of the last prompt in this conversation"}
        >
          {label}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="chat-switcher-menu">
          {chats.map((c) => (
            <div key={c.id} className={`chat-switcher-item ${c.id === activeChatId ? "active" : ""}`}>
              {editingId === c.id ? (
                <input
                  autoFocus
                  className="chat-switcher-item-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(c.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={() => commitRename(c.id)}
                />
              ) : (
                <button
                  type="button"
                  className="chat-switcher-item-main"
                  onClick={() => {
                    selectChat(project, c.id);
                    setOpen(false);
                  }}
                >
                  <span className="chat-switcher-item-title">{c.title}</span>
                  <span className="chat-switcher-item-meta">
                    {formatTokens(totalTokens(c.tokens))} tokens in total · ${c.cost_usd.toFixed(2)} · {new Date(c.last_ts * 1000).toLocaleDateString()}
                  </span>
                </button>
              )}
              {editingId !== c.id && (
                <button type="button" className="mini-btn" title="rename" onClick={() => startRename(c)}>
                  <Icon name="pencil" size={12} />
                </button>
              )}
              {chats.length > 1 && (
                <ConfirmButton
                  label="delete"
                  confirmLabel="confirm"
                  icon="trash-2"
                  iconSize={12}
                  className="mini-btn danger"
                  onConfirm={() => removeChat(project, c.id)}
                />
              )}
            </div>
          ))}
          <button
            type="button"
            className="chat-switcher-new"
            onClick={() => {
              newChat(project);
              setOpen(false);
            }}
          >
            <Icon name="plus" size={12} /> new chat
          </button>
        </div>
      )}
    </div>
  );
}
