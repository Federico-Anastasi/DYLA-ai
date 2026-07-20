---
name: meeting-notes
description: "Turns a meeting recording or transcript into minutes people actually read: who was there, what was decided, what is still open, and who owes what by when. Writes a markdown file in meetings/."
user-invocable: true
pack: office
---

# /meeting-notes — From a recording to minutes worth reading

Everyone leaves the meeting agreeing. A week later nobody remembers who was supposed to
send the file. This skill closes that gap: it takes what was said and turns it into four
things a reader can act on — **who was there, what was decided, what is still open, and
who does what by when**.

It works for any meeting, in any line of work: a project stand-up, a supplier
negotiation, a board meeting, a treatment review, a school committee. Nothing here
assumes software.

Unlike the rest of Dyla, this skill writes **plain markdown**, not JSON. There is no
schema and no dedicated viewer: minutes are prose, they get read by people, and they get
forwarded by email. A file is the right shape for that.

---

## PROTOCOL

1. **Get the source** — a transcript, a recording, or pasted notes
2. **Read it twice**: once for the shape of the meeting, once for the commitments
3. **Write** `meetings/YYYY-MM-DD-title.md`
4. **Say in chat** what you wrote and, above all, what you could not pin down
5. **Fix what the user corrects** — they were in the room, you were not

---

## PHASE 1 — THE SOURCE

You can be handed:

- **a transcript** — a `.md` or `.txt` file, usually in `meetings/`
- **a recording** — audio uploaded from the Documents menu. The app transcribes it
  locally and drops the result in `meetings/`. Transcription of a long meeting takes
  minutes: if a job is still running, say so and wait rather than working from a partial
  file
- **notes pasted into chat** — rough, half-written, out of order. Perfectly usable

If none of these exist, ask for one in a ```questions block (format in
`.claude/prompts/questions_format.md`):
````
```questions
[
  {
    "id": 1,
    "q": "I don't have a transcript, recording or notes for this meeting yet. How do you want to provide it?",
    "options": ["I'll upload the recording or transcript from the Documents menu"],
    "hint": "or paste the notes directly here"
  }
]
```
````
Do not write minutes from the project documents: minutes record what was said in a room,
and inventing that is the one unforgivable failure of this skill.

Before writing, check `meetings/` for minutes of earlier meetings on the same subject.
Two things come from them: the actions that were open last time (which you should check
against what was said today), and the names of recurring participants.

### Read a machine transcript for what it is

Automatic transcripts are the output of a speech model:

- **Speakers are usually not separated.** Do not attribute a sentence to someone just
  because their name appears above it. If a commitment matters and you cannot tell who
  made it, write the action with the owner as `unassigned` and flag it in chat. Never
  guess an owner — a wrong owner is worse than a missing one
- **Names, acronyms and numbers are the fragile part.** A surname that does not fit, a
  figure that contradicts itself, a term that does not exist in this field: flag it as
  uncertain instead of laundering it into a clean sentence
- **`[mm:ss]` timestamps are pointers.** Quote one when you flag a doubtful passage so
  the audio can be replayed. Do not carry them into the body of the minutes

---

## PHASE 2 — WHAT MINUTES ARE FOR

Minutes are not a summary of the conversation. They are the record of what changed
because the meeting happened. Three tests before you write a line:

- **A decision** is something that is now settled and can be acted on. "We will go with
  the second supplier" is a decision. "We talked about suppliers" is not
- **An open point** is a real fork the meeting did not close, with something at stake.
  Not every unanswered aside — only what someone will have to come back to
- **An action** has an owner and, wherever possible, a date. An action without an owner
  is a wish; write it down anyway, but marked as unassigned, because that is exactly the
  kind of thing that quietly disappears

Everything that fails all three tests is context. A little of it is useful; a lot of it
buries the parts that matter.

---

## PHASE 3 — WRITE THE FILE

Write to `projects/{project}/meetings/YYYY-MM-DD-short-title.md`, where the date is the
date of the **meeting**, not of today. If a file with that name already exists, add a
short distinguishing suffix rather than overwriting it — never destroy someone else's
minutes.

There is no project-less location the app can show this file in: every document the UI
lists comes from inside a project's own folder (`server/main.py`, `list_documents` only
scans `projects/{name}/docs` and `projects/{name}/meetings`). If the work is genuinely not
tied to one project, ask which project to file it under anyway (or a general/miscellaneous
one if the team keeps one) — a file written to a root-level `meetings/` would exist on
disk but never show up anywhere in the interface.

Use this structure. Drop sections that would be empty (an "Open points" heading with
nothing under it reads as if nothing is at stake, which is a claim you may not be able
to make) — but never drop **Decisions** or **Actions**: if there were none, say so in one
line, because that is itself the most useful thing the minutes can tell a reader.

```markdown
# {Meeting title}

