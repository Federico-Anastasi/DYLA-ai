// Global store: projects, model state and chats (with background turns — a chat's WS
// connection stays open even when the user navigates elsewhere; at the end of a turn, badge
// plus notification).
//
// Multi-chat per project: every project has N independent chats (see
// server/session_manager.py). Conversation entries (turns/busy/statusText) are therefore kept
// per (project, chat_id) under a composite `chatKey`; whatever belongs to the project rather
// than to a specific chat (total cost/tokens, the output docs that changed) lives in
// `projectMeta`, keyed by project alone. The "active" chat_id per project is held in
// `activeChatId`: most actions (sendPrompt, stopTurn, the anchors coming from the viewer...)
// resolve it from there, so callers can keep passing just the project name without knowing
// which chat is open.
import { create } from "zustand";
import { apiClient, ApiError } from "../api/client";
import { GLOBAL_CHAT } from "../types";
import type { Anchor, AssistantTurn, ChatMeta, ChatTokens, DocKind, ModelInfo, ProjectSummary, Segment, Turn, WsEvent } from "../types";
import { toolText } from "../lib/toolLabels";
import { diffChangedDocs, OUTPUT_DOCS, type DocSnapshot } from "../lib/documentTabs";
import { useToastStore } from "./toastStore";

// A project's first chat: an id the backend can predict (whether migrated or brand new), used
// here as the fallback until the chat registry has been loaded from the server.
const DEFAULT_CHAT_ID = "c1";

const chatKey = (project: string, chatId: string) => `${project}::${chatId}`;

export type ChatEntry = {
  busy: boolean;
  hasNews: boolean;
  turns: Turn[];
  historyLoaded: boolean;
  statusText: string;
};

function emptyEntry(): ChatEntry {
  return { busy: false, hasNews: false, turns: [], historyLoaded: false, statusText: "" };
}

function emptyTokens(): ChatTokens {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
}

export type ProjectMeta = {
  costUsd: number;
  tokens: ChatTokens;
  filesTick: number; // bumped at the end of a turn: the signal to reload files/versions/workflow
  changedDocs: DocKind[]; // output docs created/modified in the last turn (drives auto-open in the viewer)
  hasNews: boolean; // project-level aggregate: a turn finished on a chat that is not the active one
};

function emptyMeta(): ProjectMeta {
  return { costUsd: 0, tokens: emptyTokens(), filesTick: 0, changedDocs: [], hasNews: false };
}

// Snapshot of the content of the output JSON docs, per project: taken before every turn and
// compared against the one taken at the end to work out which docs that turn created or
// modified (see sendPrompt/result in handleEvent). It lives outside the zustand store: it is
// an internal detail of the auto-open mechanism, not state that should re-render anything.
const docSnapshots = new Map<string, DocSnapshot>();

async function snapshotDocs(name: string): Promise<DocSnapshot> {
  const snap: DocSnapshot = {};
  await Promise.all(
    OUTPUT_DOCS.map(async ({ doc }) => {
      try {
        const d = await apiClient.getDoc(name, doc);
        snap[doc] = JSON.stringify(d);
      } catch {
        snap[doc] = null;
      }
    }),
  );
  return snap;
}

interface ChatStore {
  projects: ProjectSummary[];
  activeChat: string | null;
  activeChatId: Record<string, string>; // project -> currently selected chat_id
  chats: Record<string, ChatMeta[]>; // project -> chat registry (for the selector)
  entries: Record<string, ChatEntry>; // key: chatKey(project, chat_id)
  projectMeta: Record<string, ProjectMeta>;
  model: ModelInfo | null;

  refreshProjects: () => Promise<void>;
  refreshModel: () => Promise<void>;
  setModel: (profile: string) => Promise<void>;

  openChat: (name: string) => Promise<void>;
  loadChats: (name: string) => Promise<void>;
  selectChat: (name: string, chatId: string) => Promise<void>;
  newChat: (name: string, title?: string) => Promise<void>;
  renameChat: (name: string, chatId: string, title: string) => Promise<void>;
  removeChat: (name: string, chatId: string) => Promise<void>;

