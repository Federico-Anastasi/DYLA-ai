---
name: meeting
description: "Merges a meeting transcript into the project brief: updates brief.json incrementally, extracts the questions still open, records decisions and people, and flags contradictions with earlier meetings."
user-invocable: true
pack: delivery
---

# /meeting — From transcript to brief

Discovery is the phase where you interview the people who will use the thing: how they
work today (usually spreadsheets, email and a couple of macros) and how that process
should look once it is a real application. The brief is what comes out of those
conversations.

This skill does one job: **turn a transcript into a document**. It does not rewrite the
brief from scratch at every meeting — it grows it.

---

**UX: chat stays conversational.** Never paste the brief, its chapters or lists of
questions into chat: the user reads them in the viewer. In chat you say what changed,
citing chapters by id **and** title (e.g. "C3, Permissions") and questions by id (e.g.
"Q7"). When you cite a chapter of the brief, write `[[brief:Chapter title]]`: it renders
as a clickable reference that opens the document at that point.

## PROTOCOL

1. **Check the project source** — this skill only applies to source `discovery`
2. **Find the transcripts not merged yet** (`meetings/` vs the `changelog` of brief.json)
3. **Read** the transcript, the current brief, context.md, the existing questions and people
4. **Merge** into the brief incrementally (`meta.status: "draft"`, `version` +1)
5. **Extract** open questions, decisions, people, contradictions
6. **Say in words** what changed (BLOCKING — wait for confirmation or edits)
7. **On confirmation:** `meta.status: "confirmed"`
8. **Update context.md**

---

## PHASE 1 — CHECK DEPENDENCIES

