// Minimal REST client — same origin (/api/*), no CDN, no external dependency.
import type {
  AgendaDoc,
  AgendaItem,
  BriefDoc,
  BriefInfo,
  ChatMeta,
  ChatsResponse,
  DataModelDoc,
  DeckDoc,
  DictationResult,
  DocKind,
  EngineMetrics,
  EstimateDoc,
  HistoryResponse,
  ModelCatalog,
  ModelEntry,
  ModelInfo,
  MockupDoc,
  PeopleDoc,
  ProjectDetail,
  ProjectDocument,
  ProjectSource,
  ProjectSummary,
  ProposedAgendaItem,
  QuestionsDoc,
  TestPlanDoc,
  TimelineDoc,
  TranscriptionJob,
} from "../types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api${path}`, opts);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const body = await r.json();
      detail = body?.detail ?? detail;
    } catch {
      /* response without a json body */
    }
    throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), r.status);
  }
  if (r.status === 204) return undefined as unknown as T;
  return r.json();
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const fileUrl = (project: string, file: string, dl = false) =>
  `/api/projects/${encodeURIComponent(project)}/files/${file}${dl ? "?dl=1" : ""}`;

export const previewUrl = (project: string, file: string) =>
  `/api/projects/${encodeURIComponent(project)}/preview/${file}`;

// inline=true is what the iframe previews need: without it the backend sends the export as an
// attachment and the browser downloads it instead of showing it.
export const exportUrl = (project: string, artifact: string, inline = false) =>
  `/api/projects/${encodeURIComponent(project)}/export/${artifact}${inline ? "?inline=1" : ""}`;

