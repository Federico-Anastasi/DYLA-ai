---
name: diagram
description: "Produces the technical diagrams of the project (architecture, operational workflows, dataflows, sequences) in diagram.json. Uses the brief and the data model when available. Exports to a self-contained HTML."
user-invocable: true
pack: delivery
---

# /diagram — Technical diagrams

Reads the project material and produces the technical diagrams: architecture views
(systems and integrations, SAI-style), operational workflows, dataflows (who touches
which data — also the base for data-privacy mapping), sequence diagrams for the
exchanges that need step-by-step precision.

**UX: chat stays conversational.** The deliverable is never drawn in chat — the user
sees and edits the diagrams on the canvas in the viewer, from `diagram.json`. In chat
you discuss in words, citing diagrams and nodes by id (e.g. the `crm` node in
`arch-overview`). When you cite a chapter of the brief, write `[[brief:Chapter title]]`.

---

## PROTOCOL

1. **Read context.md** — where is the project? (Diagrams already discussed? Decisions taken?)
2. **Read the material** — brief, data model, estimate, meetings (see PHASE 1)
3. **If `diagram.json` already exists:** ask "Edit it, or regenerate from scratch?"
4. **Q&A** (BLOCKING — 3 to 5 questions, no more): which diagrams, which scope
5. **Write diagram.json straight away** with `meta.status: "draft"`
6. **Present a conversational summary** (BLOCKING — wait for validation or edits)
7. **On confirmation:** set `meta.status: "confirmed"`
8. **Update context.md**

Note: `diagram.html` is an **export**, generated on demand by the backend from
`diagram.json` (`GET /api/projects/{project}/export/diagram.html`) — a single
self-contained file the client opens with a double click. This skill does not produce it.

---

## PHASE 1 — READING

Read ALL of these before you go on:
- the brief: `projects/{project}/brief.json`, or the input document (`brief.md`, or its
  extracted text under `.extracted/`)
- `projects/{project}/data_model.json` — if it exists: the entities and integrations it
  names are the backbone of the architecture and dataflow views
- `projects/{project}/estimate.json` — if it exists: the epics tell you which systems
  and flows the project actually touches
- `projects/{project}/meetings/*` and `docs/*` — processes are usually described there
- `projects/{project}/context.md`
- `projects/{project}/diagram.json` — if it exists

---

## PHASE 2 — Q&A (BLOCKING)

