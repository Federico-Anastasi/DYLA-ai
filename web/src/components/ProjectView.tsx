import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api/client";
import { useProjectPanel } from "../hooks/useProjectPanel";
import { OUTPUT_DOCS, labelForDoc, pickAutoOpenDoc } from "../lib/documentTabs";
import { slugify } from "../lib/slug";
import { useToastStore } from "../store/toastStore";
import { previewHow } from "./Viewer/viewerTypes";
import type { ViewerDoc } from "./Viewer/viewerTypes";
import { formatTokens, totalTokens } from "../lib/tokens";
import { useChatStore } from "../store/chatStore";
import { GLOBAL_CHAT } from "../types";
import type { DocKind } from "../types";
import { Icon } from "./icons";
import ChatPanel from "./Chat/ChatPanel";
import ChatSwitcher from "./Chat/ChatSwitcher";
import DocumentTabsBar from "./Viewer/DocumentTabsBar";
import DocumentViewer from "./Viewer/DocumentViewer";
import type { Selection } from "./Viewer/viewerTypes";

const DEFAULT_CHAT_ID = "c1";

const CHAT_COLLAPSED_KEY = "dyla.chatCollapsed";
const CHAT_PCT_KEY = "dyla.chatPct";
const CHAT_PCT_MIN = 20;
const CHAT_PCT_MAX = 45;
const CHAT_PCT_DEFAULT = 30;

function readChatPct(): number {
  const raw = Number(localStorage.getItem(CHAT_PCT_KEY));
  if (!raw || Number.isNaN(raw)) return CHAT_PCT_DEFAULT;
  return Math.min(CHAT_PCT_MAX, Math.max(CHAT_PCT_MIN, raw));
}

