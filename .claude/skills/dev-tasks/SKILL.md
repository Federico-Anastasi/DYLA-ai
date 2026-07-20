---
name: dev-tasks
description: "Breaks a confirmed estimate into granular dev tasks. Every estimate task becomes 1-3 assignable pieces of work, written inside estimate.json (epics[].tasks[].dev_tasks[])."
user-invocable: true
pack: delivery
---

# /dev-tasks — Dev tasks

Produces the developer-level breakdown of a confirmed estimate. **It does not create a new
file**: it fills the `dev_tasks[]` array of every task in
`projects/{project}/estimate.json` (one schema, one hierarchy: `epics -> tasks ->
dev_tasks`).

**UX: chat stays conversational.** The deliverable is never presented as a markdown table
in chat — the user reads it in the viewer next to the chat, from `estimate.json`. In chat
you discuss it in words, citing dev tasks by id **and** name (e.g. "E2.T3.D1, the request
table"). The user does not type ids: every row in the viewer has a chat icon that sends
you a ready-made `[REFERENCE]` — point them at that button when it is unclear which row
they mean. When you cite a chapter of the brief, write `[[brief:Chapter title]]`: it
renders as a clickable reference that opens the document at that point.

---

## PROTOCOL

1. **Read context.md and estimate.json** — is the estimate confirmed?
2. **If estimate.json does not exist:** "Produce the estimate first with `/estimate`." STOP.
3. **If estimate.json exists but `meta.status` is not `"confirmed"`:** "The estimate is not confirmed yet. Confirm it with `/estimate` before breaking it down." STOP.
4. **If `meta.dev_tasks_status` is already present:** ask in a `questions` block (see
   PHASE 2) whether to regenerate them or edit them
5. **Generate the dev tasks** for every task (1-3 each, days summing EXACTLY to task.days)
6. **Write them into estimate.json one epic at a time** (`Edit`, not a full rewrite), with
   `meta.dev_tasks_status: "draft"`, then read the finished file back and reconcile it
7. **Present a conversational summary** (BLOCKING — wait for confirmation or edits)
8. **On confirmation:** set `meta.dev_tasks_status: "confirmed"`
9. **Update context.md**

---

## PHASE 1 — CHECK DEPENDENCIES

Read ALL of these before you go on:
- the brief: `projects/{project}/brief.json`, or the input document (`brief.md`, or its
  extracted text under `.extracted/` if it is a PDF or a Word file)
- `projects/{project}/docs/*` — client documents (binaries have their text extracted
  under `.extracted/`)
- `projects/{project}/context.md`
- `projects/{project}/data_model.json` — if it exists
- `projects/{project}/estimate.json`
- `knowledge/` — if the folder exists: naming conventions, house patterns, client
  specifics. If a convention matters and nothing there covers it, ask the user

Check the estimate is confirmed (`meta.status: "confirmed"` in `estimate.json`, ideally
confirmed in `context.md` too).

If `estimate.json` does not exist:
```
Dev tasks need a confirmed estimate to break down.
Run `/estimate` to produce one.
```
STOP.

If `meta.status` is not `"confirmed"`:
```
The estimate is still a draft. Confirm it with `/estimate` first, then run `/dev-tasks`
again.
```
STOP.

---

## PHASE 2 — GENERATING THE DEV TASKS

If `meta.dev_tasks_status` is already present, ask in a ```questions block (format in
`.claude/prompts/questions_format.md`):
````
```questions
[
  {
    "id": 1,
    "q": "The dev task breakdown already exists. Do you want to edit it or regenerate it from scratch?",
    "options": ["Edit it — tell me what to change", "Regenerate it from scratch"]
  }
]
```
````

For every task in `estimate.json` (`epics[].tasks[]`, excluding the `e2e` rows), fill
`dev_tasks[]` following `schemas/estimate.schema.json`:

### Rules
- **id**: scoped to the parent task, e.g. `E2.T3.D1`, `E2.T3.D2` — pattern `^E\d+\.T\d+\.D\d+$`
- **dev_task**: the granular piece of work — what the developer concretely builds
- **description**: 3-10 lines, written for a developer. This is where the specifics go:
  - real table and column names, from `data_model.json`
  - references to the chapter of the brief that defines the behaviour
  - the objects to create, and what they connect to
  - the naming convention to follow, when the project has one (see below)
  - for integrations: which system, which endpoint, which format
  - for anything with states: the actual state values, not "the various states"
- **days**: the sum of a task's `dev_tasks[].days` must match that task's `days`
  EXACTLY (a schema rule, enforced by the backend too —
  `server/documents.py::save_doc` refuses to save when it does not add up)
- **owner**: empty string (filled in during planning)
- **layer**: 1-4, which drives the execution order on the project timeline (see below)

Dev tasks have no `note` field: gotchas, constraints and house practice belong in the
`description`.

### Technical layer

Every dev task carries a `layer` saying when it can be built. The project timeline uses it
to order the work: within one epic the layers are sequential, while different epics run in
parallel on different developers.

| Layer | Holds |
|---|---|
| 1 | Data model and data structures: tables, entities, configuration, groups |
| 2 | Forms and screens: create/edit forms, grids, detail views, dashboards, reports |
| 3 | Business rules, processes, integrations, notifications, calculations, validations |
| 4 | E2E tests |

Rules:
- A dev task spanning several layers takes the highest one: it cannot finish before then
  (e.g. "approval process and its form" → layer 3)
- Inside layer 3 there is no order: those dev tasks are parallelisable among themselves
- The `e2e` rows of the estimate get no dev tasks, so layer 4 does not appear here
- Use `depends_on` only for constraints the layer does not capture (rare): it is an
  explicit override, not the norm

### Naming convention

Many teams prefix the objects of a project with a short project code. If this project has
one, use it consistently across the descriptions so a developer can search the codebase
for it.

Take the code from `## Project code` in `context.md`. If it is missing, ask the user
before generating anything, in a ```questions block (format in
`.claude/prompts/questions_format.md`), proposing one derived from the project name:
````
```questions
[
  {
    "id": 1,
    "q": "This project has no code yet for prefixing objects (e.g. tables, forms). Use one derived from the project name?",
    "options": ["Yes, use \"{PROPOSED_CODE}\" (e.g. \"Supplier Portal\" -> SUP)", "No, I'll give you a different one"]
  }
]
```
````
Write the confirmed code into `context.md`.

Codes you find in `knowledge/` belong to OTHER projects: they are examples of the
convention, not prefixes to reuse.

### 1-3 dev tasks per task

Expect roughly two to three times as many dev tasks as estimate tasks overall. Do not
touch `task.days`: the breakdown must add up to the number already confirmed in the
estimate. If the natural split does not land on it, adjust how you divide the days between
the dev tasks — never the total.

---

## PHASE 3 — WRITE THE DRAFT (before you talk in chat)

**Do not generate xlsx.** The Excel export (`dev_tasks.xlsx`) is produced on demand by the
backend (`server/exports.py`, reading `estimate.json`) via
`GET /api/projects/{project}/export/dev_tasks.xlsx`. This skill writes `estimate.json` and
nothing else.

**Work task by task, grouped by epic, and edit — do not rewrite the file.**

Rewriting the whole `estimate.json` in one go was the original instruction here, and it
is wrong in three ways. It is slow: a full estimate is tens of thousands of characters,
and regenerating all of it — including every description that is not changing — took over
twenty-five minutes on a local model. It is fragile: while that single write is in flight
the document on disk is truncated, and a turn that stops for any reason leaves the user's
deliverable unreadable (recoverable from the snapshot, but still broken). And it is
lossy: every line you reproduce from memory is a line you can quietly alter.

So:

1. **Read the whole estimate once, for names, not for a plan.** You do not need to design
   the breakdown of every epic before starting: just note anything a later epic will
   reuse (a shared component, a data structure another epic's layer-2 screen depends on),
   so you can say "reuses E1.T2.D1" instead of re-describing it. Then process epics in
   order, one at a time — you do not need the whole shape decided up front.
2. **Go task by task, grouped by epic.** Every task's `"dev_tasks": []` line is
   byte-identical to every other task's, so an `Edit` matching only that string is not
   unique and fails. Anchor each `Edit`'s `old_string` on the task's own `"id": "E2.T3"`
   line through the `"dev_tasks": []` that follows it — the `task`/`days`/`description`
   lines in between make that span unique — and replace it with the same span ending in
   the filled `"dev_tasks": [...]`. One task per edit: small, fast, and if something goes
   wrong only that task is affected and everything already written survives.
3. On the FIRST edit, also set `meta.dev_tasks_status: "draft"`, so the viewer shows the
   work as it appears rather than all at the end.
4. **Once every epic is done, run three separate, mechanical passes — one check at a
   time, not all five things at once:**
   - **Sums**: run the validation command below and fix every task it prints as
     `MISMATCH`. This is the one the script already does for you — do not also try to add
     it up by eye
   - **Duplicated components**: grep the file for a component name or table name you used
     in more than one epic's `description` (e.g.
     `grep -n "status history" projects/{project}/estimate.json`); if it shows up as a
     fresh build in two places, one of them should instead say "reuses E_.T_.D_"
   - **Thin epics**: count `dev_tasks[]` per epic (e.g. with a short `python -c` snippet
     over the loaded JSON); an epic with far fewer dev tasks than its `days` would suggest
     is the one worth a second look
5. VALIDATE against the schema AND the summing rule:
   ```
   python -c "import json; from jsonschema import validate; d=json.load(open(r'projects/{project}/estimate.json', encoding='utf-8')); validate(d, json.load(open(r'schemas/estimate.schema.json', encoding='utf-8'))); [print('MISMATCH', t['id'], t['days'], sum(x['days'] for x in t['dev_tasks'])) for e in d['epics'] for t in e['tasks'] if t['dev_tasks'] and abs(t['days']-sum(x['days'] for x in t['dev_tasks']))>0.001]; print('valid')"
   ```
   If it prints `MISMATCH`, fix the split for that task and re-run.

---

## PHASE 4 — CONVERSATIONAL SUMMARY (BLOCKING)

The file already exists (`meta.dev_tasks_status: "draft"`) and the user can see it in the
viewer (expandable dev task rows under each task). In chat give a **conversational
summary, no table**: how many dev tasks in total, how many estimate tasks they came from,
any task with an odd breakdown (a single dev task, or more than three), and that the
owners are all still empty. You may quote two or three rows at most, never the whole
table. Close by asking for confirmation or changes.

**STOP. Wait for confirmation or change requests.**

If the user asks for changes: edit `estimate.json` directly (the `dev_tasks[]` of the task
in question, keeping the sum equal to `task.days`), re-validate schema and sums, present a
short summary of what changed (naming the `E*.T*.D*` ids) and ask again.

---

## PHASE 5 — CONFIRMATION

On confirmation: set `meta.dev_tasks_status: "confirmed"` in `estimate.json` (`Edit` just
that one field — do not rewrite the file: it is the same tens-of-thousands-of-characters
document PHASE 3 just spent seven paragraphs explaining not to rewrite, and regenerating
all of it to change one word is both slow and a chance to alter something by accident),
re-validate schema and sums. Confirm briefly in chat, and mention that the work can now be
planned on the Timeline view of the Estimate tab.

---

## PHASE 6 — UPDATE context.md

Update the `## Deliverables` section, noting that the dev task breakdown is confirmed
inside `estimate.json`.
