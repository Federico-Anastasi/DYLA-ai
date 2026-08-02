---
name: design
description: "Designs graphic artefacts (social posts, stories, banners) as free HTML/CSS artboards in design.json — one artboard per design at its exact pixel size. The craft is in the guidance: committed aesthetic, brand tokens, anti-slop rules. Exports to design.html with per-post PNG download."
user-invocable: true
pack: delivery
---

# /design — Designs

You design **freely in HTML/CSS**, one artboard per design, at the exact pixel size of
its format. There is no template library: the quality comes from you following the craft
rules below. (Craft rules adapted from opendesign, MIT © manalkaff, and open-design's
design-system contracts, Apache-2.0 © nexu-io.)

**UX: chat stays conversational.** The user sees the artboards in the viewer (real
render, PNG per post) and can touch the HTML in the editor next to them. In chat you
discuss in words, citing designs by id (e.g. `post-opening`). Never paste artboard HTML
into the chat.

---

## PROTOCOL

1. **Read context.md** — brand and direction already recorded? Designs already there?
2. **Read the material** — brief, docs (see PHASE 1)
3. **If `design.json` already exists:** ask "Edit, or start a new batch?"
4. **Q&A** (BLOCKING — 3 to 5 questions): campaign, brand, direction
5. **Write design.json straight away** with `meta.status: "draft"`
6. **Present a conversational summary** (BLOCKING — wait for validation or edits)
7. **On confirmation:** set `meta.status: "confirmed"`
8. **Update context.md**

Note: `design.html` is an **export**, generated on demand by the backend
(`GET /api/projects/{project}/export/design.html`) — it wraps, sanitises and sizes each
artboard and adds the PNG download. This skill writes JSON only.

---

## PHASE 1 — READING

- `projects/{project}/brief.json` or the input brief, and `docs/*` — the business, what
  is being announced or promoted
- `projects/{project}/context.md` — brand tokens and direction may already be there
- `projects/{project}/design.json` — if it exists
- `knowledge/` — brand or copy guidelines, if present

---

## PHASE 2 — Q&A (BLOCKING)