// Workspace: the document bar on top (input/output tabs), the viewer taking the middle ~70% (the
// actual workbench: editing, anchors, mockups, ER diagrams), and the chat on the right at ~30%,
// resizable and collapsible to a strip. 'selection' lives here rather than inside DocumentViewer
// because both the tab bar and the end-of-turn auto-open mechanism need to read and write it.
export default function ProjectView({ name }: { name: string }) {
  const meta = useChatStore((s) => s.projectMeta[name]);
  const chatId = useChatStore((s) => s.activeChatId[name]) ?? DEFAULT_CHAT_ID;
  const activeChat = useChatStore((s) => (s.chats[name] ?? []).find((c) => c.id === chatId));
  const entry = useChatStore((s) => s.entries[`${name}::${chatId}`]);
  const clearChangedDocs = useChatStore((s) => s.clearChangedDocs);
  const isProject = name !== GLOBAL_CHAT;

  const tick = meta?.filesTick ?? 0;
  const { files, versions, workflow, source, docStatuses, refresh } = useProjectPanel(name, tick, isProject);

  const [selection, setSelection] = useState<Selection>(null);
  const [currentDirty, setCurrentDirty] = useState(false);
  const [highlighted, setHighlighted] = useState<Set<DocKind>>(new Set());

  const [chatCollapsed, setChatCollapsed] = useState(() => localStorage.getItem(CHAT_COLLAPSED_KEY) === "1");
  const [chatPct, setChatPct] = useState(readChatPct);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(CHAT_COLLAPSED_KEY, chatCollapsed ? "1" : "0");
  }, [chatCollapsed]);
  useEffect(() => {
    localStorage.setItem(CHAT_PCT_KEY, String(chatPct));
  }, [chatPct]);

  // A document that has just been opened or closed always starts "clean": the dirty flag belongs to
  // the view currently mounted in DocumentViewer, and must not be carried across a selection change.
  useEffect(() => {
    setCurrentDirty(false);
  }, [selection]);

  // The heart of the flow: at the end of a turn (a result event on the WS) chatStore diffs the
  // output JSON documents before and after, and puts the created/modified ones in changedDocs. If
  // the user is not editing another document with unsaved changes we open it straight away;
  // otherwise we only highlight the tab, so they can open it whenever they want without losing what
  // they were writing.
  useEffect(() => {
    const changed = meta?.changedDocs ?? [];
    if (!isProject || !changed.length) return;
    const target = pickAutoOpenDoc(changed);
    const blockedByDirty = currentDirty && selection?.kind === "doc";
    if (target && !blockedByDirty) {
      const label = OUTPUT_DOCS.find((d) => d.doc === target)?.label ?? target;
      setSelection({ kind: "doc", doc: target, label });
      setHighlighted(new Set());
    } else {
      setHighlighted((h) => new Set([...h, ...changed]));
    }
    clearChangedDocs(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.changedDocs]);

  const selectAndClear = (s: Selection) => {
    if (s?.kind === "doc" && highlighted.has(s.doc)) {
      setHighlighted((h) => {
        const n = new Set(h);
        n.delete(s.doc);
        return n;
      });
    }
    setSelection(s);
  };

  // A citation clicked in the chat ([[brief:Chapter]]): opens the cited document and takes us to
  // the spot. It is the anchor in reverse — the existing one goes from the UI to the chat, this one
  // from the chat to the UI.
  const handleCite = async (doc: string, target: string) => {
    if (doc !== "brief") {
      // The other documents have no internal anchors: opening them at the right spot is not
      // possible, but opening them at all still beats ignoring the click.
      const known = OUTPUT_DOCS.find((d) => d.doc === doc);
      if (known && workflow?.[known.workflowKey]) {
        selectAndClear({ kind: "doc", doc: known.doc as ViewerDoc, label: labelForDoc(known.doc) });
      }
      return;
    }
    try {
      const info = await apiClient.getBrief(name);
      const wanted = slugify(target);
      // Exact match on the slug first, otherwise the first chapter whose title contains the cited
      // text: the agent cites a chapter the way it reads, not the way it slugifies.
      const hit =
        info.headings.find((h) => h.slug === wanted) ??
        info.headings.find((h) => slugify(h.title).includes(wanted) || wanted.includes(slugify(h.title)));
      if (info.kind === "doc") {
        selectAndClear({ kind: "doc", doc: "brief", label: "Brief", anchor: hit?.slug ?? wanted });
        return;
      }
      if (!info.file) {
        useToastStore.getState().push("This project has no brief yet", "error");
        return;
      }
      // In a PDF the only navigable anchor is the page: the slug does not exist in the viewer.
      const isPdf = info.file.toLowerCase().endsWith(".pdf");
      const anchor = isPdf ? (hit?.page ? `page=${hit.page}` : undefined) : (hit?.slug ?? wanted);
      selectAndClear({
        kind: "file",
        file: info.file,
        how: previewHow(info.file),
        label: "Project brief",
        anchor,
      });
      if (!hit) useToastStore.getState().push(`"${target}" not found in the brief: opening the document`);
    } catch {
      useToastStore.getState().push("Could not open the brief", "error");
    }
  };

  const onDividerDown = () => {
    setDragging(true);
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = ((rect.right - e.clientX) / rect.width) * 100;
      setChatPct(Math.min(CHAT_PCT_MAX, Math.max(CHAT_PCT_MIN, next)));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const chatBadge = !!entry?.busy || !!entry?.hasNews;

  return (
    <div id="project-view">
      <header>
        <h1>{isProject ? name : "Quick chat"}</h1>
        {!!meta?.costUsd && (
          <span className="muted">
            total cost ${meta.costUsd.toFixed(2)} · {formatTokens(totalTokens(meta.tokens))} project tokens
            {isProject && activeChat && <> · {formatTokens(totalTokens(activeChat.tokens))} tokens in the active chat</>}
          </span>
        )}
      </header>

      {isProject && (
        <DocumentTabsBar
          project={name}
          source={source}
          files={files}
          workflow={workflow}
          docStatuses={docStatuses}
          highlighted={highlighted}
          selection={selection}
          tick={tick}
          onSelect={selectAndClear}
          onRefresh={refresh}
        />
      )}

      {isProject ? (
        <div className="workspace-row" ref={containerRef}>
          <div className="workspace-viewer">
            <DocumentViewer
              project={name}
              selection={selection}
              onSelect={selectAndClear}
              tick={tick}
              versions={versions}
              onSaved={refresh}
              onDirtyChange={setCurrentDirty}
            />
          </div>

          {!chatCollapsed && <div className={`workspace-divider ${dragging ? "dragging" : ""}`} onMouseDown={onDividerDown} />}

          <div className={`workspace-chat ${chatCollapsed ? "collapsed" : ""}`} style={chatCollapsed ? undefined : { flexBasis: `${chatPct}%` }}>
            {chatCollapsed ? (
              <button type="button" className="chat-collapsed-strip" onClick={() => setChatCollapsed(false)} title="open chat">
                <Icon name="chevrons-left" size={16} />
                <span className="chat-collapsed-label">Chat</span>
                {chatBadge && <span className="chat-collapsed-badge" />}
              </button>
            ) : (
              <>
                <div className="workspace-chat-head">
                  <ChatSwitcher project={name} />
                  <button type="button" className="mini-btn" onClick={() => setChatCollapsed(true)} title="collapse chat">
                    <Icon name="chevrons-right" size={13} />
                  </button>
                </div>
                <ChatPanel name={name} onCite={handleCite} />
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="split-container">
          <div className="split-pane" style={{ flex: "1 1 100%" }}>
            <ChatPanel name={name} />
          </div>
        </div>
      )}
    </div>
  );
}
