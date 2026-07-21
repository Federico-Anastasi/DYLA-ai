// Shared types — they mirror the API contract (see CLAUDE.md) and the schemas in /schemas.

export const GLOBAL_CHAT = "_global";

// "brief" is true both when the brief is an input document (brief.pdf, brief.docx, brief.md)
// and when it is one we write ourselves (brief.json): the frontend only cares whether the
// project has one.
export type Workflow = {
  brief: boolean;
  "context.md": boolean;
  "estimate.json": boolean;
  "data_model.json": boolean;
  "mockup.json": boolean;
  [k: string]: boolean;
};

// Where the project comes from. "brief": the brief is handed to us and is a read-only input
// document. "discovery": we start from meeting transcripts and the brief is one of our own
// deliverables (brief.json, exportable to Word). See server/project_meta.py.
export type ProjectSource = "brief" | "discovery";

export type ProjectSummary = {
  name: string;
  workflow: Workflow;
  source?: ProjectSource;
  client?: string;
  // Epoch seconds of the most recently touched deliverable: the home page sorts on this, so
  // the projects being worked on stay at the top.
  modified?: number;
};

// An INPUT document with its metadata (source of the documents dropdown).
// "readable" = the agent can see its text, either directly or from the extract in .extracted/.
export type ProjectDocument = {
  file: string;
  name: string;
  kind: "brief" | "docs" | "meetings";
  ext: string;
  size: number;
  modified: number;
  readable: boolean;
  extracted: boolean;
};

// Transcription of a recorded meeting. It is long-running work (tens of minutes on CPU), so
// it is not a request but a job whose state you follow. "progress" is 0-1, measured against
// the minutes of audio already transcribed.
export type TranscriptionJob = {
  id: string;
  project: string;
  title: string;
  date: string;
  audio: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  file: string | null;
  error: string | null;
};

// A citable chapter of the brief. "page" is filled in only for PDFs (there the navigable
// anchor is #page=N, not the slug).
export type BriefHeading = {
  level: number;
  title: string;
  slug: string;
  id?: string;
  line: number | null;
  page: number | null;
};

export type BriefInfo = {
  source: ProjectSource;
  file: string | null;
  kind: "file" | "doc" | null;
  headings: BriefHeading[];
};

// Cumulative tokens (single chat or whole project) — 4 counters mirroring the SDK's
// ResultMessage.usage (input/output/cache_read/cache_write), summed turn by turn on the backend.
export type ChatTokens = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

export type ProjectDetail = ProjectSummary & {
  cost_usd?: number;
  tokens?: ChatTokens;
};

// Metadata of one chat in the project registry (.chats.json on the backend) — not the full
// history (that only arrives from /chats/{name}/history?chat_id=...), just what is needed to
// populate the selector: title, cumulative tokens/cost, when it was last used.
export type ChatMeta = {
  id: string;
  title: string;
  session_id: string | null;
  created_ts: number;
  last_ts: number;
  tokens: ChatTokens;
  // Size of the prompt on the last turn — what the conversation weighs now, which is
  // not what `tokens` says: those add up over every turn and count the same cached
  // prompt again each time. This is the one to compare with the context window.
  context_tokens?: number;
  cost_usd: number;
};

export type ChatsResponse = {
  chats: ChatMeta[];
  active: string;
};

export type Anchor = {
  file: string;
  ref: string;
  label: string;
};

export type ToolSegment = { type: "tool"; name: string; input: string };
export type TextSegment = { type: "text"; text: string };
export type Segment = TextSegment | ToolSegment;

export type UserTurn = {
  role: "user";
  text: string;
  anchor?: Anchor | null;
  ts?: number;
};

export type AssistantTurn = {
  role: "assistant";
  segments: Segment[];
  cost_usd?: number | null;
  duration_s?: number | null;
  ts?: number;
  is_error?: boolean;
  errorMessage?: string;
};

export type Turn = UserTurn | AssistantTurn;

export type HistoryResponse = {
  turns: Turn[];
  cost_usd: number;
  chat_id: string;
};

// One entry in the settings: a suggested model, one found in the models folder, or
// one the user added by path. `installed` is absent for the last two — they are on
// disk by definition.
export type ModelEntry = {
  id: string;
  label: string;
  path?: string;
  size_gb: number;
  origin: "suggested" | "found" | "added";
  repo?: string;
  quant?: string;
  needs_gb?: number;
  note?: string;
  installed?: boolean;
};