Ask in a ```questions block. The format is EXACTLY this — a JSON array of objects with
`id` (integer), `q` (the question) and `options` (1-4 plain strings; a free-text field is
always added by the UI, do not declare it). No other fields, no wrapper object:

````
```questions
[
  {
    "id": 1,
    "q": "Which views should I draw? I would start with these.",
    "options": ["Architecture + the two key workflows", "Architecture only", "Add the privacy dataflow too"],
    "hint": "name any other process worth its own diagram"
  },
  {
    "id": 2,
    "q": "For the architecture: which zones matter as boundaries?",
    "options": ["Sites + cloud + third parties", "A single site"],
    "hint": "e.g. DMZ, per-department zones"
  }
]
```
````

(The full rules live in `.claude/prompts/questions_format.md` — the example above is the
contract in miniature; when in doubt, copy its shape.) The questions settle WHAT to
diagram, not how to draw it:

- which views are needed? (architecture overview, one workflow per key process, a
  dataflow for privacy, a sequence for a critical integration — offer what the material
  suggests as options)
- for the architecture: which zones matter (sites, network zones, trust boundaries,
  third parties)?
- for workflows: which process, where does it start and end, who are the actors?

**STOP. Wait for the answer.** Write the answers into context.md.

---

## PHASE 3 — WRITE THE DRAFT diagram.json (before you talk in chat)

1. Build the JSON following `schemas/diagram.schema.json`:
   - `meta`: project, title, date, **`status: "draft"`**
   - `diagrams[]`: one per view agreed in the Q&A. Each has `id` (short slug like
     `arch-overview`, `wf-visit`), `kind`, `title`, optional `notes` (scope and
     assumptions), `groups[]`, `nodes[]`, `edges[]`
   - `nodes[].class` is semantic and decides shape and colour through the theme —
     never think in colours. People and systems: `actor`, `frontend`, `backend`,
     `service`, `database`, `storage`, `queue`, `external`, `security`. Workflow steps:
     `start`, `end`, `process`, `decision` (a branch — label its outgoing edges with the
     condition), `document`, `manual` (done by hand, outside any system)
   - `groups[]` are the zones (network, site, department, third parties), nestable via
     `parent`. Use them: an architecture without boundaries says nothing about trust
   - **For `workflow`, groups are swimlanes**: one group per actor or role (e.g.
     `reception`, `clinical`, `system`), and every step carries the `group` of whoever
     performs it. The renderer draws them as horizontal lanes, left to right — a
     workflow without lanes says nothing about who does what
   - `edges[]`: `label` carries the protocol, the data exchanged, or the branch
     condition; `style: "dashed"` for async, batch and return messages
   - For `sequence`: nodes in lifeline order, edges in message order — array order IS
     the layout
2. Write it to `projects/{project}/diagram.json` — the skeleton (`meta` plus the first
   diagram with its nodes) with `Write`, then **one diagram per `Edit`**. A single call
   carrying the whole document is how this fails on a local model: the payload arrives
   truncated and nothing is written. Anchor each `Edit` on the diagram's unique `id`.
3. VALIDATE it:
   ```
   python -c "import json; from jsonschema import validate; validate(json.load(open(r'projects/{project}/diagram.json', encoding='utf-8')), json.load(open(r'schemas/diagram.schema.json', encoding='utf-8'))); print('valid')"
   ```

Sizing: an architecture overview reads well up to ~15 nodes; past that, split into a
second view rather than cramming. A workflow follows one process — parallel processes
are separate diagrams.

**Never write `nodes[].pos`.** `pos` (`{x, y}`) is the position the user set by dragging
the node on the canvas — their manual work. When you regenerate or update the document:
- for every node that survives (same `id`), copy its existing `pos` if it had one
- for NEW nodes never set `pos` — the layout places them automatically

---

## PHASE 4 — CONVERSATIONAL SUMMARY (BLOCKING)

The file already exists (`meta.status: "draft"`) and the user sees the diagrams on the
canvas. In chat give a **conversational summary**: which views you drew and why, what
each one says (the zones, the main flows, the decisions), what you inferred versus what
the material states (cite chapters with `[[brief:...]]`), and what you left out of the
picture. Close by asking whether the views are right or something is missing.

**STOP. Wait for validation or change requests.**

If the user asks for changes: edit `diagram.json` directly (one `Edit` per diagram
touched, anchored on its `id`), re-validate, summarise what changed and ask again.

---

## PHASE 5 — CONFIRMATION

Once the user validates: set `meta.status: "confirmed"` (`Edit` just that line — do not
rewrite the file), re-validate. Confirm briefly in chat.

---

## PHASE 6 — UPDATE context.md

Write or update the `## Diagrams` section in context.md: which views exist (id, kind,
one line each), the assumptions drawn into them, open points. Update `## Deliverables`.

---

## RULES

- **Chat stays conversational: never draw or list a whole diagram in chat.** The user
  validates by looking at the canvas
- Write the JSON BEFORE you talk in chat: `meta.status` starts at `"draft"`
- Semantic classes, never colours; groups for boundaries, always
- Every view states its scope in `notes` — a diagram nobody can bound is a diagram
  nobody can trust
- The data model and the diagrams must agree: same system names, same integrations.
  If they diverge, say so and ask which one is right
- Do not invent systems the material does not mention: an inferred box is presented as
  inferred, in the summary and in `notes`
- **A decision's branches must diverge**: each outgoing edge labelled with its condition,
  each leading to a DIFFERENT node. Two branches into the same node means a step is
  missing — add it or drop the decision
- **A dataflow shows data moving, never table relations**: no "1:N" edges, no
  table-to-table joins — those belong to the data model. Every dataflow edge reads as
  "this data goes from here to there"
- `start`/`end` nodes get a short label ("Start", "Done") — never empty strings
- Keep labels short: node labels under ~18 characters where possible, edge labels under
  ~30 — long SQL or payloads do not belong on an arrow; put the detail in `desc` or notes
