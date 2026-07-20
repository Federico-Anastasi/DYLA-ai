---
name: estimate
description: "Produces the work plan in days from the brief — epics, tasks, E2E test rows and contingency — in estimate.json. Uses the data model when one is available."
user-invocable: true
pack: delivery
---

# /estimate — The estimate

Turns the brief into a work plan measured in **days**: epics, the tasks inside them, an
end-to-end test row per epic, and a contingency.

---

**UX: chat stays conversational.** The deliverable is never presented as a markdown table
in chat — the user reads the table in the viewer next to the chat, from `estimate.json`.
In chat you discuss it in words, referring to tasks by id **and** name (e.g. "E2.T3, the
detail view"): the id alone is unreadable, the name is what makes the sentence land. In
the other direction the user does not have to type ids: every row in the viewer has a
chat icon that sends you a ready-made `[REFERENCE]` with their question — point them at
that button when they are vague about which row they mean. When you cite a chapter of the
brief, write `[[brief:Chapter title]]`: it renders as a clickable reference that opens the
document at that point.

## PROTOCOL

1. **Read context.md** — is there a data model? Has the Q&A been done?
2. **Read the brief**
3. **If the estimate already exists:** ask "The estimate already exists. Regenerate it, or edit it?"
4. **If there is no Q&A:** run the Q&A (BLOCKING)
5. **If there is no data model:** carry on, but say so — "estimating without a validated data model, so this will be rougher"
6. **Build the estimate** (see PHASE 3)
7. **Write estimate.json straight away** with `meta.status: "draft"` (validated against `schemas/estimate.schema.json`)
8. **Present a conversational summary** of the draft (BLOCKING — wait for confirmation or edits)
9. **On confirmation:** set `meta.status: "confirmed"`
10. **Update context.md**
11. **Check consistency**

---

## PHASE 1 — READING

Read ALL of these before you go on:
- the brief: `projects/{project}/brief.json`, or the input document (`brief.md`, or its
  extracted text under `.extracted/` if it is a PDF or a Word file)
- `projects/{project}/meetings/*` — if the project source is `discovery`: the real
  requirements are in the transcripts before they are in the brief
- `projects/{project}/docs/*` — client documents (md, pdf, docx, xlsx, images; binaries
  have their text extracted under `.extracted/`)
- `projects/{project}/context.md`
- `projects/{project}/data_model.json` — if it exists
- `projects/{project}/estimate.json` — if it exists
- `knowledge/` — if the folder exists: your own estimation rules, per-component
  baselines, team calibration, client conventions. **See `estimation-rules.md` next to
  this file** for how to put them there

If `context.md` holds a `## Data model` section marked validated, use it as an input.

If `estimate.json` exists, ask in a ```questions block (format in
`.claude/prompts/questions_format.md`):
````
```questions
[
  {
    "id": 1,
    "q": "The estimate already exists. Do you want to edit it or regenerate it from scratch?",
    "options": ["Edit it — tell me what to change, e.g. \"the import task goes from 2 to 3 days\"", "Regenerate it from scratch"]
  }
]
```
````

If they choose to edit: read `estimate.json` and change only what they asked for, with
`Edit`. "The import task goes from 2 to 3 days" is one number: rewriting the whole file
to change it is slow, and every line you reproduce from memory is a line you can alter
without meaning to. Re-validate against the schema afterwards.

Regenerating from scratch is the other branch, and there `Write` is right — nothing is
being preserved.

---

## PHASE 2 — Q&A (BLOCKING, if needed)

Only if context.md has no Q&A. Ask in a ```questions block — the format and the rules for
`options` are in `.claude/prompts/questions_format.md`, read it before writing the block.

Ask only what actually moves the number, and say what it moves when that is worth knowing
("a fixed-width text file is roughly a day more than a spreadsheet"). It helps the user
understand why you are asking.

**STOP. Wait for the answer.** Then write the Q&A into context.md.

---

## PHASE 3 — BUILDING THE ESTIMATE

### Where the numbers come from

Read `knowledge/` first if it exists: per-component baselines, historical calibration and
house rules live there, and they beat anything you would reason out from first
principles. **If the folder is absent or silent on what you are estimating, do not invent
a baseline — ask the user.** One question with a proposed number in it ("I would put a
list screen with filters at 1.5 days on this stack — does that match what you see?") is
worth more than a confident guess, and the answer is worth writing into `knowledge/` so
it does not have to be asked twice.

`estimation-rules.md` next to this file explains the shape those rules take.

### Breaking the work down

- **One task = one thing that gets built.** Do not merge different artefacts into one
  row: a screen, the rule behind it and the integration it calls are three tasks
- **Name tasks for what they do, not for how they are built.** A project manager should
  understand the row without knowing the stack. "Import the daily supplier file" — not
  "positional parser component"
- **Number epics consistently**: "1. Epic name", "2. Epic name". The `name` string must be
  character-for-character identical on every row of that epic, or grouping breaks in the
  export
- **The same flow repeated for N types is N tasks**, not one generic one, whenever the
  data or the rules differ between them. Similar screens hide different validation
- **Every epic ends with an E2E test row** (`e2e`). Its size scales with how many paths
  the epic has: a plain CRUD flow is a fraction of what an approval flow with three
  outcomes costs to test

### The number itself

- Days only. `days` on every task, minimum 0.25, rounded to the nearest half day above 1
- **Numbers or nothing.** A vague estimate is worse than no estimate
- **Round up when in doubt.** Underestimating costs more than overestimating
- **Show your reasoning**: which rule or precedent you applied goes into `assumptions[]`
  or the task `description`. Traceability is what makes an estimate survive a review
- **Say when confidence is low**, in `considerations[]` and in chat. A number nobody
  flagged is read as a number somebody stands behind
- Contingency goes in `meta.contingency_pct`, as a percentage — a well-specified brief
  needs less of it than a vague one, and the user's own history should set the figure

---

## PHASE 4 — WRITE THE DRAFT estimate.json (before you talk in chat)

**Living-documents architecture: this skill writes ONLY JSON. Do not generate xlsx** —
the Excel export (`estimate.xlsx`) is produced on demand by the backend
(`server/exports.py`, `GET /api/projects/{project}/export/estimate.xlsx`) from
`estimate.json`. No generation script gets copied or run here.

1. Build the JSON following `schemas/estimate.schema.json`:
   - `meta`: project (folder slug), title, client, date (YYYY-MM-DD), contingency_pct,
     notes, **`status: "draft"`**
   - `epics[]`: each epic has `id` (E1, E2, …), `name` (e.g. "1. Epic name"), `tasks[]`
     (each with `id` E1.T1 etc., `task`, `days`, `description` — one or two sentences in
     plain terms, the language a project manager uses) and `e2e` (`label` + `days`). As an
     order of magnitude, a typical project lands 4-8 epics with 3-6 tasks each — fewer
     epics reads as under-decomposed (see "Breaking the work down" above), a lot more as
     over-split busywork
   - Every task also carries `dev_tasks: []` (an **empty** array, required even when
     empty): this skill writes the estimate, the granular breakdown is `/dev-tasks`'
     job later on, in the same `estimate.json`. Summing rule: when `dev_tasks` is
     non-empty, `task.days` MUST equal the sum of `dev_tasks[].days` (the backend checks
     it) — here it starts empty, so `task.days` is the directly estimated value
   - `assumptions[]`: array of strings — what you assumed in order to put a number down.
     **Do not leave it empty**: every estimate rests on at least one explicit assumption
   - `considerations[]`: array of strings — risks, dependencies, notes on confidence
   - `open_questions[]`: array of `{area, question, estimated_impact, priority: high|medium|low}`
     — what could still move the number. An empty array is allowed, but check you have
     not simply forgotten: nearly every estimate has one
   - **Do not compute totals**: `estimate.json` holds no subtotal, total or contingency
     row — consumers derive those (the backend for the Excel, the frontend for the UI)
     from `contingency_pct` and the sum of tasks + e2e
   - These fields feed the "Assumptions and Considerations" and "Open Questions" sheets
     in the Excel export (`server/exports.py`) — if they are missing, those sheets are
     not generated
2. **Write it in pieces, not in one call.** A confirmed estimate is the biggest document in
   the system — a real one runs past 70 KB — and emitting all of it in a single tool call
   is where this breaks: observed on a local model, the `Write` arrived with an EMPTY
   payload and the document was never created at all. So: `Write` the skeleton first —
   `meta` (with `status: "draft"`) and `epics: []` (`epics` has no `minItems`, so an empty
   array is a valid document) — then add one epic per `Edit`. Anchor `old_string` on the
   last epic already written — its unique `id` (e.g. `"id": "E3"`) makes the match
   unambiguous — and insert the new epic right after it. Every call stays small, the file
   is valid JSON throughout, and an interruption costs the last epic instead of the whole
   document
3. VALIDATE it against the schema:
   ```
   python -c "import json; from jsonschema import validate; validate(json.load(open(r'projects/{project}/estimate.json', encoding='utf-8')), json.load(open(r'schemas/estimate.schema.json', encoding='utf-8'))); print('valid')"
   ```
   If it fails, fix the JSON and re-validate before going on.

---

## PHASE 5 — CONVERSATIONAL SUMMARY (BLOCKING)

The file already exists (`meta.status: "draft"`) and the user can see it in the viewer. In
chat give a **conversational summary, no table**: the total in days (tasks + e2e +
contingency), the epics by name with their aggregate, the main things to watch, the key
assumptions, the high-priority open questions. You may quote two or three rows at most —
to point at one ambiguous task, say — never the whole table. Close by asking for
confirmation or changes.

An example of the tone (not a fixed template — fit it to the real content):
```
I drafted an estimate for {title}: {N} epics, {days} days in total ({pct}% contingency
included). The heaviest epic is "{epic name}" ({days} days), mostly because of {short
reason}. I left {M} open questions, the one that matters most being on {area}:
{question}. The task-by-task detail is in the panel next to this. Want me to adjust
anything, or shall I confirm it? If you want to argue with a specific row, use the chat
icon on that row in the viewer — the reference arrives here ready-made.
```

**STOP. Wait for confirmation or change requests.**

If the user asks for changes: edit `estimate.json` directly (never an intermediate
table), re-validate, present a short summary of what changed (naming the ids you touched)
and ask again.

---

## PHASE 6 — CONFIRMATION

On confirmation: set `meta.status: "confirmed"` in `estimate.json` (`Edit` just that line — do not rewrite the file: it is tens of thousands of
characters, and regenerating all of them to change one word is both slow and a
chance to alter something by accident), re-validate. Confirm briefly in chat.

---

## PHASE 7 — UPDATE context.md

Write or update the `## Estimate` section with:
- Status: confirmed
- Total days, contingency %
- The epics with their days
- Update `## Deliverables` and `## Assumptions`

---

## PHASE 8 — CONSISTENCY CHECK

- If `meta.dev_tasks_status` is present (breakdown already generated): "The estimate
  changed. Want me to update the dev tasks?" — if yes, the `dev_tasks[]` of the tasks you
  touched have to be redone or re-checked (the sums must line up with `task.days` again)
- If `data_model.json` exists and the model moved: flag it
- If `mockup.json` exists: flag it
- If `test_plan.json` exists: the cases for the epics you touched need review
- If `deck.json` exists: the status deck needs regenerating

---

## RULES

- **Chat stays conversational: NEVER the markdown table in chat.** The Epic | Task | Days
  layout belongs to the Excel export and to `context.md`, not to a message. `description`
  lives only in `estimate.json` (an extra column in the viewer)
- Write the JSON BEFORE you talk in chat: `meta.status` starts at `"draft"` and becomes
  `"confirmed"` only after the user says so explicitly
- Every epic ends with an E2E test row
- Everything is measured in days
- Conservative over optimistic
- If there is no data model, say the estimate was made without one
- Contingency is a visible percentage in `meta`, never folded silently into the task
  numbers
