import { useEffect, useRef } from "react";
import { useChatStore } from "../../store/chatStore";
import { Icon } from "../icons";
import ChatInput from "./ChatInput";
import Message from "./Message";
import type { CiteHandler } from "./Markdown";

const DEFAULT_CHAT_ID = "c1";

export default function ChatPanel({ name, onCite }: { name: string; onCite?: CiteHandler }) {
  const chatId = useChatStore((s) => s.activeChatId[name]) ?? DEFAULT_CHAT_ID;
  const entry = useChatStore((s) => s.entries[`${name}::${chatId}`]) ?? { busy: false, turns: [], statusText: "" };
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const stopTurn = useChatStore((s) => s.stopTurn);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [entry.turns, entry.busy]);

  return (
    <section id="chat">
      <div id="messages" ref={boxRef}>
        {entry.turns.length === 0 && (
          <div className="empty-chat-hint">No messages yet. Write below to get started.</div>
        )}
        {entry.turns.map((turn, i) => (
          <Message
            key={i}
            turn={turn}
            onSubmitAnswers={(answers) => sendPrompt(name, answers)}
            onCite={onCite}
          />
        ))}
      </div>
      <div id="chat-status" className={entry.busy ? "" : "hidden"}>
        <span><span className="spinner" />{entry.statusText || "working…"}</span>
        <a className="mini-btn" onClick={() => stopTurn(name)}><Icon name="stop-circle" size={12} /> stop</a>
      </div>
      <ChatInput busy={entry.busy} onSend={(text) => sendPrompt(name, text)} />
    </section>
  );
}