export type ModelCatalog = {
  suggested: ModelEntry[];
  found: ModelEntry[];
  added: ModelEntry[];
  active: string | null;
  models_dir: string;
  accelerator: string;
  engine_installed: boolean;
  // What there is to work with. The user needs it to choose a context size: the KV
  // cache is allocated up front and grows linearly with the context, so this is the
  // number that decides whether the engine starts at all.
  hardware: { vram_gb: number; ram_gb: number };
  context: number | null;
  context_choices: number[];
  recommended_context: number;
  // What to try first on this machine, worked out from the chosen model and the memory
  // that is actually here. Rough on purpose: it says where to start, not what will fit.
  context_advice: { try: number; fallback: number | null; tight: boolean; model: string } | null;
};

// What the local engine is doing right now. Everything past `running` is absent when the
// engine is off, and the rates can be null while it is working but has not produced a
// measurable delta yet — a missing number beats a stale one.
export type EngineMetrics = {
  running: boolean;
  busy?: boolean;
  generation_tps?: number | null;
  prefill_tps?: number | null;
  // False when the rates are the speed of the last finished request rather than a fresh
  // measurement — llama-server only moves its counters when a request completes, so this
  // is the normal case while a turn is running. Shown with a ~.
  rates_live?: boolean;
  tokens_generated?: number;
  tokens_prefilled?: number;
  context_used?: number | null;
  context_size?: number | null;
  context_peak?: number | null;
  queued?: number;
  // The chat the engine is holding in memory. Everything above about context belongs to
  // this one and to no other, and continuing here is the cheap move: its prompt is
  // already cached, any other chat pays for the whole thing again.
  holding?: { project: string; chat_id: string; title: string };
};

export type ModelInfo = {
  active: string;
  profiles: Record<string, string>;
  engine_running: boolean;
  accelerator: string;
  engine_installed: boolean;
  // The window the local engine was loaded with; null on the cloud profile.
  context: number | null;
};

// ---------- live documents ----------

// Granular sub-task of an estimate task (the breakdown for developers, generated by
// /dev-tasks). "id" is scoped to the parent task, e.g. "E2.T3.D1". If the task has a non-empty
// dev_tasks, task.days MUST be the sum of dev_tasks[].days (validated on the backend too, see
// server/documents.py::save_doc) — the hierarchy adds up from the bottom.
export type EstimateDevTask = {
  id: string;
  dev_task: string;
  description: string;
  days: number;
  owner?: string;
  // Technical layer (1-4): it orders the work on the project timeline. 1 = data model,
  // 2 = forms/screens, 3 = rules/processes/integrations, 4 = E2E tests. Sequential inside an
  // epic, parallel across different epics. Missing on documents generated before the field was
  // introduced: planning treats those as layer 3 (see lib/items.ts).
  layer?: 1 | 2 | 3 | 4;
  // Explicit dependency override, for the constraints the layer does not capture.
  depends_on?: string[];
};

export type EstimateTask = {
  id: string;
  task: string;
  days: number;
  description: string;
  dev_tasks: EstimateDevTask[];
};

export type EstimateE2E = { label: string; days: number } | null;

export type EstimateEpic = {
  id: string;
  name: string;
  tasks: EstimateTask[];
  e2e?: EstimateE2E;
};

// "status"/"dev_tasks_status" are optional: the backend schema adds them
// (meta.status: "draft"|"confirmed" for the estimate, meta.dev_tasks_status for the dev task
// breakdown — absent if the breakdown was never generated). They are read leniently
// (see lib/documentTabs.ts statusFromMeta) so pre-existing documents keep working.
export type EstimateMeta = {
  project: string;
  title: string;
  client?: string | null;
  date: string;
  contingency_pct: number;
  notes?: string | null;
  status?: "draft" | "confirmed";
  dev_tasks_status?: "draft" | "confirmed";
};

export type EstimateDoc = {
  meta: EstimateMeta;
  epics: EstimateEpic[];
};

export type DataModelField = {
  name: string;
  type: string;
  pk?: boolean;
  // A "table.column" reference — a string, not a boolean (mirrors schemas/data_model.schema.json).
  fk?: string;
  nullable?: boolean;
  notes?: string;
};

export type DataModelArea = { id: string; name: string; color: string };

