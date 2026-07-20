# The `questions` block — Q&A format

A contract with the UI: clarifying questions to the user are NOT written as free text, but
in a fenced ```questions block containing JSON. The frontend renders them as clickable
cards; outside the block you can write normal text (context, preamble).

```questions
[
  {
    "id": 1,
    "q": "Does the daily file arrive as a fixed-width text file or as a spreadsheet? It matters: positional parsing costs about a day more.",
    "options": ["Fixed-width text", "Spreadsheet / delimited CSV"],
    "hint": "if the layout has not arrived yet, say so here"
  },
  {
    "id": 2,
    "q": "Can you confirm the second approval step only kicks in above 500k?",
    "options": ["Confirmed"],
    "hint": "if the threshold is different, write it in"
  }
]
```

Note this block is a different artefact from `questions.json` (`schemas/questions.schema.json`,
written by `/meeting`): that is the persistent register of open questions towards the
client, with string ids `"Q1"`, `"Q2"`, … here `id` is a plain sequential integer, scoped
to this one chat turn. Do not mix the two formats up.

## Fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Sequential integer, used to refer to the question in chat (unrelated to the `"Q1"`-style string ids of `questions.json`) |
| `q` | yes | The question. If the answer moves the estimate, say so in the question itself |
| `options` | yes | 1-4 ready-made answers — the ones you actually expect |
| `hint` | no | Placeholder for the free-text field: what to add when the options do not cover it |

## Rules for `options`

The options are where most of the value is: the user clicks instead of typing. Pick how
many based on the shape of the question, not at random.

- **A binary question** → 2 options ("Fixed-width text" / "Delimited spreadsheet")
- **Yes/no** → `["Yes", "No"]`
- **Confirming an assumption** → a single option ("Confirmed"): one click to agree, and if
  the assumption is wrong they use the free-text field
- **Known alternatives** → up to 4, never more: beyond that it becomes a list to read
  rather than a choice to make

Write **self-contained** options: "A separate approvers group", not "the first one". They
get read without going back to the question.

If the question is genuinely open (a date, a number, the name of a system) and no
plausible option exists, still put the most likely answer as a single option and rely on
the free-text field.

## The free-text field

It is **always** there, under the options — you do not declare it. The user can:
- click an option only
- write free text only
- **do both**: an option plus a qualification

It all arrives joined up (`"Fixed-width text — but the layout only reaches us in
September"`). Bear that in mind: the free-text qualification always beats the option when
the two contradict each other.

## When to emit the block

By default group **ALL** the questions you have into a single block: the user answers in
one pass. If the answers open new questions, emit a new block on the next turn. Do not
split into one block per question.