export const apiClient = {
  listProjects: () => api<ProjectSummary[]>("/projects"),

  createProject: (
    name: string,
    client: string,
    description?: string | null,
    source: ProjectSource = "brief",
  ) => api<{ ok?: boolean }>("/projects", json({ name, client, description, source })),

  getProject: (name: string) => api<ProjectDetail>(`/projects/${encodeURIComponent(name)}`),

  /** Uploads one or more documents. The backend produces the text extract of binary files
   * (pdf, docx, xlsx, pptx): that is what the agent reads and cites. */
  uploadDocuments: async (name: string, files: File[], target: "brief" | "docs" | "meetings") => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const r = await fetch(
      `/api/projects/${encodeURIComponent(name)}/documents?target=${target}`,
      { method: "POST", body: fd },
    );
    if (!r.ok) throw new ApiError(r.statusText, r.status);
  },

  deleteDocument: (name: string, file: string) =>
    api<{ removed: string }>(
      `/projects/${encodeURIComponent(name)}/documents/${file}`,
      { method: "DELETE" },
    ),

  listDocuments: (name: string) =>
    api<ProjectDocument[]>(`/projects/${encodeURIComponent(name)}/documents`),

  /** Queues the transcription of a recording. It returns immediately: the real work takes tens
   * of minutes and is followed with `listTranscriptions`. */
  startTranscription: async (
    name: string, audio: File, title: string, date: string,
  ): Promise<TranscriptionJob> => {
    const fd = new FormData();
    fd.append("audio", audio, audio.name);
    fd.append("title", title);
    fd.append("date", date);
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}/transcriptions`,
      { method: "POST", body: fd });
    if (!r.ok) {
      let detail = r.statusText;
      try { detail = (await r.json())?.detail ?? detail; } catch { /* no body */ }
      throw new ApiError(detail, r.status);
    }
    return r.json();
  },

  listTranscriptions: (name: string) =>
    api<{ jobs: TranscriptionJob[]; model: string }>(
      `/projects/${encodeURIComponent(name)}/transcriptions`),

  cancelTranscription: (name: string, id: string) =>
    api<TranscriptionJob>(
      `/projects/${encodeURIComponent(name)}/transcriptions/${id}/cancel`, { method: "POST" }),

  /** Proofreading done: the audio is no longer needed and gets deleted. */
  confirmTranscription: (name: string, id: string) =>
    api<TranscriptionJob>(
      `/projects/${encodeURIComponent(name)}/transcriptions/${id}/confirm`, { method: "POST" }),

  /** Throws away both the audio and the transcript it produced. */
  discardTranscription: (name: string, id: string) =>
    api<{ removed: string }>(
      `/projects/${encodeURIComponent(name)}/transcriptions/${id}`, { method: "DELETE" }),

  /** State of the brief and its citable chapters — the source of the clickable citations in chat. */
  getBrief: (name: string) => api<BriefInfo>(`/projects/${encodeURIComponent(name)}/brief`),

  listFiles: (name: string) => api<string[]>(`/projects/${encodeURIComponent(name)}/files`),

  listVersions: (name: string) =>
    api<Record<string, { v: number; file: string; ts: number }[]>>(
      `/projects/${encodeURIComponent(name)}/versions`,
    ),

  restore: (name: string, file: string, v: number) =>
    api<{ ok: boolean }>(`/projects/${encodeURIComponent(name)}/restore`, json({ file, v })),

  getDoc: <K extends DocKind>(name: string, kind: K) =>
    api<
      K extends "estimate"
        ? EstimateDoc
        : K extends "data_model"
          ? DataModelDoc
          : K extends "timeline"
            ? TimelineDoc
            : K extends "brief"
              ? BriefDoc
              : K extends "questions"
                ? QuestionsDoc
                : K extends "people"
                  ? PeopleDoc
                  : K extends "test_plan"
                    ? TestPlanDoc
                    : K extends "deck"
                      ? DeckDoc
                      : MockupDoc
    >(`/projects/${encodeURIComponent(name)}/doc/${kind}`),

  putDoc: (name: string, kind: DocKind, doc: unknown) =>
    api<{ ok: boolean }>(`/projects/${encodeURIComponent(name)}/doc/${kind}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    }),

  getHistory: (name: string, chatId: string) =>
    api<HistoryResponse>(`/chats/${encodeURIComponent(name)}/history?chat_id=${encodeURIComponent(chatId)}`),

  interrupt: (name: string, chatId: string) =>
    api<{ ok?: boolean }>(
      `/chats/${encodeURIComponent(name)}/interrupt?chat_id=${encodeURIComponent(chatId)}`,
      { method: "POST" },
    ),

  // --- chat registry (per-project multi-chat selector) ---

  listChats: (name: string) => api<ChatsResponse>(`/projects/${encodeURIComponent(name)}/chats`),

  createChat: (name: string, title?: string) =>
    api<ChatMeta>(`/projects/${encodeURIComponent(name)}/chats`, json(title ? { title } : {})),

  renameChat: (name: string, chatId: string, title: string) =>
    api<ChatMeta>(`/projects/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),

  activateChat: (name: string, chatId: string) =>
    api<ChatMeta>(`/projects/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    }),

  deleteChat: (name: string, chatId: string) =>
    api<{ ok: boolean }>(`/projects/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}`, {
      method: "DELETE",
    }),

  // --- personal agenda (does not belong to a project) ---

  getAgenda: () => api<AgendaDoc>("/agenda"),

  addAgendaItems: (items: ProposedAgendaItem[], source: "voice" | "manual" | "chat" = "manual") =>
    api<{ added: string[] }>("/agenda/items", json(items.map((i) => ({ ...i, source })))),

  /** Passing null on an optional field removes it (e.g. clearing the date). */
  patchAgendaItem: (id: string, patch: Partial<AgendaItem> | Record<string, unknown>) =>
    api<AgendaItem>(`/agenda/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),

  deleteAgendaItem: (id: string) =>
    api<{ removed: string }>(`/agenda/items/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Audio (or text) → PROPOSED items, not saved yet: the user reviews them and confirms with
   * addAgendaItems. The transcription runs locally on CPU. */
  dictate: async (audio: Blob): Promise<DictationResult> => {
    const fd = new FormData();
    fd.append("audio", audio, "note.webm");
    const r = await fetch("/api/agenda/dictation", { method: "POST", body: fd });
    if (!r.ok) {
      let detail = r.statusText;
      try {
        detail = (await r.json())?.detail ?? detail;
      } catch {
        /* response without a json body */
      }
      throw new ApiError(typeof detail === "string" ? detail : r.statusText, r.status);
    }
    return r.json();
  },

  dictateText: (text: string) => api<DictationResult>("/agenda/parse", json({ text })),

  getModel: () => api<ModelInfo>("/model"),

  /** Everything the settings panel needs: what we suggest, what is already on disk,
   * what the user added, and what this machine can run models on. */
  listModels: () => api<ModelCatalog>("/models"),

  /** Fetches a suggested model. Gigabytes, so it is always an explicit choice. */
  downloadModel: (id: string) =>
    api<{ downloaded: string }>(`/models/${encodeURIComponent(id)}/download`, { method: "POST" }),

  chooseModel: (id: string) =>
    api<{ active: string; path: string }>("/models/active", { ...json({ id }), method: "PUT" }),

  addModel: (path: string, label?: string) =>
    api<ModelEntry>("/models/added", json({ path, label })),

  /** Forgets a model added by hand. The file itself stays where it is. */
  forgetModel: (id: string) =>
    api<{ removed: string }>(`/models/added/${id}`, { method: "DELETE" }),

  /** How much context the engine loads with. Takes effect when it next starts. */
  setContext: (size: number) =>
    api<{ context: number; restart_needed: boolean }>("/models/context",
      { ...json({ size }), method: "PUT" }),

  /** What the local engine is doing. {running: false} when there is nothing to show. */
  engineMetrics: () => api<EngineMetrics>("/engine/metrics"),

  getPreferences: () => api<{ language: string | null }>("/preferences"),

  /** The language the agent answers in. Empty clears it: back to following the user. */
  setLanguage: (language: string) =>
    api<{ language: string | null }>("/preferences", { ...json({ language }), method: "PUT" }),

  /** Downloads the llama.cpp build for this platform. */
  installEngine: () =>
    api<{ installed: string; accelerator: string }>("/model/engine", { method: "POST" }),

  setModel: (profile: string) =>
    api<{ ok?: boolean }>("/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    }),
};
