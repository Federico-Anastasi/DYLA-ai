---
name: pipeline
description: "Runs the whole estimation flow in one session: Q&A, data model, estimate, dev tasks, mockup. To produce a single deliverable, use the dedicated skills instead (/data-model, /estimate, /dev-tasks, /mockup)."
user-invocable: true
pack: delivery
---

# /pipeline — The full run

Runs the entire estimation flow in a single session. For individual deliverables, use the
modular skills.

**UX: chat stays conversational.** No deliverable is ever presented as a markdown table in
chat — every phase writes the JSON FIRST (`meta.status: "draft"`), the user reads it in
the viewer, and then it gets discussed in words, citing elements by id. On confirmation
`meta.status` becomes `"confirmed"`. When you cite a chapter of the brief, write
`[[brief:Chapter title]]`: it renders as a clickable reference that opens the document at
that point.

**The skills this composes:**
- `/meeting` — merges a meeting transcript into the brief
- `/data-model` — data model (tables, relations, integrations)
- `/estimate` — the work plan in days
- `/dev-tasks` — the granular dev task breakdown
- `/mockup` — component-based mockup

Each phase below follows the protocol of the corresponding skill. Read that skill's
SKILL.md when you need the detail — this file is the running order, not a replacement for
them.

---

## THE FLOW

```
[MEETING, if needed] → INTAKE → Q&A [STOP] → DATA MODEL [STOP] → ESTIMATE [STOP] → DEV TASKS → MOCKUP
```

Three blocking points: Q&A, data model, estimate. The user confirms before you go on.

---

## PHASE 0 — MEETING (conditional)

Read `projects/{project}/.project.json`. If `source` is `"discovery"` and
`projects/{project}/meetings/` holds transcripts not yet merged into `brief.json` (compare
with `changelog[].source`), the pipeline starts there: run `/meeting` first to merge them
and bring the brief to a stable state, then continue from PHASE 1. If the brief is already
current (or the project source is `brief`), skip this phase.

---

## PHASE 1 — INTAKE

### Invoked with a file
```
/pipeline path/to/brief.md
```
Read the file. That is your main input.

### Invoked with nothing
Look for the brief in the project folder: `brief.json` (source `discovery`) or `brief.*`
as an input document (if it is a PDF or a Word file, read the extracted text under
`.extracted/`). If there is none, ask.

### Context
Once you have read the brief:
- check `projects/{project}/docs/` for client documents
- read `knowledge/` if the folder exists, for conventions and estimation rules

---

## PHASE 2 — Q&A (BLOCKING)