// Manual position of the box on the editor canvas (dragged by the user). If absent, the editor
// computes an automatic layout. Never generated by the agent for new tables — see CLAUDE.md.
export type DataModelPos = { x: number; y: number };

export type DataModelTable = {
  id: string;
  name: string;
  area: string;
  fields: DataModelField[];
  pos?: DataModelPos;
};

export type DataModelRelation = {
  from: string;
  to: string;
  type: string;
  label?: string;
};

export type DataModelMeta = {
  project: string;
  title: string;
  date: string;
  status?: "draft" | "confirmed";
};

export type DataModelDoc = {
  meta: DataModelMeta;
  areas: DataModelArea[];
  tables: DataModelTable[];
  relations: DataModelRelation[];
};

// mockup.json: pages composed from a FIXED library of 18 component types (see
// schemas/mockup.schema.json and web/src/mockup-lib/index.ts). props is typed loosely
// (Record<string, unknown>): its exact shape depends on "type" and is interpreted at runtime in
// the registry under web/src/mockup-lib (used both by the MockupView preview and, mirroring it,
// by server/mockup_export.py on the backend for the HTML export).
export type MockupComponentType =
  | "topbar"
  | "nav"
  | "page-title"
  | "breadcrumb"
  | "kpi-row"
  | "grid"
  | "form"
  | "detail"
  | "actions"
  | "tabs"
  | "banner"
  | "wizard-steps"
  | "state-progress"
  | "filters"
  | "legend"
  | "statusbar"
  | "segmented"
  | "tiles"
  | "section"
  | "sidebar-nav"
  | (string & {});

export type MockupComponent = {
  id: string;
  type: MockupComponentType;
  props: Record<string, any>;
};

export type MockupPage = {
  id: string;
  name: string;
  // Absent or "page" = a normal page (navigable, listed in nav). "modal" = a dialog: not in nav,
  // it opens as an overlay when referenced as a target (see schemas/mockup.schema.json).
  kind?: "page" | "modal";
  components: MockupComponent[];
};

export type MockupMeta = {
  project: string;
  title: string;
  theme: "standard" | "compact" | "plain";
  date: string;
  status?: "draft" | "confirmed";
};

export type MockupDoc = {
  meta: MockupMeta;
  pages: MockupPage[];
};

// ---------- technical diagrams ----------
// diagram.json: architecture / workflow / dataflow / sequence diagrams (see
// schemas/diagram.schema.json). "class" is a semantic enum — it decides the node's shape and
// colour in DiagramView, never a literal colour stored in the JSON. "pos" is the manual
// position set by dragging on the canvas; absent means the node takes part in the client-side
// auto-layout (see lib/diagramLayout.ts-equivalent logic inside DiagramView) and is never
// written for a node the agent creates.

export type DiagramNodeClass =
  | "actor"
  | "frontend"
  | "backend"
  | "service"
  | "database"
  | "storage"
  | "queue"
  | "external"
  | "security"
  | "start"
  | "end"
  | "process"
  | "decision"
  | "document"
  | "manual";

export type DiagramPos = { x: number; y: number };

export type DiagramGroup = { id: string; label: string; parent?: string };

export type DiagramNode = {
  id: string;
  label: string;
  class: DiagramNodeClass;
  group?: string;
  desc?: string;
  pos?: DiagramPos;
};

export type DiagramEdgeStyle = "solid" | "dashed";

export type DiagramEdge = { from: string; to: string; label?: string; style?: DiagramEdgeStyle };

export type DiagramKind = "architecture" | "workflow" | "dataflow" | "sequence";

