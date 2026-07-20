---
name: data-model
description: "Analyses the brief, runs a short Q&A, and produces the validated data model (tables, relations, integrations) in data_model.json. Updates context.md."
user-invocable: true
pack: delivery
---

# /data-model — Data model

Reads the project brief and produces the validated data model.

**UX: chat stays conversational.** The deliverable is never presented as a markdown table
in chat — the user reads the table and the diagram in the viewer next to the chat, from
`data_model.json`. In chat you discuss it in words, citing elements by id (e.g. the
`refund_request` table). The user does not have to type ids: every element in the viewer
has a chat icon that sends you a ready-made `[REFERENCE]` — point them at that button
when it is unclear what they mean. When you cite a chapter of the brief, write
`[[brief:Chapter title]]`: it renders as a clickable reference that opens the document at
that point.

---

## PROTOCOL

1. **Read context.md** — where is the project? (Q&A already done? Data model already there?)
2. **Read the brief** — find the brief file in the project folder
3. **If `data_model.json` already exists:** ask "The data model already exists. Regenerate it from scratch, or edit it?"
4. **If context.md has no Q&A:** run the Q&A (BLOCKING — 5 to 7 questions, no more)
5. **Write data_model.json straight away** with `meta.status: "draft"`
6. **Present a conversational summary** (BLOCKING — wait for validation or edits)
7. **On confirmation:** set `meta.status: "confirmed"`
8. **Update context.md**
9. **Check consistency** with the deliverables that already exist

Note: `data_model.drawio` and `data_model.html` are **exports**, generated on demand by
the backend from `data_model.json` (`GET /api/projects/{project}/export/data_model.drawio`
and `.../data_model.html`). This skill does not produce them.

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
- `knowledge/` — if the folder exists: naming conventions, house patterns, client
  specifics. Nothing there is assumed: if a convention matters and the folder is silent
  about it, ask the user rather than inventing one

If `context.md` already holds answered Q&A, do not ask again — use the answers.

If `data_model.json` already exists, ask in a ```questions block (format in
`.claude/prompts/questions_format.md`):
````
```questions
[
  {
    "id": 1,
    "q": "The data model already exists. Do you want to edit it or regenerate it from scratch?",
    "options": ["Edit it — tell me what to change", "Regenerate it from scratch"]
  }
]
```
````

---

## PHASE 2 — Q&A (BLOCKING, if needed)

If context.md has no Q&A, read the brief for ambiguities and ask in a ```questions block
— the format and the rules for `options` are in `.claude/prompts/questions_format.md`,
read it before writing the block.

Here the questions exist to settle the data model: missing entities, the cardinality of
relations, the fields that distinguish one type of record from another, which data comes
from external systems. For `options`, offer the assumption you would make yourself — most
of the time the user just confirms it.

**STOP. Wait for the answer.**

Once answered, write the Q&A into context.md.

---

## PHASE 3 — WRITE THE DRAFT data_model.json (before you talk in chat)

**Do not generate drawio or html from this skill.** Those are exports produced on demand
by the backend (`server/exports.py`) from `data_model.json`: this skill writes the JSON
and nothing else. No generation script gets copied or run here.

1. Build the JSON following `schemas/data_model.schema.json`:
   - `meta`: project, title, date, **`status: "draft"`**
   - `areas[]`: functional areas with a colour (`id`, `name`, `color` as hex). Keep the
     palette consistent across areas so the diagram reads at a glance — one hue per area,
     distinguishable from the others
   - `tables[]`: `id`, `name`, `area` (referencing `areas[].id`), `fields[]` (`name`,
     `type`, `pk`, `fk` as "table.field", `nullable`, `notes`)
   - `relations[]`: `from`/`to` as "table.field", `type` (N:1 / 1:1 / N:M), optional `label`
   - As an order of magnitude: a small project sits around 8-10 tables, a mid-size one
     15-20, a large one beyond that — driven by how many distinct entity/record types the
     brief describes, not by a target count to hit
2. Write it to `projects/{project}/data_model.json` — the skeleton (`meta`,
   `areas`, empty `tables` and `relations`) with `Write`, then one area's tables
   per `Edit`. A single call carrying the whole model is how this fails on a
   local model: the payload arrives empty and nothing is written.
3. VALIDATE it:
   ```
   python -c "import json; from jsonschema import validate; validate(json.load(open(r'projects/{project}/data_model.json', encoding='utf-8')), json.load(open(r'schemas/data_model.schema.json', encoding='utf-8'))); print('valid')"
   ```

On fields: if all you have from the brief is a rough count, generate plausible, coherent
fields (an id primary key, foreign keys for the relations, the usual name / status /
dates / notes).

**Preserve `tables[].pos` when regenerating.** `pos` (`{x, y}`) is the box position the
user set by dragging it in the frontend editor — that is their manual work and it must
not be thrown away. Whenever you regenerate or update `data_model.json`:
- for every table in the output that survives (same `id` as a table in the existing
  document), copy its existing `pos` if it had one
- for NEW tables never set `pos` — the editor assigns it on first use, not the agent

---

## PHASE 4 — CONVERSATIONAL SUMMARY (BLOCKING)

The file already exists (`meta.status: "draft"`) and the user can see it in the viewer as
an ER diagram and a table. In chat give a **conversational summary, no table**: how many
tables and functional areas, which ones you inferred versus which came straight from the
brief (and why), the main relations, any integrations. You may quote two or three rows at
most, never the whole table. Close by asking whether the structure is right or something
is missing.

**STOP. Wait for validation or change requests.**

If the user asks for changes: edit `data_model.json` directly, re-validate, present a
short summary of the changes (naming the tables you touched) and ask again.

---

## PHASE 5 — CONFIRMATION

Once the user validates: set `meta.status: "confirmed"` in `data_model.json` (`Edit` just
that line — do not rewrite the file: it can run to tens of thousands of characters, and
regenerating all of it to change one word is both slow and a chance to alter something by
accident), re-validate. Confirm briefly in chat.

---

## PHASE 6 — UPDATE context.md

Write or update the `## Data model` section in context.md with:
- Status: validated
- Tables (as a markdown table — fine here, this is an internal state file, not a chat
  message)
- Relations
- Integrations
- Update the `## Deliverables` section

---

## PHASE 7 — CONSISTENCY CHECK

Check which other deliverables exist:
- `estimate.json` exists: "The estimate is already there. These data model changes may
  put it out of date. Want me to revisit it?"
- `mockup.json` exists: same question
- `estimate.json` has `meta.dev_tasks_status` set (dev task breakdown already done): same
  question
- `test_plan.json` exists: same question — the cases tied to the entities you touched
  need review

Ask file by file. Never update anything automatically.

---

## RULES

- **Chat stays conversational: NEVER the markdown table in chat.** The user validates by
  looking at the viewer and the diagram, not at a message
- Write the JSON BEFORE you talk in chat: `meta.status` starts at `"draft"` and becomes
  `"confirmed"` only after the user says so explicitly
- The data model underpins everything downstream — it has to be right
- Every table declares where it came from: a chapter of the brief, or inferred, with the
  reasoning
- Do not chase individual fields when the brief does not have them — the approximate
  shape is what matters at this stage
- Some tables are almost always needed even when nobody asked: a status history for the
  audit trail, an attachments table for uploaded documents. Propose them, do not smuggle
  them in
- Relations drive the complexity of everything built on top of this model — get the
  cardinalities right before worrying about field names
