# Bringing your own estimation rules

Dyla ships with no estimation baselines. That is deliberate: what a screen or an
integration costs depends on your stack, your team and your history, and a number
borrowed from someone else's project is worse than no number at all.

So out of the box `/estimate` reasons from the brief and **asks you** whenever it needs a
figure it cannot defend. That works, and it is slow. Once you have answered the same
question three times, write the answer down — from then on the skill applies it without
asking.

## Where the rules go

Create a `knowledge/` folder at the root of the repo. Every `.md` file in it is read by
the skills that need it. There is no required schema: it is prose and tables that a model
reads, so write it the way you would explain it to a new colleague.

```
knowledge/
  estimation.md        per-component baselines, the numbers you keep repeating
  calibration.md       what your team actually delivers, versus what you estimated
  clients/acme.md      one file per client: naming, constraints, house patterns
```

Split it however suits you — the file names above are a suggestion, not a contract. One
long file works fine until it does not.

## What is worth writing down

**Baselines per component.** The bulk of the value. A table beats a paragraph:

```markdown
| Component | What it covers | Days |
|---|---|---|
| List screen, standard filters | Grid, pagination, filters from the framework | 1-1.5 |
| List screen, custom filters | Every filter hand-built, no framework defaults | 3 |
| Create form (~20 fields) | Layout, validation, save | 1.5 |
| Edit form | The above, plus pre-fill and change handling | 2 |
| Read-only detail view | Display only, no actions | 0.5 |
| API integration, read | Call, response mapping, error handling | 1 |
| Spreadsheet import, known format | Upload, parse, validate, load | 2 |
| Spreadsheet import, format unknown | The above, plus the cost of finding out | 3.5 |
```

**Multipliers and overheads.** The adjustments you apply without thinking about them:
a first-time component costs a day more; a junior on complex work adds 20-30%; anything
crossing your API gateway carries half a day of certificate and whitelist work; reusing a
pattern the second time saves about a third.

**Test and contingency ratios.** How E2E effort scales with the epic — a plain CRUD flow
is around a tenth of its development, an approval flow with several outcomes closer to a
fifth. What contingency you attach to a well-specified brief versus a vague one.

**Team calibration.** Size and seniority mix, and above all the gap between what you
estimated and what it took. This is the section that makes the numbers yours: "our first
pass runs 20% light on anything involving file formats" is more useful than any table.

**Client specifics.** Naming conventions, mandatory constraints, patterns that recur on
every project for that client. One file per client keeps it findable.

## How the skills use it

Out of the box `knowledge/` does not exist — see the top of this file. Everything below
applies once you have created it and written at least one rule into it; on a project with
no folder, or with a folder silent on what you are estimating, the skills ask instead of
applying a rule that is not there.

`/estimate` reads `knowledge/` before estimating and cites which rule it applied in
`assumptions[]`. `/dev-tasks`, `/data-model`, `/mockup` and `/test-plan` read it too, for
naming and house patterns.

Once a rule exists, it is not treated as optional: if a rule says a component costs 2
days, the estimate says 2 days. When you disagree with the output, the fix usually
belongs in `knowledge/`, not in that one estimate — otherwise you will be making the same
correction next month.

One thing to decide up front: whether `knowledge/` belongs in version control. Shared
conventions benefit from being committed; rates, client names and calibration data
usually do not. If yours are the second kind, add `knowledge/` to `.gitignore` before you
write anything into it.