export type Diagram = {
  id: string;
  kind: DiagramKind;
  title: string;
  notes?: string;
  groups?: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

export type DiagramMeta = {
  project: string;
  title: string;
  date: string;
  status?: "draft" | "confirmed";
};

export type DiagramDoc = {
  meta: DiagramMeta;
  diagrams: Diagram[];
};

// ---------- social/graphic designs ----------
// design.json: graphic artefacts (social posts, stories, banners, slides) where the agent
// designs freely in HTML/CSS, one artboard per design at its exact pixel size (see
// schemas/design.schema.json). The backend (server/design_export.py) wraps, sanitises and
// sizes each artboard's `html` for the design.html export; DesignView never replicates the
// artboard itself — it only edits the HTML and previews the real export in an iframe.

export type DesignFormat = "ig-square" | "ig-portrait" | "ig-story" | "li-landscape" | "custom";

export type Design = {
  id: string;
  format: DesignFormat;
  width?: number;
  height?: number;
  title?: string;
  notes?: string;
  html: string;
};

export type DesignBrandColors = {
  primary: string;
  accent?: string;
  background: string;
  text: string;
};

export type DesignBrand = {
  name: string;
  handle?: string;
  colors: DesignBrandColors;
  voice?: string;
};

export type DesignMeta = {
  project: string;
  title: string;
  date: string;
  status?: "draft" | "confirmed";
};

export type DesignDoc = {
  meta: DesignMeta;
  brand: DesignBrand;
  designs: Design[];
};

// ---------- timeline ----------

// timeline.json holds the plan as ordered LANES per developer, plus the parameters (team,
// start, leave) and the progress state. Dates are not stored: they are recomputed from the
// lanes by filling each developer's capacity (see lib/lanes.ts), so the plan stays valid when
// the estimate changes.

export type TimelineLeave = { from: string; to: string; reason?: string };

export type TimelineDev = {
  id: string;
  name: string;
  leave?: TimelineLeave[];
};

export type TimelineHoliday = { date: string; name?: string };

// The plan: for each developer, the ordered row of items they will work on. The order is the
// execution order — dates are recomputed from it (see lib/lanes.ts).
export type TimelineLane = { dev: string; items: string[] };

// Progress is handled by hand. "todo" is the implicit default: only the items moved away from
// it appear in the document, so a freshly planned project carries no noise.
export type ItemStatus = "todo" | "wip" | "done";
export type TimelineItemState = { dev_task_id: string; status: ItemStatus };

export type TimelineMeta = {
  project: string;
  date: string;
  notes?: string;
  status?: "draft" | "confirmed";
};

export type TimelineDoc = {
  meta: TimelineMeta;
  start_date: string;
  team: TimelineDev[];
  holidays?: TimelineHoliday[];
  // The deadlines towards the client. They do not consume team capacity: they feed the status
  // report Gantt, and this is the only place where the project knows when it has to deliver.
  milestones?: TimelineMilestone[];
  lanes?: TimelineLane[];
  states?: TimelineItemState[];
};

// ---------- brief written by us (projects with source "discovery") ----------

export type BriefChapter = {
  id: string;
  title: string;
  level?: number;
  body: string;
  // The meetings and documents the content derives from: traceability is the reason a brief
  // generated from transcripts can be defended in front of the client.
  sources?: string[];
  open?: boolean;
};

export type BriefRequirement = {
  id: string;
  title: string;
  description: string;
  chapter?: string;
  priority?: "high" | "medium" | "low";
  status?: "proposed" | "validated" | "changed";
  source?: string;
};

export type BriefChangelogEntry = { date: string; source: string; summary: string };

export type BriefDoc = {
  meta: {
    project: string;
    title: string;
    client?: string | null;
    date: string;
    version?: number;
    notes?: string;
    status?: "draft" | "confirmed";
  };
  chapters: BriefChapter[];
  requirements?: BriefRequirement[];
  glossary?: { term: string; definition: string }[];
  changelog?: BriefChangelogEntry[];
};

// ---------- open questions for the client ----------

export type QuestionStatus = "open" | "asked" | "answered" | "closed";

export type Question = {
  id: string;
  question: string;
  area?: string;
  addressee?: string;
  source?: string;
  status: QuestionStatus;
  answer?: string;
  impact?: string;
  priority?: "high" | "medium" | "low";
  opened_at?: string;
  answered_at?: string;
};

export type QuestionsDoc = {
  meta: { project: string; date: string; notes?: string; status?: "draft" | "confirmed" };
  questions: Question[];
};

// ---------- project people ----------

export type Person = {
  id: string;
  name: string;
  role: string;
  organization: "client" | "us" | "third_party";
  area?: string;
  contact?: string;
  notes?: string;
};

export type PeopleDoc = {
  meta: { project: string; date: string; notes?: string; status?: "draft" | "confirmed" };
  people: Person[];
};

// ---------- test plan ----------

export type TestCaseOutcome = "to_run" | "ok" | "ko" | "blocked";

export type TestStep = { n: number; action: string; expected?: string };

export type TestCase = {
  id: string;
  title: string;
  epic: string;
  task?: string;
  area?: string;
  type?: "functional" | "integration" | "regression" | "negative";
  preconditions?: string;
  steps: TestStep[];
  expected_result?: string;
  outcome?: TestCaseOutcome;
  tester?: string;
  run_at?: string;
  notes?: string;
  brief_ref?: string;
};

export type TestPlanDoc = {
  meta: {
    project: string;
    title: string;
    client?: string;
    date: string;
    notes?: string;
    status?: "draft" | "confirmed";
  };
  cases: TestCase[];
};

// ---------- slide deck ----------

export type DeckSlideLayout =
  | "cover"
  | "list"
  | "table"
  | "timeline"
  | "kpi"
  | "text"
  | "image"
  | "section";

export type DeckSlide = {
  id: string;
  layout: DeckSlideLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  table?: { headers: string[]; rows: string[][] };
  kpi?: { label: string; value: string; note?: string }[];
  milestones?: {
    name: string;
    date?: string;
    status?: "planned" | "in_progress" | "completed" | "at_risk";
  }[];
  image?: string;
  speaker_notes?: string;
  // true = the slide is regenerated from the data (estimate, timeline) every time the deck is
  // updated. false/absent = written by hand and always preserved: that is what makes it possible
  // to regenerate a status deck every couple of weeks without losing risks and comments.
  auto?: boolean;
};

export type DeckDoc = {
  meta: {
    project: string;
    title: string;
    client: string;
    // Same theme set as the mockups: it drives the accent colour of the exported
    // PowerPoint and HTML.
    theme?: "standard" | "compact" | "plain";
    date: string;
    type: "kickoff" | "status" | "estimate" | "demo";
    period?: string;
    author?: string;
    notes?: string;
    status?: "draft" | "confirmed";
  };
  slides: DeckSlide[];
};

export type TimelineMilestone = {
  id: string;
  name: string;
  date: string;
  status?: "planned" | "in_progress" | "completed" | "at_risk";
  notes?: string;
};

// ---------- personal agenda (cuts across projects) ----------

export type AgendaItemStatus = "open" | "done";

export type AgendaItem = {
  id: string;
  text: string;
  // The projects the activity touches: empty for personal activities, more than one when the
  // activity really spans them. They can be free-form names.
  projects?: string[];
  due?: string;
  // Time of day, "HH:MM": it orders the day and records when something really has to
  // happen. People dictating never say a time, so the model proposes one and the user
  // corrects it. Meaningless without a date, so it never appears alone.
  time?: string;
  status: AgendaItemStatus;
  priority?: "high" | "medium" | "low";
  source?: "voice" | "manual" | "chat";
  notes?: string;
  created?: string;
  completed?: string;
};

// The buckets the agenda is read in. The order of this type is the order they must be shown in:
// you look at what is late, then today, then the rest.
export type AgendaBucket =
  | "overdue"
  | "today"
  | "tomorrow"
  | "this_week"
  | "later"
  | "undated"
  | "done";

export type AgendaDoc = {
  meta: { date: string; notes?: string };
  items: AgendaItem[];
  buckets: Record<AgendaBucket, AgendaItem[]>;
  // false = the transcription model is not in memory yet: the first dictation pays a few
  // seconds of loading time.
  transcription_ready: boolean;
};

// An item PROPOSED by dictation: it is not in the agenda yet, the user confirms it.
export type ProposedAgendaItem = {
  text: string;
  projects?: string[];
  due?: string;
  time?: string;
  priority?: "high" | "medium" | "low";
  notes?: string;
};

export type DictationResult = {
  text: string;
  items: ProposedAgendaItem[];
  reason?: string;
};

export type DocKind =
  | "estimate"
  | "data_model"
  | "mockup"
  | "timeline"
  | "brief"
  | "questions"
  | "people"
  | "test_plan"
  | "deck"
  | "diagram"
  | "design";

// ---------- WS events ----------

export type WsEventDelta = { type: "delta"; text: string };
export type WsEventTool = { type: "tool_use"; name: string; input: string };
export type WsEventResult = {
  type: "result";
  chat_id: string;
  cost_usd: number;
  chat_cost_usd: number;
  chat_tokens: ChatTokens;
  chat_context_tokens: number;
  project_cost_usd: number;
  project_tokens: ChatTokens;
  duration_s: number;
  is_error?: boolean;
};
export type WsEventError = { type: "error"; message: string };
export type WsEvent = WsEventDelta | WsEventTool | WsEventResult | WsEventError;