Read the brief for ambiguities. Five to seven questions, no more, in a ```questions block
— the format and the rules for `options` are in `.claude/prompts/questions_format.md`,
read it before writing the block.

Ask only what actually moves the number (file formats, how many flows or types, approval
levels, integrations). State the impact in the question when it is relevant ("a
fixed-width text file is roughly a day more than a spreadsheet"): it helps the user see
why you are asking.

**STOP. Wait for the answer.** Then write the Q&A into context.md.

---

## PHASE 3 — DATA MODEL (BLOCKING)

Build and immediately write `data_model.json` (`meta.status: "draft"`, validated against
`schemas/data_model.schema.json` — same structure as `/data-model`: `areas[]`, `tables[]`,
`relations[]`). **Write it in pieces, as `/data-model` PHASE 3 does**: the skeleton
(`meta`, `areas`, empty `tables` and `relations`) with `Write`, then one area's tables per
`Edit` — a single call carrying the whole model is how this fails on a local model, the
payload arrives empty and nothing is written.

In chat give a **conversational summary, no table**: how many tables, which you inferred
versus which came from the brief, the main relations, the integrations. Ask whether it is
right or something is missing.

**STOP. Wait for validation.**

On changes: edit `data_model.json` directly, re-validate, present a short summary.

On validation: `meta.status: "confirmed"`. Update context.md.

---

## PHASE 4 — ESTIMATE (BLOCKING)

Build the estimate from the brief, the Q&A and the data model, following `/estimate`
PHASE 3 for where the numbers come from — `knowledge/` if it exists, and asking the user
rather than inventing a baseline when it does not.

Write `estimate.json` straight away (`meta.status: "draft"`, validated against
`schemas/estimate.schema.json` — see `/estimate` PHASE 4 for the exact structure:
`epics[].tasks[]`, `e2e`, `assumptions[]`, `considerations[]`, `open_questions[]`).
**Write it in pieces, as `/estimate` PHASE 4 does**: the skeleton (`meta`, `epics: []`)
with `Write`, then one epic per `Edit`, anchored on the last epic's unique `id` — this is
the largest document in the system (a confirmed one runs past 70 KB), and a single-call
write is where it arrives empty on a local model.

In chat give a **conversational summary, no table**: total days, the main epics, the
things to watch, the open questions that matter. Two or three quoted rows at most.

**STOP. Wait for confirmation.**

On changes: edit `estimate.json` directly, re-validate, present a short summary.

On confirmation: `meta.status: "confirmed"`. Update context.md.

---

## PHASE 5 — DEV TASKS AND MOCKUP

Living-documents architecture: this phase writes ONLY the source-of-truth JSON files
(validated against `schemas/`). The xlsx, drawio and html exports are generated on demand
by the backend, not here. `estimate.json` and `data_model.json` were already written and
confirmed in the previous phases — what follows are the derived deliverables.

After the estimate is confirmed, generate in order, each with the same pattern (draft →
conversational summary → confirmed; not blocking here, since these derive from decisions
already taken):

1. **dev tasks inside estimate.json** — fill `epics[].tasks[].dev_tasks[]` for every task
   (see `/dev-tasks` for the structure and the summing rule: `task.days` = the sum of
   `dev_tasks[].days`), setting `meta.dev_tasks_status` to `"draft"` and then
   `"confirmed"`. There is no separate file. **Edit task by task, grouped by epic, as
   `/dev-tasks` PHASE 3 does** — never rewrite the whole `estimate.json`, and anchor each
   `Edit` on the task's own `id` (its `"dev_tasks": []` line alone is identical on every
   task, so matching only that string is not unique)
2. **mockup.json** — the component-based mockup, validated against
   `schemas/mockup.schema.json` (see `/mockup` for the library and the theme rules).
   **Write it in pieces, as `/mockup` PHASE 5 does**: the skeleton (`meta` with `theme`
   inside it, `pages` holding the first page — `pages: []` fails validation, it needs
   `minItems: 1`) with `Write`, then one page per `Edit`

### Final report

```
Files written to {folder}/:
- brief.json or brief.* — the brief
- estimate.json — the estimate in days, with the dev task breakdown per task
- data_model.json — the data model (tables, fields, relations)
- mockup.json — the mockup (pages built from the standard library)

The Excel / draw.io / HTML exports (estimate.xlsx, dev_tasks.xlsx, data_model.drawio,
data_model.html, mockup.html) download from the control panel, or via
GET /api/projects/{project}/export/{kind} — generated on the fly by the backend
(dev_tasks.xlsx reads estimate.json too).

Any deliverable can be changed with its own skill: /estimate, /dev-tasks, /data-model,
/mockup.

Later in the project: /test-plan (test cases) and /deck (project decks) — stages of the
life cycle, not of this pipeline.
```

---

## RULES

### Blocking phases
- **Q&A** — ask, STOP, wait for the answer
- **Data model** — write the draft, summarise in words, STOP, wait for validation
- **Estimate** — write the draft, summarise in words, STOP, wait for confirmation

NEVER combine the Q&A and the estimate in one message.
NEVER skip the Q&A or the data model.
NEVER present a deliverable as a markdown table in chat — the draft JSON always exists
BEFORE anyone talks about it, and the user reads it in the viewer.

### Estimate structure (for the JSON, not for chat)
`epics[].tasks[]` with `days`, plus an `e2e` row per epic. Contingency lives in
`meta.contingency_pct` and is computed by the consumers, never stored as a row.

### context.md
Update context.md after every phase. The modular skills read it to pick up the context.