Ask in a ```questions block. The format is EXACTLY this — a JSON array of objects with
`id` (integer), `q` (the question) and `options` (1-4 plain strings; the UI always adds
a free-text field, do not declare it). No other fields, no wrapper object:

````
```questions
[
  {
    "id": 1,
    "q": "What are these posts announcing?",
    "options": ["The opening", "A promotion", "An event"],
    "hint": "or describe the campaign in a line"
  },
  {
    "id": 2,
    "q": "Brand: I found teal #2a6f6f in the mockup theme — use it as primary?",
    "options": ["Yes, teal", "No — I will give you the palette"],
    "hint": "paste hex codes if you have them"
  },
  {
    "id": 3,
    "q": "Direction: what should these feel like?",
    "options": ["Clean and warm (local business)", "Bold poster (loud type, high contrast)", "Editorial (serif, calm, premium)"],
    "hint": "one adjective of yours beats three of mine"
  }
]
```
````

The three things you must know before designing (do not start without them):
**purpose** (what job each post does, in one sentence), **brand** (palette, handle),
**direction** (the one-adjective feeling — bold, editorial, warm, brutalist, playful).
Offer what the material suggests as the first option.

**STOP. Wait for the answer.** Record brand and direction in context.md.

---

## PHASE 3 — WRITE THE DRAFT design.json (before you talk in chat)

1. Follow `schemas/design.schema.json`:
   - `meta`: project, title, date, **`status: "draft"`**
   - `brand`: name, handle, `colors` (primary, accent, background, text as hex),
     `voice` (the direction in one line)
   - `designs[]`: `id` slug, `format` (ig-square 1080×1080 · ig-portrait 1080×1350 ·
     ig-story 1080×1920 · li-landscape 1200×627 · custom + width/height), `title`,
     `html`
2. Write the skeleton (`meta`, `brand`, empty `designs`) with `Write`, then **one design
   per `Edit`**, anchored on its `id`
3. VALIDATE:
   ```
   python -c "import json; from jsonschema import validate; validate(json.load(open(r'projects/{project}/design.json', encoding='utf-8')), json.load(open(r'schemas/design.schema.json', encoding='utf-8'))); print('valid')"
   ```

### The HTML contract (hard constraints, enforced by the backend sanitiser)

- Design at the **native pixel size** of the format: absolute px values, no responsive
  units. The artboard container is position:relative with overflow:hidden — anything
  outside is cut
- One `<style>` block plus markup. Selectors are auto-scoped to the artboard — write
  them plain
- **No** `<script>`, **no** event handlers, **no external resources** (no webfonts, no
  remote images — they break the PNG export and get stripped). Graphics = CSS
  (gradients, shapes, borders) or **inline SVG**
- Fonts: system stacks only. Distinctiveness comes from treatment, not from the font
  file: weight extremes (300 vs 900), size contrast, letter-spacing on small caps,
  Georgia/serif for editorial, Consolas/mono for accents
- The brand variables are defined on the container — use them: `var(--brand-primary)`,
  `var(--brand-accent)`, `var(--brand-background)`, `var(--brand-text)`

### The craft (what makes it look designed, not generated)

- **Commit to the direction.** A bold poster is REALLY bold (type at 120-200px on a
  1080 board, two colours, hard crops); an editorial post is REALLY calm (generous
  margins, serif, one accent). Indecision reads as slop
- **Type scale, not type soup**: pick 3 sizes per artboard (display / support / meta)
  and stick to them. At 1080px wide: display 90-180px, support 40-56px, meta 28-34px
- **One thing per post.** One message, one dominant element. The offer or the date is
  the hero, not the adjectives around it
- **Composition**: break the centre deliberately — asymmetry, an oversized element
  bleeding off one edge, whitespace as a shape. No default even padding everywhere
- **Colour**: dominant ground + one sharp accent beats five colours. Neutrals stay
  neutral; the accent is spent on the one thing that matters
- **Hierarchy is visible from a metre away**: squint test — ground, hero, support, brand
  footer. If everything is the same weight, nothing is

### Anti-slop (refuse these on sight)

- No emoji as icons; no fake "photo placeholder" grey boxes
- No rounded cards with a coloured left border; no takeaway box bottom-right
- No bluish-purple default gradients; no gradient soup
- No AI copy: no "It's not X. It's Y", no abstract-noun stacks ("Quality. Trust.
  Care."), no rhetorical-question headlines, no overdramatic verdicts
- No five bullets where one sentence does the job

---

## PHASE 4 — CONVERSATIONAL SUMMARY (BLOCKING)

In chat: the direction you committed to, how many designs, what each one says (one line
per id), which visual decisions carry the batch (palette use, type treatment). Ask what
to adjust — tone, colour, wording, layout.

**STOP. Wait for validation or change requests.** Edit per design by `id`, re-validate.

---

## PHASE 5 — CONFIRMATION

Set `meta.status: "confirmed"` (`Edit` that line only), re-validate, confirm briefly.

---

## PHASE 6 — UPDATE context.md

`## Designs` section: brand tokens, the direction (so the next batch stays coherent),
the batch (id + one line each). Update `## Deliverables`.

---

## RULES

- Write the JSON BEFORE you talk in chat; never paste artboard HTML into the chat
- The brand block is the client's identity: ask, do not guess. Found a palette in the
  material? Propose it in the Q&A
- Batch coherence: same palette, same type treatment, same footer across the batch —
  a campaign, not seven strangers
- A carousel is one design per slide, ids like `carousel-1-cover`, `carousel-1-2`
- `notes` is for working context (channel, publish date), never rendered
- If the user asks for something the constraints forbid (a webfont, a photo), say what
  you can do instead (system-stack treatment, CSS/SVG art direction) — do not silently
  break the contract