Read `projects/{project}/.project.json`. If `source` is not `"discovery"`, say so and ask
in a ```questions block (format in `.claude/prompts/questions_format.md`):
````
```questions
[
  {
    "id": 1,
    "q": "This project starts from a brief that was handed to us: it is an input document and this skill does not rewrite it. Do you still want this meeting's decisions and open questions kept on record, in context.md and questions.json?",
    "options": ["Yes, keep them in context.md and questions.json", "No, nothing else needed"]
  }
]
```
````

**STOP.** Never create `brief.json` on a project whose source is `brief`: it would
overwrite the meaning of the document the client gave us.

---

## PHASE 2 — FIND THE TRANSCRIPT TO MERGE

Transcripts live in `projects/{project}/meetings/` (one per meeting, typically
`YYYY-MM-DD-title.md`). Binary formats (docx, pdf) have their text extracted under
`projects/{project}/.extracted/`: read the extract, not the binary.

Compare the files you find with `changelog[].source` in `brief.json`: the ones already
cited there have been merged. If several new transcripts are waiting, **merge them one
at a time**, in date order — the brief has to grow in the same order the meetings
happened, otherwise the contradictions read backwards.

If the user named a specific file, use that one. If there is no new transcript, say so
and ask whether they want to re-merge one you have already seen or upload another — from
the **Documents** menu they can also upload the audio recording, which the app
transcribes locally and drops here.

### If the transcript is machine-made, read it for what it is

Transcripts produced by the app (header `Source: automatic transcription`) are the
output of a speech model, not minutes taken by a person. Account for that:

- **Speakers are not separated.** Do not attribute a sentence to someone just because it
  follows their name. If a statement matters (a decision, a commitment) and it is not
  clear who made it, put it among the open questions instead of guessing the person.
- **Proper nouns and acronyms are the fragile part.** A term that does not add up (a
  mangled surname, an initialism that does not exist in this domain) is almost always a
  transcription error: flag it rather than treating it as a new requirement.
- **The `[mm:ss]` timestamp is a pointer**, not content: quote it when you flag a
  doubtful passage, so the audio can be replayed (it is kept until the transcript is
  confirmed). Never carry it into the brief.

---

## PHASE 3 — READING

Read ALL of these before you go on:
- the transcript to merge (or its extract)
- `projects/{project}/brief.json` — if it exists
- `projects/{project}/context.md`
- `projects/{project}/questions.json` and `projects/{project}/people.json` — if they exist
- `projects/{project}/docs/*` — client material (emails, spreadsheets, file layouts, screenshots)
- `knowledge/` — if the folder exists: client conventions, naming, recurring patterns

Transcripts are **messy**: speaker labels, repetitions, half sentences, digressions.
That is not a problem to report, it is the normal raw material.

---

## PHASE 4 — INCREMENTAL MERGE (write first, talk in chat after)

Write `projects/{project}/brief.json` following `schemas/brief.schema.json`.

### If the brief does not exist yet
Build it from the first meeting. `meta` requires `project`, `title` and `date`;
`version` starts at 1, `status` is `"draft"`. Each chapter requires `id` (`C1`, `C2`, …),
`title` and `body`. A typical starting structure — adapt it to the project, it is not a
form to fill in:

| id | Chapter | Content |
|---|---|---|
| C1 | Context and goals | Why the project exists, who asked for it, what it solves |
| C2 | How it works today | Current process: tools, hand-offs, who does what |
| C3 | How it should work | The target process on the new application |
| C4 | People and roles | Who uses what, with which permissions |
| C5 | Functional requirements | What the system must do, by area |
| C6 | Data and integrations | External systems, files, layouts |
| C7 | Constraints | Regulatory, security, infrastructure |

### If the brief exists (the normal case)
**Do not rewrite it.** For each thing that came up in the meeting:

- it **confirms** something already written → leave the chapter as it is, add the meeting
  to `sources`
- it **adds** a detail → fold it into the relevant chapter, keeping the existing text
  that still holds
- it **changes** something already written → rewrite that part and record it explicitly
  in the `changelog` ("previously X, now Y")
- it **opens** a new topic → new chapter, with `open: true` if it is still a sketch

Writing rules:
- `body` in markdown, in document prose: full sentences, not telegraphic notes. This is a
  document the client reads
- Never report the talking: write the **content**, not "Mr Smith said that"
- `sources`: the meeting files the chapter derives from. Always fill it in — that
  traceability is what makes the brief defensible in front of the client
- `open: true` on chapters where questions remain: that is information, not a defect
- `requirements[]`: the requirements that emerged in verifiable form, each linked to its
  chapter. Required fields: `id` (`R1`, `R2`, …), `title`, `description` (self-contained,
  readable without the chapter); `chapter` links it back to `chapters[].id`. If a
  requirement is not confirmed by the client yet, `status: "proposed"`
- `glossary`: domain terms and acronyms a reader outside the project would not know, each
  as `{term, definition}` — both required. Add them as they show up, from the first
  meeting
- `changelog`: one entry for this meeting, with `date`, `source` = the file name, and
  `summary` = what changed in the brief (not what was said in the meeting) — all three
  required
- `meta.version`: +1. `meta.status`: `"draft"`

Check validity:
```
python -c "import json; from jsonschema import validate; validate(json.load(open(r'projects/{project}/brief.json', encoding='utf-8')), json.load(open(r'schemas/brief.schema.json', encoding='utf-8'))); print('valid')"
```

---

## PHASE 5 — QUESTIONS, PEOPLE, DECISIONS, CONTRADICTIONS

### questions.json
Everything left hanging in the meeting ("they will let us know", "we have to ask team X",
"it depends how Y works") becomes a question in `projects/{project}/questions.json`
(`schemas/questions.schema.json`).

- `source`: the meeting file the doubt came from
- `addressee`: who can answer, if the transcript makes it clear
- `impact`: what changes depending on the answer (the estimate, the data model, a
  requirement). This is the field that lets you prioritise: a question with no impact is
  curiosity
- Do not duplicate questions that already exist: if this meeting **answered** an open
  question, set `status: "answered"` and write the `answer` (the backend rejects
  `answered`/`closed` without text)

### people.json
Who spoke, who was named as a contact, who decides. `schemas/people.schema.json`. The
`notes` field is what makes the file worth keeping: what that person knows, what they
decide on. Do not invent contact details you do not have.

### Decisions
Decisions taken go into `context.md`, under `## Decisions`, with the date and who took
them. One line each, in plain language.

### Contradictions
If the meeting contradicts something written earlier (in the brief or in a decision),
**flag it, do not resolve it**. Say it in chat, and set `open: true` on the chapter
involved. Resolving a contradiction between two meetings on your own means choosing on
the client's behalf.

---

## PHASE 6 — CONVERSATIONAL SUMMARY (BLOCKING)

The files already exist and the user can see them in the viewer. In chat, tell them:
- what changed in the brief, chapter by chapter (**only the ones you touched**), with
  clickable `[[brief:Title]]` references
- how many new questions were opened and which are the pressing ones
- the contradictions you found, explicitly
- the new people recorded

An example of the tone (not a fixed template):
```
I merged the 12 September meeting into the brief (version 3). Most of it lands on
[[brief:How it should work]], which now carries the two-step approval we did not have
before: above 50,000 the branch manager has to sign off as well. I updated
[[brief:People and roles]] to match.

One contradiction worth your attention: in July they said expired requests close
automatically, here they described closing them by hand with a reason. I left that
chapter open — it needs to go back to them.

Four new questions, the heaviest being whether the daily file arrives once a day or once
a week: that changes the whole design of the import. They are in the Questions tab.
```

**STOP. Wait for confirmation or change requests.**

If the user asks for changes: edit the files directly, re-validate against the schemas,
present a short summary of what you touched, and ask for confirmation again.

---

## PHASE 7 — CONFIRMATION

On confirmation: `meta.status: "confirmed"` in `brief.json` (`Edit` just that line — do not rewrite the file: it is tens of thousands of
characters, and regenerating all of them to change one word is both slow and a
chance to alter something by accident), re-validate. Confirm briefly in chat, and remind them the brief downloads as a Word
document from the "download" button in the viewer — that is the format to send out.

---

## PHASE 8 — UPDATE context.md

- `## Brief` — version, date of the last merge, chapters, meetings merged so far
- `## Decisions` — the decisions from this meeting
- `## Deliverables` — updated state

---

## PHASE 9 — CONSISTENCY CHECK

If the project already has other deliverables and the brief changed substantially:
- `estimate.json` exists → "The brief changed on {area}. The estimate may no longer line
  up: want me to revisit it?"
- `data_model.json` exists and new entities or fields came up → say which
- `test_plan.json` exists → the cases tied to the changed requirements need review

**Never update the other deliverables automatically.** You flag and you ask, one file at
a time.

---

## RULES

- Only for projects whose source is `discovery`. We do not write on the client's brief
- **Incremental, never from scratch**: the brief accumulates meetings, it does not
  replace them
- Every chapter declares its `sources`. Without traceability the brief is not defensible
- Contradictions get flagged, not resolved
- Open questions are a deliverable, not leftovers: always fill in `impact`
- Do not invent requirements the meeting did not express. If a topic was only brushed
  against, the chapter stays `open: true` with an open question
- Chat stays conversational: never paste chapters or question lists into the message