  loadHistory: (name: string) => Promise<void>;
  sendPrompt: (name: string, prompt: string, anchor?: Anchor | null) => Promise<void>;
  stopTurn: (name: string) => Promise<void>;
  entry: (name: string) => ChatEntry;
  meta: (name: string) => ProjectMeta;
  bumpFilesTick: (name: string) => void;
  clearChangedDocs: (name: string) => void;
}

const sockets = new Map<string, WebSocket>();

function currentChatId(get: () => ChatStore, name: string): string {
  return get().activeChatId[name] ?? DEFAULT_CHAT_ID;
}

function ensureSocket(
  name: string,
  chatId: string,
  get: () => ChatStore,
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
): Promise<WebSocket> {
  const key = chatKey(name, chatId);
  const existing = sockets.get(key);
  if (existing && existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(name)}/${encodeURIComponent(chatId)}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("chat connection failed"));
    ws.onmessage = (evt) => handleEvent(name, chatId, JSON.parse(evt.data), get, set);
    ws.onclose = () => {
      sockets.delete(key);
      updateEntry(key, set, (e) => {
        // A socket closing mid-turn means the backend died halfway through. Without this
        // branch the user only saw the spinner stop on an empty bubble, with no clue that
        // anything had gone wrong.
        if (!e.busy) return { ...e, busy: false };
        const turns = e.turns.slice();
        const turn = lastAssistantTurn(turns);
        if (turn) {
          turns[turns.length - 1] = {
            ...turn,
            is_error: true,
            errorMessage:
              turn.errorMessage ??
              "The connection to the agent was lost. Check the server window and try again.",
          };
        }
        return { ...e, turns, busy: false, statusText: "" };
      });
    };
    sockets.set(key, ws);
  });
}

function updateEntry(
  key: string,
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  fn: (e: ChatEntry) => ChatEntry,
) {
  set((s) => {
    const cur = s.entries[key] || emptyEntry();
    return { entries: { ...s.entries, [key]: fn(cur) } };
  });
}

function updateMeta(
  name: string,
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  fn: (m: ProjectMeta) => ProjectMeta,
) {
  set((s) => {
    const cur = s.projectMeta[name] || emptyMeta();
    return { projectMeta: { ...s.projectMeta, [name]: fn(cur) } };
  });
}

function lastAssistantTurn(turns: Turn[]): AssistantTurn | null {
  const t = turns[turns.length - 1];
  return t && t.role === "assistant" ? t : null;
}

function chatName(name: string): string {
  return name === GLOBAL_CHAT ? "quick chat" : name;
}

function handleEvent(
  name: string,
  chatId: string,
  ev: WsEvent,
  get: () => ChatStore,
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
) {
  const key = chatKey(name, chatId);
  // "active" = both the project open in ProjectView AND this being the chat selected inside
  // it: a turn finishing on ANOTHER chat of the same project still counts as inactive (toast
  // plus badge).
  const isActive = get().activeChat === name && currentChatId(get, name) === chatId;

  if (ev.type === "delta") {
    updateEntry(key, set, (e) => {
      const turns = e.turns.slice();
      const turn = lastAssistantTurn(turns);
      if (!turn) return e;
      const segs = turn.segments.slice();
      const last = segs[segs.length - 1] as Segment | undefined;
      if (last && last.type === "text") segs[segs.length - 1] = { type: "text", text: last.text + ev.text };
      else segs.push({ type: "text", text: ev.text });
      turns[turns.length - 1] = { ...turn, segments: segs };
      return { ...e, turns };
    });
  } else if (ev.type === "tool_use") {
    updateEntry(key, set, (e) => {
      const turns = e.turns.slice();
      const turn = lastAssistantTurn(turns);
      if (turn) {
        const segs = turn.segments.slice();
        segs.push({ type: "tool", name: ev.name, input: ev.input });
        segs.push({ type: "text", text: "" });
        turns[turns.length - 1] = { ...turn, segments: segs };
      }
      return { ...e, turns, statusText: isActive ? toolText(ev.name, ev.input) + "…" : e.statusText };
    });
  } else if (ev.type === "result") {
    updateEntry(key, set, (e) => {
      const turns = e.turns.slice();
      const turn = lastAssistantTurn(turns);
      if (turn) {
        turns[turns.length - 1] = { ...turn, cost_usd: ev.cost_usd, duration_s: ev.duration_s };
      }
      if (!isActive) {
        useToastStore.getState().push(
          ev.is_error ? `Something went wrong on ${chatName(name)}` : `Work finished on ${chatName(name)}`,
          ev.is_error ? "error" : "ok",
        );
        notifyDone(name, !!ev.is_error);
      }
      return { ...e, turns, busy: false, statusText: "", hasNews: isActive ? e.hasNews : true };
    });
    updateMeta(name, set, (m) => ({
      ...m,
      costUsd: ev.project_cost_usd,
      tokens: ev.project_tokens,
      filesTick: m.filesTick + 1,
      hasNews: isActive ? m.hasNews : true,
    }));
    // Update the chat counters in the local registry (the selector): this avoids one extra
    // round trip just to reflect the tokens and cost this turn has already accumulated.
    set((s) => ({
      chats: {
        ...s.chats,
        [name]: (s.chats[name] || []).map((c) =>
          c.id === chatId
            ? { ...c, tokens: ev.chat_tokens, context_tokens: ev.chat_context_tokens,
                cost_usd: ev.chat_cost_usd, last_ts: Date.now() / 1000 }
            : c,
        ),
      },
    }));
    if (name !== GLOBAL_CHAT) {
      const before = docSnapshots.get(name) ?? {};
      snapshotDocs(name)
        .then((after) => {
          docSnapshots.set(name, after);
          const changed = diffChangedDocs(before, after);
          if (changed.length) updateMeta(name, set, (m) => ({ ...m, changedDocs: changed }));
        })
        .catch(() => {
          /* if the refetch fails, no auto-open for this turn — not critical */
        });
    }
  } else if (ev.type === "error") {
    updateEntry(key, set, (e) => {
      const turns = e.turns.slice();
      const turn = lastAssistantTurn(turns);
      if (turn) turns[turns.length - 1] = { ...turn, is_error: true, errorMessage: ev.message };
      return { ...e, turns, busy: false, statusText: "" };
    });
  }
}

