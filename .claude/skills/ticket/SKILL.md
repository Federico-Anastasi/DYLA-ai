---
name: ticket
description: "Triages a maintenance ticket on a delivered project: which area and epic are involved, which objects are likely affected, what the brief says should happen, and a first hypothesis. It does not fix anything — it points."
user-invocable: true
pack: delivery
---

# /ticket — Maintenance triage

Support is usually done by a different team from the one that built the thing. Faced with
a ticket, the time goes first of all into working out **where to look**.

On a delivered project that answer is already written in our own deliverables: the
estimate says what was built, the data model says where the data lives, the mockup says
what the user sees, the brief says what should happen.

This skill does not fix the ticket and does not touch code. **It points.**

---

**UX: chat stays conversational.** The triage is an answer in chat, not a deliverable: no
JSON gets written. Cite dev tasks by id **and** name, and chapters of the brief as
`[[brief:Title]]`, so the reader gets there with one click.

## PROTOCOL

1. **Get the ticket text** from the user (or from the file they point at)
2. **Read** the project deliverables
3. **Answer** with the triage: where to look, what should happen, hypothesis
4. **Do not modify any file** unless explicitly asked

---

## PHASE 1 — THE TICKET

If the user has not pasted the text, ask for it in a ```questions block (format in
`.claude/prompts/questions_format.md`):
````
```questions
[
  {
    "id": 1,
    "q": "Paste the ticket text so I can triage it.",
    "options": ["I'll paste it now"],
    "hint": "as it arrived, bad grammar and all"
  }
]
```
````
You want it as it arrived: the end user's own words tell you which screen they are
looking at the problem from.

If the project is still in flight (estimate in draft, dev tasks unfinished), say so: this
skill is at its best on a delivered application, where the deliverables describe something
that actually exists.

---

## PHASE 2 — READING

Read ALL of these before answering:
- `projects/{project}/estimate.json` — epics, tasks and **dev tasks**: the inventory of
  what was built, with the `layer` telling you what kind of thing each piece is
- `projects/{project}/data_model.json` — tables, fields, relations
- `projects/{project}/mockup.json` — the pages and their names: the bridge between the
  user's words ("the requests screen") and the objects
- the brief (`brief.json` or the input document, possibly via `.extracted/`)
- `projects/{project}/context.md` — decisions and assumptions: many apparent anomalies are
  behaviours somebody decided on deliberately
- `projects/{project}/test_plan.json` — if it exists: a case covering the flow tells you
  how to reproduce it
- `knowledge/` — if the folder exists: naming and client patterns

---

## PHASE 3 — THE TRIAGE

Answer in chat, in this order.

**1. Where to look.** The epic and functional area involved, and the objects likely
affected, drawn from the dev tasks. Cite dev tasks by id and name. If the project's naming
convention is known, use the real object names.

**2. What should happen.** The expected behaviour according to the brief, with the chapter
reference. This is the part that separates a bug from a misunderstanding: quite often the
system is doing exactly what was asked for.

**3. How to reproduce it.** If the test plan has a case covering the flow, point at it: it
already has preconditions and steps.

**4. First hypothesis.** Stated as a hypothesis, with the reasoning. If you do not have a
sensible one, **say so**: "I have nothing to go on, we would need to know X" is a useful
answer, an invented hypothesis costs somebody half a day.

**5. What is needed to move forward.** The missing information to ask of whoever opened
the ticket (user account, date and time, the record involved, a screenshot).

An example of the tone (not a fixed template):
```
The ticket says the supplier file upload "skips some rows": that is epic 3, the file
import. The objects involved are two dev tasks, E3.T1.D2 (parsing the fixed-width file)
and E3.T1.D3 (rejecting and logging invalid rows).

According to [[brief:File import]] that is the expected behaviour: rows failing validation
are rejected into the rejects log, they do not block the import. So before treating it as
a bug I would check whether the user expects to see them somewhere — case TC12 in the test
plan covers exactly this flow.

A hypothesis, and it is only that: if there are more rejected rows than usual, I would look
at whether the file layout changed upstream. The parsing is positional and would not
notice.

To go further we need the file that was uploaded and the date of the import.
```

---

## RULES

- **It points, it does not fix.** No patches, no changes to the deliverables
- Hypotheses are stated as hypotheses. Never a cause presented as a certainty
- If the brief says the system is behaving correctly, say that first: it is the most
  frequent case and the fastest to close
- If the deliverables are not enough to say anything useful, say so. A vague triage wastes
  more time than no triage
- This skill writes no files