**Date:** {YYYY-MM-DD} · **Time:** {start-end, if known} · **Where:** {room, call, etc.}
**Source:** {transcript file, recording, or notes taken in the room}

## In attendance
- {Name} — {role or organisation}
- {Name} — {role or organisation}
- Apologies: {names, if mentioned}

## In one paragraph
{Three or four lines: why the meeting happened and what came out of it. This is the part
a busy person reads instead of the rest — write it so that stopping here is not a
mistake.}

## Decisions
- **{The decision, stated as settled}** — {why, in a clause. Who took it, if it matters.}

## Open points
- **{The question}** — {what hangs on it, and who is expected to close it.}

## Actions
| # | Action | Owner | Due |
|---|---|---|---|
| 1 | {What gets done, concretely} | {Name} | {YYYY-MM-DD or "not set"} |

## Notes
{Context worth keeping that is not a decision, an open point or an action: figures
quoted, constraints mentioned, a position someone stated for the record. Skip the
section if there is nothing.}

## Uncertain
- {Anything you could not pin down: an owner you could not identify, a name or figure the
  transcript garbled, a decision that may have been reversed later in the call. Cite the
  `[mm:ss]` timestamp so it can be checked.}
```

### Writing rules

- **Write content, not talking.** "The launch moves to March" — not "Sara said she
  thought the launch might move".
- **Decisions in the present, actions in the imperative.** "The March date is confirmed";
  "Send the revised quote to Legal".
- **Name the owner.** One person, not a team: "Marketing" owns nothing. If the meeting
  genuinely assigned it to a group, write the group and flag it under **Uncertain**.
- **Dates as dates.** "By next Friday" becomes the actual date; if the meeting date is
  ambiguous, put the phrase in and flag it.
- **Quote figures and deadlines exactly as stated**, even when they sound wrong — then
  flag them as uncertain. Correcting a number on your own is how a typo becomes a fact.
- **Keep the disagreement when it is load-bearing.** If two people held opposite views
  and the meeting did not settle it, that belongs in **Open points**, with both
  positions. Minutes that smooth over a live disagreement will be contradicted by the
  next meeting.
- **Short lines.** Someone will read this on a phone between two other meetings.
- Never invent an attendee, an action, or a due date. An empty field is a fact; a
  plausible guess is a fabrication that will be acted on.

---

## PHASE 4 — SAY IT IN CHAT

Do not paste the minutes back into chat — the user opens the file. Tell them:

- where you wrote it
- the decisions and the actions, in one breath (counts and the sharp ones by name)
- **what you could not pin down** — this is the most valuable part of the message, and
  the part only the person who was in the room can fix
- open actions from previous minutes that were not mentioned today, if you found any

An example of the tone (not a fixed template):
```
Minutes are in meetings/2026-03-14-supplier-review.md.

Four decisions, the real one being that we go with the second supplier and the current
contract runs to the end of June. Six actions: four have an owner and a date, two do not
— "chase the shipping figures" and "redo the cost comparison" were agreed in the passive
voice and I could not tell who took them. Worth your two minutes.

One thing I left flagged: at 41:20 there is a figure I heard as "180,000" but the
sentence before it says 118. I wrote 180,000 and marked it uncertain.

Also: the action about the insurance certificate from the February minutes never came up
today. Still open, as far as this transcript goes.
```

If the user corrects something, edit the file and say what you changed in one line. They
were in the room and you were not: their correction wins, always, with no argument.

---

## RULES

- **Only what was said.** Never fill gaps from the project documents or from what would
  make sense. Minutes are evidence
- Every action has an owner or is explicitly marked unassigned. No silent orphans
- Uncertainty is stated, never smoothed over. The **Uncertain** section is a feature
- Decisions are recorded as settled; anything still in play is an open point instead
- Preserve real disagreement; do not resolve it in the writing
- Markdown in `meetings/`, one file per meeting, never overwritten
- The user's correction always wins