function notifyDone(name: string, isError: boolean) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    new Notification("Dyla", {
      body: isError
        ? `Something went wrong on ${chatName(name)}`
        : `Work finished on ${chatName(name)}`,
    });
  }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  projects: [],
  activeChat: null,
  activeChatId: {},
  chats: {},
  entries: {},
  projectMeta: {},
  model: null,

  entry: (name) => get().entries[chatKey(name, currentChatId(get, name))] || emptyEntry(),
  meta: (name) => get().projectMeta[name] || emptyMeta(),

  refreshProjects: async () => {
    try {
      const projects = await apiClient.listProjects();
      set({ projects });
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not load the projects", "error");
    }
  },

  refreshModel: async () => {
    try {
      const model = await apiClient.getModel();
      set({ model });
    } catch {
      /* engine unreachable: do not block the app */
    }
  },

  setModel: async (profile) => {
    try {
      await apiClient.setModel(profile);
      useToastStore.getState().push("Model updated");
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not switch model", "error");
    }
    await get().refreshModel();
  },

  openChat: async (name) => {
    set({ activeChat: name });
    // The quick chat (_global) does not expose the selector yet: it always stays on the first
    // chat, so there is no need to load the registry.
    if (name !== GLOBAL_CHAT && !get().chats[name]) {
      await get().loadChats(name);
    }
    const chatId = currentChatId(get, name);
    const key = chatKey(name, chatId);
    const cur = get().entries[key];
    const needsReload = !cur?.historyLoaded || cur?.hasNews; // a turn finished while we were away: resync
    updateEntry(key, set, (e) => ({ ...e, hasNews: false }));
    updateMeta(name, set, (m) => ({ ...m, hasNews: false }));
    if (needsReload) {
      await get().loadHistory(name);
    }
  },

  loadChats: async (name) => {
    try {
      const res = await apiClient.listChats(name);
      set((s) => ({
        chats: { ...s.chats, [name]: res.chats },
        // do not overwrite a local selection the user already made in this UI session
        activeChatId: { ...s.activeChatId, [name]: s.activeChatId[name] ?? res.active },
      }));
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not load the chats", "error");
    }
  },

  selectChat: async (name, chatId) => {
    set((s) => ({ activeChatId: { ...s.activeChatId, [name]: chatId } }));
    const key = chatKey(name, chatId);
    updateEntry(key, set, (e) => ({ ...e, hasNews: false }));
    if (!get().entries[key]?.historyLoaded) {
      await get().loadHistory(name);
    }
    try {
      await apiClient.activateChat(name, chatId); // best-effort persistence of "which chat do I reopen"
    } catch {
      /* does not block the switch in the UI */
    }
  },

  newChat: async (name, title) => {
    try {
      const chat = await apiClient.createChat(name, title);
      await get().loadChats(name);
      set((s) => ({ activeChatId: { ...s.activeChatId, [name]: chat.id } }));
      await get().loadHistory(name); // empty history: clears any stale entry on the same key
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not create the chat", "error");
    }
  },

  renameChat: async (name, chatId, title) => {
    const t = title.trim();
    if (!t) return;
    try {
      await apiClient.renameChat(name, chatId, t);
      set((s) => ({
        chats: { ...s.chats, [name]: (s.chats[name] || []).map((c) => (c.id === chatId ? { ...c, title: t } : c)) },
      }));
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not rename the chat", "error");
    }
  },

  removeChat: async (name, chatId) => {
    try {
      await apiClient.deleteChat(name, chatId);
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not delete the chat", "error");
      return;
    }
    const key = chatKey(name, chatId);
    set((s) => {
      const entries = { ...s.entries };
      delete entries[key];
      return { entries };
    });
    try {
      // When it deletes the active chat the backend already picks another one: we reread the
      // registry to fall in line with its choice instead of guessing it on the client.
      const res = await apiClient.listChats(name);
      set((s) => ({ chats: { ...s.chats, [name]: res.chats }, activeChatId: { ...s.activeChatId, [name]: res.active } }));
      await get().loadHistory(name);
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not reload the chats", "error");
    }
  },

  loadHistory: async (name) => {
    const chatId = currentChatId(get, name);
    const key = chatKey(name, chatId);
    try {
      const h = await apiClient.getHistory(name, chatId);
      updateEntry(key, set, (e) => ({ ...e, turns: h.turns, historyLoaded: true }));
      updateMeta(name, set, (m) => ({ ...m, costUsd: h.cost_usd }));
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not load the history", "error");
    }
  },

  sendPrompt: async (name, prompt, anchor) => {
    const text = prompt.trim();
    if (!text) return;
    const chatId = currentChatId(get, name);
    const key = chatKey(name, chatId);
    const cur = get().entries[key] || emptyEntry();
    if (cur.busy) return;

    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }

    updateEntry(key, set, (e) => ({
      ...e,
      busy: true,
      statusText: "",
      turns: [
        ...e.turns,
        { role: "user", text, anchor: anchor ?? null, ts: Date.now() / 1000 },
        { role: "assistant", segments: [{ type: "text", text: "" }] },
      ],
    }));

    let ws: WebSocket;
    try {
      ws = await ensureSocket(name, chatId, get, set);
    } catch (e) {
      updateEntry(key, set, (en) => {
        const turns = en.turns.slice();
        const turn = lastAssistantTurn(turns);
        if (turn) turns[turns.length - 1] = { ...turn, is_error: true, errorMessage: e instanceof Error ? e.message : "error" };
        return { ...en, turns, busy: false };
      });
      return;
    }

    // Pre-turn snapshot of the output docs: compared at the end of the turn (result event) to
    // work out which ones were created or modified and drive the auto-open in the viewer. It
    // has to be taken BEFORE sending the prompt (and awaited) so a very fast result cannot
    // land before the snapshot and fall outside the comparison.
    if (name !== GLOBAL_CHAT) {
      try {
        docSnapshots.set(name, await snapshotDocs(name));
      } catch {
        /* does not block the send */
      }
    }

    ws.send(JSON.stringify(anchor ? { prompt: text, anchor } : { prompt: text }));
  },

  stopTurn: async (name) => {
    try {
      await apiClient.interrupt(name, currentChatId(get, name));
    } catch (e) {
      if (!(e instanceof ApiError)) useToastStore.getState().push("Could not stop the turn", "error");
    }
  },

  bumpFilesTick: (name) => updateMeta(name, set, (m) => ({ ...m, filesTick: m.filesTick + 1 })),

  clearChangedDocs: (name) => updateMeta(name, set, (m) => (m.changedDocs.length ? { ...m, changedDocs: [] } : m)),
}));
